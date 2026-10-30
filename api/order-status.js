'use strict';
/*
 * GET /api/order-status?id=<orderId>&token=<token> (CONTRACT 5.6). Owner: payments.
 * Refreshes from the gateway at most once per 15 s per order (in-memory, per instance).
 *
 * Every response adds `canResume`: true while an unpaid Cashfree order is still inside its payment window, so the
 * order page can offer "Complete payment".
 * GET …&resume=1 re-confirms the order with Cashfree first and, only if it is still unpaid and open, adds
 * `resume: { paymentSessionId, environment }` so the page can reopen checkout for the SAME order. A paid,
 * expired, demo or soon-to-expire order never gets a session.
 */

const { HttpError, sendJson, applyCors, allowMethods, getQuery, log, withErrorHandling } = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const { STATUSES, loadOrderWithToken, syncOrderSafe, toOrderView } = require('../lib/orders');
const cashfree = require('../lib/cashfree');

const THROTTLE_MS = 15000;
const EXPIRED_RECHECK_MS = 3 * 24 * 60 * 60 * 1000; // late payments can still land on recently expired orders
const MAX_ENTRIES = 5000;
const RESUME_MIN_LEFT_MS = 60 * 1000; // don't reopen checkout with less than a minute left
const lastCheck = new Map(); // orderId -> ms of last gateway refresh

function shouldRefresh(orderId, now) {
  const prev = lastCheck.get(orderId);
  if (prev !== undefined && now - prev <= THROTTLE_MS) return false;
  lastCheck.delete(orderId); // re-insert at the end so Map order ~ recency
  lastCheck.set(orderId, now);
  while (lastCheck.size > MAX_ENTRIES) lastCheck.delete(lastCheck.keys().next().value);
  return true;
}

/** Unpaid Cashfree order with more than a minute left in its payment window. */
function canResume(record, now) {
  if (record.status !== STATUSES.AWAITING && record.status !== STATUSES.FAILED) return false;
  if ((record.paymentMode || 'cashfree') !== 'cashfree' || cashfree.paymentMode() !== 'cashfree') return false;
  const exp = Date.parse(record.expiresAt);
  return Number.isFinite(exp) && exp - now > RESUME_MIN_LEFT_MS;
}

module.exports = withErrorHandling(async (req, res) => {
  if (!enforceRateLimit(req, res, 'order-status', { limit: 60, windowMs: 60000 })) return;
  if (applyCors(req, res, { methods: ['GET'] })) return;
  if (!allowMethods(req, res, ['GET'])) return;

  const q = getQuery(req) || {};
  const read = (k) => (typeof q.get === 'function' ? q.get(k) : q[k]);
  const id = read('id');
  // Prefer the X-Order-Token header (keeps the token out of URLs and request logs); ?token= still works.
  const headerToken = typeof req.headers['x-order-token'] === 'string' ? req.headers['x-order-token'] : '';
  const token = headerToken || read('token');
  const wantResume = read('resume') === '1';

  let record = await loadOrderWithToken(id, token);
  const now = Date.now();

  if (wantResume) {
    if (!enforceRateLimit(req, res, 'order-resume', { limit: 10, windowMs: 60000 })) return;
    // Always re-confirm first: a payment may have landed since the page last looked.
    if (record.status !== STATUSES.PAID) record = await syncOrderSafe(record, 'resume');
    const view = toOrderView(record);
    if (!canResume(record, Date.now())) {
      sendJson(res, 200, { ...view, canResume: false });
      return;
    }
    let gw;
    try {
      gw = await cashfree.getGatewayOrder(record.orderId);
    } catch (e) {
      log('warn', 'resume_gateway_error', { orderId: record.orderId, upstreamStatus: e && e.upstreamStatus });
      throw new HttpError(502, 'gateway_error', 'The payment gateway is not responding right now. Please try again in a moment.');
    }
    if (gw.status !== 'ACTIVE' || !gw.paymentSessionId) {
      // Paid, expired or terminated at Cashfree: never hand out a session; the next status check will catch up.
      sendJson(res, 200, { ...view, canResume: false });
      return;
    }
    log('info', 'payment_resumed', { orderId: record.orderId });
    sendJson(res, 200, {
      ...view,
      canResume: true,
      resume: { paymentSessionId: gw.paymentSessionId, environment: cashfree.environment() }
    });
    return;
  }

  const recentlyExpired = record.status === STATUSES.EXPIRED && now - Date.parse(record.expiresAt) < EXPIRED_RECHECK_MS;
  if ((record.status === STATUSES.AWAITING || record.status === STATUSES.FAILED || recentlyExpired) &&
      shouldRefresh(record.orderId, now)) {
    record = await syncOrderSafe(record, 'status');
  }
  sendJson(res, 200, { ...toOrderView(record), canResume: canResume(record, Date.now()) });
});

module.exports._resetThrottle = () => lastCheck.clear();
