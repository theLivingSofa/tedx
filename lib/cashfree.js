'use strict';
/*
 * Cashfree Payment Gateway REST client (PG API, x-api-version 2026-01-01) + mock gateway.
 * Owner: payments (see docs/CONTRACT.md 6.7).
 *
 * Facts used here come from the official Node SDK cashfree-pg@6.0.6 (api.ts):
 *   - base URLs https://sandbox.cashfree.com/pg and https://api.cashfree.com/pg
 *   - headers x-client-id, x-client-secret, x-api-version, x-request-id, x-idempotency-key
 *   - POST /orders, GET /orders/{order_id}, GET /orders/{order_id}/payments
 *   - webhook signature = base64(HMAC-SHA256(secret, timestamp + rawBody))
 * Never log request bodies, secrets or customer data from this module.
 */

const crypto = require('node:crypto');
const { HttpError, log } = require('./http');

const DEFAULT_API_VERSION = '2026-01-01';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;
const GATEWAY_MESSAGE = 'The payment gateway is not responding right now. Please try again in a moment.';

/* ------------------------------------------------------------------ config */

function env(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

function hasKeys() {
  return Boolean(env('CASHFREE_APP_ID') && env('CASHFREE_SECRET_KEY'));
}

/**
 * 'cashfree' | 'mock' | 'unavailable' (CONTRACT 3):
 *  - PAYMENT_MODE=mock forces mock; PAYMENT_MODE=cashfree requires both keys (else 'unavailable');
 *  - auto (unset/other) = cashfree when both keys are set, else mock;
 *  - mock is refused ('unavailable') when VERCEL_ENV=production unless ALLOW_MOCK_IN_PRODUCTION=true,
 *    so /api/mock-pay can never mark orders paid on a production deployment by accident.
 */
function paymentMode() {
  const forced = env('PAYMENT_MODE').toLowerCase();
  let mode;
  if (forced === 'mock') mode = 'mock';
  else if (forced === 'cashfree') mode = hasKeys() ? 'cashfree' : 'unavailable';
  else mode = hasKeys() ? 'cashfree' : 'mock';
  if (mode === 'mock' && env('VERCEL_ENV').toLowerCase() === 'production' &&
      env('ALLOW_MOCK_IN_PRODUCTION').toLowerCase() !== 'true') {
    return 'unavailable';
  }
  // Simulated payments must never write "Paid" rows into a real Google Sheet (e.g. from a preview
  // deployment that inherited the Sheets credentials) unless the team explicitly opts in for a demo.
  if (mode === 'mock' && sheetsConfigured() && env('ALLOW_MOCK_WITH_SHEETS').toLowerCase() !== 'true') {
    return 'unavailable';
  }
  return mode;
}

function sheetsConfigured() {
  return !!(env('GOOGLE_SHEET_ID') && env('GOOGLE_SERVICE_ACCOUNT_EMAIL') && env('GOOGLE_PRIVATE_KEY'));
}

/** Flag stored on each new order so organisers can tell test payments from real ones in the sheet. */
function testPaymentFlag(mode) {
  if (mode === 'mock') return 'TEST_PAYMENT_MOCK';
  if (mode === 'cashfree' && environment() === 'sandbox') return 'TEST_PAYMENT_SANDBOX';
  return '';
}

function environment() {
  return env('CASHFREE_ENV').toLowerCase() === 'production' ? 'production' : 'sandbox';
}

function baseUrl() {
  return environment() === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
}

function apiVersion() {
  const v = env('CASHFREE_API_VERSION');
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DEFAULT_API_VERSION;
}

/* ------------------------------------------------------------- REST client */

function gatewayError(fields) {
  const err = new HttpError(502, 'gateway_error', GATEWAY_MESSAGE);
  Object.assign(err, fields);
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return 300 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200);
}

/**
 * One Cashfree call with timeout + limited retries.
 * Retries only on network errors / timeouts / 429 / 5xx; for POST only when an idempotency key is sent.
 * Throws HttpError(502,'gateway_error') carrying { upstreamStatus, cfCode, cfType, notFound }.
 */
