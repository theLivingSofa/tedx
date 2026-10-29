'use strict';
/*
 * Organiser dashboard helpers: password check, signed session cookie, and the summary maths.
 *
 * Security model
 *  - ADMIN_PASSWORD (Vercel secret) switches the admin area on (unset = 404) and is the starting password.
 *  - Organisers can change the password on /admin. The new one is stored only as a salted scrypt hash in the
 *    Sheet's Config tab (key ADMIN_PASSWORD_HASH; local demo: admin.json). While that row exists it replaces
 *    ADMIN_PASSWORD; deleting the row restores ADMIN_PASSWORD (the recovery path).
 *  - A successful login gets an HttpOnly, Secure, SameSite=Strict cookie holding `<expiry>.<HMAC>`. The HMAC
 *    key is derived from the current credential, so changing the password signs everyone else out.
 *  - No customer data is ever logged; responses are no-store (sendJson default).
 */

const crypto = require('node:crypto');
const { safeEqual } = require('./tokens');

const COOKIE = '__Host-merch_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
const CREDENTIAL_TTL_MS = 30 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const HASH_RE = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const ONE_SIZE = 'One size';

let _credential = null; // { value: { kind, secret }, at }

function adminPassword() {
  const v = process.env.ADMIN_PASSWORD;
  return typeof v === 'string' && v.length >= MIN_PASSWORD_LENGTH ? v : '';
}

function adminEnabled() {
  return Boolean(adminPassword());
}

/* ------------------------------------------------------------------ password hashing */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function isPasswordHash(v) {
  const m = typeof v === 'string' ? HASH_RE.exec(v) : null;
  return Boolean(m && Number(m[1]) >= 16384 && Number(m[1]) <= 1048576 && Number(m[2]) <= 16 && Number(m[3]) <= 4);
}

function verifyPasswordHash(candidate, stored) {
  if (!isPasswordHash(stored) || typeof candidate !== 'string' || !candidate || candidate.length > 256) return false;
  const [, N, r, p, salt, key] = HASH_RE.exec(stored);
  const expected = Buffer.from(key, 'base64url');
  const got = crypto.scryptSync(candidate, Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * Number(N) * Number(r) });
  return crypto.timingSafeEqual(got, expected);
}

/** Constant-time comparison with a plain password (hash both sides so lengths never leak). */
function equalsPlain(candidate, password) {
  if (!password || typeof candidate !== 'string' || !candidate || candidate.length > 256) return false;
  const a = crypto.createHash('sha256').update(candidate, 'utf8').digest('hex');
  const b = crypto.createHash('sha256').update(password, 'utf8').digest('hex');
  return safeEqual(a, b);
}

/* ------------------------------------------------------------------ current credential */

/** -> { kind: 'hash'|'env', secret } or null when the admin area is off. Cached briefly per instance. */
async function credential({ fresh = false } = {}) {
  const env = adminPassword();
  if (!env) return null;
  if (!fresh && _credential && Date.now() - _credential.at < CREDENTIAL_TTL_MS) return _credential.value;
  const stored = await require('./sheets').getAdminPasswordHash(); // lazy: avoids a require cycle
  const value = isPasswordHash(stored) ? { kind: 'hash', secret: stored } : { kind: 'env', secret: env };
  _credential = { value, at: Date.now() };
  return value;
}

function checkAgainst(candidate, cred) {
  if (!cred) return false;
  return cred.kind === 'hash' ? verifyPasswordHash(candidate, cred.secret) : equalsPlain(candidate, cred.secret);
}

/* ------------------------------------------------------------------ sessions */

function sessionKey(secret) {
  return crypto.createHash('sha256').update('tedx-merch-admin-session-v2:' + secret, 'utf8').digest();
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', sessionKey(secret)).update(payload, 'utf8').digest('base64url');
}

function createSession({ now = Date.now(), secret } = {}) {
  const exp = String(now + SESSION_MS);
  return `${exp}.${sign(exp, secret)}`;
}

function verifySession(value, { now = Date.now(), secret } = {}) {
  if (!secret || typeof value !== 'string' || value.length > 200) return false;
  const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp <= now || exp > now + SESSION_MS + 60000) return false;
  return safeEqual(m[2], sign(m[1], secret));
}

/** -> a new session value, or null for a wrong password. */
async function login(candidate) {
  const cred = await credential({ fresh: true });
  return checkAgainst(candidate, cred) ? createSession({ secret: cred.secret }) : null;
}

/**
 * Changes the admin password. -> { ok: true, session } or { ok: false, field, message }.
 * The caller must already hold a valid session.
 */
async function changePassword(current, next) {
  const cred = await credential({ fresh: true });
  if (!checkAgainst(current, cred)) return { ok: false, field: 'currentPassword', message: 'Your current password is not right.' };
  if (typeof next !== 'string' || next.length < MIN_PASSWORD_LENGTH || next.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, field: 'newPassword', message: `Use ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters.` };
  }
  if (next === current) return { ok: false, field: 'newPassword', message: 'Choose a different password from the current one.' };
  const hash = hashPassword(next);
  await require('./sheets').setAdminPasswordHash(hash);
  _credential = { value: { kind: 'hash', secret: hash }, at: Date.now() };
  return { ok: true, session: createSession({ secret: hash }) };
}

