'use strict';
// End-to-end flow in demo mode: PAYMENT_MODE=mock + LOCAL storage (no Google / Cashfree env).
// Handlers in api/*.js are called directly with fake Node req/res objects (CONTRACT 5).
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./helpers/http-mock.js');

const SITE_URL = h.SITE_URL;
const MESSAGES = {
  Paid: 'Payment received. Your order is confirmed.',
  'Awaiting Payment': 'We are waiting for confirmation from the payment gateway. This page updates automatically.',
  Failed: 'The payment did not go through. No money was taken, or it will be refunded automatically by your bank.',
  Expired: 'This order expired before payment was completed. Please place a new order.'
};

let ctx = null;

/** Fresh env + fresh modules + fresh LOCAL_DATA_DIR. `patch(sheets)` runs before any handler is loaded. */
function boot(env = {}, patch) {
  if (ctx) h.removeDir(ctx.dataDir);
  const dataDir = h.makeTempDir('tedx-flow-');
  h.setEnv({ LOCAL_DATA_DIR: dataDir, PAYMENT_MODE: 'mock', SITE_URL, ...env });
  h.freshModules();
  const sheets = h.requireLib('sheets');
  if (patch) patch(sheets);
  const cache = {};
  ctx = {
    dataDir,
    sheets,
    api(name) {
      if (!cache[name]) cache[name] = h.loadHandler(name);
      return cache[name];
    }
  };
  return ctx;
}

function orderBody(overrides = {}) {
  return {
    customer: { name: 'Asha Verma', roll: 'IPM2023-045', email: 'Asha@Example.com', phone: '+91 98765-43210', notes: 'Hostel B' },
    items: [
      { sku: 'HOD-001', quantity: 2, size: 'M', printing: true, printedName: 'ASHA' },
      { sku: 'MUG-001', quantity: 1 }
    ],
    ...overrides
  };
}

function createOrder(body = orderBody(), extra = {}) {
  return h.postJson(ctx.api('create-order'), '/api/create-order', body, extra);
}

