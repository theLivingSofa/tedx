'use strict';
/*
 * GET /api/catalogue — public catalogue + store settings (CONTRACT 5.1).
 * Owner: sheets-catalogue.
 */

const { applyCors, allowMethods, sendJson, withErrorHandling } = require('../lib/http.js');
const { getCatalogue, getConfig } = require('../lib/sheets.js');

const DEFAULT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const CACHE_CONTROL = 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';

function sizes() {
  try {
    const { SIZES } = require('../lib/validate.js');
    if (Array.isArray(SIZES) && SIZES.length) return SIZES.slice();
  } catch (_) {
    /* validate.js unavailable — use the contract list */
  }
  return DEFAULT_SIZES.slice();
}

/** Same rules as CONTRACT 3 (PAYMENT_MODE / CASHFREE_ENV / ALLOW_MOCK_IN_PRODUCTION). */
function paymentFromEnv() {
  const e = process.env;
  const environment = String(e.CASHFREE_ENV || '').trim().toLowerCase() === 'production' ? 'production' : 'sandbox';
  const forced = String(e.PAYMENT_MODE || '').trim().toLowerCase();
  const hasKeys = Boolean(e.CASHFREE_APP_ID && e.CASHFREE_SECRET_KEY);
  let mode;
  if (forced === 'mock') mode = 'mock';
  else if (forced === 'cashfree') mode = hasKeys ? 'cashfree' : 'unavailable';
  else mode = hasKeys ? 'cashfree' : 'mock';
  if (mode === 'mock' && e.VERCEL_ENV === 'production' &&
      String(e.ALLOW_MOCK_IN_PRODUCTION || '').trim().toLowerCase() !== 'true') {
    mode = 'unavailable';
  }
  return { mode, environment };
}

function payment() {
  let info = null;
  try {
    const cf = require('../lib/cashfree.js');
    if (typeof cf.paymentMode === 'function' && typeof cf.environment === 'function') {
      info = { mode: cf.paymentMode(), environment: cf.environment() };
    }
  } catch (_) {
    info = null;
  }
  if (!info) info = paymentFromEnv();
  // The public shape only knows 'cashfree' | 'mock'. 'unavailable' means real payments are intended but not
  // configured: the page renders the Cashfree flow and create-order answers 503 payments_unavailable.
  return {
    mode: info.mode === 'mock' ? 'mock' : 'cashfree',
    environment: info.environment === 'production' ? 'production' : 'sandbox'
  };
}

function publicProduct(p, maxQuantityPerSku) {
  const available = p.stock === null || p.stock === undefined || p.stock > 0;
  const maxQuantity = !available
    ? 0
    : p.stock === null || p.stock === undefined
      ? maxQuantityPerSku
      : Math.min(maxQuantityPerSku, p.stock);
  return {
    sku: p.sku,
    name: p.name,
    price: p.price,
    category: p.category,
    apparel: p.apparel,
    printing: p.printing,
    imageUrl: p.imageUrl,
    available,
    maxQuantity
  };
}

async function handler(req, res) {
  if (applyCors(req, res, { methods: ['GET'] })) return;
  if (!allowMethods(req, res, ['GET'])) return;

  const [catalogue, config] = await Promise.all([getCatalogue(), getConfig()]);
  const products = catalogue.products
    .filter((p) => p.active)
    .map((p) => publicProduct(p, config.maxQuantityPerSku));

  sendJson(
    res,
    200,
    {
      products,
      sizes: sizes(),
      printingCharge: config.printingCharge,
      maxQuantityPerSku: config.maxQuantityPerSku,
      storeOpen: config.storeOpen,
      source: catalogue.source,
      payment: payment()
    },
    { 'Cache-Control': CACHE_CONTROL }
  );
}

module.exports = withErrorHandling(handler);
