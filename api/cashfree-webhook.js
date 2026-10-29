'use strict';
/*
 * POST /api/cashfree-webhook (CONTRACT 5.4). Owner: payments.
 * Verifies x-webhook-signature over the RAW body, then re-confirms the order with Get Order.
 * The payload's own status/amount are never trusted. Duplicate deliveries are harmless.
 */

const { HttpError, sendJson, readRawBody, allowMethods, log, withErrorHandling } = require('../lib/http');
const { paymentMode, verifyWebhookSignature, webhookTimestampMs } = require('../lib/cashfree');
const { validateOrderId } = require('../lib/validate');
const sheets = require('../lib/sheets');
const { syncOrder, notFound } = require('../lib/orders');

function header(req, name) {
  const headers = req.headers || {};
  let v = headers[name];
  if (v === undefined) {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    v = key === undefined ? undefined : headers[key];
  }
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' ? v.trim() : '';
}

function tolerance() {
  const n = parseInt(process.env.WEBHOOK_TOLERANCE_SECONDS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

module.exports = withErrorHandling(async (req, res) => {
  if (paymentMode() !== 'cashfree') throw notFound();
  if (!allowMethods(req, res, ['POST'])) return;

  const rawBody = await readRawBody(req, { limit: 65536 });
  const ok = verifyWebhookSignature({
    rawBody,
    signature: header(req, 'x-webhook-signature'),
    timestamp: header(req, 'x-webhook-timestamp'),
    secret: (process.env.CASHFREE_SECRET_KEY || '').trim(),
    toleranceSeconds: tolerance()
  });
  if (!ok) {
    // Diagnose without weakening the check: would the signature be valid if the clock were ignored?
    // A "stale_timestamp" reason on real Cashfree deliveries would point at clock skew or a unit change.
    const ts = header(req, 'x-webhook-timestamp');
    const sigOnly = /^\d{1,16}$/.test(ts) && verifyWebhookSignature({
      rawBody, signature: header(req, 'x-webhook-signature'), timestamp: ts,
      secret: (process.env.CASHFREE_SECRET_KEY || '').trim(), toleranceSeconds: tolerance(), now: Number(ts)
    });
    log('warn', 'webhook_invalid_signature', {
      reason: sigOnly ? 'stale_timestamp' : 'bad_signature',
      skewSeconds: /^\d{1,16}$/.test(ts) ? Math.round((Date.now() - webhookTimestampMs(ts)) / 1000) : null
    });
    throw new HttpError(401, 'invalid_signature', 'Invalid webhook signature.');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (_) {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  const type = payload && typeof payload.type === 'string' ? payload.type.slice(0, 64) : '';
  const order = payload && payload.data && payload.data.order;
  const orderId = order && typeof order.order_id === 'string' ? order.order_id : '';
  if (!orderId || !validateOrderId(orderId)) {
    log('info', 'webhook_ignored', { type, reason: 'no_order_id' });
    return sendJson(res, 200, { received: true });
  }

  let record;
  try {
    record = await sheets.getOrder(orderId);
  } catch (e) {
    log('error', 'storage_failed', { op: 'getOrder', orderId });
    // Non-2xx makes Cashfree retry the delivery later.
    throw new HttpError(503, 'storage_unavailable', 'Storage temporarily unavailable.');
  }
  if (!record) {
    log('info', 'webhook_ignored', { type, orderId, reason: 'unknown_order' });
    return sendJson(res, 200, { received: true });
  }

  try {
    await syncOrder(orderId, { source: 'webhook' });
  } catch (e) {
    log('warn', 'webhook_sync_failed', { orderId, type, code: e && e.code, upstreamStatus: e && e.upstreamStatus });
    throw new HttpError(503, 'sync_failed', 'Temporarily unable to process the notification.');
  }
  log('info', 'webhook_processed', { orderId, type });
  sendJson(res, 200, { received: true });
});
