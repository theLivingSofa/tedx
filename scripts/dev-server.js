#!/usr/bin/env node
'use strict';
/*
 * Local development server emulating the Vercel deployment (CONTRACT 9). No dependencies.
 * Owner: security-infra.   Usage: npm run dev   (PORT, default 3000; HOST, default 127.0.0.1)
 *
 *  - loads .env.local then .env (existing environment variables always win)
 *  - serves ONLY files inside public/, with Vercel-style clean URLs (/order -> order.html,
 *    /order.html -> 308 /order), and rejects traversal / encoded slashes / NUL bytes / dotfiles
 *  - routes /api/<name> to api/<name>.js and calls handler(req, res) with plain Node objects
 *    (no req.body / res.json helpers, exactly like the contract requires)
 *  - applies the "headers" rules from vercel.json; over plain http it drops HSTS and the CSP
 *    `upgrade-insecure-requests` directive, which would otherwise break http://localhost
 *  - overwrites x-forwarded-for / x-real-ip / x-forwarded-proto like Vercel's edge does
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const API_DIR = path.join(ROOT, 'api');

/* --------------------------------------------------------------- .env */

function unescapeDouble(s) {
  return s.replace(/\\([nrt"\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }[c]));
}

/** Tiny .env parser: KEY=VALUE, `export ` prefix, '…' literal, "…" with \n escapes (may span lines), # comments. */
function parseEnv(text) {
  const out = {};
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(lines[i]);
    if (!m) continue; // blank line, comment or junk
    const key = m[1];
    let rest = m[2];
    let value;
    if (rest.startsWith('"')) {
      let body = rest.slice(1);
      let end = findClosingQuote(body);
      while (end === -1 && i + 1 < lines.length) {
        body += '\n' + lines[++i];
        end = findClosingQuote(body);
      }
      value = unescapeDouble(end === -1 ? body : body.slice(0, end));
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      value = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else {
      const hash = rest.search(/\s#/);
      if (hash !== -1) rest = rest.slice(0, hash);
      value = rest.trim();
    }
    out[key] = value;
  }
  return out;
}

function findClosingQuote(s) {
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '"') return j;
  }
  return -1;
}

function loadEnvFiles() {
  const loaded = [];
  for (const name of ['.env.local', '.env']) {
    const file = path.join(ROOT, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const vars = parseEnv(text);
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in process.env)) process.env[k] = v;
    }
    loaded.push(name);
  }
  return loaded;
}

/* ------------------------------------------------------- vercel.json headers */

/** Converts the small subset of path-to-regexp used in vercel.json sources: literals, (regex), :name, :name(regex). */
function sourceToRegExp(source) {
  let out = '^';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === ':' && /[A-Za-z_]/.test(source[i + 1] || '')) {
      const m = /^:([A-Za-z0-9_]+)/.exec(source.slice(i));
      i += m[0].length;
      if (source[i] !== '(') out += '([^/]+?)';
      continue;
    }
    if (c === '(') {
      let depth = 0;
      let j = i;
      for (; j < source.length; j++) {
        if (source[j] === '\\') { j++; continue; }
        if (source[j] === '(') depth++;
        else if (source[j] === ')' && --depth === 0) break;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    i++;
  }
  return new RegExp(`${out}$`);
}

function loadHeaderRules() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    return (Array.isArray(cfg.headers) ? cfg.headers : []).map((rule) => ({
      re: sourceToRegExp(String(rule.source)),
      headers: Array.isArray(rule.headers) ? rule.headers : []
    }));
  } catch (err) {
    console.warn(`[dev] could not read vercel.json headers: ${err.message}`);
    return [];
  }
}

const HEADER_RULES = loadHeaderRules();

function applyVercelHeaders(res, pathname) {
  for (const rule of HEADER_RULES) {
    if (!rule.re.test(pathname)) continue;
    for (const { key, value } of rule.headers) {
      if (!key) continue;
      const k = String(key);
      let v = String(value);
      // Plain-http dev server: HSTS is meaningless and upgrade-insecure-requests would rewrite
      // http://localhost sub-resources to https and break the page.
      if (k.toLowerCase() === 'strict-transport-security') continue;
      if (k.toLowerCase() === 'content-security-policy') {
        v = v.split(';').map((d) => d.trim()).filter((d) => d && d !== 'upgrade-insecure-requests').join('; ');
      }
      res.setHeader(k, v);
    }
  }
}

