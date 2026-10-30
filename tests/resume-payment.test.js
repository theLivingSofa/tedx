'use strict';
// "Complete payment" on the order page: GET /api/order-status?resume=1 hands out Cashfree's payment session for
// the SAME order only while it is unpaid and open. Paid, expired, demo and soon-to-expire orders never get one.
const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/http-mock.js');
const cf = require('./helpers/cashfree-fixtures.js');

let stub = null;
let api;
let sheets;

function boot(env = {}) {
  h.setEnv({
    LOCAL_DATA_DIR: h.makeTempDir('tedx-resume-'),
    SITE_URL: h.SITE_URL,
    CASHFREE_APP_ID: 'TEST_APP_ID_123',
    CASHFREE_SECRET_KEY: 'cfsk_ma_test_secret_for_tests',
    CASHFREE_ENV: 'sandbox',
    ...env
  });
  h.freshModules();
  sheets = h.requireLib('sheets');
  const cache = {};
  api = (name) => (cache[name] = cache[name] || h.loadHandler(name));
}

async function createOrder() {
  const r = await h.postJson(api('create-order'), '/api/create-order', {
    customer: { name: 'Asha Verma', roll: 'IPM2023-045', email: 'asha@example.com', phone: '9876543210' },
    items: [{ sku: 'MUG-001', quantity: 1 }]
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const status = (o, extra = '') => h.invoke(api('order-status'), {
  method: 'GET', url: '/api/order-status?id=' + o.orderId + extra, headers: { 'x-order-token': o.token }
});

describe('Complete payment (order-status resume)', () => {
  beforeEach(() => { stub = cf.installCashfreeFetchStub(); boot(); });
  afterEach(() => { if (stub) stub.restore(); stub = null; });
  after(() => h.restoreEnv());

  it('offers the same order\'s payment session while it is unpaid and open', async () => {
    const o = await createOrder();
    const plain = await status(o);
    assert.equal(plain.status, 200);
    assert.equal(plain.body.canResume, true);
    assert.equal(plain.body.resume, undefined, 'plain status checks never carry a session');

    const r = await status(o, '&resume=1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.resume, { paymentSessionId: stub.sessionId, environment: 'sandbox' });
    assert.equal(r.body.orderId, o.orderId);
    assert.equal(stub.callsTo(/\/orders$/, 'POST').length, 1, 'no second Cashfree order is created');
  });

  it('never resumes a paid order, and marks it Paid if the payment already landed', async () => {
    const o = await createOrder();
    const g = stub.gateway.get(o.orderId);
    g.status = 'PAID';
    g.payments = [{ cf_payment_id: '999', payment_status: 'SUCCESS', payment_amount: g.amount, payment_group: 'upi',
      payment_method: { upi: { upi_id: 'x@y' } }, payment_completion_time: new Date().toISOString() }];
    const r = await status(o, '&resume=1');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'Paid');
    assert.equal(r.body.canResume, false);
    assert.equal(r.body.resume, undefined);
  });

  it('does not resume once Cashfree says the order is no longer active', async () => {
    const o = await createOrder();
    stub.gateway.get(o.orderId).status = 'TERMINATED';
    const r = await status(o, '&resume=1');
    assert.equal(r.status, 200);
    assert.equal(r.body.resume, undefined);
  });

  it('does not resume with less than a minute left or after expiry', async () => {
    const o = await createOrder();
    await sheets.updateOrder(o.orderId, { expiresAt: new Date(Date.now() + 30 * 1000).toISOString() });
    const soon = await status(o, '&resume=1');
    assert.equal(soon.body.canResume, false);
    assert.equal(soon.body.resume, undefined);
  });

  it('needs the order token', async () => {
    const o = await createOrder();
    const r = await h.invoke(api('order-status'), {
      method: 'GET', url: '/api/order-status?resume=1&id=' + o.orderId, headers: { 'x-order-token': 'A'.repeat(43) }
    });
    assert.equal(r.status, 404);
  });
});

describe('Complete payment in demo mode', () => {
  after(() => h.restoreEnv());
  it('is never offered for demo (mock) orders', async () => {
    boot({ CASHFREE_APP_ID: undefined, CASHFREE_SECRET_KEY: undefined, PAYMENT_MODE: 'mock' });
    const o = await createOrder();
    const plain = await status(o);
    assert.equal(plain.body.canResume, false);
    const r = await status(o, '&resume=1');
    assert.equal(r.body.resume, undefined);
  });
});
