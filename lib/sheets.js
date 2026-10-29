'use strict';
/*
 * Storage layer: Google Sheets (production) or a local JSON file (demo / dev).
 * Owner: sheets-catalogue (see docs/CONTRACT.md 6.6).
 *
 * storageMode() is 'sheets' when GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY are
 * all set, otherwise 'local'.
 *
 * Sheet tabs (CONTRACT 4.3):
 *   Catalogue — read by header NAME (case-insensitive, order-independent; the team may reorder columns).
 *   Orders    — read/written by POSITION in ORDER_HEADERS order (A:Y). The header row is verified once per
 *               process; a mismatch refuses to read/write so data is never written into the wrong columns.
 *   Config    — key/value rows.
 *
 * Test hooks (not part of the public contract, safe to ignore in app code):
 *   _resetForTests()                  clears catalogue/config caches, the local store pointer, the write queue
 *                                     and the cached real Google client. It does NOT remove an injected client
 *                                     or retry options set via the hooks below.
 *   _setSheetsClientForTests(client)  injects a fake Google Sheets client. It must look like the object returned
 *                                     by `sheets({ version: 'v4' })`, i.e. `client.spreadsheets.values.get /
 *                                     update / append(params)` returning `{ data }` promises. storageMode() is
 *                                     still decided by the env vars, so tests set the three GOOGLE_* vars to
 *                                     dummy values. Pass null to remove it.
 *   _setRetryOptionsForTests({ baseDelayMs, maxAttempts, sleep, random })
 *                                     override backoff timing (e.g. baseDelayMs: 1 or a fake sleep). Pass null
 *                                     to restore defaults.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const brand = require('../public/config/brand.js');
const { HttpError, log } = require('./http.js');

// ---------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------

const CATALOGUE_HEADERS = Object.freeze([
  'sku', 'name', 'price', 'category', 'apparel', 'printing', 'imageUrl', 'active', 'stock'
]);

const ORDER_HEADERS = Object.freeze([
  'Order ID', 'Created At', 'Updated At', 'Status', 'Name', 'Roll Number', 'Email', 'Phone', 'Items',
  'Items JSON', 'Subtotal', 'Printing Total', 'Total', 'Currency', 'Notes', 'Token Hash', 'Payment Mode',
  'Gateway Order ID', 'Gateway Status', 'Payment ID', 'Payment Method', 'Paid At', 'Expires At',
  'Email Sent At', 'Review Flag'
]);

const CONFIG_HEADERS = Object.freeze(['key', 'value']);

// Record field for each ORDER_HEADERS column (same order).
const ORDER_FIELDS = Object.freeze([
  'orderId', 'createdAt', 'updatedAt', 'status', 'name', 'roll', 'email', 'phone', 'itemsSummary',
  'items', 'subtotal', 'printingTotal', 'total', 'currency', 'notes', 'tokenHash', 'paymentMode',
  'gatewayOrderId', 'gatewayStatus', 'paymentId', 'paymentMethod', 'paidAt', 'expiresAt',
  'emailSentAt', 'reviewFlag'
]);
const NUMBER_FIELDS = new Set(['subtotal', 'printingTotal', 'total']);

const TAB_CATALOGUE = 'Catalogue';
const TAB_ORDERS = 'Orders';
const TAB_CONFIG = 'Config';
const ORDERS_LAST_COL = 'Y'; // 25 columns

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const CACHE_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const MAX_QTY_CEILING = 20;
const MAX_PRICE = 100000;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE', 'ENETUNREACH',
  'EHOSTUNREACH', 'ECONNABORTED', 'ESOCKETTIMEDOUT', 'TimeoutError', 'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT'
]);
const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 400,
  maxDelayMs: 4000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random
});

// The fallback catalogue. A literal path.join(__dirname, ...) so Vercel's file tracer bundles it.
const PRODUCTS_FILE = path.join(__dirname, '..', 'data', 'products.json');

// ---------------------------------------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------------------------------------

let _catalogueCache = null; // { value, expiresAt }
let _catalogueInflight = null;
let _configCache = null;
let _configInflight = null;
let _client = null; // real Google client (lazy, once per process)
let _testClient = null; // injected by tests
let _retry = DEFAULT_RETRY;
let _ordersHeaderVerified = false;
let _localFile = null; // resolved path of orders.json (the "local store pointer")
let _localQueue = Promise.resolve();
const _orderLocks = new Map(); // orderId -> tail promise (serialises updates per order within a process)
let _warnedEphemeral = false;

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

function storageMode() {
  const e = process.env;
  return e.GOOGLE_SHEET_ID && e.GOOGLE_SERVICE_ACCOUNT_EMAIL && e.GOOGLE_PRIVATE_KEY ? 'sheets' : 'local';
}

const DANGEROUS_FIRST = /^[=+\-@\t\r]/;
const QUOTED_DANGEROUS = /^'[=+\-@\t\r]/;

/** Formula-injection guard (CONTRACT 4.4). Non-strings are returned unchanged. */
function sanitizeCell(value) {
  if (typeof value !== 'string') return value;
  return DANGEROUS_FIRST.test(value) ? "'" + value : value;
}

/** Reverses sanitizeCell: removes ONE leading quote only when followed by a dangerous character. */
function unsanitizeCell(value) {
  if (typeof value !== 'string') return value;
  return QUOTED_DANGEROUS.test(value) ? value.slice(1) : value;
}

function sectionIds(sections) {
  const list = Array.isArray(sections) && sections.length ? sections : brand.sections;
  return list
    .map((s) => (s && typeof s === 'object' ? s.id : s))
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim());
}

// 'Accessories' -> 'accessor', 'Winter' -> 'winter' (CONTRACT 4.5 matches on winter / summer / accessor).
function categoryStem(id) {
  const lower = id.toLowerCase();
  const stem = lower.replace(/(ies|s)$/, '');
  return stem.length >= 3 ? stem : lower;
}

