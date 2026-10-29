'use strict';
/*
 * GET /api/order-status?id=<orderId>&token=<token> (CONTRACT 5.6). Owner: payments.
 * Refreshes from the gateway at most once per 15 s per order (in-memory, per instance).
 */

const { sendJson, applyCors, allowMethods, getQuery, withErrorHandling } = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const { STATUSES, loadOrderWithToken, syncOrderSafe, toOrderView } = require('../lib/orders');

const THROTTLE_MS = 15000;
const EXPIRED_RECHECK_MS = 3 * 24 * 60 * 60 * 1000; // late payments can still land on recently expired orders
const MAX_ENTRIES = 5000;
const lastCheck = new Map(); // orderId -> ms of last gateway refresh

function shouldRefresh(orderId, now) {
  const prev = lastCheck.get(orderId);
  if (prev !== undefined && now - prev <= THROTTLE_MS) return false;
  lastCheck.delete(orderId); // re-insert at the end so Map order ~ recency
  lastCheck.set(orderId, now);
  while (lastCheck.size > MAX_ENTRIES) lastCheck.delete(lastCheck.keys().next().value);
  return true;
}

module.exports = withErrorHandling(async (req, res) => {
  if (!enforceRateLimit(req, res, 'order-status', { limit: 60, windowMs: 60000 })) return;
  if (applyCors(req, res, { methods: ['GET'] })) return;
  if (!allowMethods(req, res, ['GET'])) return;

  const q = getQuery(req) || {};
  const id = typeof q.get === 'function' ? q.get('id') : q.id;
  // Prefer the X-Order-Token header (keeps the token out of URLs and request logs); ?token= still works.
  const headerToken = typeof req.headers['x-order-token'] === 'string' ? req.headers['x-order-token'] : '';
  const token = headerToken || (typeof q.get === 'function' ? q.get('token') : q.token);

  let record = await loadOrderWithToken(id, token);
  const now = Date.now();
  const recentlyExpired = record.status === STATUSES.EXPIRED && now - Date.parse(record.expiresAt) < EXPIRED_RECHECK_MS;
  if ((record.status === STATUSES.AWAITING || record.status === STATUSES.FAILED || recentlyExpired) &&
      shouldRefresh(record.orderId, now)) {
    record = await syncOrderSafe(record, 'status');
  }
  sendJson(res, 200, toOrderView(record));
});

module.exports._resetThrottle = () => lastCheck.clear();
