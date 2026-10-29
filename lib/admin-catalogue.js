'use strict';
/*
 * Validation for products edited on the /admin-products page. Mirrors the rules the store applies when it
 * reads the Catalogue tab (lib/sheets.js normaliseProduct), but reports problems per field instead of
 * silently skipping the row, so organisers see what to fix.
 */

const brand = require('../public/config/brand.js');

const SKU_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const MAX_PRICE = 100000;
const MAX_STOCK = 100000;
const FIELDS = ['sku', 'name', 'price', 'category', 'apparel', 'printing', 'imageUrl', 'active', 'stock'];
// Image hosts the site's Content-Security-Policy allows (vercel.json img-src).
const IMAGE_HOSTS = [/^drive\.google\.com$/i, /\.googleusercontent\.com$/i];

function sectionIds() {
  return (brand.sections || []).map((s) => s.id);
}

/** Google Drive share links -> the thumbnail URL the store can display. Anything else is returned as is. */
function driveThumbnail(url) {
  const m = /^https:\/\/drive\.google\.com\/(?:file\/d\/([A-Za-z0-9_-]{10,})|open\?id=([A-Za-z0-9_-]{10,})|uc\?(?:[^#]*&)?id=([A-Za-z0-9_-]{10,}))/.exec(url);
  if (!m) return url;
  return `https://drive.google.com/thumbnail?id=${m[1] || m[2] || m[3]}&sz=w1200`;
}

function cleanImage(v, errors) {
  if (v == null || String(v).trim() === '') return '';
  const s = driveThumbnail(String(v).trim());
  if (/[\s"'<>\\`]/.test(s) || s.length > 500) { errors.imageUrl = 'That image link is not valid.'; return ''; }
  if (s.startsWith('/images/')) {
    if (s.includes('..') || s.includes('//')) { errors.imageUrl = 'That image path is not valid.'; return ''; }
    return s;
  }
  let u;
  try { u = new URL(s); } catch (_) { u = null; }
  if (!u || u.protocol !== 'https:') { errors.imageUrl = 'Use a Google Drive link or a /images/… path.'; return ''; }
  if (!IMAGE_HOSTS.some((re) => re.test(u.hostname))) {
    errors.imageUrl = 'Images must be on Google Drive (shared as "Anyone with the link") or in /images/. Other sites are blocked by the store.';
    return '';
  }
  return s;
}

function toBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null || v === '') return fallback;
  return null;
}

/**
 * input: plain object from the browser. Returns { ok, product, errors } where errors maps field -> message.
 * Unknown fields are rejected so typos never silently do nothing.
 */
function validateProduct(input) {
  const errors = {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const k of Object.keys(src)) if (!FIELDS.includes(k)) errors[k] = 'Unknown field.';

  const sku = String(src.sku == null ? '' : src.sku).trim().toUpperCase();
  if (!SKU_RE.test(sku)) errors.sku = 'SKU must be 2–20 capital letters, digits or dashes, e.g. HOD-004.';

  const name = String(src.name == null ? '' : src.name).replace(/\s+/g, ' ').trim();
  if (!name) errors.name = 'Enter a product name.';
  else if (name.length > 80) errors.name = 'Keep the name under 80 characters.';

  const price = typeof src.price === 'number' ? src.price : Number(String(src.price == null ? '' : src.price).replace(/,/g, '').trim());
  if (!Number.isFinite(price) || price <= 0 || price > MAX_PRICE) errors.price = `Price must be more than ₹0 and at most ₹${MAX_PRICE.toLocaleString('en-IN')}.`;
  else if (Math.round(price * 100) !== price * 100) errors.price = 'Use at most 2 decimals.';

  const category = String(src.category == null ? '' : src.category).trim();
  if (!sectionIds().includes(category)) errors.category = `Choose one of: ${sectionIds().join(', ')}.`;

  const apparel = toBool(src.apparel, false);
  const printing = toBool(src.printing, false);
  const active = toBool(src.active, true);
  if (apparel === null) errors.apparel = 'Must be true or false.';
  if (printing === null) errors.printing = 'Must be true or false.';
  if (active === null) errors.active = 'Must be true or false.';

  let stock = null;
  if (src.stock !== undefined && src.stock !== null && String(src.stock).trim() !== '') {
    const n = typeof src.stock === 'number' ? src.stock : Number(String(src.stock).trim());
    if (!Number.isInteger(n) || n < 0 || n > MAX_STOCK) errors.stock = 'Stock must be a whole number (0 = sold out), or empty for unlimited.';
    else stock = n;
  }

  const imageUrl = cleanImage(src.imageUrl, errors);

  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    product: ok ? { sku, name, price: Math.round(price * 100) / 100, category, apparel, printing, imageUrl, active, stock } : null
  };
}

module.exports = { validateProduct, driveThumbnail, FIELDS, SKU_RE };