/* ------------------------------------------------------------- static */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf'
};

let publicReal = PUBLIC_DIR;
try { publicReal = fs.realpathSync(PUBLIC_DIR); } catch { /* public/ missing: everything 404s */ }

function isInside(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

/** Absolute path of a regular file inside public/ for this URL path, or null. */
function resolvePublicFile(relPath) {
  const abs = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize('/' + relPath));
  if (!isInside(abs, PUBLIC_DIR)) return null;
  let real;
  try {
    real = fs.realpathSync(abs); // symlinks must not lead outside public/
  } catch {
    return null;
  }
  if (!isInside(real, publicReal)) return null;
  try {
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  if (res.headersSent) { res.end(); return; }
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(Buffer.byteLength(text)));
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

function sendFile(req, res, file, status = 200) {
  const stat = fs.statSync(file);
  res.statusCode = status;
  res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', status === 200 ? 'public, max-age=0, must-revalidate' : 'no-store');
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function sendNotFound(req, res) {
  const page = resolvePublicFile('404.html');
  if (page) { sendFile(req, res, page, 404); return; }
  sendText(res, 404, '<!doctype html><meta charset="utf-8"><title>Not found</title><h1>404 — Not found</h1>',
    'text/html; charset=utf-8');
}

function serveStatic(req, res, pathname, search) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    sendText(res, 405, 'Method not allowed');
    return;
  }
  // cleanUrls: /x.html -> 308 /x, /index.html and /dir/index.html -> 308 / and /dir
  if (/\.html$/i.test(pathname)) {
    let target = pathname.replace(/\.html$/i, '');
    if (/(^|\/)index$/i.test(target)) target = target.replace(/\/?index$/i, '') || '/';
    res.statusCode = 308;
    res.setHeader('Location', target + search);
    res.setHeader('Content-Length', '0');
    res.end();
    return;
  }
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const candidates = clean === '/' ? ['index.html'] : [clean, `${clean}.html`, `${clean}/index.html`];
  for (const c of candidates) {
    const file = resolvePublicFile(c);
    if (file) { sendFile(req, res, file); return; }
  }
  sendNotFound(req, res);
}

/* ---------------------------------------------------------------- api */

const API_NAME_RE = /^[a-z-]+$/;
const handlerCache = new Map();

