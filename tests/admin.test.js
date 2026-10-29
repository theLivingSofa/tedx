'use strict';
// Organiser dashboard: password + signed session (lib/admin.js), summary maths, and the /api/admin-* handlers
// end to end in demo mode (mock payments + local storage).
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/http-mock.js');

const PASSWORD = 'correct-horse-battery-staple-42';

describe('lib/admin password and session', () => {
  let admin;
  beforeEach(() => {
    h.setEnv({ ADMIN_PASSWORD: PASSWORD });
    h.freshModules();
    admin = h.requireLib('admin');
  });
  after(() => h.restoreEnv());

  it('is disabled without a password, or with one shorter than 12 characters', () => {
    h.setEnv({});
    assert.equal(admin.adminEnabled(), false);
    h.setEnv({ ADMIN_PASSWORD: 'short' });
    assert.equal(admin.adminEnabled(), false);
    h.setEnv({ ADMIN_PASSWORD: PASSWORD });
    assert.equal(admin.adminEnabled(), true);
  });

  it('checks the password exactly', () => {
    assert.equal(admin.checkPassword(PASSWORD), true);
    assert.equal(admin.checkPassword(PASSWORD + ' '), false);
    assert.equal(admin.checkPassword(''), false);
    assert.equal(admin.checkPassword(undefined), false);
    assert.equal(admin.checkPassword('x'.repeat(300)), false);
  });

  it('accepts its own session and rejects tampered, expired or foreign ones', () => {
    const now = Date.now();
    const s = admin.createSession({ now });
    assert.equal(admin.verifySession(s, { now }), true);
    assert.equal(admin.verifySession(s, { now: now + admin.SESSION_MS + 1 }), false, 'expired');
    const [exp, sig] = s.split('.');
    assert.equal(admin.verifySession(`${Number(exp) + 3600000}.${sig}`, { now }), false, 'extended expiry');
    assert.equal(admin.verifySession(`${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, { now }), false, 'bad signature');
    assert.equal(admin.verifySession(s, { now, password: 'another-long-password-123' }), false, 'password changed');
    assert.equal(admin.verifySession('', { now }), false);
    assert.equal(admin.verifySession('garbage', { now }), false);
  });

  it('builds a Secure, HttpOnly, SameSite=Strict cookie and reads it back', () => {
    const c = admin.sessionCookie('abc');
    assert.match(c, /^__Host-merch_admin=abc;/);
    for (const part of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(c.includes(part), part);
    assert.equal(admin.readCookie({ headers: { cookie: 'a=1; __Host-merch_admin=xyz; b=2' } }), 'xyz');
    assert.equal(admin.readCookie({ headers: {} }), '');
    assert.match(admin.clearedCookie(), /Max-Age=0/);
  });
});

describe('lib/admin summarise', () => {
  const admin = require('../lib/admin');
  const item = (sku, qty, extra = {}) => ({ sku, name: sku, size: '', printing: false, printedName: '', quantity: qty, lineTotal: 100 * qty, ...extra });
  const orders = [
    { orderId: 'TEDX-20261029-AAAAAA', status: 'Paid', total: 1600, reviewFlag: '', createdAt: '2026-10-29T10:00:00Z',
      items: [item('HOD-001', 2, { size: 'M', printing: true, printedName: 'ASHA', lineTotal: 1600 })] },
    { orderId: 'TEDX-20261029-BBBBBB', status: 'Paid', total: 130, reviewFlag: '', createdAt: '2026-10-29T11:00:00Z', items: [item('MUG-001', 1, { lineTotal: 130 })] },
    { orderId: 'TEDX-20261029-CCCCCC', status: 'Paid', total: 130, reviewFlag: 'TEST_PAYMENT_SANDBOX', createdAt: '2026-10-29T12:00:00Z', items: [item('MUG-001', 1, { lineTotal: 130 })] },
    { orderId: 'TEDX-20261029-DDDDDD', status: 'Failed', total: 750, reviewFlag: '', createdAt: '2026-10-29T13:00:00Z', items: [item('HOD-001', 1, { size: 'L' })] },
    { orderId: 'TEDX-20261029-EEEEEE', status: 'Awaiting Payment', total: 750, reviewFlag: 'AMOUNT_MISMATCH gateway=1.00 expected=750.00', createdAt: '2026-10-29T14:00:00Z', items: [] }
  ];
  const catalogue = [{ sku: 'HOD-001', name: 'Hoodie' }, { sku: 'MUG-001', name: 'White Ceramic Mug' }, { sku: 'BDG-001', name: 'Badge' }];
  const handover = new Map([['TEDX-20261029-BBBBBB', { handedOver: true, note: '' }]]);

  it('counts real paid orders only, unless test payments are included', () => {
    const s = admin.summarise({ orders, catalogue, handover });
    assert.deepEqual(s.metrics, {
      paidOrders: 2, moneyCollected: 1730, itemsSold: 3, itemsPrinted: 2, handedOver: 1, toHandOver: 1,
      awaiting: 1, failedOrExpired: 1, needsReview: 1
    });
    const withTest = admin.summarise({ orders, catalogue, handover, includeTest: true });
    assert.equal(withTest.metrics.paidOrders, 3);
    assert.equal(withTest.metrics.moneyCollected, 1860);
  });

  it('splits quantities by product and size and lists names to print', () => {
    const s = admin.summarise({ orders, catalogue, handover });
    const hoodie = s.products.find((p) => p.sku === 'HOD-001');
    assert.deepEqual(hoodie.sizes, { M: 2 }, 'failed orders are not counted');
    assert.equal(hoodie.printed, 2);
    assert.equal(s.products.find((p) => p.sku === 'MUG-001').sizes['One size'], 1);
    assert.equal(s.products.find((p) => p.sku === 'BDG-001').total, 0);
    assert.deepEqual(s.sizes, ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'One size']);
    assert.deepEqual(s.printedNames, [{ orderId: 'TEDX-20261029-AAAAAA', sku: 'HOD-001', product: 'Hoodie', size: 'M', printedName: 'ASHA', quantity: 2 }]);
  });

  it('lists orders newest first with handover and review state', () => {
    const s = admin.summarise({ orders, catalogue, handover });
    assert.deepEqual(s.orders.map((o) => o.orderId.slice(-6)), ['EEEEEE', 'DDDDDD', 'BBBBBB', 'AAAAAA']);
    assert.equal(s.orders.find((o) => o.orderId.endsWith('BBBBBB')).handedOver, true);
    assert.equal(s.orders.find((o) => o.orderId.endsWith('EEEEEE')).needsReview, true);
  });
});

describe('/api/admin-* handlers (demo mode)', () => {
  let api;
  function boot(env = {}) {
    const dataDir = h.makeTempDir('tedx-admin-');
    h.setEnv({ LOCAL_DATA_DIR: dataDir, PAYMENT_MODE: 'mock', SITE_URL: h.SITE_URL, ...env });
    h.freshModules();
    const cache = {};
    api = (name) => (cache[name] = cache[name] || h.loadHandler(name));
  }
  after(() => h.restoreEnv());

  async function paidOrder() {
    const c = await h.postJson(api('create-order'), '/api/create-order', {
      customer: { name: 'Asha Verma', roll: 'IPM2023-045', email: 'asha@example.com', phone: '9876543210' },
      items: [{ sku: 'HOD-001', quantity: 1, size: 'M', printing: true, printedName: 'ASHA' }]
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const p = await h.postJson(api('mock-pay'), '/api/mock-pay', { orderId: c.body.orderId, token: c.body.token, outcome: 'success' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    return c.body.orderId;
  }

  async function login(password = PASSWORD, ip) {
    return h.postJson(api('admin-login'), '/api/admin-login', { password }, ip ? { ip } : {});
  }

  function cookieFrom(r) {
    const set = [].concat(r.headers['set-cookie'] || [])[0] || '';
    return set.split(';')[0];
  }

  it('does not exist when ADMIN_PASSWORD is not set', async () => {
    boot();
    for (const name of ['admin-login', 'admin-logout', 'admin-handover']) {
      const r = await h.postJson(api(name), `/api/${name}`, {});
      assert.equal(r.status, 404, name);
    }
    const r = await h.invoke(api('admin-summary'), { method: 'GET', url: '/api/admin-summary' });
    assert.equal(r.status, 404);
  });

  it('needs a session for the summary and for handover', async () => {
    boot({ ADMIN_PASSWORD: PASSWORD });
    const s = await h.invoke(api('admin-summary'), { method: 'GET', url: '/api/admin-summary', headers: { cookie: '__Host-merch_admin=1793280000000.' + 'x'.repeat(43) } });
    assert.equal(s.status, 401);
    const ho = await h.postJson(api('admin-handover'), '/api/admin-handover', { orderId: 'TEDX-20261029-AAAAAA', handedOver: true });
    assert.equal(ho.status, 401);
  });

  it('rejects a wrong password and rate-limits guessing', async () => {
    boot({ ADMIN_PASSWORD: PASSWORD });
    const ip = h.uniqueIp();
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong-password-123', ip)).status, 401);
    assert.equal((await login(PASSWORD, ip)).status, 429, 'locked out after 5 tries, even with the right password');
  });

  it('refuses requests from other websites', async () => {
    boot({ ADMIN_PASSWORD: PASSWORD });
    const r = await h.postJson(api('admin-login'), '/api/admin-login', { password: PASSWORD }, { headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });

  it('logs in, shows the summary, and records a handover', async () => {
    boot({ ADMIN_PASSWORD: PASSWORD });
    const orderId = await paidOrder();
    const l = await login();
    assert.equal(l.status, 200);
    const cookie = cookieFrom(l);
    assert.match(cookie, /^__Host-merch_admin=\d{13}\./);

    const s1 = await h.invoke(api('admin-summary'), { method: 'GET', url: '/api/admin-summary?includeTest=1', headers: { cookie } });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.equal(s1.body.storage, 'local');
    assert.equal(s1.body.handoverAvailable, true);
    assert.equal(s1.body.metrics.paidOrders, 1, 'mock payments are test payments, shown with includeTest');
    assert.equal(s1.body.printedNames[0].printedName, 'ASHA');
    assert.equal(s1.headers['cache-control'], 'no-store');

    const real = await h.invoke(api('admin-summary'), { method: 'GET', url: '/api/admin-summary', headers: { cookie } });
    assert.equal(real.body.metrics.paidOrders, 0, 'test payments hidden by default');

    const ho = await h.postJson(api('admin-handover'), '/api/admin-handover', { orderId, handedOver: true, note: 'collected by friend' }, { headers: { cookie } });
    assert.equal(ho.status, 200, JSON.stringify(ho.body));
    assert.deepEqual(ho.body, { orderId, handedOver: true, note: 'collected by friend' });

    const s2 = await h.invoke(api('admin-summary'), { method: 'GET', url: '/api/admin-summary?includeTest=1', headers: { cookie } });
    assert.equal(s2.body.metrics.handedOver, 1);
    assert.equal(s2.body.orders[0].handoverNote, 'collected by friend');

    const out = await h.postJson(api('admin-logout'), '/api/admin-logout', {}, { headers: { cookie } });
    assert.match([].concat(out.headers['set-cookie'])[0], /Max-Age=0/);
  });

  it('validates handover requests', async () => {
    boot({ ADMIN_PASSWORD: PASSWORD });
    const cookie = cookieFrom(await login());
    const bad = await h.postJson(api('admin-handover'), '/api/admin-handover', { orderId: 'nope', handedOver: 'yes' }, { headers: { cookie } });
    assert.equal(bad.status, 400);
    const missing = await h.postJson(api('admin-handover'), '/api/admin-handover', { orderId: 'TEDX-20261029-ZZZZZZ', handedOver: true }, { headers: { cookie } });
    assert.equal(missing.status, 404);
  });
});
