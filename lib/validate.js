'use strict';
/*
 * Request validation for POST /api/create-order (CONTRACT 5.2 + 6.3). Owner: security-infra.
 *
 * Structural checks only — catalogue rules (apparel, printing offered, stock) live in lib/pricing.js.
 * Every validator returns ALL problems at once:
 *   { ok: true, value } | { ok: false, fields: { <path>: <user-facing message> } }
 * Paths: name | roll | email | phone | notes, items, items[i], items[i].<field>, and `_` for
 * unexpected fields / wrong shapes. Length limits are checked before any regex runs.
 */

const SIZES = Object.freeze(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']);
const MAX_QTY = 20;
const MAX_ITEMS = 50;

const ORDER_ID_RE = /^[A-Z0-9]{1,8}-\d{8}-[A-Z2-9]{6}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ORDER_KEYS = new Set(['customer', 'items']);
const CUSTOMER_KEYS = new Set(['name', 'roll', 'email', 'phone', 'notes']);
const ITEM_KEYS = new Set(['sku', 'quantity', 'size', 'printing', 'printedName']);

const NAME_RE = /^\p{L}[\p{L}\p{M} .'-]*$/u;
const ROLL_RE = /^[A-Za-z0-9/_ -]+$/;
const EMAIL_LOCAL_RE = /^[a-z0-9_%+'-]+(?:\.[a-z0-9_%+'-]+)*$/;
const EMAIL_DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const PHONE_RE = /^(?:\+91|91|0)?([6-9]\d{9})$/;
const PRINTED_NAME_RE = /^[A-Za-z0-9 .'&-]+$/;
const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const HAS_ALNUM = /[A-Za-z0-9]/;

const MSG = {
  body: 'Send the order as a JSON object.',
  customer: 'Customer details are missing or invalid.',
  name: 'Enter your full name (2–80 letters; spaces and . \' - allowed).',
  roll: 'Enter your roll number (up to 30 letters, digits, spaces or / _ -).',
  email: 'Enter a valid email address.',
  phone: 'Enter a valid 10-digit Indian mobile number.',
  notes: 'Notes must be text of at most 500 characters.',
  itemsMissing: 'Add at least one item to your order.',
  itemsList: 'Items must be a list.',
  itemsTooMany: `You can order at most ${MAX_ITEMS} different products at once.`,
  item: 'This item is invalid.',
  sku: 'Choose a valid product.',
  duplicate: 'This product is already in your order — change its quantity instead.',
  quantity: `Quantity must be a whole number from 1 to ${MAX_QTY}.`,
  size: 'Choose a valid size.',
  printing: 'Printing must be turned on or off.',
  printedName: 'Enter the name to print (1–20 letters, digits, spaces or . \' & -).',
  printedNameUnexpected: 'Remove the printed name or turn on name printing.'
};

/* ---------------------------------------------------------------- helpers */

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function charLength(s) {
  let n = 0;
  for (const _ of s) n++; // code points, not UTF-16 units
  return n;
}

function setOnce(fields, path, message) {
  if (!Object.prototype.hasOwnProperty.call(fields, path)) fields[path] = message;
}

function displayKey(key) {
  const k = String(key).replace(/[^\w$.-]/g, '?');
  return k.length > 40 ? `${k.slice(0, 40)}…` : k;
}

/** Records the first unexpected key (incl. __proto__/constructor/prototype) under `_`. */
function checkKeys(obj, allowed, prefix, fields) {
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(k) || !allowed.has(k)) {
      setOnce(fields, '_', `Unexpected field: ${prefix}${displayKey(k)}`);
      return false;
    }
  }
  return true;
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** NFC, typographic apostrophes -> ', trim, collapse whitespace runs to one space. */
function normaliseLine(s) {
  return s.normalize('NFC').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
}

function result(fields, value) {
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value };
}

/* ---------------------------------------------------------------- fields */

function checkName(raw) {
  if (typeof raw !== 'string' || raw.length > 400) return { error: MSG.name };
  const v = normaliseLine(raw);
  const len = charLength(v);
  if (len < 2 || len > 80 || !NAME_RE.test(v)) return { error: MSG.name };
  return { value: v };
}

function checkRoll(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return { error: MSG.roll };
  const v = normaliseLine(raw);
  if (v.length < 1 || v.length > 30 || !ROLL_RE.test(v) || !HAS_ALNUM.test(v)) return { error: MSG.roll };
  return { value: v };
}

function checkEmail(raw) {
  if (typeof raw !== 'string' || raw.length > 400) return { error: MSG.email };
  const v = raw.normalize('NFC').trim().toLowerCase();
  if (v.length < 6 || v.length > 254) return { error: MSG.email };
  const at = v.indexOf('@');
  if (at < 1 || at !== v.lastIndexOf('@')) return { error: MSG.email };
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (local.length > 64 || domain.length < 4 || domain.length > 253) return { error: MSG.email };
  if (!EMAIL_LOCAL_RE.test(local) || !EMAIL_DOMAIN_RE.test(domain)) return { error: MSG.email };
  return { value: v };
}

function checkPhone(raw) {
  if (typeof raw !== 'string' || raw.length > 30) return { error: MSG.phone };
  const compact = raw.trim().replace(/[\s-]/g, '');
  if (compact.length > 14) return { error: MSG.phone };
  const m = PHONE_RE.exec(compact);
  if (!m) return { error: MSG.phone };
  return { value: m[1] };
}

