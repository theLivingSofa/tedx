'use strict';
/*
 * Plain-Node HTTP helpers shared by every /api handler (CONTRACT 5 + 6.1).
 * Owner: security-infra.
 *
 * Handlers only touch req/res through these helpers so they behave the same on Vercel,
 * under scripts/dev-server.js and in tests. Never read `req.body`: Vercel's @vercel/node
 * replays the original body into the request stream, so reading the stream always works.
 */

const net = require('node:net');

const DEFAULT_LIMIT = 32 * 1024;
const MAX_LOG_STRING = 200;
const MAX_LOG_DEPTH = 5;
const MAX_LOG_ENTRIES = 50;

/* ------------------------------------------------------------------ errors */

class HttpError extends Error {
  /**
   * @param {number} status HTTP status (400–599)
   * @param {string} code snake_case error code
   * @param {string} message user-safe message
   * @param {{fields?: object, retryAfter?: number}} [extra]
   */
  constructor(status, code, message, extra = {}) {
    super(typeof message === 'string' && message ? message : 'Request failed.');
    this.name = 'HttpError';
    this.isHttpError = true;
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    this.statusCode = this.status;
    this.code = typeof code === 'string' && code ? code : 'internal_error';
    const e = extra && typeof extra === 'object' ? extra : {};
    if (e.fields && typeof e.fields === 'object') this.fields = e.fields;
    if (e.retryAfter !== undefined) this.retryAfter = e.retryAfter;
  }
}

function isHttpError(err) {
  // Duck-typed so errors from a second copy of this module (tests reload /lib) still match.
  return Boolean(err && typeof err === 'object' && (err instanceof HttpError || err.isHttpError === true));
}

/* --------------------------------------------------------------- responses */

function hasHeaderKey(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/** JSON response; Content-Type JSON + Cache-Control no-store unless `headers` overrides them. */
function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded || res.headersSent) return;
  const extra = headers && typeof headers === 'object' ? headers : {};
  const payload = JSON.stringify(body === undefined ? null : body);
  res.statusCode = status;
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) res.setHeader(k, v);
  }
  if (!hasHeaderKey(extra, 'content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!hasHeaderKey(extra, 'cache-control')) res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', String(Buffer.byteLength(payload)));
  res.end(payload);
}

/** Writes `{ error: { code, message, fields?, retryAfter? } }` (CONTRACT 5). */
function sendError(res, status, code, message, extra = {}) {
  const e = extra && typeof extra === 'object' ? extra : {};
  const error = {
    code: typeof code === 'string' && code ? code : 'internal_error',
    message: typeof message === 'string' && message ? message : 'Something went wrong. Please try again.'
  };
  const headers = {};
  if (e.fields && typeof e.fields === 'object') error.fields = e.fields;
  if (e.retryAfter !== undefined && Number.isFinite(Number(e.retryAfter))) {
    const seconds = Math.max(1, Math.ceil(Number(e.retryAfter)));
    error.retryAfter = seconds;
    headers['Retry-After'] = String(seconds);
  }
  // The rest of an oversized body is never read; close the connection instead of draining it.
  if (status === 413) headers.Connection = 'close';
  sendJson(res, status, { error }, headers);
}

function safeEnd(res) {
  try {
    if (!res.writableEnded) res.end();
  } catch { /* ignore */ }
}

/* -------------------------------------------------------------------- body */

function stopReading(req) {
  try {
    if (typeof req.unpipe === 'function') req.unpipe();
    if (typeof req.pause === 'function') req.pause();
  } catch { /* ignore */ }
}

function tooLarge() {
  return new HttpError(413, 'payload_too_large', 'The request is too large.');
}

/**
 * Reads the request stream into a Buffer, refusing more than `limit` bytes.
 * @returns {Promise<Buffer>}
 */
