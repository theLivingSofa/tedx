'use strict';
/* POST /api/admin-handover { orderId, handedOver, note? } -> { orderId, handedOver, note }. Needs the admin session. */

const { HttpError, sendJson, readJsonBody, applyCors, allowMethods, withErrorHandling } = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const sheets = require('../lib/sheets');
const admin = require('../lib/admin');

const ORDER_ID_RE = /^[A-Z0-9]{1,8}-\d{8}-[A-Z0-9]{6}$/;

module.exports = withErrorHandling(async (req, res) => {
  if (!admin.adminEnabled()) throw new HttpError(404, 'not_found', 'Not found.');
  if (applyCors(req, res, { methods: ['POST'] })) return;
  if (!allowMethods(req, res, ['POST'])) return;
  if (!enforceRateLimit(req, res, 'admin-handover', { limit: 120, windowMs: 60000 })) return;
  if (!admin.isAuthenticated(req)) throw new HttpError(401, 'unauthorized', 'Please sign in.');

  const body = await readJsonBody(req, { limit: 2048 });
  const orderId = body && typeof body.orderId === 'string' ? body.orderId.trim() : '';
  if (!ORDER_ID_RE.test(orderId) || typeof body.handedOver !== 'boolean' ||
      (body.note !== undefined && typeof body.note !== 'string')) {
    throw new HttpError(400, 'invalid_request', 'Send orderId, handedOver (true/false) and an optional note.');
  }
  const saved = await sheets.setHandover(orderId, { handedOver: body.handedOver, note: body.note });
  sendJson(res, 200, { orderId, ...saved });
});