/** CONTRACT 4.5. Returns a section id. */
function normaliseCategory(product, sections) {
  const ids = sectionIds(sections);
  const p = product || {};
  const cat = String(p.category == null ? '' : p.category).trim().toLowerCase();
  if (cat) {
    const exact = ids.find((id) => id.toLowerCase() === cat);
    if (exact) return exact;
    const contained = ids.find((id) => cat.includes(categoryStem(id)));
    if (contained) return contained;
  }
  const text = `${p.name == null ? '' : p.name} ${p.sku == null ? '' : p.sku}`.toLowerCase();
  let inferred = 'Accessories';
  if (/hoodie|varsity|zipper|jacket|sweat/.test(text)) inferred = 'Winter';
  else if (/t-shirt|tshirt|polo|tee/.test(text)) inferred = 'Summer';
  const match = ids.find((id) => id.toLowerCase() === inferred.toLowerCase());
  if (match) return match;
  // Rebranded sections without these ids: fall back to the last section (usually the catch-all).
  return ids.length ? ids[ids.length - 1] : inferred;
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Tolerant boolean. Returns true/false, or null when blank or unrecognised. */
function parseBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

/** '₹1,250.50' / 'Rs. 750' / 750 -> number; null if blank or not a finite number. */
function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/₹|rs\.?|inr|,|\s/gi, '');
  if (!s || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function hasAtMostTwoDecimals(n) {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Only '/images/…' paths or https:// URLs; anything else becomes ''. */
function cleanImageUrl(v) {
  if (isBlank(v)) return '';
  const s = String(v).trim();
  if (/[\s"'<>\\`]/.test(s)) return '';
  if (s.startsWith('/images/')) {
    return s.includes('..') || s.includes('//') ? '' : s;
  }
  if (/^https:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return u.protocol === 'https:' && u.hostname ? s : '';
    } catch (_) {
      return '';
    }
  }
  return '';
}

function safeSkuForLog(sku) {
  return String(sku == null ? '' : sku).trim().slice(0, 40);
}

/**
 * Normalise one raw product (object with catalogue field names) -> product or null (invalid, logged).
 * Shared by the Sheet parser and the products.json loader so both behave identically.
 */
function normaliseProduct(raw, source) {
  const sku = String(raw.sku == null ? '' : raw.sku).trim().toUpperCase();
  if (!sku) return null; // blank row — skip silently
  if (!SKU_RE.test(sku)) {
    log('warn', 'catalogue_row_skipped', { source, sku: safeSkuForLog(sku), reason: 'invalid_sku' });
    return null;
  }
  const name = String(raw.name == null ? '' : raw.name).replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) {
    log('warn', 'catalogue_row_skipped', { source, sku, reason: 'missing_name' });
    return null;
  }
  const price = parseAmount(raw.price);
  if (price === null || price <= 0 || price > MAX_PRICE || !hasAtMostTwoDecimals(price)) {
    log('warn', 'catalogue_row_skipped', { source, sku, reason: 'invalid_price' });
    return null;
  }
  let stock = null;
  if (!isBlank(raw.stock)) {
    const n = typeof raw.stock === 'number' ? raw.stock : Number(String(raw.stock).replace(/,/g, '').trim());
    if (Number.isFinite(n) && n >= 0) {
      stock = Math.floor(n);
    } else {
      // Unknown stock: treat as out of stock rather than risk overselling.
      log('warn', 'catalogue_invalid_stock', { source, sku });
      stock = 0;
    }
  }
  let active = isBlank(raw.active) ? true : parseBool(raw.active);
  if (active === null) {
    log('warn', 'catalogue_invalid_active', { source, sku });
    active = false;
  }
  const apparel = parseBool(raw.apparel) === true;
  const printing = parseBool(raw.printing) === true;
  const category = normaliseCategory(
    { category: raw.category == null ? '' : String(raw.category), name, sku },
    brand.sections
  );
  return {
    sku,
    name,
    price: round2(price),
    category,
    apparel,
    printing,
    imageUrl: cleanImageUrl(raw.imageUrl),
    active,
    stock
  };
}

function dedupeProducts(list, source) {
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p) continue;
    if (seen.has(p.sku)) {
      log('warn', 'catalogue_duplicate_sku', { source, sku: p.sku });
      continue;
    }
    seen.add(p.sku);
    out.push(p);
  }
  return out;
}

const normaliseHeader = (h) => String(h == null ? '' : h).trim().toLowerCase().replace(/[\s_-]+/g, '');

/** Parse Catalogue tab values (row 1 = headers, any column order). Throws if sku/name/price columns missing. */
function parseCatalogueValues(values) {
  const rows = Array.isArray(values) ? values : [];
  const header = (rows[0] || []).map(normaliseHeader);
  const index = {};
  for (const field of CATALOGUE_HEADERS) {
    const i = header.indexOf(normaliseHeader(field));
    if (i !== -1) index[field] = i;
  }
  const missing = ['sku', 'name', 'price'].filter((f) => index[f] === undefined);
  if (missing.length) {
    const err = new Error(`Catalogue tab is missing required column(s): ${missing.join(', ')}`);
    err.code = 'CATALOGUE_HEADERS';
    throw err;
  }
  const products = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const raw = {};
    for (const field of CATALOGUE_HEADERS) raw[field] = index[field] === undefined ? '' : row[index[field]];
    products.push(normaliseProduct(raw, 'sheet'));
  }
  return dedupeProducts(products, 'sheet');
}

function loadFallbackProducts() {
  const parsed = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.products) ? parsed.products : [];
  return dedupeProducts(list.map((p) => normaliseProduct(p || {}, 'fallback')), 'fallback');
}

