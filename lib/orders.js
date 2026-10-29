'use strict';
/*
 * Order state machine (CONTRACT 4.2 / 6.8). Owner: payments.
 * syncOrder is the single idempotent path that moves an order between statuses; it is used by
 * verify-payment, cashfree-webhook, reconcile, order-status and mock-pay.
 * Gateway-reported status/amount are always fetched server-to-server; webhook payloads are never trusted.
 */

const crypto = require('node:crypto');
const { HttpError, log } = require('./http');
const { amountsEqual } = require('./pricing');
const sheets = require('./sheets');
const cashfree = require('./cashfree');
const { verifyToken } = require('./tokens');
const { validateOrderId, validateTokenFormat } = require('./validate');

const STATUSES = Object.freeze({
  AWAITING: 'Awaiting Payment',
  PAID: 'Paid',
  FAILED: 'Failed',
  EXPIRED: 'Expired'
});

const EXPIRY_GRACE_MS = 15 * 60 * 1000;
const FAILED_PAYMENT_STATUSES = new Set(['FAILED', 'USER_DROPPED', 'CANCELLED']);

const MESSAGES = {
  [STATUSES.PAID]: 'Payment received. Your order is confirmed.',
  [STATUSES.AWAITING]: 'We are waiting for confirmation from the payment gateway. This page updates automatically.',
  [STATUSES.FAILED]: 'The payment did not go through. No money was taken, or it will be refunded automatically by your bank.',
  [STATUSES.EXPIRED]: 'This order expired before payment was completed. Please place a new order.'
};

/* ------------------------------------------------------------------ helpers */

