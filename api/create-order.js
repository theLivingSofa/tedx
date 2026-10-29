'use strict';
/*
 * POST /api/create-order (CONTRACT 5.2). Owner: payments.
 * Prices are always computed server-side from the catalogue; client totals are never accepted.
 */

const {
  HttpError, sendJson, readJsonBody, applyCors, allowMethods, getSiteUrl, log, withErrorHandling
} = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const { validateOrderRequest } = require('../lib/validate');
const { priceOrder, summariseItems } = require('../lib/pricing');
const { generateOrderId, generateToken, hashToken } = require('../lib/tokens');
const sheets = require('../lib/sheets');
const cashfree = require('../lib/cashfree');
const { STATUSES, customerIdFor, storageUnavailable, isHttpError, addFlag } = require('../lib/orders');
const brand = require('../public/config/brand.js');

const AVAILABILITY_CODES = new Set(['unknown_sku', 'inactive', 'out_of_stock', 'insufficient_stock']);
const FIELD_FOR_CODE = {
  size_required: 'size',
  size_not_applicable: 'size',
  printing_not_available: 'printing',
  printed_name_required: 'printedName',
  quantity_limit: 'quantity',
  duplicate_sku: 'sku'
};

function expiryMinutes() {
  const n = parseInt(process.env.ORDER_EXPIRY_MINUTES || '', 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(Math.max(n, 16), 30 * 24 * 60); // Cashfree needs >= 15 min; cap at 30 days
}

async function storage(op, fn) {
  try {
    return await fn();
  } catch (e) {
    if (isHttpError(e)) throw e;
    log('error', 'storage_failed', { op, message: e && e.message });
    throw storageUnavailable();
  }
}

function pricingErrors(errors) {
  const unavailable = {};
  const invalid = {};
  for (const err of errors) {
    const i = Number.isInteger(err.index) ? err.index : 0;
    if (AVAILABILITY_CODES.has(err.code)) {
      unavailable[`items[${i}]`] = err.message || 'This item is not available.';
    } else {
      const sub = FIELD_FOR_CODE[err.code];
      invalid[sub ? `items[${i}].${sub}` : `items[${i}]`] = err.message || 'Please check this item.';
    }
  }
  if (Object.keys(unavailable).length) {
    return new HttpError(409, 'item_unavailable',
      'Some items in your cart are no longer available. Please update your cart.', { fields: unavailable });
  }
  return new HttpError(400, 'validation_failed', 'Please check the highlighted fields.', { fields: invalid });
}

module.exports = withErrorHandling(async (req, res) => {
  if (!enforceRateLimit(req, res, 'create-order', { limit: 10, windowMs: 60000 })) return;
  if (applyCors(req, res, { methods: ['POST'] })) return;
  if (!allowMethods(req, res, ['POST'])) return;

  const body = await readJsonBody(req);
  const v = validateOrderRequest(body);
  if (!v.ok) throw new HttpError(400, 'validation_failed', 'Please check the highlighted fields.', { fields: v.fields });
  const { customer, items } = v.value;

  const config = await storage('getConfig', () => sheets.getConfig());
  if (!config.storeOpen) throw new HttpError(503, 'store_closed', 'The store is closed for new orders right now.');

  const catalogue = await storage('getCatalogue', () => sheets.getCatalogue());
  const priced = priceOrder(items, catalogue.products, {
    printingCharge: config.printingCharge,
    maxQuantityPerSku: config.maxQuantityPerSku
  });
  if (!priced.ok) throw pricingErrors(priced.errors || []);

  // 'unavailable' covers PAYMENT_MODE=cashfree without keys and mock refused on VERCEL_ENV=production.
  const mode = cashfree.paymentMode();
  if (mode !== 'cashfree' && mode !== 'mock') {
    throw new HttpError(503, 'payments_unavailable', 'Online payments are not available right now. Please try again later.');
  }

  const now = new Date();
  const orderId = generateOrderId(brand.orderIdPrefix, now);
  const token = generateToken();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiryMinutes() * 60000).toISOString();

  const record = {
    orderId,
    createdAt,
    updatedAt: createdAt,
    status: STATUSES.AWAITING,
    name: customer.name,
    roll: customer.roll,
    email: customer.email,
    phone: customer.phone,
    itemsSummary: summariseItems(priced.lines),
    items: priced.lines,
    subtotal: priced.subtotal,
    printingTotal: priced.printingTotal,
    total: priced.total,
    currency: 'INR',
    notes: customer.notes || '',
    tokenHash: hashToken(token),
    paymentMode: mode,
    gatewayOrderId: '',
    gatewayStatus: '',
    paymentId: '',
    paymentMethod: '',
    paidAt: '',
    expiresAt,
    emailSentAt: '',
    reviewFlag: cashfree.testPaymentFlag(mode)
  };
  await storage('appendOrder', () => sheets.appendOrder(record));

  const siteUrl = String(getSiteUrl(req) || '').replace(/\/+$/, '');
  let gw;
  try {
    gw = await cashfree.createGatewayOrder({
      orderId,
      amount: priced.total,
      customer: { id: customerIdFor(customer.email), name: customer.name, email: customer.email, phone: customer.phone },
      returnUrl: `${siteUrl}/order?id=${encodeURIComponent(orderId)}`,
      notifyUrl: /^https:\/\//i.test(siteUrl) ? `${siteUrl}/api/cashfree-webhook` : undefined,
      expiresAt,
      note: `${brand.organisation} merch order`.slice(0, 200)
    });
  } catch (e) {
    log('warn', 'gateway_create_failed', { orderId, upstreamStatus: e && e.upstreamStatus, code: e && e.cfCode });
    try {
      await sheets.updateOrder(orderId, { status: STATUSES.FAILED, reviewFlag: addFlag(record.reviewFlag, 'GATEWAY_CREATE_FAILED') });
    } catch (_) {
      log('error', 'storage_failed', { op: 'updateOrder', orderId });
    }
    if (isHttpError(e) && e.code === 'payments_unavailable') throw e;
    throw new HttpError(502, 'gateway_error', 'We could not start the payment. Please try again in a moment.');
  }

  try {
    await sheets.updateOrder(orderId, { gatewayOrderId: gw.gatewayOrderId || '', gatewayStatus: gw.status || 'ACTIVE' });
  } catch (_) {
    // The order exists at the gateway and in storage; syncs key on orderId, so this is not fatal.
    log('warn', 'storage_failed', { op: 'updateOrder', orderId });
  }

  log('info', 'order_created', { orderId, mode, total: priced.total, lines: priced.lines.length });
  sendJson(res, 201, {
    orderId,
    token,
    paymentSessionId: gw.paymentSessionId,
    paymentMode: mode,
    environment: cashfree.environment(),
    total: priced.total,
    currency: 'INR',
    expiresAt
  });
});
