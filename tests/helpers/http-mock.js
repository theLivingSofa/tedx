'use strict';
/*
 * Test helpers: fake Node req/res objects, fresh module loading and env isolation.
 * Handlers are called exactly like Vercel / scripts/dev-server.js would call them:
 * handler(req, res) with a readable request stream and a plain http.ServerResponse-like object.
 * No Vercel helpers (res.status/res.json/req.body) are provided on purpose — CONTRACT 1 forbids them.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB_DIR = path.join(ROOT, 'lib') + path.sep;
const API_DIR = path.join(ROOT, 'api') + path.sep;

const SITE_URL = 'http://localhost:3000';

/** Env vars that would change behaviour and must not leak in from the developer's shell. */
const MANAGED_ENV_PREFIXES = ['GOOGLE_', 'CASHFREE_', 'RESEND_', 'VERCEL'];
const MANAGED_ENV_KEYS = [
  'SITE_URL', 'PAYMENT_MODE', 'ALLOW_MOCK_IN_PRODUCTION', 'PRINTING_CHARGE', 'ORDER_EXPIRY_MINUTES',
  'RECONCILE_MIN_AGE_MINUTES', 'CRON_SECRET', 'WEBHOOK_TOLERANCE_SECONDS', 'EMAIL_FROM', 'LOCAL_DATA_DIR',
  'TRUST_PROXY', 'STORE_OPEN', 'MAX_QUANTITY_PER_SKU'
];

const ORIGINAL_ENV = { ...process.env };

function isManaged(key) {
  return MANAGED_ENV_KEYS.includes(key) || MANAGED_ENV_PREFIXES.some((p) => key.startsWith(p));
}

/** Remove every managed env var, then apply `env` (values of undefined are skipped). */
function setEnv(env = {}) {
  for (const key of Object.keys(process.env)) {
    if (isManaged(key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = String(value);
  }
}

/** Restore the environment the test process started with. */
function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) process.env[key] = value;
}

/** Drop every cached module under /lib and /api so module-level state (caches, rate limits) starts fresh. */
function freshModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(LIB_DIR) || key.startsWith(API_DIR)) delete require.cache[key];
  }
}

function requireLib(name) {
  return require(path.join(ROOT, 'lib', name + '.js'));
}

/** Load an api/<name>.js handler. Accepts `module.exports = fn` or `{ default: fn }` / `{ handler: fn }`. */
function loadHandler(name) {
  const mod = require(path.join(ROOT, 'api', name + '.js'));
  const handler = typeof mod === 'function' ? mod : (mod && (mod.default || mod.handler));
  if (typeof handler !== 'function') throw new Error(`api/${name}.js does not export a handler function`);
  return handler;
}

/** Fresh temp directory for LOCAL_DATA_DIR. */
function makeTempDir(prefix = 'tedx-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

let ipCounter = 0;
/** A unique client IP per call, so rate limits from one test never affect another. */
function uniqueIp() {
  ipCounter += 1;
  const n = ipCounter + process.pid * 1000;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

/**
 * Build a fake IncomingMessage.
 * @param {object} o
 * @param {string} [o.method='GET']
 * @param {string} [o.url='/']
 * @param {object} [o.headers]
 * @param {string|Buffer|object} [o.body] objects are JSON-encoded
 * @param {string} [o.ip] sets x-forwarded-for
 */
function createReq({ method = 'GET', url = '/', headers = {}, body, ip } = {}) {
  let buf = null;
  if (body !== undefined && body !== null) {
    if (Buffer.isBuffer(body)) buf = body;
    else if (typeof body === 'string') buf = Buffer.from(body, 'utf8');
    else buf = Buffer.from(JSON.stringify(body), 'utf8');
  }
  const lower = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) lower[k.toLowerCase()] = v;
  }
  if (!('host' in lower)) lower.host = 'localhost:3000';
  if (!('x-forwarded-proto' in lower)) lower['x-forwarded-proto'] = 'http';
  if (!('x-forwarded-for' in lower)) lower['x-forwarded-for'] = ip || uniqueIp();
  if (buf && !('content-type' in lower)) lower['content-type'] = 'application/json';
  if (buf && !('content-length' in lower)) lower['content-length'] = String(buf.length);

  let pushed = false;
  const req = new Readable({
    read() {
      if (pushed) return;
      pushed = true;
      if (buf && buf.length) this.push(buf);
      this.push(null);
    }
  });
  req.method = method;
  req.url = url;
  req.headers = lower;
  req.rawHeaders = Object.entries(lower).flat();
  req.httpVersion = '1.1';
  req.socket = { remoteAddress: '127.0.0.1', encrypted: false };
  req.connection = req.socket;
  return req;
}

/** Fake ServerResponse capturing status, headers and body. */
class MockRes extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.statusMessage = '';
    this._headers = {};
    this._chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
    this.finished = false;
    this._ended = new Promise((resolve) => { this._resolveEnded = resolve; });
  }
  setHeader(name, value) { this._headers[String(name).toLowerCase()] = value; return this; }
  getHeader(name) { return this._headers[String(name).toLowerCase()]; }
  getHeaders() { return { ...this._headers }; }
  getHeaderNames() { return Object.keys(this._headers); }
  hasHeader(name) { return String(name).toLowerCase() in this._headers; }
  removeHeader(name) { delete this._headers[String(name).toLowerCase()]; }
  writeHead(status, reasonOrHeaders, maybeHeaders) {
    this.statusCode = status;
    const hdrs = typeof reasonOrHeaders === 'object' && reasonOrHeaders !== null ? reasonOrHeaders : maybeHeaders;
    if (typeof reasonOrHeaders === 'string') this.statusMessage = reasonOrHeaders;
    if (hdrs) for (const [k, v] of Object.entries(hdrs)) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }
  write(chunk, encoding, cb) {
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    if (chunk !== undefined && chunk !== null) {
      this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || 'utf8'));
    }
    this.headersSent = true;
    if (cb) cb();
    return true;
  }
  end(chunk, encoding, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    if (this.writableEnded) return this;
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    this.headersSent = true;
    this.writableEnded = true;
    this.finished = true;
    this.emit('finish');
    this._resolveEnded();
    if (cb) cb();
    return this;
  }
  get bodyText() { return Buffer.concat(this._chunks).toString('utf8'); }
}

function createRes() {
  return new MockRes();
}

/**
 * Call a handler and wait for the response to finish.
 * @returns {Promise<{status:number, headers:object, body:any, text:string}>}
 */
async function invoke(handler, reqOptions = {}, { timeoutMs = 4000 } = {}) {
  const req = createReq(reqOptions);
  const res = createRes();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`handler did not end the response within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const ret = handler(req, res);
    await Promise.race([Promise.resolve(ret).then(() => res._ended), timeout]);
  } finally {
    clearTimeout(timer);
  }
  const text = res.bodyText;
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  return { status: res.statusCode, headers: res.getHeaders(), body, text };
}

/** Convenience: JSON POST. */
function postJson(handler, url, body, extra = {}) {
  return invoke(handler, { method: 'POST', url, body, ...extra });
}

module.exports = {
  ROOT,
  SITE_URL,
  setEnv,
  restoreEnv,
  freshModules,
  requireLib,
  loadHandler,
  makeTempDir,
  removeDir,
  uniqueIp,
  createReq,
  createRes,
  invoke,
  postJson
};