function readRawBody(req, { limit = DEFAULT_LIMIT } = {}) {
  const max = Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_LIMIT;
  return new Promise((resolve, reject) => {
    if (!req || typeof req.on !== 'function') {
      reject(new TypeError('readRawBody: req is not a readable stream'));
      return;
    }
    const declared = req.headers && req.headers['content-length'];
    if (typeof declared === 'string' && /^\d+$/.test(declared.trim()) && Number(declared) > max) {
      stopReading(req);
      reject(tooLarge());
      return;
    }
    // Stream already fully consumed by someone else: nothing left to read (never hang).
    if (req.readableEnded) {
      resolve(Buffer.alloc(0));
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    function onData(chunk) {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > max) {
        stopReading(req);
        fail(tooLarge());
        return;
      }
      chunks.push(buf);
    }
    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    }
    function onError() {
      fail(new HttpError(400, 'invalid_json', 'The request body could not be read.'));
    }
    function onAborted() {
      fail(new HttpError(400, 'invalid_json', 'The request body could not be read.'));
    }
    function onClose() {
      // 'close' before 'end' means the client went away mid-body.
      if (!settled && !req.readableEnded) onAborted();
    }

    // Keep a permanent no-op listener so a late stream error after cleanup cannot crash the process.
    req.on('error', () => {});
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
    if (typeof req.resume === 'function') req.resume();
  });
}

/** Reads and parses a JSON body. Empty / non-JSON / wrong Content-Type -> 400 invalid_json. */
async function readJsonBody(req, { limit = DEFAULT_LIMIT } = {}) {
  const ct = req && req.headers ? req.headers['content-type'] : undefined;
  if (ct !== undefined && String(ct).trim() !== '') {
    const type = String(ct).split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      throw new HttpError(400, 'invalid_json', 'Send JSON (Content-Type: application/json).');
    }
  }
  const raw = await readRawBody(req, { limit });
  if (raw.length === 0) throw new HttpError(400, 'invalid_json', 'The request body is empty. Send JSON.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw); // also drops a leading BOM
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid UTF-8 JSON.');
  }
  if (text.trim() === '') throw new HttpError(400, 'invalid_json', 'The request body is empty. Send JSON.');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

/* ------------------------------------------------------------ request info */

function trustProxy() {
  return String(process.env.TRUST_PROXY || '').trim().toLowerCase() !== 'false';
}

function firstHeader(req, name) {
  const v = req && req.headers ? req.headers[name] : undefined;
  if (Array.isArray(v)) return v.length ? String(v[0]) : '';
  return typeof v === 'string' ? v : '';
}

function requestProto(req) {
  if (trustProxy()) {
    const p = firstHeader(req, 'x-forwarded-proto').split(',')[0].trim().toLowerCase();
    if (p === 'http' || p === 'https') return p;
  }
  const sock = req && (req.socket || req.connection);
  return sock && sock.encrypted ? 'https' : 'http';
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

function requestHost(req) {
  const h = firstHeader(req, 'host').trim().toLowerCase();
  return h && h.length <= 260 && HOST_RE.test(h) ? h : 'localhost';
}

/** `${proto}://${host}` of the request itself, normalised like a browser Origin (default ports dropped). */
function requestOrigin(req) {
  try {
    return new URL(`${requestProto(req)}://${requestHost(req)}`).origin;
  } catch {
    return 'http://localhost';
  }
}

function configuredSiteUrl() {
  const raw = String(process.env.SITE_URL || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return raw.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** SITE_URL (no trailing slash) or, in dev when it is unset, the request's own origin. */
function getSiteUrl(req) {
  return configuredSiteUrl() || requestOrigin(req);
}

function allowedOrigin(req) {
  const site = configuredSiteUrl();
  if (site) return new URL(site).origin;
  return requestOrigin(req);
}

/* ------------------------------------------------------------------- IP */

function normaliseIp(value) {
  if (typeof value !== 'string') return '';
  let ip = value.trim().toLowerCase();
  if (!ip || ip.length > 64) return '';
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end === -1) return '';
    ip = ip.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(':'));
  }
  const pct = ip.indexOf('%'); // IPv6 zone id
  if (pct !== -1) ip = ip.slice(0, pct);
  if (ip.startsWith('::ffff:') && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip.slice(7))) ip = ip.slice(7);
  return net.isIP(ip) ? ip : '';
}

