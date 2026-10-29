'use strict';
/*
 * Order access tokens and order IDs (CONTRACT 6.2). Owner: security-infra.
 *
 * The token is a 256-bit bearer secret handed to the customer once; only its sha256 is stored.
 * Order IDs are not secret (they appear in URLs and receipts) — the token is what authorises access.
 */

const crypto = require('node:crypto');

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const PREFIX_RE = /^[A-Z0-9]{1,8}$/;
const ORDER_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // A–Z and 2–9 without I, O (32 symbols)
const ORDER_ID_RANDOM_LENGTH = 6;

/** 32 random bytes, base64url (43 chars, no padding). */
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** sha256 hex of the token. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Constant-time string comparison. Both inputs are hashed first so the comparison takes the same
 * time whatever the lengths; a length mismatch still returns false, but only after the full compare.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  const same = crypto.timingSafeEqual(ha, hb);
  return same && Buffer.byteLength(a, 'utf8') === Buffer.byteLength(b, 'utf8');
}

/** true iff sha256(token) equals tokenHash; constant-time; false for non-string or malformed input. */
function verifyToken(token, tokenHash) {
  if (typeof token !== 'string' || typeof tokenHash !== 'string') return false;
  if (!TOKEN_RE.test(token)) return false;
  const expectedHex = tokenHash.trim().toLowerCase();
  if (!HASH_RE.test(expectedHex)) return false;
  const actual = crypto.createHash('sha256').update(token, 'utf8').digest();
  const expected = Buffer.from(expectedHex, 'hex');
  return crypto.timingSafeEqual(actual, expected);
}

/** Unbiased random string over `alphabet` using rejection sampling on crypto random bytes. */
function randomString(length, alphabet) {
  const n = alphabet.length;
  const ceiling = 256 - (256 % n); // bytes >= ceiling are rejected to avoid modulo bias
  let out = '';
  while (out.length < length) {
    const bytes = crypto.randomBytes(Math.max(8, (length - out.length) * 2));
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < ceiling) out += alphabet[bytes[i] % n];
    }
  }
  return out;
}

const IST_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** YYYYMMDD of `date` on the Asia/Kolkata calendar (organisers are in India). */
function istDateStamp(date) {
  const parts = {};
  for (const p of IST_DATE.formatToParts(date)) parts[p.type] = p.value;
  return `${parts.year}${parts.month}${parts.day}`;
}

function defaultPrefix() {
  try {
    // eslint-disable-next-line global-require
    return require('../public/config/brand.js').orderIdPrefix;
  } catch {
    return 'ORDER';
  }
}

/**
 * `${prefix}-${YYYYMMDD}-${6 chars}` e.g. TEDX-20261029-K3F9QZ.
 * @param {string} [prefix] letters/digits, max 8 (defaults to brand.orderIdPrefix); upper-cased
 * @param {Date} [date]
 */
function generateOrderId(prefix, date = new Date()) {
  const p = String(prefix === undefined || prefix === null || prefix === '' ? defaultPrefix() : prefix)
    .trim()
    .toUpperCase();
  if (!PREFIX_RE.test(p)) throw new TypeError('generateOrderId: prefix must be 1–8 letters or digits');
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError('generateOrderId: invalid date');
  return `${p}-${istDateStamp(d)}-${randomString(ORDER_ID_RANDOM_LENGTH, ORDER_ID_ALPHABET)}`;
}

module.exports = {
  generateToken,
  hashToken,
  verifyToken,
  safeEqual,
  generateOrderId
};
