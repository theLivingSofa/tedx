'use strict';
// Regression tests for the Phase 3 security review findings.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/http-mock.js');
const cf = require('./helpers/cashfree-fixtures.js');

const SECRET = 'TEST_SECRET_dummy_cfsk_ma_test_abcdef0123456789';
let dataDir = null;
let stub = null;

function boot(env = {}) {
  if (dataDir) h.removeDir(dataDir);
  dataDir = h.makeTempDir('tedx-sec-');
  h.setEnv({ LOCAL_DATA_DIR: dataDir, SITE_URL: h.SITE_URL, ...env });
  h.freshModules();
}

afterEach(() => {
  if (stub) { stub.restore(); stub = null; }
  h.restoreEnv();
  if (dataDir) { h.removeDir(dataDir); dataDir = null; }
});

function baseOrder(overrides = {}) {
  return {
    orderId: 'TEDX-20261029-ABCDEF', status: 'Awaiting Payment', name: 'Asha', roll: 'R1', email: 'a@example.com',
    phone: '9876543210', itemsSummary: 'MUG-001 White Ceramic Mug ×1', items: [], subtotal: 130, printingTotal: 0,
    total: 130, currency: 'INR', notes: '', tokenHash: 'x'.repeat(64), paymentMode: 'cashfree', gatewayOrderId: '',
    gatewayStatus: '', paymentId: '', paymentMethod: '', paidAt: '', expiresAt: new Date(Date.now() + 1800e3).toISOString(),
    emailSentAt: '', reviewFlag: '', ...overrides
  };
}

describe('H1: simulated payments never write Paid rows into a real Google Sheet', () => {
  const sheetsEnv = { GOOGLE_SHEET_ID: 'sheet', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@x.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: 'k' };

  it('mock mode is unavailable when Sheets is configured', () => {
    boot(sheetsEnv);
    assert.equal(h.requireLib('cashfree').paymentMode(), 'unavailable');
  });
  it('…unless ALLOW_MOCK_WITH_SHEETS=true', () => {
    boot({ ...sheetsEnv, ALLOW_MOCK_WITH_SHEETS: 'true' });
    assert.equal(h.requireLib('cashfree').paymentMode(), 'mock');
  });
  it('VERCEL_ENV is compared case-insensitively', () => {
    boot({ VERCEL_ENV: 'Production' });
    assert.equal(h.requireLib('cashfree').paymentMode(), 'unavailable');
  });
  it('new orders carry a test-payment flag (mock / sandbox), none in production', () => {
    boot({});
    assert.equal(h.requireLib('cashfree').testPaymentFlag('mock'), 'TEST_PAYMENT_MOCK');
    boot({ CASHFREE_ENV: 'sandbox' });
    assert.equal(h.requireLib('cashfree').testPaymentFlag('cashfree'), 'TEST_PAYMENT_SANDBOX');
    boot({ CASHFREE_ENV: 'production' });
    assert.equal(h.requireLib('cashfree').testPaymentFlag('cashfree'), '');
  });
});

describe('M1: storage refuses to regress a Paid order', () => {
  beforeEach(() => boot({}));

  it('status/paidAt/paymentId cannot be overwritten once Paid', async () => {
    const sheets = h.requireLib('sheets');
    await sheets.appendOrder(baseOrder({ status: 'Paid', paidAt: '2026-10-29T10:00:00.000Z', paymentId: '2', paymentMethod: 'upi' }));
    const out = await sheets.updateOrder('TEDX-20261029-ABCDEF', { status: 'Failed', paidAt: '', paymentId: '1', gatewayStatus: 'ACTIVE' });
    assert.equal(out.status, 'Paid');
    assert.equal(out.paymentId, '2');
    assert.equal(out.paidAt, '2026-10-29T10:00:00.000Z');
    assert.equal(out.gatewayStatus, 'ACTIVE', 'non-payment fields can still be updated');
    assert.equal((await sheets.getOrder('TEDX-20261029-ABCDEF')).status, 'Paid');
    const exp = await sheets.updateOrder('TEDX-20261029-ABCDEF', { status: 'Expired' });
    assert.equal(exp.status, 'Paid');
  });

  it('the first emailSentAt claim wins (no duplicate receipts across instances)', async () => {
    const sheets = h.requireLib('sheets');
    await sheets.appendOrder(baseOrder());
    const a = await sheets.updateOrder('TEDX-20261029-ABCDEF', { emailSentAt: '2026-10-29T10:00:00.000Z' });
    const b = await sheets.updateOrder('TEDX-20261029-ABCDEF', { emailSentAt: '2026-10-29T10:00:00.500Z' });
    assert.equal(a.emailSentAt, '2026-10-29T10:00:00.000Z');
    assert.equal(b.emailSentAt, '2026-10-29T10:00:00.000Z');
  });
});

