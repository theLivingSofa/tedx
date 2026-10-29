'use strict';
// Cashfree mode end-to-end with a stubbed global fetch (CONTRACT 5.2, 5.3, 5.4, 6.7, 6.8).
// The webhook payload is never trusted: the order becomes Paid only because Get Order says PAID with a matching amount.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');

const h = require('./helpers/http-mock.js');
const cf = require('./helpers/cashfree-fixtures.js');

const SITE_URL = h.SITE_URL;
const APP_ID = 'TEST_APP_ID_dummy_123';
const SECRET = 'TEST_SECRET_dummy_cfsk_ma_test_abcdef0123456789';

let ctx = null;
let stub = null;

function boot(env = {}) {
  if (ctx) h.removeDir(ctx.dataDir);
  const dataDir = h.makeTempDir('tedx-cf-');
  h.setEnv({
    LOCAL_DATA_DIR: dataDir,
    SITE_URL,
    CASHFREE_APP_ID: APP_ID,
    CASHFREE_SECRET_KEY: SECRET,
    CASHFREE_ENV: 'sandbox',
    RESEND_API_KEY: 're_test_dummy_key',
    EMAIL_FROM: 'TEDxIIMRohtak Merch <merch@example.com>',
    ...env
  });
  h.freshModules();
  const sheets = h.requireLib('sheets');
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

function orderBody() {
  return {
    customer: { name: 'Asha Verma', roll: 'IPM2023-045', email: 'Asha@Example.com', phone: '9876543210', notes: '' },
    items: [
      { sku: 'HOD-001', quantity: 2, size: 'M', printing: true, printedName: 'ASHA' },
      { sku: 'MUG-001', quantity: 1 }
    ]
  };
}

async function createOk(body = orderBody()) {
  const r = await h.postJson(ctx.api('create-order'), '/api/create-order', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

/** Deliver a webhook. By default signs `raw` correctly with the current time. */
function deliver(raw, { ts = String(Date.now()), secret = SECRET, signature, headers = {} } = {}) {
  const sig = signature !== undefined ? signature : cf.signWebhook(raw, ts, secret);
  const hdrs = { 'content-type': 'application/json', 'x-webhook-version': '2025-01-01', ...headers };
  if (sig !== null) hdrs['x-webhook-signature'] = sig;
  if (ts !== null) hdrs['x-webhook-timestamp'] = ts;
  return h.invoke(ctx.api('cashfree-webhook'), { method: 'POST', url: '/api/cashfree-webhook', headers: hdrs, body: raw });
}

function setGatewayPaid(orderId, { amount = 1630, paymentId = '5114910392481' } = {}) {
  const g = stub.gateway.get(orderId);
  assert.ok(g, 'gateway order exists (created through the stub)');
  g.status = 'PAID';
  g.amount = amount;
  g.payments = [{ cf_payment_id: paymentId, payment_status: 'SUCCESS', payment_group: 'upi', payment_amount: amount }];
}

function getOrderCalls(orderId) {
  return stub.calls.filter((c) => c.method === 'GET' && c.url === `${cf.SANDBOX_BASE}/orders/${orderId}`);
}

beforeEach(() => {
  stub = cf.installCashfreeFetchStub();
  boot();
});

afterEach(() => {
  if (stub) stub.restore();
  stub = null;
  if (ctx) h.removeDir(ctx.dataDir);
  ctx = null;
  h.restoreEnv();
});

describe('create-order → Cashfree Create Order', () => {
  it('sends the contract headers, the server-computed amount and a token-free return_url', async () => {
    const o = await createOk();
    assert.equal(o.paymentMode, 'cashfree');
    assert.equal(o.environment, 'sandbox');
    assert.equal(o.paymentSessionId, stub.sessionId);
    assert.equal(o.total, 1630);

    const creates = stub.callsTo(/\/pg\/orders$/, 'POST');
    assert.equal(creates.length, 1);
    const call = creates[0];
    assert.equal(call.url, `${cf.SANDBOX_BASE}/orders`);
    assert.equal(call.headers['x-api-version'], '2026-01-01');
    assert.equal(call.headers['x-client-id'], APP_ID);
    assert.equal(call.headers['x-client-secret'], SECRET);
    assert.equal(call.headers['x-idempotency-key'], o.orderId);
    assert.ok(call.headers['x-request-id'], 'x-request-id is sent');
    assert.match(call.headers['content-type'], /^application\/json/);

    const body = call.json;
    assert.ok(body, 'JSON body');
    assert.equal(body.order_id, o.orderId);
    assert.equal(body.order_amount, 1630);
    assert.equal(typeof body.order_amount, 'number');
    assert.equal(body.order_currency, 'INR');
    assert.equal(body.customer_details.customer_phone, '9876543210');
    assert.equal(body.customer_details.customer_email, 'asha@example.com');
    assert.ok(body.customer_details.customer_id, 'customer_id is required by Cashfree');

    const returnUrl = body.order_meta.return_url;
    assert.ok(returnUrl.startsWith(`${SITE_URL}/order?id=${o.orderId}`), returnUrl);
    assert.ok(!returnUrl.includes(o.token), 'return_url must not contain the token');
    assert.ok(!/token=/i.test(returnUrl));
    if (body.order_meta.notify_url) {
      assert.equal(body.order_meta.notify_url, `${SITE_URL}/api/cashfree-webhook`);
    }
    assert.ok(!call.body.includes(o.token), 'token is never sent to Cashfree');

    const expiry = Date.parse(body.order_expiry_time);
    assert.ok(expiry >= Date.now() + 15 * 60000, 'order_expiry_time at least 16 min ahead');

    const rec = await ctx.sheets.getOrder(o.orderId);
    assert.equal(rec.paymentMode, 'cashfree');
    assert.equal(rec.gatewayOrderId, stub.cfOrderId);
    assert.equal(rec.status, 'Awaiting Payment');
  });

  it('order_amount follows server pricing (PRINTING_CHARGE=50 → 1730)', async () => {
    boot({ PRINTING_CHARGE: '50' });
    const o = await createOk();
    assert.equal(o.total, 1730);
    assert.equal(stub.callsTo(/\/pg\/orders$/, 'POST')[0].json.order_amount, 1730);
  });

  it('uses the production base URL when CASHFREE_ENV=production', async () => {
    stub.restore();
    stub = cf.installCashfreeFetchStub({ base: cf.PRODUCTION_BASE });
    boot({ CASHFREE_ENV: 'production' });
    const o = await createOk();
    assert.equal(o.environment, 'production');
    assert.equal(stub.callsTo(/\/pg\/orders$/, 'POST')[0].url, `${cf.PRODUCTION_BASE}/orders`);
  });

  it('a gateway error → 502 gateway_error and the row becomes Failed / GATEWAY_CREATE_FAILED', async () => {
    stub.createStatus = 400; // 4xx: not retried
    const r = await h.postJson(ctx.api('create-order'), '/api/create-order', orderBody());
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'gateway_error');
    const failed = await ctx.sheets.listOrders({ statuses: ['Failed'], olderThan: new Date(Date.now() + 60000), limit: 25 });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reviewFlag, 'GATEWAY_CREATE_FAILED');
    assert.ok(!r.text.includes(SECRET));
  });

  it('catalogue reports cashfree / sandbox', async () => {
    const r = await h.invoke(ctx.api('catalogue'), { method: 'GET', url: '/api/catalogue' });
    assert.deepEqual(r.body.payment, { mode: 'cashfree', environment: 'sandbox' });
  });

  it('mock-pay is disabled in cashfree mode (404)', async () => {
    const o = await createOk();
    const r = await h.postJson(ctx.api('mock-pay'), '/api/mock-pay', { orderId: o.orderId, token: o.token, outcome: 'success' });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'not_found');
    assert.equal((await ctx.sheets.getOrder(o.orderId)).status, 'Awaiting Payment');
  });
});

