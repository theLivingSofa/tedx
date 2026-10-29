'use strict';
/*
 * In-memory fixed-window rate limiter (CONTRACT 6.5). Owner: security-infra.
 *
 * LIMITATIONS (by design, no external store): counters live in this function instance's memory.
 * They reset on every cold start / redeploy, and each concurrently running Vercel instance keeps
 * its own counters — so this is a best-effort brake against bursts from one client, not a hard
 * global quota. The map is bounded (MAX_KEYS) so a flood of distinct IPs cannot exhaust memory.
 */

const { getClientIp, sendError, log } = require('./http');

const MAX_KEYS = 10000;

/** key -> { start: windowStartMs, count, windowMs } ; Map keeps insertion order for eviction. */
const buckets = new Map();

function evictIfFull(now) {
  if (buckets.size < MAX_KEYS) return;
  // Entries are kept in least-recently-used order: drop expired ones from the front, stop at the
  // first live one (keeps this O(1) amortised), then evict the least recently used if still full.
  for (const [k, b] of buckets) {
    if (now - b.start < b.windowMs) break;
    buckets.delete(k);
  }
  while (buckets.size >= MAX_KEYS) {
    const oldest = buckets.keys().next().value;
    buckets.delete(oldest);
  }
}

/**
 * Counts one hit for `key`.
 * @returns {{ok:boolean, remaining:number, retryAfter:number}} retryAfter in whole seconds (0 when ok)
 */
function rateLimit(key, { limit, windowMs } = {}) {
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const win = Number.isFinite(windowMs) && windowMs >= 1 ? Math.floor(windowMs) : 60000;
  const k = String(key);
  const now = Date.now();

  let b = buckets.get(k);
  if (!b || now - b.start >= b.windowMs || now < b.start) {
    if (b) buckets.delete(k);
    evictIfFull(now);
    b = { start: now, count: 0, windowMs: win };
  } else {
    buckets.delete(k); // re-insert below so recently used keys are evicted last
  }
  buckets.set(k, b);

  if (b.count >= max) {
    const retryAfter = Math.max(1, Math.ceil((b.start + b.windowMs - now) / 1000));
    return { ok: false, remaining: 0, retryAfter };
  }
  b.count += 1;
  return { ok: true, remaining: max - b.count, retryAfter: 0 };
}

/**
 * Applies `rateLimit` to `${name}:${clientIp}`. On limit: 429 rate_limited + Retry-After, returns false.
 */
function enforceRateLimit(req, res, name, { limit, windowMs } = {}) {
  const r = rateLimit(`${name}:${getClientIp(req)}`, { limit, windowMs });
  if (r.ok) return true;
  log('warn', 'rate_limited', { limiter: String(name) });
  sendError(res, 429, 'rate_limited', 'Too many requests. Please wait a moment and try again.', {
    retryAfter: r.retryAfter
  });
  return false;
}

/** Test helper: forget all counters. */
function _resetForTests() {
  buckets.clear();
}

module.exports = {
  rateLimit,
  enforceRateLimit,
  _resetForTests
};