/** Duck-typed HttpError check (works across reloaded copies of lib/http.js). */
function isHttpError(e) {
  return Boolean(e && typeof e === 'object' && (e instanceof HttpError || e.isHttpError === true));
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function fmt2(n) {
  return isFiniteNumber(n) ? n.toFixed(2) : 'unknown';
}

/** Adds a review flag to the existing ' | '-separated list (no duplicates, keeps earlier flags). */
function addFlag(existing, flag) {
  const parts = String(existing || '').split('|').map((x) => x.trim()).filter(Boolean);
  if (!flag) return parts.join(' | ');
  const key = String(flag).split(' ')[0];
  const kept = parts.filter((x) => x.split(' ')[0] !== key);
  kept.push(String(flag));
  return kept.join(' | ').slice(0, 500);
}

/** True when a gateway amount is a real money value with at most two decimals (e.g. 1630 or 1630.5). */
function isMoneyValue(n) {
  return isFiniteNumber(n) && n > 0 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

function safeAmountsEqual(a, b) {
  if (!isFiniteNumber(a) || !isFiniteNumber(b)) return false;
  try { return amountsEqual(a, b); } catch (_) { return false; }
}

function timeOf(p) {
  const t = Date.parse(p && p.time);
  return Number.isFinite(t) ? t : NaN;
}

/** Latest payment attempt: newest by time; ties / missing times fall back to array order (last wins). */
function latestPayment(payments) {
  if (!Array.isArray(payments) || payments.length === 0) return null;
  let best = null;
  let bestT = -Infinity;
  payments.forEach((p) => {
    if (!p) return;
    const t = timeOf(p);
    const key = Number.isFinite(t) ? t : -Infinity;
    if (best === null || key >= bestT) { best = p; bestT = key; }
  });
  return best;
}

function successPayment(payments) {
  if (!Array.isArray(payments)) return null;
  const ok = payments.filter((p) => p && String(p.status).toUpperCase() === 'SUCCESS');
  return latestPayment(ok);
}

/** Internal-only: SHA-256 based, alphanumeric Cashfree customer_id that does not expose the email. */
function customerIdFor(email) {
  return 'c' + crypto.createHash('sha256').update(String(email || '').toLowerCase()).digest('hex').slice(0, 20);
}

/* ------------------------------------------------------------ resolveStatus */

/**
 * Pure. gateway = { orderStatus, amount, currency?, payments: [{ status, time? }] }.
 * expectedTotal = stored order total in rupees.
 * -> { status, reviewFlag? }
 */
function resolveStatus(current, gateway, expectedTotal, { now = Date.now(), expiresAt } = {}) {
  if (current === STATUSES.PAID) return { status: STATUSES.PAID };
  const g = gateway || {};
  const orderStatus = String(g.orderStatus || '').toUpperCase();
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const expMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);

  if (orderStatus === 'PAID') {
    const currencyOk = !g.currency || String(g.currency).toUpperCase() === 'INR';
    const expected = Number(expectedTotal);
    const amount = Number(g.amount);
    if (currencyOk && isMoneyValue(amount) && isMoneyValue(expected) && safeAmountsEqual(amount, expected)) {
      return { status: STATUSES.PAID };
    }
    return {
      status: current,
      reviewFlag: `AMOUNT_MISMATCH gateway=${fmt2(Number(g.amount))} expected=${fmt2(Number(expectedTotal))}` +
        (currencyOk ? '' : ` currency=${String(g.currency).slice(0, 8)}`)
    };
  }

  // Only a (matching) PAID can move an Expired order.
  if (current === STATUSES.EXPIRED) return { status: STATUSES.EXPIRED };

  if (orderStatus === 'EXPIRED' || orderStatus === 'TERMINATED') return { status: STATUSES.EXPIRED };

  if (orderStatus === 'ACTIVE') {
    // Gateway still says ACTIVE long after our own expiry: give up on it (CONTRACT 5.5).
    if (Number.isFinite(expMs) && Number.isFinite(nowMs) && nowMs > expMs + EXPIRY_GRACE_MS) {
      return { status: STATUSES.EXPIRED };
    }
    const latest = latestPayment(g.payments);
    if (latest && FAILED_PAYMENT_STATUSES.has(String(latest.status).toUpperCase())) {
      return { status: STATUSES.FAILED };
    }
  }

  return { status: current };
}

/* --------------------------------------------------------------- syncOrder */

function nowIso() {
  return new Date().toISOString();
}

/**
 * Build the patch for `record` from a gateway snapshot. Returns { patch, from, to }.
 * snapshot = { known: boolean, order, payments, mode }.
 */
function buildPatch(record, snap, now) {
  const patch = {};
  const from = record.status;
  let resolved;

  if (snap.known) {
    resolved = resolveStatus(from, {
      orderStatus: snap.order.status,
      amount: snap.order.amount,
      currency: snap.order.currency,
      payments: snap.payments
    }, Number(record.total), { now, expiresAt: record.expiresAt });

    // Raw gateway status column. In mock mode the column holds the MOCK_* state itself: never overwrite it.
    if (snap.mode !== 'mock' && snap.order.status && snap.order.status !== record.gatewayStatus) {
      patch.gatewayStatus = snap.order.status;
    }
    if (snap.mode !== 'mock' && snap.order.gatewayOrderId && !record.gatewayOrderId) {
      patch.gatewayOrderId = snap.order.gatewayOrderId;
    }
  } else {
    // Gateway has no such order (404) or this order belongs to another payment mode:
    // nothing to learn from the gateway, only the time-based expiry may apply.
    resolved = resolveStatus(from, { orderStatus: 'ACTIVE', payments: [] }, Number(record.total),
      { now, expiresAt: record.expiresAt });
  }

  const to = resolved.status;
  if (to !== from) patch.status = to;
  let flags = record.reviewFlag || '';
  if (resolved.reviewFlag) flags = addFlag(flags, resolved.reviewFlag);

  if (snap.known) {
    if (to === STATUSES.PAID && from !== STATUSES.PAID) {
      const ok = successPayment(snap.payments);
      const paidMs = ok ? timeOf(ok) : NaN;
      patch.paidAt = Number.isFinite(paidMs) ? new Date(paidMs).toISOString() : nowIso();
      if (ok && ok.paymentId) patch.paymentId = ok.paymentId;
      if (ok && ok.method) patch.paymentMethod = ok.method;
      if (from === STATUSES.EXPIRED) flags = addFlag(flags, 'PAID_AFTER_EXPIRY');
      if (/AMOUNT_MISMATCH/.test(flags)) flags = addFlag(flags, 'RESOLVED_PAID_WITH_MATCHING_AMOUNT');
    } else if (to !== STATUSES.PAID) {
      const latest = latestPayment(snap.payments);
      if (latest && latest.paymentId && latest.paymentId !== record.paymentId) {
        patch.paymentId = latest.paymentId;
        if (latest.method) patch.paymentMethod = latest.method;
      }
    }
  }
  if (flags !== (record.reviewFlag || '')) patch.reviewFlag = flags;
  return { patch, from, to };
}

async function fetchSnapshot(record) {
  const mode = cashfree.paymentMode();
  const recMode = record.paymentMode || 'cashfree';
  if (mode !== recMode) {
    log('info', 'sync_mode_mismatch', { orderId: record.orderId, orderMode: recMode, currentMode: mode });
    return { known: false, mode };
  }
  let order;
  try {
    order = await cashfree.getGatewayOrder(record.orderId);
  } catch (e) {
    if (e && e.notFound) {
      log('warn', 'gateway_order_not_found', { orderId: record.orderId });
      return { known: false, mode };
    }
    throw e;
  }
  let payments = [];
  const st = String(order.status || '').toUpperCase();
  if (st === 'ACTIVE' || st === 'PAID') {
    try {
      payments = await cashfree.getGatewayPayments(record.orderId);
    } catch (e) {
      // Without payments we can still confirm PAID (order status + amount); for ACTIVE we just learn nothing.
      log('warn', 'gateway_payments_unavailable', { orderId: record.orderId, status: e && e.upstreamStatus });
      payments = [];
    }
  }
  return { known: true, mode, order: { ...order, status: st }, payments };
}

// Serialise syncs for the same order within one warm instance (webhook + verify often arrive together).
const inflight = new Map();

async function syncOrder(orderId, { source = 'unknown' } = {}) {
  const prev = inflight.get(orderId) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => doSync(orderId, source));
  inflight.set(orderId, run);
  try {
    return await run;
  } finally {
    if (inflight.get(orderId) === run) inflight.delete(orderId);
  }
}