describe('amount and flag edge cases in resolveStatus', () => {
  beforeEach(() => boot({}));

  it('gateway amounts with more than two decimals are not accepted as a match', () => {
    const { resolveStatus } = h.requireLib('orders');
    const r = resolveStatus('Awaiting Payment', { orderStatus: 'PAID', amount: 300.6249, currency: 'INR', payments: [] }, 300.62, {});
    assert.notEqual(r.status, 'Paid');
    assert.match(r.reviewFlag, /AMOUNT_MISMATCH/);
  });
  it('a blank/zero stored total can never be Paid', () => {
    const { resolveStatus } = h.requireLib('orders');
    assert.notEqual(resolveStatus('Awaiting Payment', { orderStatus: 'PAID', amount: 0, currency: 'INR' }, 0, {}).status, 'Paid');
    assert.notEqual(resolveStatus('Awaiting Payment', { orderStatus: 'PAID', amount: 0, currency: 'INR' }, Number(''), {}).status, 'Paid');
  });
  it('addFlag keeps earlier flags, replaces a flag of the same kind and dedupes', () => {
    const { addFlag } = h.requireLib('orders');
    let f = addFlag('', 'TEST_PAYMENT_SANDBOX');
    f = addFlag(f, 'AMOUNT_MISMATCH gateway=1.00 expected=130.00');
    f = addFlag(f, 'AMOUNT_MISMATCH gateway=2.00 expected=130.00');
    assert.equal(f, 'TEST_PAYMENT_SANDBOX | AMOUNT_MISMATCH gateway=2.00 expected=130.00');
    assert.equal(addFlag(f, 'TEST_PAYMENT_SANDBOX'), 'AMOUNT_MISMATCH gateway=2.00 expected=130.00 | TEST_PAYMENT_SANDBOX');
  });
});

describe('M3 + L2: late payments on expired orders are recovered by reconcile', () => {
  it('Expired → Paid via reconcile, flagged PAID_AFTER_EXPIRY; an earlier mismatch flag is marked resolved', async () => {
    boot({ CASHFREE_APP_ID: 'app', CASHFREE_SECRET_KEY: SECRET, CASHFREE_ENV: 'sandbox', CRON_SECRET: 'cron-secret-123', RECONCILE_MIN_AGE_MINUTES: '0' });
    stub = cf.installCashfreeFetchStub();
    const r = await h.postJson(h.loadHandler('create-order'), '/api/create-order', {
      customer: { name: 'Asha Verma', roll: 'R1', email: 'asha@example.com', phone: '9876543210' },
      items: [{ sku: 'MUG-001', quantity: 1 }]
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.orderId;
    const sheets = h.requireLib('sheets');
    await sheets.updateOrder(id, {
      status: 'Expired', expiresAt: new Date(Date.now() - 3600e3).toISOString(),
      reviewFlag: 'TEST_PAYMENT_SANDBOX | AMOUNT_MISMATCH gateway=1.00 expected=130.00'
    });
    const g = stub.gateway.get(id);
    g.status = 'PAID'; g.amount = 130;
    g.payments = [{ cf_payment_id: '77', payment_status: 'SUCCESS', payment_group: 'upi', payment_amount: 130 }];

    const rec = await h.invoke(h.loadHandler('reconcile'), { method: 'POST', url: '/api/reconcile', headers: { authorization: 'Bearer cron-secret-123' } });
    assert.equal(rec.status, 200, JSON.stringify(rec.body));
    assert.deepEqual(rec.body.changed, [{ orderId: id, from: 'Expired', to: 'Paid' }]);
    const row = await sheets.getOrder(id);
    assert.equal(row.status, 'Paid');
    assert.match(row.reviewFlag, /PAID_AFTER_EXPIRY/);
    assert.match(row.reviewFlag, /RESOLVED_PAID_WITH_MATCHING_AMOUNT/);
    assert.match(row.reviewFlag, /TEST_PAYMENT_SANDBOX/);
  });
});

describe('L4: order-status accepts the token in the X-Order-Token header', () => {
  it('header token works; wrong header token gives the same 404', async () => {
    boot({ PAYMENT_MODE: 'mock' });
    const r = await h.postJson(h.loadHandler('create-order'), '/api/create-order', {
      customer: { name: 'Asha Verma', roll: 'R1', email: 'asha@example.com', phone: '9876543210' },
      items: [{ sku: 'MUG-001', quantity: 1 }]
    });
    assert.equal(r.status, 201);
    const status = h.loadHandler('order-status');
    const ok = await h.invoke(status, { url: `/api/order-status?id=${r.body.orderId}`, headers: { 'x-order-token': r.body.token } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.orderId, r.body.orderId);
    const bad = await h.invoke(status, { url: `/api/order-status?id=${r.body.orderId}`, headers: { 'x-order-token': 'A'.repeat(43) } });
    const unknown = await h.invoke(status, { url: '/api/order-status?id=TEDX-20261029-ZZZZZZ', headers: { 'x-order-token': r.body.token } });
    assert.equal(bad.status, 404);
    assert.equal(bad.text, unknown.text);
  });
});
