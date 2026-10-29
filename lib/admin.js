'use strict';
/*
 * Organiser dashboard helpers: password check, signed session cookie, and the summary maths.
 *
 * Security model
 *  - One shared ADMIN_PASSWORD (Vercel secret). Unset = the admin area does not exist (404).
 *  - A successful login gets an HttpOnly, Secure, SameSite=Strict cookie holding `<expiry>.<HMAC>`.
 *    The HMAC key is derived from ADMIN_PASSWORD, so changing the password signs everyone out.
 *  - No customer data is ever logged; responses are no-store (sendJson default).
 */

const crypto = require('node:crypto');
const { safeEqual } = require('./tokens');

const COOKIE = '__Host-merch_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 12;
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const ONE_SIZE = 'One size';

function adminPassword() {
  const v = process.env.ADMIN_PASSWORD;
  return typeof v === 'string' && v.length >= MIN_PASSWORD_LENGTH ? v : '';
}

function adminEnabled() {
  return Boolean(adminPassword());
}

function sessionKey(password) {
  return crypto.createHash('sha256').update('tedx-merch-admin-session-v1:' + password, 'utf8').digest();
}

function sign(payload, password) {
  return crypto.createHmac('sha256', sessionKey(password)).update(payload, 'utf8').digest('base64url');
}

/** Constant-time password check (hash both sides so lengths never leak). */
function checkPassword(candidate, password = adminPassword()) {
  if (!password || typeof candidate !== 'string' || !candidate || candidate.length > 256) return false;
  const a = crypto.createHash('sha256').update(candidate, 'utf8').digest('hex');
  const b = crypto.createHash('sha256').update(password, 'utf8').digest('hex');
  return safeEqual(a, b);
}

function createSession({ now = Date.now(), password = adminPassword() } = {}) {
  const exp = String(now + SESSION_MS);
  return `${exp}.${sign(exp, password)}`;
}

function verifySession(value, { now = Date.now(), password = adminPassword() } = {}) {
  if (!password || typeof value !== 'string' || value.length > 200) return false;
  const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp <= now || exp > now + SESSION_MS + 60000) return false;
  return safeEqual(m[2], sign(m[1], password));
}

function readCookie(req, name = COOKIE) {
  const header = req && req.headers && req.headers.cookie;
  if (typeof header !== 'string') return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function isAuthenticated(req) {
  return verifySession(readCookie(req));
}

function sessionCookie(value) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
}

function clearedCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/* ------------------------------------------------------------------------------------------ summary */

function isTest(order) {
  return /TEST_PAYMENT/.test(String(order.reviewFlag || ''));
}

/** A Review Flag that is anything other than the routine test-payment flags. */
function needsReview(order) {
  const flags = String(order.reviewFlag || '').split('|').map((s) => s.trim()).filter(Boolean);
  return flags.some((f) => !/^TEST_PAYMENT_(SANDBOX|MOCK)$/.test(f));
}

function toNumber(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sizeRank(size) {
  const i = SIZE_ORDER.indexOf(size);
  return i === -1 ? SIZE_ORDER.length : i;
}

/**
 * orders: storage records; handover: Map orderId -> { handedOver, note }; catalogue: products (for order + names).
 * Returns everything the dashboard shows. Totals cover Paid orders only (test payments excluded unless asked).
 */
function summarise({ orders = [], handover = new Map(), catalogue = [], includeTest = false } = {}) {
  const counted = orders.filter((o) => o && o.orderId && (includeTest || !isTest(o)));
  const paid = counted.filter((o) => o.status === 'Paid');

  const bySku = new Map();
  for (const p of catalogue) bySku.set(p.sku, { sku: p.sku, name: p.name, sizes: {}, total: 0, printed: 0, revenue: 0 });
  const printedNames = [];
  let itemsSold = 0;
  let itemsPrinted = 0;

  for (const o of paid) {
    for (const it of Array.isArray(o.items) ? o.items : []) {
      const qty = Math.max(0, Math.floor(toNumber(it.quantity)));
      if (!qty || typeof it.sku !== 'string') continue;
      let row = bySku.get(it.sku);
      if (!row) { row = { sku: it.sku, name: String(it.name || it.sku), sizes: {}, total: 0, printed: 0, revenue: 0 }; bySku.set(it.sku, row); }
      const size = it.size ? String(it.size) : ONE_SIZE;
      row.sizes[size] = (row.sizes[size] || 0) + qty;
      row.total += qty;
      row.revenue += toNumber(it.lineTotal);
      itemsSold += qty;
      if (it.printing) {
        row.printed += qty;
        itemsPrinted += qty;
        printedNames.push({ orderId: o.orderId, sku: it.sku, product: row.name, size, printedName: String(it.printedName || ''), quantity: qty });
      }
    }
  }

  const products = [...bySku.values()].map((r) => ({ ...r, revenue: Math.round(r.revenue * 100) / 100 }));
  // Standard sizes first, then any unexpected size found in orders, then "One size".
  const extra = new Set();
  for (const r of products) for (const s of Object.keys(r.sizes)) if (sizeRank(s) === SIZE_ORDER.length && s !== ONE_SIZE) extra.add(s);
  const sizes = [...SIZE_ORDER, ...[...extra].sort(), ONE_SIZE];

  const handedOver = paid.filter((o) => handover.get(o.orderId) && handover.get(o.orderId).handedOver).length;
  const count = (status) => counted.filter((o) => o.status === status).length;
  const money = paid.reduce((sum, o) => sum + toNumber(o.total), 0);

  const list = counted
    .map((o) => ({
      orderId: o.orderId,
      createdAt: o.createdAt,
      status: o.status,
      name: o.name,
      roll: o.roll,
      email: o.email,
      phone: o.phone,
      items: o.itemsSummary,
      total: toNumber(o.total),
      paidAt: o.paidAt,
      paymentMethod: o.paymentMethod,
      reviewFlag: o.reviewFlag,
      test: isTest(o),
      needsReview: needsReview(o),
      handedOver: Boolean(handover.get(o.orderId) && handover.get(o.orderId).handedOver),
      handoverNote: (handover.get(o.orderId) && handover.get(o.orderId).note) || ''
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return {
    includeTest,
    metrics: {
      paidOrders: paid.length,
      moneyCollected: Math.round(money * 100) / 100,
      itemsSold,
      itemsPrinted,
      handedOver,
      toHandOver: paid.length - handedOver,
      awaiting: count('Awaiting Payment'),
      failedOrExpired: count('Failed') + count('Expired'),
      needsReview: counted.filter(needsReview).length
    },
    sizes,
    products,
    printedNames,
    orders: list
  };
}

module.exports = {
  COOKIE,
  SESSION_MS,
  MIN_PASSWORD_LENGTH,
  adminEnabled,
  checkPassword,
  createSession,
  verifySession,
  readCookie,
  isAuthenticated,
  sessionCookie,
  clearedCookie,
  isTest,
  needsReview,
  summarise
};
