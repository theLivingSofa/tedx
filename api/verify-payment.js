'use strict';
/*
 * POST /api/verify-payment (CONTRACT 5.3). Owner: payments.
 * Re-checks the order with the gateway (server-to-server) and returns the order view.
 * Unknown order and wrong/missing token give the identical 404.
 */

const { sendJson, readJsonBody, applyCors, allowMethods, withErrorHandling } = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const { loadOrderWithToken, syncOrderSafe, toOrderView, notFound } = require('../lib/orders');

module.exports = withErrorHandling(async (req, res) => {
  if (!enforceRateLimit(req, res, 'verify-payment', { limit: 30, windowMs: 60000 })) return;
  if (applyCors(req, res, { methods: ['POST'] })) return;
  if (!allowMethods(req, res, ['POST'])) return;

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw notFound();

  const record = await loadOrderWithToken(body.orderId, body.token);
  const updated = await syncOrderSafe(record, 'verify');
  sendJson(res, 200, toOrderView(updated));
});