async function createOk(body) {
  const r = await createOrder(body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

function orderStatus(id, token, extra = {}) {
  const q = new URLSearchParams();
  if (id !== undefined) q.set('id', id);
  if (token !== undefined) q.set('token', token);
  return h.invoke(ctx.api('order-status'), { method: 'GET', url: '/api/order-status?' + q.toString(), ...extra });
}

function verifyPayment(orderId, token) {
  return h.postJson(ctx.api('verify-payment'), '/api/verify-payment', { orderId, token });
}

function mockPay(orderId, token, outcome) {
  return h.postJson(ctx.api('mock-pay'), '/api/mock-pay', { orderId, token, outcome });
}

function reconcile(authorization, method = 'GET') {
  const headers = authorization === undefined ? {} : { authorization };
  return h.invoke(ctx.api('reconcile'), { method, url: '/api/reconcile', headers });
}

function assertError(r, status, code) {
  assert.equal(r.status, status, `expected ${status} ${code}, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(r.body && r.body.error, 'error shape { error: {...} }');
  assert.equal(r.body.error.code, code);
  assert.equal(typeof r.body.error.message, 'string');
  assert.ok(r.body.error.message.length > 0);
  assert.match(String(r.headers['content-type']), /^application\/json/);
  assert.doesNotMatch(r.text, /\n\s+at\s|Error:\s.*\.js:\d+/, 'no stack traces in responses');
}

function readOrdersFile() {
  const file = path.join(ctx.dataDir, 'orders.json');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

beforeEach(() => { boot(); });
afterEach(() => {
  if (ctx) h.removeDir(ctx.dataDir);
  ctx = null;
  h.restoreEnv();
});

describe('GET /api/catalogue', () => {
  it('returns the contract shape from the fallback catalogue', async () => {
    const r = await h.invoke(ctx.api('catalogue'), { method: 'GET', url: '/api/catalogue' });
    assert.equal(r.status, 200, r.text);
    assert.match(String(r.headers['content-type']), /^application\/json; charset=utf-8/i);
    assert.match(String(r.headers['cache-control']), /s-maxage=60/);
    const b = r.body;
    assert.deepEqual(b.sizes, ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']);
    assert.equal(b.printingCharge, 0);
    assert.equal(b.maxQuantityPerSku, 20);
    assert.equal(b.storeOpen, true);
    assert.equal(b.source, 'fallback');
    assert.deepEqual(b.payment, { mode: 'mock', environment: 'sandbox' });
    assert.ok(Array.isArray(b.products));
    assert.equal(b.products.length, 30);
    assert.equal(b.products[0].sku, 'HOD-001', 'order as in the file');
    assert.deepEqual(b.products[0], {
      sku: 'HOD-001', name: 'Hoodie', price: 750, category: 'Winter', apparel: true, printing: true,
      imageUrl: '/images/hoodie-black.svg', available: true, maxQuantity: 20
    });
    for (const p of b.products) {
      assert.deepEqual(Object.keys(p).sort(), ['apparel', 'available', 'category', 'imageUrl', 'maxQuantity', 'name', 'price', 'printing', 'sku']);
      assert.ok(!('stock' in p), 'raw stock is not exposed');
      assert.ok(['Winter', 'Summer', 'Accessories'].includes(p.category), p.sku);
    }
    assert.equal(b.products.find((p) => p.sku === 'MAG-005').category, 'Accessories');
  });

  it('405 with Allow header for a wrong method', async () => {
    const r = await h.invoke(ctx.api('catalogue'), { method: 'DELETE', url: '/api/catalogue' });
    assertError(r, 405, 'method_not_allowed');
    assert.match(String(r.headers.allow), /GET/);
  });
});

describe('POST /api/create-order', () => {
  it('happy path: 201 with server-computed total; row stored with token hash only', async () => {
    const before = Date.now();
    const r = await createOrder();
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    const b = r.body;
    assert.match(b.orderId, /^TEDX-\d{8}-[A-Z2-9]{6}$/);
    assert.match(b.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(typeof b.paymentSessionId, 'string');
    assert.match(b.paymentSessionId, /^mock_session_/);
    assert.equal(b.paymentMode, 'mock');
    assert.equal(b.environment, 'sandbox');
    assert.equal(b.total, 1630);
    assert.equal(b.currency, 'INR');
    const exp = Date.parse(b.expiresAt);
    assert.ok(exp >= before + 29 * 60000 && exp <= Date.now() + 31 * 60000, 'expiresAt ≈ now + 30 min');

    const rec = await ctx.sheets.getOrder(b.orderId);
    assert.ok(rec, 'order row written');
    assert.equal(rec.status, 'Awaiting Payment');
    assert.equal(rec.total, 1630);
    assert.equal(rec.subtotal, 1630);
    assert.equal(rec.printingTotal, 0);
    assert.equal(rec.currency, 'INR');
    assert.equal(rec.email, 'asha@example.com');
    assert.equal(rec.phone, '9876543210');
    assert.equal(rec.paymentMode, 'mock');
    assert.equal(rec.gatewayOrderId, 'mock_' + b.orderId);
    assert.equal(rec.itemsSummary, 'HOD-001 Hoodie (M, print: "ASHA") ×2; MUG-001 White Ceramic Mug ×1');
    assert.equal(rec.items.length, 2);
    assert.equal(rec.tokenHash, crypto.createHash('sha256').update(b.token).digest('hex'));
    assert.ok(!readOrdersFile().includes(b.token), 'the token itself is never stored');
  });

  it('uses the configured printing charge (PRINTING_CHARGE=50 → 1730)', async () => {
    boot({ PRINTING_CHARGE: '50' });
    const b = await createOk();
    assert.equal(b.total, 1730);
    const rec = await ctx.sheets.getOrder(b.orderId);
    assert.equal(rec.printingTotal, 100);
    assert.equal(rec.subtotal, 1630);
  });

  it('rejects a client-supplied total (400 validation_failed, fields._) and stores nothing', async () => {
    const r = await createOrder(orderBody({ total: 1 }));
    assertError(r, 400, 'validation_failed');
    assert.match(r.body.error.fields._, /total/);
    assert.equal(readOrdersFile().includes('Asha'), false);
  });

  it('rejects a client-supplied item price', async () => {
    const body = orderBody();
    body.items[1].price = 1;
    const r = await createOrder(body);
    assertError(r, 400, 'validation_failed');
    assert.match(r.body.error.fields._, /price/);
  });

  it('returns every field error at once with contract paths', async () => {
    const body = orderBody();
    body.customer.email = 'nope';
    body.customer.phone = '123';
    body.items[0].quantity = '2';
    const r = await createOrder(body);
    assertError(r, 400, 'validation_failed');
    for (const k of ['email', 'phone', 'items[0].quantity']) assert.ok(k in r.body.error.fields, k);
  });

  it('400 invalid_json for a malformed body', async () => {
    const r = await h.invoke(ctx.api('create-order'), { method: 'POST', url: '/api/create-order', body: '{"customer":' });
    assertError(r, 400, 'invalid_json');
  });

  it('413 payload_too_large above 32 KB', async () => {
    const big = JSON.stringify({ ...orderBody(), pad: 'x'.repeat(40 * 1024) });
    const r = await h.invoke(ctx.api('create-order'), { method: 'POST', url: '/api/create-order', body: big });
    assertError(r, 413, 'payload_too_large');
  });

  it('409 item_unavailable for an unknown SKU, keyed by items[i]', async () => {
    const body = orderBody();
    body.items[1].sku = 'NOPE-999';
    const r = await createOrder(body);
    assertError(r, 409, 'item_unavailable');
    assert.ok(r.body.error.fields && 'items[1]' in r.body.error.fields, JSON.stringify(r.body.error));
  });

  it('409 for inactive, out-of-stock and insufficient-stock SKUs', async () => {
    boot({}, (sheets) => {
      const original = sheets.getCatalogue;
      sheets.getCatalogue = async (...args) => {
        const c = await original.apply(sheets, args);
        return {
          ...c,
          products: c.products.map((p) => {
            if (p.sku === 'TOT-002') return { ...p, active: false };
            if (p.sku === 'BDG-001') return { ...p, stock: 0 };
            if (p.sku === 'MUG-002') return { ...p, stock: 1 };
            return p;
          })
        };
      };
    });
    for (const [sku, quantity] of [['TOT-002', 1], ['BDG-001', 1], ['MUG-002', 2]]) {
      const r = await createOrder(orderBody({ items: [{ sku: 'MUG-001', quantity: 1 }, { sku, quantity }] }));
      assertError(r, 409, 'item_unavailable');
      assert.ok('items[1]' in r.body.error.fields, `${sku}: ${JSON.stringify(r.body.error.fields)}`);
    }
    // stock 1, quantity 1 is fine
    await createOk(orderBody({ items: [{ sku: 'MUG-002', quantity: 1 }] }));
  });

  it('400 for size / printing problems found against the catalogue', async () => {
    const r1 = await createOrder(orderBody({ items: [{ sku: 'HOD-001', quantity: 1 }] }));
    assert.equal(r1.status, 400, JSON.stringify(r1.body));
    assert.equal(r1.body.error.code, 'validation_failed');
    assert.ok('items[0].size' in r1.body.error.fields, JSON.stringify(r1.body.error.fields));
    const r2 = await createOrder(orderBody({ items: [{ sku: 'MUG-001', quantity: 1, printing: true, printedName: 'ASHA' }] }));
    assert.ok([400, 409].includes(r2.status), JSON.stringify(r2.body));
  });

  it('405 with Allow: POST for GET', async () => {
    const r = await h.invoke(ctx.api('create-order'), { method: 'GET', url: '/api/create-order' });
    assertError(r, 405, 'method_not_allowed');
    assert.match(String(r.headers.allow), /POST/);
  });

  it('503 payments_unavailable when PAYMENT_MODE=cashfree has no keys', async () => {
    boot({ PAYMENT_MODE: 'cashfree' });
    const r = await createOrder();
    assertError(r, 503, 'payments_unavailable');
  });

  it('refuses mock mode on a production deployment unless ALLOW_MOCK_IN_PRODUCTION=true', async () => {
    boot({ PAYMENT_MODE: undefined, VERCEL_ENV: 'production' });
    assertError(await createOrder(), 503, 'payments_unavailable');
    boot({ PAYMENT_MODE: undefined, VERCEL_ENV: 'production', ALLOW_MOCK_IN_PRODUCTION: 'true' });
    const b = await createOk();
    assert.equal(b.paymentMode, 'mock');
  });

  it('rate limit: 429 with Retry-After after 10 requests per minute per IP', async () => {
    const ip = '198.51.100.77';
    const statuses = [];
    let limited = null;
    for (let i = 0; i < 12; i += 1) {
      const r = await createOrder(orderBody(), { ip });
      statuses.push(r.status);
      if (r.status === 429 && !limited) limited = r;
    }
    assert.ok(statuses.slice(0, 10).every((s) => s === 201), statuses.join(','));
    assert.ok(limited, `expected a 429, got ${statuses.join(',')}`);
    assertError(limited, 429, 'rate_limited');
    const retryAfter = Number(limited.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 60, `Retry-After ${limited.headers['retry-after']}`);
    // another IP is unaffected
    assert.equal((await createOrder(orderBody(), { ip: '198.51.100.78' })).status, 201);
  });
});

describe('CORS', () => {
  it('403 forbidden_origin for a foreign Origin, and nothing is stored', async () => {
    const r = await createOrder(orderBody(), { headers: { origin: 'https://evil.example' } });
    assertError(r, 403, 'forbidden_origin');
    assert.notEqual(r.headers['access-control-allow-origin'], 'https://evil.example');
    assert.equal(readOrdersFile().includes('Asha'), false);
  });

  it('403 for a foreign Origin on GET endpoints too', async () => {
    const r = await h.invoke(ctx.api('order-status'), {
      method: 'GET', url: '/api/order-status?id=TEDX-20261029-AAAAAA&token=' + 'A'.repeat(43), headers: { origin: 'https://evil.example' }
    });
    assertError(r, 403, 'forbidden_origin');
  });

  it('allows the SITE_URL origin and echoes it', async () => {
    const r = await createOrder(orderBody(), { headers: { origin: SITE_URL } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.headers['access-control-allow-origin'], SITE_URL);
  });

  it('preflight OPTIONS from the allowed origin → 204 with allow headers', async () => {
    const r = await h.invoke(ctx.api('create-order'), {
      method: 'OPTIONS', url: '/api/create-order',
      headers: { origin: SITE_URL, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], SITE_URL);
    assert.match(String(r.headers['access-control-allow-methods']), /POST/);
  });

  it('preflight OPTIONS from a foreign origin is refused', async () => {
    const r = await h.invoke(ctx.api('create-order'), {
      method: 'OPTIONS', url: '/api/create-order',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' }
    });
    assert.equal(r.status, 403);
    assert.notEqual(r.headers['access-control-allow-origin'], 'https://evil.example');
  });
});

describe('order access is token-protected (IDOR)', () => {
  it('GET /api/order-status: correct token → 200 Awaiting Payment view', async () => {
    const o = await createOk();
    const r = await orderStatus(o.orderId, o.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers['cache-control'], 'no-store');
    const v = r.body;
    assert.equal(v.orderId, o.orderId);
    assert.equal(v.status, 'Awaiting Payment');
    assert.equal(v.message, MESSAGES['Awaiting Payment']);
    assert.equal(v.paymentMode, 'mock');
    assert.equal(v.total, 1630);
    assert.equal(v.subtotal, 1630);
    assert.equal(v.printingTotal, 0);
    assert.equal(v.currency, 'INR');
    assert.equal(v.notes, 'Hostel B');
    assert.deepEqual(v.customer, { name: 'Asha Verma', roll: 'IPM2023-045', email: 'asha@example.com', phone: '******3210' });
    assert.deepEqual(v.items[0], {
      sku: 'HOD-001', name: 'Hoodie', size: 'M', printing: true, printedName: 'ASHA', quantity: 2, unitPrice: 750, printingCharge: 0, lineTotal: 1500
    });
    assert.equal(v.items[1].sku, 'MUG-001');
    assert.equal(v.items[1].lineTotal, 130);
    assert.ok(!r.text.includes(o.token), 'token not echoed');
    assert.ok(!('tokenHash' in v));
    assert.ok(!r.text.includes('9876543210'), 'full phone never returned');
  });

  it('wrong token, missing token and unknown order give the identical 404', async () => {
    const o = await createOk();
    const otherToken = 'B'.repeat(43);
    const wrong = await orderStatus(o.orderId, otherToken);
    const missing = await orderStatus(o.orderId, undefined);
    const unknown = await orderStatus('TEDX-20261029-ZZZZZZ', o.token);
    const garbage = await orderStatus('../../etc/passwd', 'x');
    for (const r of [wrong, missing, unknown, garbage]) assertError(r, 404, 'not_found');
    assert.deepEqual(wrong.body, unknown.body);
    assert.deepEqual(missing.body, unknown.body);
    assert.deepEqual(garbage.body, unknown.body);
  });

  it('POST /api/verify-payment: wrong token and unknown order give the identical 404', async () => {
    const o = await createOk();
    const wrong = await verifyPayment(o.orderId, 'C'.repeat(43));
    const unknown = await verifyPayment('TEDX-20261029-ZZZZZZ', o.token);
    const missing = await h.postJson(ctx.api('verify-payment'), '/api/verify-payment', { orderId: o.orderId });
    for (const r of [wrong, unknown]) assertError(r, 404, 'not_found');
    assert.deepEqual(wrong.body, unknown.body);
    assert.ok([400, 404].includes(missing.status));
    // another customer's token cannot read this order
    const other = await createOk();
    assertError(await verifyPayment(o.orderId, other.token), 404, 'not_found');
  });

  it('POST /api/mock-pay with a wrong token → 404 and the order is unchanged', async () => {
    const o = await createOk();
    assertError(await mockPay(o.orderId, 'D'.repeat(43), 'success'), 404, 'not_found');
    const rec = await ctx.sheets.getOrder(o.orderId);
    assert.equal(rec.status, 'Awaiting Payment');
    assert.notEqual(rec.gatewayStatus, 'MOCK_PAID');
  });
});

describe('mock payment flow', () => {
  it('mock-pay success → verify-payment returns Paid', async () => {
    const o = await createOk();
    const paid = await mockPay(o.orderId, o.token, 'success');
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.status, 'Paid');

    const r = await verifyPayment(o.orderId, o.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'Paid');
    assert.equal(r.body.message, MESSAGES.Paid);
    assert.equal(r.body.total, 1630);
    assert.ok(r.body.paidAt && !Number.isNaN(Date.parse(r.body.paidAt)), 'paidAt set');

    const rec = await ctx.sheets.getOrder(o.orderId);
    assert.equal(rec.status, 'Paid');
    assert.equal(rec.gatewayStatus, 'MOCK_PAID');
    assert.equal(rec.reviewFlag, 'TEST_PAYMENT_MOCK', 'mock orders are flagged as test payments');

    const s = await orderStatus(o.orderId, o.token);
    assert.equal(s.body.status, 'Paid');
  });

  it('Paid never regresses: later failure / verify calls are idempotent', async () => {
    const o = await createOk();
    await mockPay(o.orderId, o.token, 'success');
    const first = (await verifyPayment(o.orderId, o.token)).body;
    assert.equal(first.status, 'Paid');

    const fail = await mockPay(o.orderId, o.token, 'failure');
    assert.equal(fail.status, 200, JSON.stringify(fail.body));
    assert.equal(fail.body.status, 'Paid');

    const second = (await verifyPayment(o.orderId, o.token)).body;
    const third = (await verifyPayment(o.orderId, o.token)).body;
    for (const v of [second, third]) {
      assert.equal(v.status, 'Paid');
      assert.equal(v.paidAt, first.paidAt);
      assert.equal(v.paymentId, first.paymentId);
    }
    const rec = await ctx.sheets.getOrder(o.orderId);
    assert.equal(rec.status, 'Paid');
    assert.equal(rec.gatewayStatus, 'MOCK_PAID', 'gatewayStatus is not changed once Paid');
  });

  it('mock-pay failure → Failed; a retry that succeeds → Paid', async () => {
    const o = await createOk();
    const failed = await mockPay(o.orderId, o.token, 'failure');
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(failed.body.status, 'Failed');
    assert.equal(failed.body.message, MESSAGES.Failed);
    assert.equal((await verifyPayment(o.orderId, o.token)).body.status, 'Failed');

    const paid = await mockPay(o.orderId, o.token, 'success');
    assert.equal(paid.body.status, 'Paid');
    assert.equal((await verifyPayment(o.orderId, o.token)).body.status, 'Paid');
  });

  it('mock-pay rejects an unknown outcome', async () => {
    const o = await createOk();
    const r = await mockPay(o.orderId, o.token, 'maybe');
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal((await ctx.sheets.getOrder(o.orderId)).status, 'Awaiting Payment');
  });

  it('verify-payment while nothing happened yet → Awaiting Payment', async () => {
    const o = await createOk();
    const r = await verifyPayment(o.orderId, o.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'Awaiting Payment');
  });

  it('405 for GET /api/verify-payment', async () => {
    const r = await h.invoke(ctx.api('verify-payment'), { method: 'GET', url: '/api/verify-payment' });
    assertError(r, 405, 'method_not_allowed');
    assert.match(String(r.headers.allow), /POST/);
  });
});

describe('POST /api/cashfree-webhook in mock mode', () => {
  it('returns 404 not_found', async () => {
    const o = await createOk();
    const r = await h.postJson(ctx.api('cashfree-webhook'), '/api/cashfree-webhook',
      { type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: o.orderId, order_amount: 1630 } } },
      { headers: { 'x-webhook-signature': 'abc', 'x-webhook-timestamp': String(Date.now()) } });
    assertError(r, 404, 'not_found');
    assert.equal((await ctx.sheets.getOrder(o.orderId)).status, 'Awaiting Payment');
  });
});

describe('/api/reconcile', () => {
  it('503 not_configured when CRON_SECRET is not set', async () => {
    assertError(await reconcile(undefined), 503, 'not_configured');
    assertError(await reconcile('Bearer anything'), 503, 'not_configured');
  });

  it('401 unauthorized for a missing or wrong bearer token', async () => {
    boot({ CRON_SECRET: 'cron-secret-for-tests-0123456789' });
    assertError(await reconcile(undefined), 401, 'unauthorized');
    assertError(await reconcile('Bearer wrong'), 401, 'unauthorized');
    assertError(await reconcile('Bearer cron-secret-for-tests-012345678'), 401, 'unauthorized');
    assertError(await reconcile('cron-secret-for-tests-0123456789'), 401, 'unauthorized');
    assertError(await reconcile('Basic cron-secret-for-tests-0123456789'), 401, 'unauthorized');
  });

  it('200 with the right bearer (GET and POST); reconciles old orders only', async () => {
    boot({ CRON_SECRET: 'cron-secret-for-tests-0123456789' });
    const auth = 'Bearer cron-secret-for-tests-0123456789';

    const empty = await reconcile(auth);
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(empty.body).sort(), ['changed', 'checked', 'errors']);
    assert.equal(typeof empty.body.checked, 'number');
    assert.ok(Array.isArray(empty.body.changed));
    assert.equal(empty.body.errors, 0);

    // Aged orders are seeded with appendOrder (createdAt may be immutable in updateOrder): clone a real
    // order row under a new id with an old createdAt.
    const { generateOrderId } = h.requireLib('tokens');
    const template = await ctx.sheets.getOrder((await createOk()).orderId);
    async function seedAged(minutesAgo, patch) {
      const orderId = generateOrderId('TEDX');
      const createdAt = new Date(Date.now() - minutesAgo * 60000).toISOString();
      await ctx.sheets.appendOrder({
        ...template, orderId, gatewayOrderId: 'mock_' + orderId, createdAt, updatedAt: createdAt,
        status: 'Awaiting Payment', ...patch
      });
      return { orderId };
    }
    // old order the customer paid for, but whose browser never called verify-payment
    const paidLater = await seedAged(60, { gatewayStatus: 'MOCK_PAID' });
    // old order that was never paid and expired > 15 min ago
    const abandoned = await seedAged(120, { gatewayStatus: 'ACTIVE', expiresAt: new Date(Date.now() - 60 * 60000).toISOString() });
    // fresh order (younger than RECONCILE_MIN_AGE_MINUTES) — must not be touched
    const young = await createOk();
    await ctx.sheets.updateOrder(young.orderId, { gatewayStatus: 'MOCK_PAID' });

    const r = await reconcile(auth, 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.errors, 0);
    assert.ok(r.body.checked >= 2, JSON.stringify(r.body));
    assert.ok(r.body.checked <= 2, 'the young orders are not checked');
    assert.deepEqual(r.body.changed.find((c) => c.orderId === paidLater.orderId),
      { orderId: paidLater.orderId, from: 'Awaiting Payment', to: 'Paid' });
    assert.deepEqual(r.body.changed.find((c) => c.orderId === abandoned.orderId),
      { orderId: abandoned.orderId, from: 'Awaiting Payment', to: 'Expired' });
    assert.equal(r.body.changed.find((c) => c.orderId === young.orderId), undefined);

    assert.equal((await ctx.sheets.getOrder(paidLater.orderId)).status, 'Paid');
    assert.equal((await ctx.sheets.getOrder(abandoned.orderId)).status, 'Expired');
    assert.equal((await ctx.sheets.getOrder(young.orderId)).status, 'Awaiting Payment');
    assert.ok(!r.text.includes('asha'), 'no PII in the reconcile response');

    // second run: nothing left to change
    const again = await reconcile(auth);
    assert.equal(again.status, 200);
    assert.equal(again.body.changed.filter((c) => c.orderId === paidLater.orderId).length, 0);
  });
});