/** Order record -> row array (A:Y). Strings sanitised, numbers as numbers, items as JSON. */
function orderToRow(record) {
  return ORDER_FIELDS.map((field) => {
    const v = record[field];
    if (field === 'items') {
      if (typeof v === 'string') return sanitizeCell(v);
      return sanitizeCell(JSON.stringify(v == null ? [] : v));
    }
    if (NUMBER_FIELDS.has(field)) {
      if (isBlank(v)) return '';
      const n = typeof v === 'number' ? v : parseAmount(String(v));
      return n !== null && Number.isFinite(n) ? round2(n) : '';
    }
    if (v === undefined || v === null) return '';
    return sanitizeCell(String(v));
  });
}

/** Row array (A:Y) -> order record. */
function rowToOrder(row) {
  const r = Array.isArray(row) ? row : [];
  const rec = {};
  ORDER_FIELDS.forEach((field, i) => {
    const v = r[i];
    if (field === 'items') {
      const s = unsanitizeCell(isBlank(v) ? '' : String(v));
      let items = [];
      if (s) {
        try {
          items = JSON.parse(s);
        } catch (_) {
          log('warn', 'order_items_json_invalid', { orderId: String(r[0] == null ? '' : r[0]).slice(0, 40) });
          items = [];
        }
      }
      rec.items = Array.isArray(items) ? items : [];
    } else if (NUMBER_FIELDS.has(field)) {
      rec[field] = isBlank(v) ? null : parseAmount(typeof v === 'number' ? v : String(v));
    } else {
      rec[field] = v === undefined || v === null ? '' : unsanitizeCell(String(v));
    }
  });
  rec.orderId = rec.orderId.trim();
  return rec;
}

/** Normalise a record exactly as a Sheets round trip would. */
function normaliseOrder(record) {
  return rowToOrder(orderToRow(record));
}

// Once an order is Paid (or has a paidAt), these fields are frozen, whoever writes. This is the
// storage-level guarantee behind "Paid never regresses" when several instances sync the same order.
const PAID_FROZEN_FIELDS = new Set(['status', 'paidAt', 'paymentId', 'paymentMethod', 'total', 'tokenHash', 'items']);

function mergeOrder(current, patch) {
  const merged = { ...current };
  const isPaid = current.status === 'Paid' || !!current.paidAt;
  for (const field of ORDER_FIELDS) {
    if (field === 'orderId' || field === 'createdAt') continue;
    if (isPaid && PAID_FROZEN_FIELDS.has(field)) continue;
    if (field === 'emailSentAt' && current.emailSentAt) continue; // the first claim wins
    if (patch && Object.prototype.hasOwnProperty.call(patch, field) && patch[field] !== undefined) {
      merged[field] = patch[field];
    }
  }
  merged.updatedAt = new Date().toISOString();
  return normaliseOrder(merged);
}

function prepareNewOrder(record) {
  if (!record || typeof record !== 'object' || typeof record.orderId !== 'string' || !record.orderId.trim()) {
    throw new TypeError('appendOrder: record.orderId is required');
  }
  const now = new Date().toISOString();
  return normaliseOrder({
    ...record,
    orderId: record.orderId.trim(),
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || record.createdAt || now,
    currency: record.currency || 'INR'
  });
}