/** Client IP: first x-forwarded-for entry, then x-real-ip (only when TRUST_PROXY !== 'false'), else socket. */
function getClientIp(req) {
  if (trustProxy()) {
    const xff = normaliseIp(firstHeader(req, 'x-forwarded-for').split(',')[0]);
    if (xff) return xff;
    const real = normaliseIp(firstHeader(req, 'x-real-ip'));
    if (real) return real;
  }
  const sock = req && (req.socket || req.connection);
  const addr = normaliseIp(sock && sock.remoteAddress ? String(sock.remoteAddress) : '');
  return addr || 'unknown';
}

/* ------------------------------------------------------------------- CORS */

function appendVary(res, value) {
  const current = res.getHeader ? res.getHeader('Vary') : undefined;
  if (!current) {
    res.setHeader('Vary', value);
    return;
  }
  const parts = String(current).split(',').map((s) => s.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase()) && !parts.includes('*')) res.setHeader('Vary', `${current}, ${value}`);
}

function methodList(methods) {
  const list = Array.isArray(methods) && methods.length ? methods.map((m) => String(m).toUpperCase()) : ['GET'];
  return Array.from(new Set(list));
}

/**
 * CORS for the single allowed origin (SITE_URL, or the request's own origin in dev). Never '*'.
 * Returns true when it fully handled the request (OPTIONS preflight, or 403 forbidden_origin).
 */
function applyCors(req, res, { methods } = {}) {
  const allowed = methodList(methods);
  appendVary(res, 'Origin');
  const origin = firstHeader(req, 'origin');
  const isOptions = String(req.method || '').toUpperCase() === 'OPTIONS';

  if (!origin) {
    // Same-origin navigation / server-to-server: no CORS headers needed.
    if (isOptions) {
      res.statusCode = 204;
      res.setHeader('Allow', [...allowed, 'OPTIONS'].join(', '));
      res.setHeader('Content-Length', '0');
      res.end();
      return true;
    }
    return false;
  }

  if (origin !== allowedOrigin(req)) {
    sendError(res, 403, 'forbidden_origin', 'Requests from this website are not allowed.');
    return true;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  if (isOptions) {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Methods', [...allowed, 'OPTIONS'].join(', '));
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Order-Token');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Content-Length', '0');
    res.end();
    return true;
  }
  return false;
}

/** true if req.method is allowed; otherwise sends 405 with an Allow header and returns false. */
function allowMethods(req, res, methods) {
  const allowed = methodList(methods);
  if (allowed.includes(String(req.method || '').toUpperCase())) return true;
  if (!res.headersSent) res.setHeader('Allow', allowed.join(', '));
  sendError(res, 405, 'method_not_allowed', 'This method is not allowed here.');
  return false;
}

/* ------------------------------------------------------------------ query */

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Plain object of query parameters (first value wins; prototype keys skipped). */
function getQuery(req) {
  const out = {};
  let params;
  try {
    params = new URL(String((req && req.url) || '/'), 'http://localhost').searchParams;
  } catch {
    return out;
  }
  for (const [k, v] of params) {
    if (UNSAFE_KEYS.has(k) || Object.prototype.hasOwnProperty.call(out, k)) continue;
    out[k] = v;
  }
  return out;
}

/* -------------------------------------------------------------------- log */

// Keys whose values are never logged (case-insensitive exact names, CONTRACT 6.1) …
const DROP_KEYS = new Set([
  'email', 'phone', 'name', 'roll', 'token', 'notes', 'printedname', 'authorization', 'secret', 'key',
  'customer', 'password', 'cookie', 'set-cookie', 'signature', 'body', 'rawbody', 'headers'
]);
// … plus anything that looks like a credential.
const DROP_KEY_RE = /secret|passw|private.?key|api.?key|token|authorization|cookie|signature/i;

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_IN_TEXT = /(?<![\d])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d])/g;

function cleanString(s) {
  let out = s.replace(EMAIL_IN_TEXT, '[email]').replace(PHONE_IN_TEXT, '[phone]');
  if (out.length > MAX_LOG_STRING) out = out.slice(0, MAX_LOG_STRING) + '…';
  return out;
}

function shouldDrop(key) {
  const k = String(key).toLowerCase();
  return DROP_KEYS.has(k) || DROP_KEY_RE.test(k);
}

