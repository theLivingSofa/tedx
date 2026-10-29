'use strict';
// Organiser dashboard: password, hashing and signed sessions (lib/admin.js), summary maths, and the
// /api/admin-* handlers end to end in demo mode (mock payments + local storage), plus the Sheets-backed
// password hash against an in-memory fake of the Config tab.
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./helpers/http-mock.js');

const PASSWORD = 'correct-horse-battery-staple-42';

describe('lib/admin hashing and sessions', () => {
  let admin;
  let dataDir;
  beforeEach(() => {
    dataDir = h.makeTempDir('tedx-admin-lib-');
    h.setEnv({ ADMIN_PASSWORD: PASSWORD, LOCAL_DATA_DIR: dataDir });
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

  it('hashes with a random salt and verifies exactly', () => {
    const a = admin.hashPassword('a new password 123');
    const b = admin.hashPassword('a new password 123');
    assert.notEqual(a, b, 'salted');
    assert.equal(admin.isPasswordHash(a), true);
    assert.ok(!a.includes('a new password'), 'never stores the password itself');
    assert.equal(admin.verifyPasswordHash('a new password 123', a), true);
    assert.equal(admin.verifyPasswordHash('a new password 124', a), false);
    assert.equal(admin.verifyPasswordHash('', a), false);
    assert.equal(admin.isPasswordHash('scrypt$1$1$1$x$y'), false);
  });

  it('logs in with ADMIN_PASSWORD until a new password is set', async () => {
    assert.ok(await admin.login(PASSWORD));
    assert.equal(await admin.login(PASSWORD + ' '), null);
    assert.equal(await admin.login(''), null);
    assert.equal(await admin.login('x'.repeat(300)), null);
  });

  it('accepts its own session and rejects tampered, expired or foreign ones', () => {
    const now = Date.now();
    const s = admin.createSession({ now, secret: 's1' });
    assert.equal(admin.verifySession(s, { now, secret: 's1' }), true);
    assert.equal(admin.verifySession(s, { now: now + admin.SESSION_MS + 1, secret: 's1' }), false, 'expired');
    const [exp, sig] = s.split('.');
    assert.equal(admin.verifySession(`${Number(exp) + 3600000}.${sig}`, { now, secret: 's1' }), false, 'extended expiry');
    assert.equal(admin.verifySession(`${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, { now, secret: 's1' }), false, 'bad signature');
    assert.equal(admin.verifySession(s, { now, secret: 's2' }), false, 'credential changed');
    assert.equal(admin.verifySession('', { now, secret: 's1' }), false);
    assert.equal(admin.verifySession('garbage', { now, secret: 's1' }), false);
  });

  it('changes the password: checks the current one, rejects weak or unchanged ones, stores only a hash', async () => {
    assert.deepEqual(await admin.changePassword('wrong-password-123', 'brand new password 1'),
      { ok: false, field: 'currentPassword', message: 'Your current password is not right.' });
    assert.equal((await admin.changePassword(PASSWORD, 'short')).field, 'newPassword');
    assert.equal((await admin.changePassword(PASSWORD, PASSWORD)).field, 'newPassword');
    const r = await admin.changePassword(PASSWORD, 'brand new password 1');
    assert.equal(r.ok, true);
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin.json'), 'utf8')).passwordHash;
    assert.equal(admin.isPasswordHash(stored), true);
    assert.equal(await admin.login(PASSWORD), null, 'old password no longer works');
    assert.ok(await admin.login('brand new password 1'));
    // Recovery: removing the stored hash brings back ADMIN_PASSWORD.
    fs.unlinkSync(path.join(dataDir, 'admin.json'));
    assert.ok(await admin.login(PASSWORD));
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

  it('counts real paid orders only and never includes test payments', () => {
    const s = admin.summarise({ orders, catalogue, handover });
    assert.deepEqual(s.metrics, {
      paidOrders: 2, moneyCollected: 1730, itemsSold: 3, itemsPrinted: 2, handedOver: 1, toHandOver: 1,
      awaiting: 1, failedOrExpired: 1, needsReview: 1
    });
    assert.ok(!s.orders.some((o) => o.orderId.endsWith('CCCCCC')), 'test order not listed');
    assert.equal('includeTest' in s, false);
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
  let sheets;
  function boot(env = {}) {
    const dataDir = h.makeTempDir('tedx-admin-');
    h.setEnv({ LOCAL_DATA_DIR: dataDir, PAYMENT_MODE: 'mock', SITE_URL: h.SITE_URL, ...env });
    h.freshModules();
    sheets = h.requireLib('sheets');
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

  const login = (password = PASSWORD, ip) => h.postJson(api('admin-auth'), '/api/admin-auth?op=login', { password }, ip ? { ip } : {});
  const cookieFrom = (r) => ([].concat(r.headers['set-cookie'] || [])[0] || '').split(';')[0];
  const summary = (cookie) => h.invoke(api('admin-summary'), { method: 'GET', url: '/api/admin-summary', headers: { cookie } });

  it('does not exist when ADMIN_PASSWORD is not set', async () => {
    boot();
    for (const [name, url] of [['admin-auth', '/api/admin-auth?op=login'], ['admin-auth', '/api/admin-auth?op=logout'],
      ['admin-auth', '/api/admin-auth?op=password'], ['admin-handover', '/api/admin-handover']]) {
      const r = await h.postJson(api(name), url, {});
      assert.equal(r.status, 404, url);
    }
    assert.equal((await h.invoke(api('admin-summary'), { method: 'GET', url: '/api/admin-summary' })).status, 404);
  });

  it('needs a session for the summary, handover and password change', async () => {
    boot({ ADMIN_PASSWORD: PASSWORD });
    assert.equal((await summary('__Host-merch_admin=1793280000000.' + 'x'.repeat(43))).status, 401);
    assert.equal((await h.postJson(api('admin-handover'), '/api/admin-handover', { orderId: 'TEDX-20261029-AAAAAA', handedOver: true })).status, 401);
    assert.equal((await h.postJson(api('admin-auth'), '/api/admin-auth?op=password', { currentPassword: PASSWORD, newPassword: 'x'.repeat(20) })).status, 401);
  });

  it('rejects a wrong password and rate-limits guessing', async () => {
    boot({ ADMIN_PASSWORD: PASSWORD });
    const ip = h.uniqueIp();
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong-password-123', ip)).status, 401);
    assert.equal((await login(PASSWORD, ip)).status, 429, 'locked out after 5 tries, even with the right password');
  });

  it('refuses requests from other websites', async () => {
    boot({ ADMIN_PASSWORD: PASSWORD });
    const r = await h.postJson(api('admin-auth'), '/api/admin-auth?op=login', { password: PASSWORD }, { headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });

  it('logs in, never shows test payments, and records a handover', async () => {
    boot({ ADMIN_PASSWORD: PASSWORD });
    const orderId = await paidOrder(); // demo payments are flagged TEST_PAYMENT_MOCK
    const l = await login();
    assert.equal(l.status, 200);
    const cookie = cookieFrom(l);
    assert.match(cookie, /^__Host-merch_admin=\d{13}\./);

    const s1 = await summary(cookie);
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.equal(s1.body.storage, 'local');
    assert.equal(s1.body.handoverAvailable, true);
    assert.equal(s1.body.metrics.paidOrders, 0);
    assert.deepEqual(s1.body.orders, []);
    assert.equal(s1.headers['cache-control'], 'no-store');
    const withParam = await h.invoke(api('admin-summary'), { method: 'GET', url: '/api/admin-summary?includeTest=1', headers: { cookie } });
    assert.equal(withParam.body.metrics.paidOrders, 0, 'the old includeTest switch is gone');

    const ho = await h.postJson(api('admin-handover'), '/api/admin-handover', { orderId, handedOver: true, note: 'collected by friend' }, { headers: { cookie } });
    assert.equal(ho.status, 200, JSON.stringify(ho.body));
    assert.deepEqual(ho.body, { orderId, handedOver: true, note: 'collected by friend' });
    assert.deepEqual((await sheets.getHandover()).get(orderId), { handedOver: true, note: 'collected by friend' });

    const out = await h.postJson(api('admin-auth'), '/api/admin-auth?op=logout', {}, { headers: { cookie } });
    assert.match([].concat(out.headers['set-cookie'])[0], /Max-Age=0/);
  });

  it('validates handover requests', async () => {
    boot({ ADMIN_PASSWORD: PASSWORD });
    const cookie = cookieFrom(await login());
    assert.equal((await h.postJson(api('admin-handover'), '/api/admin-handover', { orderId: 'nope', handedOver: 'yes' }, { headers: { cookie } })).status, 400);
    assert.equal((await h.postJson(api('admin-handover'), '/api/admin-handover', { orderId: 'TEDX-20261029-ZZZZZZ', handedOver: true }, { headers: { cookie } })).status, 404);
  });

  it('changes the password, keeps the changer signed in and signs everyone else out', async () => {
    boot({ ADMIN_PASSWORD: PASSWORD });
    const mine = cookieFrom(await login());
    const other = cookieFrom(await login());
    const change = (body, cookie = mine) => h.postJson(api('admin-auth'), '/api/admin-auth?op=password', body, { headers: { cookie } });

    const wrong = await change({ currentPassword: 'wrong-password-123', newPassword: 'a brand new password' });
    assert.equal(wrong.status, 400);
    assert.ok(wrong.body.error.fields.currentPassword);
    const weak = await change({ currentPassword: PASSWORD, newPassword: 'short' });
    assert.equal(weak.status, 400);
    assert.ok(weak.body.error.fields.newPassword);

    const ok = await change({ currentPassword: PASSWORD, newPassword: 'a brand new password' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const fresh = cookieFrom(ok);
    assert.equal((await summary(fresh)).status, 200, 'changer keeps working with the new cookie');
    assert.equal((await summary(other)).status, 401, 'other sessions are signed out');
    assert.equal((await login(PASSWORD)).status, 401, 'old password refused');
    assert.equal((await login('a brand new password')).status, 200, 'new password accepted');
  });
});

describe('admin password hash in the Config tab (Sheets mode)', () => {
  function fakeConfig(rows) {
    const tab = rows.map((r) => r.slice());
    return {
      tab,
      spreadsheets: {
        values: {
          get: async ({ range }) => {
            assert.match(range, /^Config!/);
            return { data: { values: tab.map((r) => r.slice()) } };
          },
          update: async ({ range, requestBody }) => {
            const m = /^Config!B(\d+)$/.exec(range);
            assert.ok(m, range);
            tab[Number(m[1]) - 1][1] = requestBody.values[0][0];
            return { data: {} };
          },
          append: async ({ range, requestBody }) => {
            assert.equal(range, 'Config!A:B');
            tab.push(...requestBody.values.map((r) => r.slice()));
            return { data: {} };
          }
        }
      }
    };
  }

  let sheets;
  let admin;
  let fake;
  beforeEach(() => {
    h.setEnv({ ADMIN_PASSWORD: PASSWORD, GOOGLE_SHEET_ID: 'sheet', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@example.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: 'x' });
    h.freshModules();
    sheets = h.requireLib('sheets');
    sheets._setRetryOptionsForTests({ maxAttempts: 1, sleep: async () => {} });
    fake = fakeConfig([['key', 'value'], ['PRINTING_CHARGE', 0], ['STORE_OPEN', true]]);
    sheets._setSheetsClientForTests(fake);
    admin = h.requireLib('admin');
  });
  after(() => h.restoreEnv());

  it('adds an ADMIN_PASSWORD_HASH row, then updates it in place', async () => {
    assert.ok((await admin.changePassword(PASSWORD, 'first new password!')).ok);
    assert.equal(fake.tab.length, 4);
    assert.equal(fake.tab[3][0], 'ADMIN_PASSWORD_HASH');
    assert.equal(admin.isPasswordHash(fake.tab[3][1]), true);
    assert.ok((await admin.changePassword('first new password!', 'second new password')).ok);
    assert.equal(fake.tab.length, 4, 'no second row');
    assert.ok(await admin.login('second new password'));
    assert.equal(fake.tab[1][0], 'PRINTING_CHARGE', 'other settings untouched');
  });
});