function filterOrders(records, { statuses, olderThan, limit = 25 } = {}) {
  const statusSet = Array.isArray(statuses) && statuses.length ? new Set(statuses) : null;
  const cutoff = olderThan instanceof Date ? olderThan.getTime() : olderThan != null ? new Date(olderThan).getTime() : null;
  const max = Number.isInteger(limit) && limit > 0 ? limit : 25;
  const ts = (rec) => {
    const t = Date.parse(rec.createdAt);
    return Number.isFinite(t) ? t : Infinity;
  };
  return records
    .filter((rec) => rec.orderId)
    .filter((rec) => !statusSet || statusSet.has(rec.status))
    .filter((rec) => cutoff === null || !Number.isFinite(cutoff) || ts(rec) < cutoff)
    .map((rec, i) => ({ rec, i, t: ts(rec) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .slice(0, max)
    .map((x) => x.rec);
}

function withOrderLock(orderId, fn) {
  const prev = _orderLocks.get(orderId) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  _orderLocks.set(orderId, tail);
  tail.then(() => {
    if (_orderLocks.get(orderId) === tail) _orderLocks.delete(orderId);
  });
  return run;
}

function notFound() {
  return new HttpError(404, 'not_found', 'Order not found.');
}

function storageUnavailable() {
  return new HttpError(503, 'storage_unavailable', 'Order storage is temporarily unavailable. Please try again in a minute.');
}

// ---------------------------------------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------------------------------------

function clampQty(v) {
  if (isBlank(v)) return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_QTY_CEILING, Math.max(1, Math.floor(n)));
}

function parseCharge(v) {
  if (isBlank(v)) return null;
  const n = parseAmount(typeof v === 'number' ? v : String(v));
  if (n === null || n < 0 || n > MAX_PRICE) return null;
  return round2(n);
}

/** Defaults: env PRINTING_CHARGE (also optional env STORE_OPEN / MAX_QUANTITY_PER_SKU for local demos). */
function envConfig() {
  const e = process.env;
  const charge = parseCharge(e.PRINTING_CHARGE);
  const open = isBlank(e.STORE_OPEN) ? null : parseBool(e.STORE_OPEN);
  const qty = clampQty(e.MAX_QUANTITY_PER_SKU);
  return {
    printingCharge: charge === null ? 0 : charge,
    storeOpen: open === null ? true : open,
    maxQuantityPerSku: qty === null ? MAX_QTY_CEILING : qty
  };
}

function parseConfigValues(values, defaults) {
  const cfg = { ...defaults };
  const rows = Array.isArray(values) ? values : [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const k = String(row[0] == null ? '' : row[0]).trim().toUpperCase();
    const v = row[1];
    if (!k || k === 'KEY') continue;
    if (k === 'PRINTING_CHARGE') {
      const n = parseCharge(v);
      if (n !== null) cfg.printingCharge = n;
      else if (!isBlank(v)) log('warn', 'config_invalid_value', { setting: k });
    } else if (k === 'STORE_OPEN') {
      const b = parseBool(v);
      if (b !== null) cfg.storeOpen = b;
      else if (!isBlank(v)) log('warn', 'config_invalid_value', { setting: k });
    } else if (k === 'MAX_QUANTITY_PER_SKU') {
      const n = clampQty(v);
      if (n !== null) cfg.maxQuantityPerSku = n;
      else if (!isBlank(v)) log('warn', 'config_invalid_value', { setting: k });
    }
  }
  return cfg;
}

// ---------------------------------------------------------------------------------------------------------
// Google Sheets backend
// ---------------------------------------------------------------------------------------------------------

function getClient() {
  if (_testClient) return _testClient;
  if (_client) return _client;
  const { sheets, auth } = require('@googleapis/sheets');
  let key = String(process.env.GOOGLE_PRIVATE_KEY || '').trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  key = key.replace(/\\r/g, '').replace(/\\n/g, '\n');
  const jwt = new auth.JWT({
    email: String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL).trim(),
    key,
    scopes: [SCOPE]
  });
  // Library-level retries are disabled; withRetry() below is the single retry policy.
  _client = sheets({ version: 'v4', auth: jwt, retry: false, timeout: REQUEST_TIMEOUT_MS });
  return _client;
}

function errorStatus(err) {
  if (!err || typeof err !== 'object') return null;
  const s = (err.response && err.response.status) || err.status || (typeof err.code === 'number' ? err.code : Number(err.code));
  return Number.isInteger(s) && s >= 100 && s < 600 ? s : null;
}

function isRetryable(err) {
  const status = errorStatus(err);
  if (status !== null) return RETRYABLE_STATUS.has(status);
  let e = err;
  for (let depth = 0; e && depth < 4; depth++, e = e.cause) {
    if (typeof e.code === 'string' && RETRYABLE_CODES.has(e.code)) return true;
    if (typeof e.name === 'string' && RETRYABLE_CODES.has(e.name)) return true;
    if (e.message === 'fetch failed') return true;
  }
  return false;
}

/** Safe, PII-free description of an error for logs. */
function errorInfo(err) {
  const info = {};
  const status = errorStatus(err);
  if (status !== null) info.status = status;
  if (err && typeof err.code === 'string') info.code = err.code;
  if (err && err.message) info.message = String(err.message).slice(0, 200);
  return info;
}

async function withRetry(op, fn) {
  const { maxAttempts, baseDelayMs, maxDelayMs, sleep, random } = _retry;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      // Exponential backoff with "equal jitter": half fixed, half random.
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.round(exp / 2 + random() * (exp / 2));
      log('warn', 'sheets_retry', { op, attempt, delayMs: delay, ...errorInfo(err) });
      await sleep(delay);
    }
  }
}

const sheetId = () => process.env.GOOGLE_SHEET_ID;

async function valuesGet(op, range) {
  const res = await withRetry(op, () =>
    getClient().spreadsheets.values.get({
      spreadsheetId: sheetId(),
      range,
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    })
  );
  return (res && res.data && res.data.values) || [];
}

async function valuesUpdate(op, range, values) {
  return withRetry(op, () =>
    getClient().spreadsheets.values.update({
      spreadsheetId: sheetId(),
      range,
      valueInputOption: 'RAW',
      requestBody: { values }
    })
  );
}

async function ensureOrdersHeader() {
  if (_ordersHeaderVerified) return;
  const rows = await valuesGet('orders_header', `${TAB_ORDERS}!A1:${ORDERS_LAST_COL}1`);
  const header = rows[0] || [];
  if (header.every(isBlank)) {
    await valuesUpdate('orders_header_write', `${TAB_ORDERS}!A1:${ORDERS_LAST_COL}1`, [ORDER_HEADERS.slice()]);
  } else {
    const ok = ORDER_HEADERS.every(
      (h, i) => String(header[i] == null ? '' : header[i]).trim().toLowerCase() === h.toLowerCase()
    );
    if (!ok) {
      const err = new Error('Orders tab header row does not match the expected columns (run npm run setup-sheet and do not reorder Orders columns)');
      err.code = 'ORDERS_HEADERS';
      throw err;
    }
  }
  _ordersHeaderVerified = true;
}

/** Returns the 1-based sheet row number of orderId, or null. */
async function findOrderRow(orderId) {
  const col = await valuesGet('orders_scan', `${TAB_ORDERS}!A:A`);
  let found = null;
  for (let i = 1; i < col.length; i++) {
    const cell = col[i] && col[i][0];
    if (cell != null && unsanitizeCell(String(cell)).trim() === orderId) {
      if (found !== null) {
        // Two rows with one Order ID means the tab was edited by hand (copy/paste or a sort mid-write).
        const err = new Error('Order ID appears in more than one row of the Orders tab');
        err.code = 'ORDERS_DUPLICATE_ID';
        throw err;
      }
      found = i + 1;
    }
  }
  return found;
}

/** Reads column A of one row: used to make sure a row did not move (sort/insert) around a write. */
async function orderIdAtRow(rowNumber) {
  const rows = await valuesGet('orders_verify', `${TAB_ORDERS}!A${rowNumber}:A${rowNumber}`);
  const cell = rows[0] && rows[0][0];
  return cell == null ? '' : unsanitizeCell(String(cell)).trim();
}

async function readOrderRow(rowNumber) {
  const rows = await valuesGet('orders_row', `${TAB_ORDERS}!A${rowNumber}:${ORDERS_LAST_COL}${rowNumber}`);
  return rowToOrder(rows[0] || []);
}