function checkNotes(raw) {
  if (raw === undefined || raw === null) return { value: '' };
  if (typeof raw !== 'string' || raw.length > 4000) return { error: MSG.notes };
  const v = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // control characters except newline, plus bidi overrides/isolates and BOM
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩﻿]/g, '')
    .replace(/[  ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (charLength(v) > 500) return { error: MSG.notes };
  return { value: v };
}

/* ------------------------------------------------------------- validators */

/**
 * Validates and normalises customer details.
 * @returns {{ok:true, value:{name,roll,email,phone,notes}} | {ok:false, fields:object}}
 */
function validateCustomer(customer) {
  const fields = {};
  if (customer === undefined || customer === null) customer = {};
  if (!isPlainObject(customer)) return { ok: false, fields: { _: MSG.customer } };
  checkKeys(customer, CUSTOMER_KEYS, 'customer.', fields);

  const value = {};
  const checks = [
    ['name', checkName],
    ['roll', checkRoll],
    ['email', checkEmail],
    ['phone', checkPhone],
    ['notes', checkNotes]
  ];
  for (const [key, fn] of checks) {
    const r = fn(has(customer, key) ? customer[key] : undefined);
    if (r.error) setOnce(fields, key, r.error);
    else value[key] = r.value;
  }
  return result(fields, value);
}

/**
 * Validates the item list structurally (no catalogue lookups).
 * @returns {{ok:true, value:Array<{sku,quantity,size,printing,printedName}>} | {ok:false, fields:object}}
 */
function validateItems(items) {
  const fields = {};
  if (items === undefined || items === null) return { ok: false, fields: { items: MSG.itemsMissing } };
  if (!Array.isArray(items)) return { ok: false, fields: { items: MSG.itemsList } };
  if (items.length === 0) return { ok: false, fields: { items: MSG.itemsMissing } };
  if (items.length > MAX_ITEMS) return { ok: false, fields: { items: MSG.itemsTooMany } };

  const value = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const p = `items[${i}]`;
    if (!isPlainObject(item)) {
      setOnce(fields, p, MSG.item);
      continue;
    }
    checkKeys(item, ITEM_KEYS, `${p}.`, fields);

    // sku
    let sku = null;
    const rawSku = item.sku;
    if (typeof rawSku === 'string' && rawSku.length <= 40) {
      const s = rawSku.trim().toUpperCase();
      if (SKU_RE.test(s)) sku = s;
    }
    if (sku === null) setOnce(fields, `${p}.sku`, MSG.sku);
    else if (seen.has(sku)) setOnce(fields, `${p}.sku`, MSG.duplicate);
    else seen.add(sku);

    // quantity: a real JSON integer only (numeric strings rejected)
    const q = item.quantity;
    const quantityOk = typeof q === 'number' && Number.isInteger(q) && q >= 1 && q <= MAX_QTY;
    if (!quantityOk) setOnce(fields, `${p}.quantity`, MSG.quantity);

    // size: optional here (pricing decides whether the product needs one); '' / null = none
    let size = '';
    if (has(item, 'size') && item.size !== null && item.size !== undefined) {
      if (typeof item.size !== 'string' || item.size.length > 10) {
        setOnce(fields, `${p}.size`, MSG.size);
      } else {
        const s = item.size.trim().toUpperCase();
        if (s !== '' && !SIZES.includes(s)) setOnce(fields, `${p}.size`, MSG.size);
        else size = s;
      }
    }

    // printing: boolean only (no "true"/1)
    let printing = false;
    if (has(item, 'printing')) {
      if (typeof item.printing !== 'boolean') setOnce(fields, `${p}.printing`, MSG.printing);
      else printing = item.printing;
    }

    // printedName: required iff printing === true; otherwise absent or empty
    let printedName = '';
    const rawName = has(item, 'printedName') ? item.printedName : undefined;
    if (printing === true) {
      if (typeof rawName !== 'string' || rawName.length > 100) {
        setOnce(fields, `${p}.printedName`, MSG.printedName);
      } else {
        const n = normaliseLine(rawName);
        if (n.length < 1 || n.length > 20 || !PRINTED_NAME_RE.test(n) || !HAS_ALNUM.test(n)) {
          setOnce(fields, `${p}.printedName`, MSG.printedName);
        } else {
          printedName = n;
        }
      }
    } else if (rawName !== undefined && rawName !== null) {
      if (typeof rawName !== 'string' || rawName.trim() !== '') {
        setOnce(fields, `${p}.printedName`, MSG.printedNameUnexpected);
      }
    }

    value.push({ sku: sku || '', quantity: quantityOk ? q : 0, size, printing, printedName });
  }
  return result(fields, value);
}

/**
 * Validates the whole create-order body.
 * @returns {{ok:true, value:{customer, items}} | {ok:false, fields:object}}
 */
function validateOrderRequest(body) {
  if (!isPlainObject(body)) return { ok: false, fields: { _: MSG.body } };
  const fields = {};
  checkKeys(body, ORDER_KEYS, '', fields);

  const c = validateCustomer(has(body, 'customer') ? body.customer : undefined);
  const it = validateItems(has(body, 'items') ? body.items : undefined);
  for (const r of [c, it]) {
    if (!r.ok) for (const [k, v] of Object.entries(r.fields)) setOnce(fields, k, v);
  }
  if (Object.keys(fields).length) return { ok: false, fields };
  return { ok: true, value: { customer: c.value, items: it.value } };
}

/** Order ID shape, e.g. TEDX-20261029-K3F9QZ. */
function validateOrderId(id) {
  return typeof id === 'string' && id.length <= 30 && ORDER_ID_RE.test(id);
}

/** Access token shape: 43 base64url characters. */
function validateTokenFormat(token) {
  return typeof token === 'string' && token.length === 43 && TOKEN_RE.test(token);
}

module.exports = {
  SIZES,
  MAX_QTY,
  validateOrderRequest,
  validateCustomer,
  validateItems,
  validateOrderId,
  validateTokenFormat
};
