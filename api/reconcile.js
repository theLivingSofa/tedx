'use strict';
/*
 * GET|POST /api/reconcile (CONTRACT 5.5). Owner: payments.
 * Vercel Cron calls this with "Authorization: Bearer <CRON_SECRET>". Server-to-server: no CORS.
 */

const { HttpError, sendJson, allowMethods, log, withErrorHandling } = require('../lib/http');
const { safeEqual } = require('../lib/tokens');
const sheets = require('../lib/sheets');
const { STATUSES, syncOrder, storageUnavailable, isHttpError } = require('../lib/orders');

const MAX_PER_RUN = 25;
const EXPIRED_PER_RUN = 10;
const EXPIRED_RECHECK_MS = 3 * 24 * 60 * 60 * 1000; // re-check Expired orders for 3 days
const TIME_BUDGET_MS = 45000; // function maxDuration is 60 s

function minAgeMinutes() {
  const n = parseInt(process.env.RECONCILE_MIN_AGE_MINUTES || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

function bearer(req) {
  const h = req.headers && req.headers.authorization;
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(v.trim());
  return m ? m[1].trim() : '';
}

module.exports = withErrorHandling(async (req, res) => {
  if (!allowMethods(req, res, ['GET', 'POST'])) return;

  const secret = typeof process.env.CRON_SECRET === 'string' ? process.env.CRON_SECRET.trim() : '';
  if (!secret) throw new HttpError(503, 'not_configured', 'Reconciliation is not configured.');
  if (!safeEqual(bearer(req), secret)) throw new HttpError(401, 'unauthorized', 'Unauthorized.');

  const started = Date.now();
  let orders;
  try {
    const olderThan = new Date(started - minAgeMinutes() * 60000);
    orders = await sheets.listOrders({ statuses: [STATUSES.AWAITING, STATUSES.FAILED], olderThan, limit: MAX_PER_RUN });
    // A payment that was in progress when the order expired can still succeed at the gateway: keep
    // re-checking recently expired orders for a few days (newest first) so they turn Paid on their own.
    const expired = await sheets.listOrders({ statuses: [STATUSES.EXPIRED], olderThan, limit: 5000 });
    const recent = (expired || [])
      .filter((o) => started - Date.parse(o.expiresAt) < EXPIRED_RECHECK_MS)
      .slice(-EXPIRED_PER_RUN)
      .reverse();
    orders = (orders || []).slice(0, MAX_PER_RUN - recent.length).concat(recent);
  } catch (e) {
    if (isHttpError(e)) throw e;
    log('error', 'storage_failed', { op: 'listOrders', message: e && e.message });
    throw storageUnavailable();
  }

  const changed = [];
  let errors = 0;
  let checked = 0;
  for (const rec of (orders || []).slice(0, MAX_PER_RUN)) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    checked++;
    try {
      const updated = await syncOrder(rec.orderId, { source: 'reconcile' });
      if (updated && updated.status !== rec.status) {
        changed.push({ orderId: rec.orderId, from: rec.status, to: updated.status });
      }
    } catch (e) {
      errors++;
      log('warn', 'reconcile_sync_failed', { orderId: rec.orderId, code: e && e.code, upstreamStatus: e && e.upstreamStatus });
    }
  }

  log('info', 'reconcile_done', { checked, changed: changed.length, errors });
  sendJson(res, 200, { checked, changed, errors });
});