/** Locate + read an order; re-scans once if the row moved between scan and read. */
async function locateOrder(orderId) {
  for (let pass = 0; pass < 2; pass++) {
    const rowNumber = await findOrderRow(orderId);
    if (rowNumber === null) return null;
    const rec = await readOrderRow(rowNumber);
    if (rec.orderId === orderId) return { rowNumber, rec };
  }
  return null;
}

async function sheetsOrdersOp(op, fn) {
  try {
    await ensureOrdersHeader();
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    log('error', 'sheets_orders_error', { op, ...errorInfo(err) });
    throw storageUnavailable();
  }
}

const sheetsBackend = {
  async catalogue() {
    const values = await valuesGet('catalogue', TAB_CATALOGUE);
    return parseCatalogueValues(values);
  },
  async config(defaults) {
    const values = await valuesGet('config', `${TAB_CONFIG}!A:B`);
    return parseConfigValues(values, defaults);
  },
  appendOrder(rec) {
    return sheetsOrdersOp('append', async () => {
      const row = orderToRow(rec);
      await withRetry('orders_append', async (attempt) => {
        // A retried append may follow a request that actually succeeded: never write a duplicate row.
        if (attempt > 1 && (await findOrderRow(rec.orderId)) !== null) return;
        await getClient().spreadsheets.values.append({
          spreadsheetId: sheetId(),
          range: `${TAB_ORDERS}!A:${ORDERS_LAST_COL}`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [row] }
        });
      });
      return rec;
    });
  },
  getOrder(orderId) {
    return sheetsOrdersOp('get', async () => {
      const found = await locateOrder(orderId);
      return found ? found.rec : null;
    });
  },
  updateOrder(orderId, patch) {
    return sheetsOrdersOp('update', async () => {
      let found = await locateOrder(orderId);
      if (!found) throw notFound();
      // Re-check the row right before writing; if someone sorted/inserted rows meanwhile, locate again.
      if ((await orderIdAtRow(found.rowNumber)) !== orderId) {
        found = await locateOrder(orderId);
        if (!found || (await orderIdAtRow(found.rowNumber)) !== orderId) {
          const err = new Error('Orders row moved during update');
          err.code = 'ORDERS_ROW_MOVED';
          throw err;
        }
      }
      const merged = mergeOrder(found.rec, patch);
      const n = found.rowNumber;
      await valuesUpdate('orders_update', `${TAB_ORDERS}!A${n}:${ORDERS_LAST_COL}${n}`, [orderToRow(merged)]);
      if ((await orderIdAtRow(n)) !== orderId) {
        // The row moved between the check and the write: another order's row may have been overwritten.
        log('error', 'orders_row_overwritten', { orderId, row: n });
        const err = new Error('Orders row moved during update');
        err.code = 'ORDERS_ROW_MOVED';
        throw err;
      }
      return merged;
    });
  },
  listOrders(opts) {
    return sheetsOrdersOp('list', async () => {
      const rows = await valuesGet('orders_list', `${TAB_ORDERS}!A:${ORDERS_LAST_COL}`);
      return filterOrders(rows.slice(1).map(rowToOrder), opts);
    });
  }
};

// ---------------------------------------------------------------------------------------------------------
// Local JSON-file backend
// ---------------------------------------------------------------------------------------------------------

function localFile() {
  if (!_localFile) {
    const dir = process.env.LOCAL_DATA_DIR || path.join(os.tmpdir(), 'tedx-merch');
    _localFile = path.join(path.resolve(dir), 'orders.json');
    if (!_warnedEphemeral && process.env.VERCEL_ENV === 'production') {
      _warnedEphemeral = true;
      log('warn', 'local_storage_in_production', { message: 'Google Sheets env vars missing; orders are stored in ephemeral local files' });
    }
  }
  return _localFile;
}

function readLocalOrders() {
  const file = localFile();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    log('error', 'local_store_read_failed', { code: err.code });
    throw storageUnavailable();
  }
  if (!text.trim()) return [];
  try {
    const data = JSON.parse(text);
    return Array.isArray(data.orders) ? data.orders : [];
  } catch (_) {
    // Never overwrite a corrupt file (that would lose orders); refuse until someone looks at it.
    log('error', 'local_store_corrupt', {});
    throw storageUnavailable();
  }
}

function writeLocalOrders(orders) {
  const file = localFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, orders }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    log('error', 'local_store_write_failed', { code: err.code });
    throw storageUnavailable();
  }
}

/** Serialises read-modify-write cycles within this process so concurrent writes never lose updates. */
function enqueueLocal(fn) {
  const run = _localQueue.then(() => fn());
  _localQueue = run.then(() => {}, () => {});
  return run;
}

const localBackend = {
  async catalogue() {
    return loadFallbackProducts();
  },
  async config(defaults) {
    return { ...defaults };
  },
  appendOrder(rec) {
    return enqueueLocal(() => {
      const orders = readLocalOrders();
      if (orders.some((o) => o.orderId === rec.orderId)) throw new Error('appendOrder: duplicate orderId');
      orders.push(rec);
      writeLocalOrders(orders);
      return rec;
    });
  },
  async getOrder(orderId) {
    const found = readLocalOrders().find((o) => o.orderId === orderId);
    return found ? normaliseOrder(found) : null;
  },
  updateOrder(orderId, patch) {
    return enqueueLocal(() => {
      const orders = readLocalOrders();
      const i = orders.findIndex((o) => o.orderId === orderId);
      if (i === -1) throw notFound();
      const merged = mergeOrder(normaliseOrder(orders[i]), patch);
      orders[i] = merged;
      writeLocalOrders(orders);
      return merged;
    });
  },
  async listOrders(opts) {
    return filterOrders(readLocalOrders().map(normaliseOrder), opts);
  }
};

const backend = () => (storageMode() === 'sheets' ? sheetsBackend : localBackend);