async function cfRequest(method, path, { body, idempotencyKey, op } = {}) {
  const canRetry = method === 'GET' || Boolean(idempotencyKey);
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const requestId = crypto.randomUUID();
    const headers = {
      'x-client-id': env('CASHFREE_APP_ID'),
      'x-client-secret': env('CASHFREE_SECRET_KEY'),
      'x-api-version': apiVersion(),
      'x-request-id': requestId,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(baseUrl() + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      const timedOut = e && e.name === 'AbortError';
      log('warn', 'cashfree_network_error', { op, attempt, requestId, timedOut });
      lastErr = gatewayError({ upstreamStatus: 0 });
      if (canRetry && attempt < MAX_ATTEMPTS) { await sleep(backoffMs(attempt)); continue; }
      throw lastErr;
    }

    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return data;

    const cfCode = data && typeof data.code === 'string' ? data.code.slice(0, 80) : undefined;
    const cfType = data && typeof data.type === 'string' ? data.type.slice(0, 80) : undefined;
    log(res.status === 404 ? 'info' : 'warn', 'cashfree_http_error', {
      op, attempt, status: res.status, cfCode, cfType,
      requestId: res.headers.get('x-request-id') || requestId
    });
    lastErr = gatewayError({ upstreamStatus: res.status, cfCode, cfType, notFound: res.status === 404 });
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && canRetry && attempt < MAX_ATTEMPTS) { await sleep(backoffMs(attempt)); continue; }
    throw lastErr;
  }
  throw lastErr;
}

