'use strict';
/*
 * GET /api/admin-summary[?includeTest=1] -> dashboard data (metrics, per-product sizes, printed names, orders).
 * Needs the admin session cookie. Contains customer details: never cache, never log.
 */

const { HttpError, sendJson, applyCors, allowMethods, getQuery, withErrorHandling } = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const sheets = require('../lib/sheets');
const admin = require('../lib/admin');

module.exports = withErrorHandling(async (req, res) => {
  if (!admin.adminEnabled()) throw new HttpError(404, 'not_found', 'Not found.');
  if (applyCors(req, res, { methods: ['GET'] })) return;
  if (!allowMethods(req, res, ['GET'])) return;
  if (!enforceRateLimit(req, res, 'admin-summary', { limit: 60, windowMs: 60000 })) return;
  if (!admin.isAuthenticated(req)) throw new HttpError(401, 'unauthorized', 'Please sign in.');

  const q = getQuery(req) || {};
  const raw = typeof q.get === 'function' ? q.get('includeTest') : q.includeTest;
  const includeTest = raw === '1' || raw === 'true';

  const [orders, catalogue, handover] = await Promise.all([
    sheets.listOrders({ limit: 100000 }),
    sheets.getCatalogue().then((c) => (c && Array.isArray(c.products) ? c.products : Array.isArray(c) ? c : [])),
    sheets.getHandover().catch((err) => {
      if (err && err.code === 'handover_unavailable') return null;
      throw err;
    })
  ]);

  const summary = admin.summarise({ orders, catalogue, handover: handover || new Map(), includeTest });
  summary.handoverAvailable = handover !== null;
  summary.storage = sheets.storageMode();
  summary.generatedAt = new Date().toISOString();
  sendJson(res, 200, summary);
});