// ---------------------------------------------------------------------------------------------------------
// Handover (who has collected their order). Sheets: the "Handover" tab built by `npm run setup-dashboard`,
// where column A mirrors the Orders IDs by formula, J is the "Handed over" checkbox and K a free-text note.
// Local: handover.json next to orders.json.
// ---------------------------------------------------------------------------------------------------------

const TAB_HANDOVER = 'Handover';
const HANDOVER_NOTE_MAX = 200;

function handoverUnavailable() {
  return new HttpError(503, 'handover_unavailable',
    'The Handover tab is missing from the Sheet. Run `npm run setup-dashboard` once, then try again.');
}

function localHandoverFile() {
  return path.join(path.dirname(localFile()), 'handover.json');
}

function readLocalHandover() {
  try {
    const data = JSON.parse(fs.readFileSync(localHandoverFile(), 'utf8'));
    return data && typeof data.handover === 'object' && data.handover ? data.handover : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    log('error', 'local_handover_read_failed', { code: err.code });
    throw storageUnavailable();
  }
}

/** -> Map orderId -> { handedOver: boolean, note: string } */
async function getHandover() {
  if (storageMode() !== 'sheets') {
    return new Map(Object.entries(readLocalHandover()));
  }
  let rows;
  try {
    rows = await valuesGet('handover_list', `${TAB_HANDOVER}!A:K`);
  } catch (err) {
    if (errorStatus(err) === 400) throw handoverUnavailable(); // tab does not exist
    log('error', 'sheets_handover_error', { op: 'list', ...errorInfo(err) });
    throw storageUnavailable();
  }
  const map = new Map();
  for (const row of rows.slice(1)) {
    const id = row && row[0] != null ? unsanitizeCell(String(row[0])).trim() : '';
    if (!id) continue;
    map.set(id, { handedOver: row[9] === true || String(row[9]).toUpperCase() === 'TRUE', note: row[10] == null ? '' : unsanitizeCell(String(row[10])) });
  }
  return map;
}

/** Ticks/unticks "Handed over" for one order. Throws HttpError(404) for unknown orders. */
async function setHandover(orderId, { handedOver, note = '' } = {}) {
  if (typeof orderId !== 'string' || !orderId.trim() || orderId.length > 64) throw notFound();
  const id = orderId.trim();
  const value = { handedOver: Boolean(handedOver), note: String(note || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, HANDOVER_NOTE_MAX) };
  if (storageMode() !== 'sheets') {
    return enqueueLocal(() => {
      if (!readLocalOrders().some((o) => o.orderId === id)) throw notFound();
      const all = readLocalHandover();
      all[id] = value;
      const file = localHandoverFile();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ version: 1, handover: all }, null, 2), { mode: 0o600 });
      return value;
    });
  }
  return withOrderLock(id, async () => {
    let rows;
    try {
      rows = await valuesGet('handover_scan', `${TAB_HANDOVER}!A:A`);
    } catch (err) {
      if (errorStatus(err) === 400) throw handoverUnavailable();
      log('error', 'sheets_handover_error', { op: 'scan', ...errorInfo(err) });
      throw storageUnavailable();
    }
    const i = rows.findIndex((r, k) => k > 0 && r && r[0] != null && unsanitizeCell(String(r[0])).trim() === id);
    if (i === -1) throw notFound();
    const n = i + 1;
    try {
      await valuesUpdate('handover_update', `${TAB_HANDOVER}!J${n}:K${n}`, [[value.handedOver, sanitizeCell(value.note)]]);
    } catch (err) {
      log('error', 'sheets_handover_error', { op: 'update', ...errorInfo(err) });
      throw storageUnavailable();
    }
    return value;
  });
}

// ---------------------------------------------------------------------------------------------------------
// Admin password hash (set from /admin). Sheets: a Config row "ADMIN_PASSWORD_HASH". Local: admin.json.
// Only a salted scrypt hash is ever stored (lib/admin.js). Deleting the row restores ADMIN_PASSWORD.
// ---------------------------------------------------------------------------------------------------------

const ADMIN_HASH_KEY = 'ADMIN_PASSWORD_HASH';

function localAdminFile() {
  return path.join(path.dirname(localFile()), 'admin.json');
}

/** -> stored hash string, or '' when none is set. */
async function getAdminPasswordHash() {
  if (storageMode() !== 'sheets') {
    try {
      const data = JSON.parse(fs.readFileSync(localAdminFile(), 'utf8'));
      return data && typeof data.passwordHash === 'string' ? data.passwordHash : '';
    } catch (err) {
      if (err.code === 'ENOENT') return '';
      log('error', 'local_admin_read_failed', { code: err.code });
      throw storageUnavailable();
    }
  }
  try {
    const rows = await valuesGet('config_admin', `${TAB_CONFIG}!A:B`);
    const row = rows.find((r) => r && String(r[0] == null ? '' : r[0]).trim().toUpperCase() === ADMIN_HASH_KEY);
    return row && row[1] != null ? String(row[1]).trim() : '';
  } catch (err) {
    log('error', 'sheets_admin_error', { op: 'get', ...errorInfo(err) });
    throw storageUnavailable();
  }
}