function _resetForTests() {
  _credential = null;
}

function readCookie(req, name = COOKIE) {
  const header = req && req.headers && req.headers.cookie;
  if (typeof header !== 'string') return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

async function isAuthenticated(req) {
  const value = readCookie(req);
  if (!value) return false;
  const cred = await credential();
  return Boolean(cred) && verifySession(value, { secret: cred.secret });
}

function sessionCookie(value) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
}

function clearedCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/* ------------------------------------------------------------------------------------------ summary */

function isTest(order) {
  return /TEST_PAYMENT/.test(String(order.reviewFlag || ''));
}

/** A Review Flag that is anything other than the routine test-payment flags. */
function needsReview(order) {
  const flags = String(order.reviewFlag || '').split('|').map((s) => s.trim()).filter(Boolean);
  return flags.some((f) => !/^TEST_PAYMENT_(SANDBOX|MOCK)$/.test(f));
}

function toNumber(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sizeRank(size) {
  const i = SIZE_ORDER.indexOf(size);
  return i === -1 ? SIZE_ORDER.length : i;
}

/**
 * orders: storage records; handover: Map orderId -> { handedOver, note }; catalogue: products (for order + names).
 * Returns everything the dashboard shows. Test (sandbox / demo) payments are left out entirely; totals cover Paid orders.
 */
function summarise({ orders = [], handover = new Map(), catalogue = [] } = {}) {
  const counted = orders.filter((o) => o && o.orderId && !isTest(o));
  const paid = counted.filter((o) => o.status === 'Paid');

  const bySku = new Map();
  for (const p of catalogue) bySku.set(p.sku, { sku: p.sku, name: p.name, sizes: {}, total: 0, printed: 0, revenue: 0 });
  const printedNames = [];
  let itemsSold = 0;
  let itemsPrinted = 0;

  for (const o of paid) {
    for (const it of Array.isArray(o.items) ? o.items : []) {
      const qty = Math.max(0, Math.floor(toNumber(it.quantity)));
      if (!qty || typeof it.sku !== 'string') continue;
      let row = bySku.get(it.sku);
      if (!row) { row = { sku: it.sku, name: String(it.name || it.sku), sizes: {}, total: 0, printed: 0, revenue: 0 }; bySku.set(it.sku, row); }
      const size = it.size ? String(it.size) : ONE_SIZE;
      row.sizes[size] = (row.sizes[size] || 0) + qty;
      row.total += qty;
      row.revenue += toNumber(it.lineTotal);
      itemsSold += qty;
      if (it.printing) {
        row.printed += qty;
        itemsPrinted += qty;
        printedNames.push({ orderId: o.orderId, sku: it.sku, product: row.name, size, printedName: String(it.printedName || ''), quantity: qty });
      }
    }
  }

  const products = [...bySku.values()].map((r) => ({ ...r, revenue: Math.round(r.revenue * 100) / 100 }));
  // Standard sizes first, then any unexpected size found in orders, then "One size".
  const extra = new Set();
  for (const r of products) for (const s of Object.keys(r.sizes)) if (sizeRank(s) === SIZE_ORDER.length && s !== ONE_SIZE) extra.add(s);
  const sizes = [...SIZE_ORDER, ...[...extra].sort(), ONE_SIZE];

  const handedOver = paid.filter((o) => handover.get(o.orderId) && handover.get(o.orderId).handedOver).length;
  const count = (status) => counted.filter((o) => o.status === status).length;
  const money = paid.reduce((sum, o) => sum + toNumber(o.total), 0);

  const list = counted
    .map((o) => ({
      orderId: o.orderId,
      createdAt: o.createdAt,
      status: o.status,
      name: o.name,
      roll: o.roll,
      email: o.email,
      phone: o.phone,
      items: o.itemsSummary,
      total: toNumber(o.total),
      paidAt: o.paidAt,
      paymentMethod: o.paymentMethod,
      reviewFlag: o.reviewFlag,
      test: isTest(o),
      needsReview: needsReview(o),
      handedOver: Boolean(handover.get(o.orderId) && handover.get(o.orderId).handedOver),
      handoverNote: (handover.get(o.orderId) && handover.get(o.orderId).note) || ''
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return {
    metrics: {
      paidOrders: paid.length,
      moneyCollected: Math.round(money * 100) / 100,
      itemsSold,
      itemsPrinted,
      handedOver,
      toHandOver: paid.length - handedOver,
      awaiting: count('Awaiting Payment'),
      failedOrExpired: count('Failed') + count('Expired'),
      needsReview: counted.filter(needsReview).length
    },
    sizes,
    products,
    printedNames,
    orders: list
  };
}

module.exports = {
  COOKIE,
  SESSION_MS,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  adminEnabled,
  hashPassword,
  isPasswordHash,
  verifyPasswordHash,
  credential,
  login,
  changePassword,
  createSession,
  verifySession,
  readCookie,
  isAuthenticated,
  _resetForTests,
  sessionCookie,
  clearedCookie,
  isTest,
  needsReview,
  summarise
};
