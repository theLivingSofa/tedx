'use strict';
/*
 * POST /api/mock-pay (mock payment mode only; CONTRACT 5.7). Owner: payments.
 * Simulates the gateway: stores MOCK_PAID / MOCK_FAILED in the order's gatewayStatus column, then syncs.
 */

const { HttpError, sendJson, readJsonBody, applyCors, allowMethods, log, withErrorHandling } = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const sheets = require('../lib/sheets');
const { paymentMode } = require('../lib/cashfree');
const { STATUSES, loadOrderWithToken, syncOrderSafe, toOrderView, notFound, storageUnavailable, isHttpError } = require('../lib/orders');

module.exports = withErrorHandling(async (req, res) => {
  if (paymentMode() !== 'mock') throw notFound();
  if (!enforceRateLimit(req, res, 'mock-pay', { limit: 20, windowMs: 60000 })) return;
  if (applyCors(req, res, { methods: ['POST'] })) return;
  if (!allowMethods(req, res, ['POST'])) return;

  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw notFound();

  const record = await loadOrderWithToken(body.orderId, body.token);
  if (record.paymentMode !== 'mock') throw notFound();
  if (body.outcome !== 'success' && body.outcome !== 'failure') {
    throw new HttpError(400, 'validation_failed', 'Please check the highlighted fields.',
      { fields: { outcome: 'Choose success or failure.' } });
  }

  let current = record;
  if (record.status !== STATUSES.PAID) {
    const gatewayStatus = body.outcome === 'success' ? 'MOCK_PAID' : 'MOCK_FAILED';
    try {
      // Re-read right before writing so a concurrent Paid is never touched.
      const fresh = await sheets.getOrder(record.orderId);
      if (fresh && fresh.status !== STATUSES.PAID) {
        current = await sheets.updateOrder(record.orderId, { gatewayStatus }) || { ...fresh, gatewayStatus };
      } else if (fresh) {
        current = fresh;
      }
    } catch (e) {
      if (isHttpError(e)) throw e;
      log('error', 'storage_failed', { op: 'mockPay', message: e && e.message });
      throw storageUnavailable();
    }
    log('info', 'mock_payment', { orderId: record.orderId, outcome: body.outcome });
  }

  const updated = await syncOrderSafe(current, 'mock-pay');
  sendJson(res, 200, toOrderView(updated));
});
