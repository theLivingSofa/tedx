'use strict';
/*
 * POST /api/verify-payment (CONTRACT 5.3). Owner: payments.
 * Re-checks the order with the gateway (server-to-server) and returns the order view.
 * Unknown order and wrong/missing token give the identical 404.
 */

const { sendJson, readJsonBody, applyCors, allowMethods, withErrorHandling } = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const { loadOrderWithToken, syncOrderSafe, toOrderView, notFound } = require('../lib/orders');

const VERIFY_THROTTLE_MS = 2000;
const lastVerify = new Map();

module.exports = withErrorHandling(async (req, res) => {
  if (!enforceRateLimit(req, res, 'verify-payment', { limit: 30, windowMs: 60000 })) return;
  if (applyCors(req, res, { methods: ['POST'] })) return;
  if (!allowMethods(req, res, ['POST'])) return;

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw notFound();

  const record = await loadOrderWithToken(body.orderId, body.token);
  // At most one gateway check per order every 2 s per instance (protects the merchant's API quota).
  const now = Date.now();
  const prev = lastVerify.get(record.orderId);
  let updated = record;
  if (prev === undefined || now - prev >= VERIFY_THROTTLE_MS) {
    lastVerify.delete(record.orderId);
    lastVerify.set(record.orderId, now);
    while (lastVerify.size > 5000) lastVerify.delete(lastVerify.keys().next().value);
    updated = await syncOrderSafe(record, 'verify');
  }
  sendJson(res, 200, toOrderView(updated));
});

module.exports._resetThrottle = () => lastVerify.clear();