async function setAdminPasswordHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('scrypt$')) throw new TypeError('setAdminPasswordHash: expected a scrypt hash');
  if (storageMode() !== 'sheets') {
    const file = localAdminFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ version: 1, passwordHash: hash }, null, 2), { mode: 0o600 });
    return;
  }
  try {
    const rows = await valuesGet('config_admin', `${TAB_CONFIG}!A:B`);
    const i = rows.findIndex((r) => r && String(r[0] == null ? '' : r[0]).trim().toUpperCase() === ADMIN_HASH_KEY);
    if (i !== -1) {
      await valuesUpdate('config_admin_update', `${TAB_CONFIG}!B${i + 1}`, [[hash]]);
    } else {
      await withRetry('config_admin_append', async (attempt) => {
        if (attempt > 1) {
          const again = await valuesGet('config_admin', `${TAB_CONFIG}!A:B`);
          const j = again.findIndex((r) => r && String(r[0] == null ? '' : r[0]).trim().toUpperCase() === ADMIN_HASH_KEY);
          if (j !== -1) { await valuesUpdate('config_admin_update', `${TAB_CONFIG}!B${j + 1}`, [[hash]]); return; }
        }
        await getClient().spreadsheets.values.append({
          spreadsheetId: sheetId(),
          range: `${TAB_CONFIG}!A:B`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[ADMIN_HASH_KEY, hash]] }
        });
      });
    }
  } catch (err) {
    log('error', 'sheets_admin_error', { op: 'set', ...errorInfo(err) });
    throw storageUnavailable();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Catalogue editing (organiser /admin-products page). Sheets mode only: the local demo catalogue is the
// read-only data/products.json. Products are matched by SKU (column order is read from the header row).
// ---------------------------------------------------------------------------------------------------------

function catalogueReadOnly() {
  return new HttpError(503, 'catalogue_readonly',
    'Editing products needs the Google Sheet. In local demo mode the catalogue comes from data/products.json.');
}

function catalogueStorageError(op, err) {
  if (err instanceof HttpError) return err;
  log('error', 'sheets_catalogue_error', { op, ...errorInfo(err) });
  return storageUnavailable();
}

const colLetter = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** -> { header (raw), index: field -> column, rows: raw rows incl. header } */
async function readCatalogueTab() {
  const rows = await valuesGet('catalogue_admin_read', TAB_CATALOGUE);
  const header = (rows[0] || []).map(normaliseHeader);
  const index = {};
  for (const field of CATALOGUE_HEADERS) {
    const i = header.indexOf(normaliseHeader(field));
    if (i !== -1) index[field] = i;
  }
  const missing = CATALOGUE_HEADERS.filter((f) => index[f] === undefined);
  if (missing.length) {
    throw new HttpError(503, 'catalogue_columns', `The Catalogue tab is missing column(s): ${missing.join(', ')}.`);
  }
  return { header: rows[0] || [], index, rows };
}

function skuAt(row, index) {
  const v = row && row[index.sku];
  return v == null ? '' : String(v).trim().toUpperCase();
}

function productToCells(product, index, width, existing = []) {
  const row = Array.from({ length: width }, (_, i) => (existing[i] === undefined ? '' : existing[i]));
  row[index.sku] = product.sku;
  row[index.name] = sanitizeCell(product.name);
  row[index.price] = product.price;
  row[index.category] = product.category;
  row[index.apparel] = product.apparel;
  row[index.printing] = product.printing;
  row[index.imageUrl] = sanitizeCell(product.imageUrl || '');
  row[index.active] = product.active;
  row[index.stock] = product.stock === null || product.stock === undefined ? '' : product.stock;
  return row;
}

/** Every Catalogue row (active or not) as the store reads it, plus rows the store skips as invalid. */
async function listCatalogueForAdmin() {
  if (storageMode() !== 'sheets') {
    return { editable: false, products: loadFallbackProducts(), invalidRows: [] };
  }
  try {
    const { index, rows } = await readCatalogueTab();
    const products = [];
    const invalidRows = [];
    const seen = new Set();
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const raw = {};
      for (const field of CATALOGUE_HEADERS) raw[field] = row[index[field]];
      if (!skuAt(row, index) && !String(raw.name || '').trim()) continue; // blank row
      const p = normaliseProduct(raw, 'sheet');
      if (!p || seen.has(p.sku)) {
        invalidRows.push({ row: r + 1, sku: skuAt(row, index), reason: p ? 'duplicate SKU' : 'invalid row (check SKU, name and price)' });
        continue;
      }
      seen.add(p.sku);
      products.push(p);
    }
    return { editable: true, products, invalidRows };
  } catch (err) {
    throw catalogueStorageError('list', err);
  }
}

/** Creates (create=true) or updates the product with product.sku. Throws 404 / 409 HttpErrors. */
async function saveCatalogueProduct(product, { create = false } = {}) {
  if (storageMode() !== 'sheets') throw catalogueReadOnly();
  try {
    const { header, index, rows } = await readCatalogueTab();
    const width = Math.max(header.length, ...Object.values(index).map((i) => i + 1));
    const r = rows.findIndex((row, k) => k > 0 && skuAt(row, index) === product.sku);
    if (create) {
      if (r !== -1) throw new HttpError(409, 'sku_exists', `A product with SKU ${product.sku} already exists.`);
      await withRetry('catalogue_append', async (attempt) => {
        if (attempt > 1) {
          const again = await valuesGet('catalogue_admin_read', TAB_CATALOGUE);
          if (again.some((row, k) => k > 0 && skuAt(row, index) === product.sku)) return; // first try landed
        }
        await getClient().spreadsheets.values.append({
          spreadsheetId: sheetId(),
          range: `${TAB_CATALOGUE}!A:${colLetter(width - 1)}`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [productToCells(product, index, width)] }
        });
      });
    } else {
      if (r === -1) throw new HttpError(404, 'not_found', `No product with SKU ${product.sku}.`);
      const n = r + 1;
      const check = await valuesGet('catalogue_admin_verify', `${TAB_CATALOGUE}!${colLetter(index.sku)}${n}`);
      if (skuAt([check[0] && check[0][0]], { sku: 0 }) !== product.sku) {
        throw new HttpError(409, 'catalogue_changed', 'The Catalogue tab changed while saving. Reload and try again.');
      }
      await valuesUpdate('catalogue_update', `${TAB_CATALOGUE}!A${n}:${colLetter(width - 1)}${n}`,
        [productToCells(product, index, width, rows[r])]);
    }
    _catalogueCache = null;
    return product;
  } catch (err) {
    throw catalogueStorageError(create ? 'create' : 'update', err);
  }
}