function redact(value, depth, seen) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return cleanString(value);
  if (t === 'number') return Number.isFinite(value) ? value : String(value);
  if (t === 'boolean') return value;
  if (t === 'bigint') return value.toString();
  if (t === 'function' || t === 'symbol') return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (value instanceof Error) {
    const e = { name: cleanString(String(value.name || 'Error')), message: cleanString(String(value.message || '')) };
    if (value.code !== undefined && (typeof value.code === 'string' || typeof value.code === 'number')) {
      e.code = typeof value.code === 'string' ? cleanString(value.code) : value.code;
    }
    if (value.status !== undefined && Number.isFinite(value.status)) e.status = value.status;
    return e; // never the stack
  }
  if (t !== 'object') return undefined;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_LOG_DEPTH) return '[…]';
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.slice(0, MAX_LOG_ENTRIES).map((v) => {
      const r = redact(v, depth + 1, seen);
      return r === undefined ? null : r;
    });
    if (value.length > MAX_LOG_ENTRIES) out.push(`…${value.length - MAX_LOG_ENTRIES} more`);
  } else {
    out = {};
    let n = 0;
    for (const k of Object.keys(value)) {
      if (shouldDrop(k) || UNSAFE_KEYS.has(k)) continue;
      if (n++ >= MAX_LOG_ENTRIES) break;
      const r = redact(value[k], depth + 1, seen);
      if (r !== undefined) out[k] = r;
    }
  }
  seen.delete(value);
  return out;
}

/** One JSON line: { ts, level, event, ...fields } with PII/secret keys dropped recursively, no stacks. */
function log(level, event, fields = {}) {
  const lvl = level === 'warn' || level === 'error' ? level : 'info';
  const entry = { ts: new Date().toISOString(), level: lvl, event: cleanString(String(event || 'event')).slice(0, 100) };
  const safe = fields && typeof fields === 'object' && !Array.isArray(fields)
    ? redact(fields, 0, new Set())
    : (fields === undefined ? {} : { value: redact(fields, 0, new Set()) });
  for (const [k, v] of Object.entries(safe || {})) {
    if (k === 'ts' || k === 'level' || k === 'event') continue;
    entry[k] = v;
  }
  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ ts: entry.ts, level: lvl, event: entry.event });
  }
  if (lvl === 'error') console.error(line);
  else if (lvl === 'warn') console.warn(line);
  else console.log(line);
}

/* ---------------------------------------------------------- error wrapper */

function requestPath(req) {
  const url = String((req && req.url) || '');
  const q = url.indexOf('?');
  return (q === -1 ? url : url.slice(0, q)).slice(0, 100); // never the query string (tokens live there)
}

/**
 * Wraps an async (req, res) handler: HttpError -> sendError; anything else -> log + generic 500.
 */
function withErrorHandling(handler) {
  return async function handled(req, res) {
    try {
      return await handler(req, res);
    } catch (err) {
      if (isHttpError(err)) {
        if (err.status >= 500) {
          log('error', 'http_error', { status: err.status, code: err.code, path: requestPath(req) });
        }
        if (res.headersSent || res.writableEnded) {
          safeEnd(res);
          return undefined;
        }
        const extra = {};
        if (err.fields) extra.fields = err.fields;
        if (err.retryAfter !== undefined) extra.retryAfter = err.retryAfter;
        sendError(res, err.status, err.code, err.message, extra);
        return undefined;
      }
      log('error', 'unhandled_error', {
        message: err && err.message ? String(err.message) : String(err),
        errorName: err && err.name ? String(err.name) : undefined,
        method: req && req.method,
        path: requestPath(req)
      });
      if (res.headersSent || res.writableEnded) {
        safeEnd(res);
        return undefined;
      }
      sendError(res, 500, 'internal_error', 'Something went wrong on our side. Please try again.');
      return undefined;
    }
  };
}

module.exports = {
  HttpError,
  sendJson,
  sendError,
  readRawBody,
  readJsonBody,
  applyCors,
  allowMethods,
  getClientIp,
  getSiteUrl,
  getQuery,
  log,
  withErrorHandling
};