function loadHandler(name) {
  if (handlerCache.has(name)) return handlerCache.get(name);
  const file = path.join(API_DIR, `${name}.js`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const mod = require(file); // cached like a warm Vercel instance (keeps in-memory state)
  const fn = typeof mod === 'function' ? mod : mod && (mod.default || mod.handler);
  if (typeof fn !== 'function') throw new Error(`api/${name}.js does not export a handler`);
  handlerCache.set(name, fn);
  return fn;
}

function apiError(res, status, code, message) {
  if (res.headersSent) { res.end(); return; }
  const body = JSON.stringify({ error: { code, message } });
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', String(Buffer.byteLength(body)));
  res.end(body);
}

async function serveApi(req, res, pathname) {
  const name = pathname.slice('/api/'.length).replace(/\/$/, '');
  if (!API_NAME_RE.test(name)) { apiError(res, 404, 'not_found', 'Not found.'); return; }
  let handler;
  try {
    handler = loadHandler(name);
  } catch (err) {
    console.error(`[dev] failed to load api/${name}.js: ${err && err.message}`);
    apiError(res, 500, 'internal_error', 'Something went wrong on our side. Please try again.');
    return;
  }
  if (!handler) { apiError(res, 404, 'not_found', 'Not found.'); return; }

  const maxSeconds = name === 'reconcile' ? 60 : 10; // vercel.json maxDuration
  const timer = setTimeout(() => {
    if (!res.writableEnded) {
      console.error(`[dev] api/${name} exceeded ${maxSeconds}s`);
      apiError(res, 504, 'function_timeout', 'The request took too long. Please try again.');
    }
  }, maxSeconds * 1000);
  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[dev] api/${name} threw: ${err && err.message}`);
    apiError(res, 500, 'internal_error', 'Something went wrong on our side. Please try again.');
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- router */

function badRequest(res) {
  sendText(res, 400, 'Bad request');
}

async function route(req, res) {
  const url = String(req.url || '');
  if (!url.startsWith('/') || url.startsWith('//')) { badRequest(res); return; }
  const q = url.indexOf('?');
  const rawPath = (q === -1 ? url : url.slice(0, q)).split('#')[0];
  const search = q === -1 ? '' : url.slice(q);

  // Encoded separators / NUL / backslashes are never legitimate here.
  if (/%(?:2f|5c|00)/i.test(rawPath) || rawPath.includes('\\') || rawPath.includes('\0')) { badRequest(res); return; }
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    badRequest(res);
    return;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) { badRequest(res); return; }
  const segments = pathname.split('/');
  // Traversal segments and dotfiles (.env, .git …) are never served.
  if (segments.some((s) => s === '..' || s === '.' || (s.startsWith('.') && s.length > 0))) {
    applyVercelHeaders(res, '/404');
    sendNotFound(req, res);
    return;
  }

  applyVercelHeaders(res, pathname);
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    await serveApi(req, res, pathname);
    return;
  }
  serveStatic(req, res, pathname, search);
}

/* -------------------------------------------------------------- start */

function storageModeFromEnv() {
  const ok = ['GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY']
    .every((k) => String(process.env[k] || '').trim() !== '');
  return ok ? 'Google Sheets' : `local file (${process.env.LOCAL_DATA_DIR || '<os tmpdir>/tedx-merch'})`;
}

function paymentModeFromEnv() {
  try {
    return require(path.join(ROOT, 'lib', 'cashfree.js')).paymentMode();
  } catch {
    const forced = String(process.env.PAYMENT_MODE || '').trim().toLowerCase();
    const keys = Boolean(String(process.env.CASHFREE_APP_ID || '').trim() && String(process.env.CASHFREE_SECRET_KEY || '').trim());
    if (forced === 'mock') return 'mock';
    if (forced === 'cashfree') return keys ? 'cashfree' : 'unavailable';
    return keys ? 'cashfree' : 'mock';
  }
}

function start() {
  const loaded = loadEnvFiles();
  const port = Number.parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[dev] invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    // Like Vercel's edge: the client cannot choose its own forwarded headers.
    const remote = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    req.headers['x-forwarded-for'] = remote;
    req.headers['x-real-ip'] = remote;
    req.headers['x-forwarded-proto'] = 'http';
    delete req.headers['x-forwarded-host'];

    res.on('finish', () => {
      const p = String(req.url || '').split('?')[0]; // never log query strings (tokens)
      console.log(`[dev] ${req.method} ${p.slice(0, 120)} ${res.statusCode} ${Date.now() - started}ms`);
    });
    route(req, res).catch((err) => {
      console.error(`[dev] router error: ${err && err.message}`);
      if (!res.headersSent) sendText(res, 500, 'Internal error');
      else res.end();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  server.listen(port, host, () => {
    const addr = server.address();
    const shownHost = host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`\n  Merch store dev server: http://${shownHost}:${addr.port}`);
    console.log(`  env files: ${loaded.length ? loaded.join(', ') : 'none (demo mode defaults)'}`);
    console.log(`  storage:   ${storageModeFromEnv()}`);
    console.log(`  payments:  ${paymentModeFromEnv()}${process.env.CASHFREE_ENV ? ` (${process.env.CASHFREE_ENV})` : ''}`);
    if (process.env.SITE_URL) console.log(`  SITE_URL:  ${process.env.SITE_URL} (API calls from other origins get 403)`);
    console.log('');
  });
  return server;
}

if (require.main === module) start();

module.exports = { parseEnv, sourceToRegExp, start };