function toNumber(v) {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : NaN;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function paymentMethodOf(p) {
  const m = p && p.payment_method;
  if (m && typeof m === 'object') {
    const k = Object.keys(m).find((key) => m[key] != null);
    if (k) return k;
  }
  return p && typeof p.payment_group === 'string' ? p.payment_group : '';
}

/* ---------------------------------------------------------------- mock gateway */

function sheets() {
  return require('./sheets'); // lazy: avoids load-order coupling
}

async function mockStoredOrder(orderId) {
  const rec = await sheets().getOrder(orderId);
  if (!rec) throw gatewayError({ upstreamStatus: 404, notFound: true });
  return rec;
}

async function mockGetOrder(orderId) {
  const rec = await mockStoredOrder(orderId);
  const gs = String(rec.gatewayStatus || '');
  return {
    orderId,
    gatewayOrderId: rec.gatewayOrderId || 'mock_' + orderId,
    status: gs === 'MOCK_PAID' ? 'PAID' : 'ACTIVE',
    amount: toNumber(rec.total),
    currency: 'INR'
  };
}

async function mockGetPayments(orderId) {
  const rec = await mockStoredOrder(orderId);
  const gs = String(rec.gatewayStatus || '');
  const base = { amount: toNumber(rec.total), method: 'mock', time: rec.updatedAt || new Date().toISOString() };
  if (gs === 'MOCK_PAID') return [{ paymentId: 'mock_pay_' + orderId, status: 'SUCCESS', ...base }];
  if (gs === 'MOCK_FAILED') return [{ paymentId: 'mock_fail_' + orderId, status: 'FAILED', ...base }];
  return [];
}

/* ------------------------------------------------------------- public API */

/**
 * POST /orders. amount in rupees. customer = { id, name, email, phone }.
 * -> { gatewayOrderId, paymentSessionId, status, expiresAt }
 */
async function createGatewayOrder({ orderId, amount, customer = {}, returnUrl, notifyUrl, expiresAt, note }) {
  const mode = paymentMode();
  if (mode === 'mock') {
    return {
      gatewayOrderId: 'mock_' + orderId,
      paymentSessionId: 'mock_session_' + crypto.randomBytes(16).toString('hex'),
      status: 'ACTIVE',
      expiresAt
    };
  }
  if (mode !== 'cashfree') throw new HttpError(503, 'payments_unavailable', 'Online payments are not available right now.');

  const orderMeta = {};
  if (returnUrl) orderMeta.return_url = returnUrl;
  if (notifyUrl) orderMeta.notify_url = notifyUrl;
  const payload = {
    order_id: orderId,
    order_amount: round2(toNumber(amount)),
    order_currency: 'INR',
    customer_details: {
      customer_id: customer.id,
      customer_phone: customer.phone,
      ...(customer.email ? { customer_email: customer.email } : {}),
      ...(customer.name ? { customer_name: String(customer.name).slice(0, 100) } : {})
    },
    order_meta: orderMeta,
    order_tags: { source: 'merch-store' }
  };
  if (expiresAt) payload.order_expiry_time = expiresAt;
  if (note) payload.order_note = String(note).slice(0, 200);

  const data = await cfRequest('POST', '/orders', { body: payload, idempotencyKey: orderId, op: 'create_order' });
  if (!data || typeof data.payment_session_id !== 'string' || !data.payment_session_id) {
    log('warn', 'cashfree_bad_response', { op: 'create_order', orderId });
    throw gatewayError({ upstreamStatus: 200 });
  }
  return {
    gatewayOrderId: data.cf_order_id != null ? String(data.cf_order_id) : '',
    paymentSessionId: data.payment_session_id,
    status: typeof data.order_status === 'string' ? data.order_status : 'ACTIVE',
    expiresAt: data.order_expiry_time || expiresAt
  };
}

/** GET /orders/{order_id} -> { orderId, gatewayOrderId, status, amount, currency } */
async function getGatewayOrder(orderId) {
  const mode = paymentMode();
  if (mode === 'mock') return mockGetOrder(orderId);
  if (mode !== 'cashfree') throw gatewayError({ upstreamStatus: 0 });
  const data = await cfRequest('GET', '/orders/' + encodeURIComponent(orderId), { op: 'get_order' });
  return {
    orderId: data && data.order_id ? String(data.order_id) : orderId,
    gatewayOrderId: data && data.cf_order_id != null ? String(data.cf_order_id) : '',
    status: data && typeof data.order_status === 'string' ? data.order_status.toUpperCase() : '',
    amount: toNumber(data && data.order_amount),
    currency: data && typeof data.order_currency === 'string' ? data.order_currency : ''
  };
}

/** GET /orders/{order_id}/payments -> [{ paymentId, status, amount, method, time }] */
async function getGatewayPayments(orderId) {
  const mode = paymentMode();
  if (mode === 'mock') return mockGetPayments(orderId);
  if (mode !== 'cashfree') throw gatewayError({ upstreamStatus: 0 });
  const data = await cfRequest('GET', '/orders/' + encodeURIComponent(orderId) + '/payments', { op: 'get_payments' });
  const list = Array.isArray(data) ? data : [];
  return list.map((p) => ({
    paymentId: p && p.cf_payment_id != null ? String(p.cf_payment_id) : '',
    status: p && typeof p.payment_status === 'string' ? p.payment_status.toUpperCase() : '',
    amount: toNumber(p && p.payment_amount),
    method: paymentMethodOf(p),
    time: (p && (p.payment_completion_time || p.payment_time)) || ''
  }));
}

/**
 * Pure webhook signature check (CONTRACT 5.4; SDK PGVerifyWebhookSignature):
 *   expected = base64(HMAC_SHA256(secret, timestamp + rawBody)), constant-time compared.
 * timestamp is epoch milliseconds; |now - ts| must be <= toleranceSeconds.
 */
function verifyWebhookSignature({ rawBody, signature, timestamp, secret, toleranceSeconds = 300, now = Date.now() } = {}) {
  if (rawBody == null || (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody))) return false;
  if (typeof signature !== 'string' || !signature || signature.length > 512) return false;
  if (typeof secret !== 'string' || !secret) return false;
  const tsStr = typeof timestamp === 'number' ? String(timestamp) : timestamp;
  if (typeof tsStr !== 'string' || !/^\d{1,16}$/.test(tsStr)) return false;

  const tsMs = Number(tsStr); // epoch milliseconds (CONTRACT 5.4)
  const tol = Number(toleranceSeconds);
  const tolMs = (Number.isFinite(tol) && tol >= 0 ? tol : 300) * 1000;
  if (!Number.isFinite(Number(now)) || Math.abs(Number(now) - tsMs) > tolMs) return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(tsStr, 'utf8')
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8'))
    .digest('base64');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim(), 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a); // keep timing roughly uniform
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  testPaymentFlag,
  paymentMode,
  environment,
  baseUrl,
  createGatewayOrder,
  getGatewayOrder,
  getGatewayPayments,
  verifyWebhookSignature,
  apiVersion
};