/** Removes the Catalogue row for `sku`. Past orders keep their own copy of name and price. */
async function deleteCatalogueProduct(sku) {
  if (storageMode() !== 'sheets') throw catalogueReadOnly();
  try {
    const { index, rows } = await readCatalogueTab();
    const r = rows.findIndex((row, k) => k > 0 && skuAt(row, index) === sku);
    if (r === -1) throw new HttpError(404, 'not_found', `No product with SKU ${sku}.`);
    const meta = await withRetry('catalogue_meta', () =>
      getClient().spreadsheets.get({ spreadsheetId: sheetId(), fields: 'sheets.properties(sheetId,title)' }));
    const tab = ((meta && meta.data && meta.data.sheets) || []).find((s) => s.properties && s.properties.title === TAB_CATALOGUE);
    if (!tab) throw new HttpError(503, 'catalogue_columns', 'The Catalogue tab is missing.');
    const check = await valuesGet('catalogue_admin_verify', `${TAB_CATALOGUE}!${colLetter(index.sku)}${r + 1}`);
    if (skuAt([check[0] && check[0][0]], { sku: 0 }) !== sku) {
      throw new HttpError(409, 'catalogue_changed', 'The Catalogue tab changed while deleting. Reload and try again.');
    }
    // Single attempt on purpose: a retry after a request that actually succeeded would delete the next row.
    await getClient().spreadsheets.batchUpdate({
      spreadsheetId: sheetId(),
      requestBody: { requests: [{ deleteDimension: { range: { sheetId: tab.properties.sheetId, dimension: 'ROWS', startIndex: r, endIndex: r + 1 } } }] }
    });
    _catalogueCache = null;
    return { sku };
  } catch (err) {
    throw catalogueStorageError('delete', err);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Public API (CONTRACT 6.6)
// ---------------------------------------------------------------------------------------------------------

function copyCatalogue(value) {
  return { products: value.products.map((p) => ({ ...p })), source: value.source };
}

async function loadCatalogue() {
  if (storageMode() === 'sheets') {
    try {
      return { products: await sheetsBackend.catalogue(), source: 'sheet' };
    } catch (err) {
      log('warn', 'catalogue_fallback', errorInfo(err));
    }
  }
  return { products: loadFallbackProducts(), source: 'fallback' };
}

/** -> { products: [...all rows incl. inactive], source: 'sheet' | 'fallback' } (60 s memory cache). */
async function getCatalogue({ fresh = false } = {}) {
  if (!fresh && _catalogueCache && _catalogueCache.expiresAt > Date.now()) return copyCatalogue(_catalogueCache.value);
  if (!_catalogueInflight) {
    _catalogueInflight = loadCatalogue()
      .then((value) => {
        _catalogueCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        _catalogueInflight = null;
      });
  }
  return copyCatalogue(await _catalogueInflight);
}

async function loadConfig() {
  const defaults = envConfig();
  try {
    return await backend().config(defaults);
  } catch (err) {
    log('warn', 'config_fallback', errorInfo(err));
    return defaults;
  }
}

/** -> { printingCharge, storeOpen, maxQuantityPerSku } (60 s memory cache). */
async function getConfig() {
  if (_configCache && _configCache.expiresAt > Date.now()) return { ..._configCache.value };
  if (!_configInflight) {
    _configInflight = loadConfig()
      .then((value) => {
        _configCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
        return value;
      })
      .finally(() => {
        _configInflight = null;
      });
  }
  return { ...(await _configInflight) };
}

/** Writes one order row. Returns the stored (normalised) record. */
async function appendOrder(record) {
  const rec = prepareNewOrder(record);
  return backend().appendOrder(rec);
}

/** -> record | null */
async function getOrder(orderId) {
  if (typeof orderId !== 'string' || !orderId.trim() || orderId.length > 64) return null;
  return backend().getOrder(orderId.trim());
}

/** Merges patch (Order fields; orderId/createdAt are immutable), sets updatedAt. Throws HttpError(404). */
async function updateOrder(orderId, patch) {
  if (typeof orderId !== 'string' || !orderId.trim() || orderId.length > 64) throw notFound();
  const id = orderId.trim();
  return withOrderLock(id, () => backend().updateOrder(id, patch || {}));
}

/** Oldest first. statuses: array of status strings (omit for all); olderThan: Date (createdAt < olderThan). */
async function listOrders({ statuses, olderThan, limit = 25 } = {}) {
  return backend().listOrders({ statuses, olderThan, limit });
}

function _resetForTests() {
  _catalogueCache = null;
  _catalogueInflight = null;
  _configCache = null;
  _configInflight = null;
  _client = null;
  _ordersHeaderVerified = false;
  _localFile = null;
  _localQueue = Promise.resolve();
  _orderLocks.clear();
  _warnedEphemeral = false;
}

function _setSheetsClientForTests(client) {
  _testClient = client || null;
}

function _setRetryOptionsForTests(opts) {
  _retry = opts ? { ...DEFAULT_RETRY, ...opts } : DEFAULT_RETRY;
}

module.exports = {
  ORDER_HEADERS,
  CATALOGUE_HEADERS,
  CONFIG_HEADERS,
  storageMode,
  sanitizeCell,
  unsanitizeCell,
  normaliseCategory,
  getCatalogue,
  getConfig,
  appendOrder,
  getOrder,
  updateOrder,
  listOrders,
  getHandover,
  setHandover,
  getAdminPasswordHash,
  setAdminPasswordHash,
  listCatalogueForAdmin,
  saveCatalogueProduct,
  deleteCatalogueProduct,
  _resetForTests,
  _setSheetsClientForTests,
  _setRetryOptionsForTests
};