async function doSync(orderId, source) {
  const record = await sheets.getOrder(orderId);
  if (!record) return null;
  if (record.status === STATUSES.PAID) return record; // terminal

  const snap = await fetchSnapshot(record);
  const now = Date.now();
  const first = buildPatch(record, snap, now);
  if (Object.keys(first.patch).length === 0) return record;

  // Re-read just before writing: another request may have changed the row meanwhile.
  const fresh = await sheets.getOrder(orderId);
  if (!fresh) return null;
  if (fresh.status === STATUSES.PAID) return fresh; // never overwrite Paid
  const { patch, from, to } = buildPatch(fresh, snap, now);
  if (Object.keys(patch).length === 0) return fresh;

  const email = require('./email');
  const sendEmail = to === STATUSES.PAID && !fresh.emailSentAt && email.emailEnabled();
  if (sendEmail) patch.emailSentAt = nowIso(); // claimed in the same write that marks the order Paid

  const updated = await sheets.updateOrder(orderId, patch);
  // Storage refuses to change a row that another instance already marked Paid/emailed meanwhile:
  // only the request whose claim actually landed sends the receipt.
  const claimedEmail = sendEmail && updated && updated.emailSentAt === patch.emailSentAt;
  if (to !== from) {
    log('info', 'order_status_changed', { orderId, from, to, source, gatewayStatus: snap.known ? snap.order.status : 'unknown' });
  }
  if (patch.reviewFlag) log('warn', 'order_review_flag', { orderId, reviewFlag: patch.reviewFlag, source });

  if (claimedEmail) {
    try {
      const sent = await email.sendReceiptEmail(updated || { ...fresh, ...patch });
      log(sent ? 'info' : 'warn', sent ? 'receipt_email_sent' : 'receipt_email_failed', { orderId });
    } catch (_) {
      log('warn', 'receipt_email_failed', { orderId });
    }
  }
  return updated || { ...fresh, ...patch };
}