describe('POST /api/cashfree-webhook', () => {
  it('valid signed webhook → Paid, because Get Order says PAID with the matching amount', async () => {
    const o = await createOk();
    setGatewayPaid(o.orderId);
    const before = getOrderCalls(o.orderId).length;

    const r = await deliver(cf.paymentSuccessWebhookBody({ orderId: o.orderId, amount: '1630.00' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { received: true });
    assert.ok(getOrderCalls(o.orderId).length > before, 'server re-confirmed with Get Order');

    const rec = await ctx.sheets.getOrder(o.orderId);
    assert.equal(rec.status, 'Paid');
    assert.equal(rec.gatewayStatus, 'PAID');
    assert.equal(rec.paymentId, '5114910392481');
    assert.equal(rec.paymentMethod, 'upi');
    assert.ok(rec.paidAt && !Number.isNaN(Date.parse(rec.paidAt)));
    assert.ok(!rec.reviewFlag);

    await sleep(30);
    assert.equal(stub.emails.length, 1, 'one receipt email');
    assert.ok(JSON.stringify(stub.emails[0].json.to).includes('asha@example.com'));
    assert.ok((await ctx.sheets.getOrder(o.orderId)).emailSentAt, 'emailSentAt guard set');

    const view = await h.postJson(ctx.api('verify-payment'), '/api/verify-payment', { orderId: o.orderId, token: o.token });
    assert.equal(view.body.status, 'Paid');
    assert.equal(view.body.paymentMethod, 'upi');
    assert.equal(view.body.paymentId, '5114910392481');
  });

  it('the payload is not trusted: SUCCESS webhook while Get Order says ACTIVE → still Awaiting Payment', async () => {
    const o = await createOk();
    // gateway left ACTIVE with no payments
    const r = await deliver(cf.paymentSuccessWebhookBody({ orderId: o.orderId }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { received: true });
    const rec = await ctx.sheets.getOrder(o.orderId);
    assert.equal(rec.status, 'Awaiting Payment');
    await sleep(20);
    assert.equal(stub.emails.length, 0);
  });

  it('Get Order reports a different amount → not Paid, review flag set, no email', async () => {
    const o = await createOk();
    setGatewayPaid(o.orderId, { amount: 1 });
    const r = await deliver(cf.paymentSuccessWebhookBody({ orderId: o.orderId, amount: '1630.00' }));
    assert.equal(r.status, 200);
    const rec = await ctx.sheets.getOrder(o.orderId);
    assert.notEqual(rec.status, 'Paid');
    assert.match(rec.reviewFlag, /^AMOUNT_MISMATCH/);
    await sleep(20);
    assert.equal(stub.emails.length, 0);
  });

  it('invalid signature → 401 invalid_signature, order unchanged, gateway not queried', async () => {
    const o = await createOk();
    setGatewayPaid(o.orderId);
    const before = await ctx.sheets.getOrder(o.orderId);
    const callsBefore = stub.calls.length;
    const raw = cf.paymentSuccessWebhookBody({ orderId: o.orderId });
    const ts = String(Date.now());

    const attempts = [
      deliver(raw, { secret: 'wrong-secret' }),
      deliver(raw, { signature: 'bm90IGEgcmVhbCBzaWduYXR1cmU=' }),
      deliver(raw, { signature: null }),
      deliver(raw, { ts: null }),
      deliver(raw.replace('1630.00', '1.00'), { ts, signature: cf.signWebhook(raw, ts, SECRET) }),
      deliver(JSON.stringify(JSON.parse(raw)), { ts, signature: cf.signWebhook(raw, ts, SECRET) }),
      deliver(raw, { ts: String(Date.now() - 10 * 60000) }), // stale (> 300 s)
      deliver(raw, { ts: String(Date.now() + 10 * 60000) }) // from the future
    ];
    for (const r of await Promise.all(attempts)) {
      assert.equal(r.status, 401, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'invalid_signature');
    }
    assert.equal(stub.calls.length, callsBefore, 'no Cashfree calls for rejected webhooks');
    assert.deepEqual(await ctx.sheets.getOrder(o.orderId), before);
  });

  it('respects WEBHOOK_TOLERANCE_SECONDS', async () => {
    boot({ WEBHOOK_TOLERANCE_SECONDS: '30' });
    const o = await createOk();
    const raw = cf.paymentSuccessWebhookBody({ orderId: o.orderId });
    const r = await deliver(raw, { ts: String(Date.now() - 60000) });
    assert.equal(r.status, 401);
  });

  it('replayed duplicate webhook → one transition, one email', async () => {
    const o = await createOk();
    setGatewayPaid(o.orderId);
    const raw = cf.paymentSuccessWebhookBody({ orderId: o.orderId });
    const ts = String(Date.now());
    const sig = cf.signWebhook(raw, ts, SECRET);

    const first = await deliver(raw, { ts, signature: sig });
    assert.equal(first.status, 200);
    await sleep(30);
    const afterFirst = await ctx.sheets.getOrder(o.orderId);
    assert.equal(afterFirst.status, 'Paid');

    await sleep(5);
    const second = await deliver(raw, { ts, signature: sig });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { received: true });
    const third = await deliver(raw); // re-sent by Cashfree with a fresh timestamp
    assert.equal(third.status, 200);
    await sleep(30);

    const afterReplay = await ctx.sheets.getOrder(o.orderId);
    assert.equal(afterReplay.status, 'Paid');
    assert.equal(afterReplay.paidAt, afterFirst.paidAt);
    assert.equal(afterReplay.emailSentAt, afterFirst.emailSentAt);
    assert.equal(afterReplay.updatedAt, afterFirst.updatedAt, 'nothing changed → no write');
    assert.equal(stub.emails.length, 1, 'receipt email is not duplicated');
  });

  it('concurrent duplicate deliveries still send one email', async () => {
    const o = await createOk();
    setGatewayPaid(o.orderId);
    const raw = cf.paymentSuccessWebhookBody({ orderId: o.orderId });
    const results = await Promise.all([deliver(raw), deliver(raw), deliver(raw)]);
    for (const r of results) assert.equal(r.status, 200);
    await sleep(50);
    assert.equal((await ctx.sheets.getOrder(o.orderId)).status, 'Paid');
    assert.ok(stub.emails.length <= 1, `expected at most one email, got ${stub.emails.length}`);
  });

  it('webhook for an unknown order → 200 { received: true }', async () => {
    const r = await deliver(cf.paymentSuccessWebhookBody({ orderId: 'TEDX-20261029-ZZZZZZ' }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { received: true });
    const r2 = await deliver(cf.paymentSuccessWebhookBody({ orderId: 'not-our-format' }));
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.body, { received: true });
  });

  it('non-JSON body with a valid signature → 400 invalid_json', async () => {
    const r = await deliver('this is not json');
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.error.code, 'invalid_json');
  });

  it('ignores the Origin header (server-to-server)', async () => {
    const o = await createOk();
    setGatewayPaid(o.orderId);
    const r = await deliver(cf.paymentSuccessWebhookBody({ orderId: o.orderId }), { headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await ctx.sheets.getOrder(o.orderId)).status, 'Paid');
  });

  it('a later EXPIRED/TERMINATED webhook never regresses a Paid order', async () => {
    const o = await createOk();
    setGatewayPaid(o.orderId);
    await deliver(cf.paymentSuccessWebhookBody({ orderId: o.orderId }));
    assert.equal((await ctx.sheets.getOrder(o.orderId)).status, 'Paid');
    stub.gateway.get(o.orderId).status = 'TERMINATED';
    const r = await deliver(cf.paymentSuccessWebhookBody({ orderId: o.orderId, status: 'FAILED', type: 'PAYMENT_FAILED_WEBHOOK' }));
    assert.equal(r.status, 200);
    assert.equal((await ctx.sheets.getOrder(o.orderId)).status, 'Paid');
  });

  it('405 for GET', async () => {
    const r = await h.invoke(ctx.api('cashfree-webhook'), { method: 'GET', url: '/api/cashfree-webhook' });
    assert.equal(r.status, 405);
    assert.match(String(r.headers.allow), /POST/);
  });
});

describe('verify-payment in cashfree mode (server-to-server Get Order)', () => {
  it('ACTIVE + FAILED payment → Failed; retry PAID → Paid; then TERMINATED → still Paid', async () => {
    const o = await createOk();
    const g = stub.gateway.get(o.orderId);
    g.payments = [{ cf_payment_id: '111', payment_status: 'FAILED', payment_group: 'upi' }];

    const verify = () => h.postJson(ctx.api('verify-payment'), '/api/verify-payment', { orderId: o.orderId, token: o.token });

    let r = await verify();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'Failed');
    assert.ok(getOrderCalls(o.orderId).length >= 1);

    setGatewayPaid(o.orderId, { paymentId: '222' });
    g.payments.unshift({ cf_payment_id: '111', payment_status: 'FAILED', payment_group: 'upi' });
    r = await verify();
    assert.equal(r.body.status, 'Paid');
    assert.equal(r.body.paymentId, '222', 'the successful payment is recorded, not the failed one');

    g.status = 'TERMINATED';
    g.payments = [{ cf_payment_id: '333', payment_status: 'FAILED', payment_group: 'upi' }];
    r = await verify();
    assert.equal(r.body.status, 'Paid');
    assert.equal(r.body.paymentId, '222');
    await sleep(20);
    assert.equal(stub.emails.length, 1);
  });

  it('amount mismatch via verify-payment → not Paid', async () => {
    const o = await createOk();
    setGatewayPaid(o.orderId, { amount: 750 });
    const r = await h.postJson(ctx.api('verify-payment'), '/api/verify-payment', { orderId: o.orderId, token: o.token });
    assert.equal(r.status, 200);
    assert.notEqual(r.body.status, 'Paid');
    assert.match((await ctx.sheets.getOrder(o.orderId)).reviewFlag, /^AMOUNT_MISMATCH/);
  });
});