/* ------------------------------------------------------------ order views */

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? '******' + digits.slice(-4) : '';
}

function num(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return isFiniteNumber(n) ? n : 0;
}

function parseItems(items) {
  if (Array.isArray(items)) return items;
  if (typeof items === 'string' && items.trim()) {
    try { const v = JSON.parse(items); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  }
  return [];
}

function toOrderView(record) {
  const r = record || {};
  const status = MESSAGES[r.status] ? r.status : STATUSES.AWAITING;
  return {
    orderId: r.orderId,
    status,
    paymentMode: r.paymentMode || 'cashfree',
    createdAt: r.createdAt || null,
    paidAt: r.paidAt || null,
    expiresAt: r.expiresAt || null,
    customer: {
      name: r.name || '',
      roll: r.roll || '',
      email: r.email || '',
      phone: maskPhone(r.phone)
    },
    items: parseItems(r.items).map((l) => ({
      sku: l.sku,
      name: l.name,
      size: l.size || '',
      printing: Boolean(l.printing),
      printedName: l.printedName || '',
      quantity: num(l.quantity),
      unitPrice: num(l.unitPrice),
      printingCharge: num(l.printingCharge),
      lineTotal: num(l.lineTotal)
    })),
    subtotal: num(r.subtotal),
    printingTotal: num(r.printingTotal),
    total: num(r.total),
    currency: r.currency || 'INR',
    paymentMethod: r.paymentMethod || null,
    paymentId: r.paymentId || null,
    notes: r.notes || '',
    message: MESSAGES[status]
  };
}

/* ------------------------------------------------- shared handler helpers */

const NOT_FOUND_MESSAGE = 'Order not found.';

function notFound() {
  return new HttpError(404, 'not_found', NOT_FOUND_MESSAGE);
}

function storageUnavailable() {
  return new HttpError(503, 'storage_unavailable', 'Order storage is temporarily unavailable. Please try again in a moment.');
}

/**
 * Validates id/token formats, loads the order and checks the token.
 * Unknown order, malformed input and wrong token all throw the identical 404.
 */
async function loadOrderWithToken(orderId, token) {
  if (typeof orderId !== 'string' || typeof token !== 'string' ||
      !validateOrderId(orderId) || !validateTokenFormat(token)) {
    throw notFound();
  }
  let record;
  try {
    record = await sheets.getOrder(orderId); // null when missing
  } catch (e) {
    log('error', 'storage_read_failed', { op: 'getOrder', message: e && e.message });
    throw storageUnavailable();
  }
  // Always run verifyToken (constant-time) so timing does not reveal existence.
  const ok = verifyToken(token, record ? record.tokenHash : '0'.repeat(64));
  if (!record || !ok) throw notFound();
  return record;
}

/** syncOrder that never fails the caller: logs and returns the record unchanged on gateway/storage trouble. */
async function syncOrderSafe(record, source) {
  try {
    const updated = await syncOrder(record.orderId, { source });
    return updated || record;
  } catch (e) {
    log('warn', 'sync_failed', {
      orderId: record.orderId, source,
      code: e && e.code, upstreamStatus: e && e.upstreamStatus,
      message: isHttpError(e) ? undefined : e && e.message
    });
    return record;
  }
}

module.exports = {
  STATUSES,
  resolveStatus,
  syncOrder,
  toOrderView,
  // extras used by the payments handlers
  syncOrderSafe,
  loadOrderWithToken,
  customerIdFor,
  storageUnavailable,
  notFound,
  isHttpError,
  latestPayment,
  addFlag
};
