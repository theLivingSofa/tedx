'use strict';
// Organiser product editor: validation (lib/admin-catalogue.js), Catalogue tab writes (lib/sheets.js) against an
// in-memory fake of the Google Sheets client, and the /api/admin-catalogue handler.
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/http-mock.js');
const { validateProduct, driveThumbnail } = require('../lib/admin-catalogue');

const PASSWORD = 'correct-horse-battery-staple-42';
const HEADER = ['sku', 'name', 'price', 'category', 'apparel', 'printing', 'imageUrl', 'active', 'stock'];
const base = { sku: 'HOD-009', name: 'Test Hoodie', price: 799, category: 'Winter', apparel: true, printing: true, imageUrl: '', active: true, stock: '' };

/* ------------------------------------------------------------------ fake Google Sheets client */

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function fakeSheets(rows) {
  const tab = rows.map((r) => r.slice());
  const parse = (range) => {
    const [name, a1] = range.split('!');
    assert.equal(name, 'Catalogue', 'only the Catalogue tab is touched');
    if (!a1) return { all: true };
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(a1);
    return { c0: colIndex(m[1]), r0: m[2] ? Number(m[2]) - 1 : null, c1: m[3] ? colIndex(m[3]) : colIndex(m[1]), r1: m[4] ? Number(m[4]) - 1 : null };
  };
  const client = {
    tab,
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { sheetId: 7, title: 'Catalogue' } }, { properties: { sheetId: 8, title: 'Orders' } }] } }),
      batchUpdate: async ({ requestBody }) => {
        for (const r of requestBody.requests) {
          if (r.deleteDimension) {
            assert.equal(r.deleteDimension.range.sheetId, 7, 'deletes from the Catalogue tab only');
            tab.splice(r.deleteDimension.range.startIndex, r.deleteDimension.range.endIndex - r.deleteDimension.range.startIndex);
          }
        }
        return { data: {} };
      },
      values: {
        get: async ({ range }) => {
          if (range.startsWith('Config!')) return { data: { values: [['key', 'value']] } }; // no admin password hash set
          const p = parse(range);
          if (p.all || p.r0 === null) return { data: { values: tab.map((r) => r.slice()) } };
          const out = [];
          for (let r = p.r0; r <= (p.r1 === null ? p.r0 : p.r1); r++) out.push((tab[r] || []).slice(p.c0, p.c1 + 1));
          return { data: { values: out } };
        },
        update: async ({ range, requestBody }) => {
          const p = parse(range);
          tab[p.r0] = requestBody.values[0].slice();
          return { data: {} };
        },
        append: async ({ requestBody }) => {
          for (const row of requestBody.values) tab.push(row.slice());
          return { data: {} };
        }
      }
    }
  };
  return client;
}

const seedRows = () => [
  HEADER,
  ['HOD-001', 'Hoodie', 750, 'Winter', true, true, '/images/products/hod-001.webp', true, ''],
  ['MUG-001', 'White Ceramic Mug', 130, 'Accessories', false, false, '', true, 5],
  ['BAD', '', 'abc', '', '', '', '', '', '']
];

/* ------------------------------------------------------------------ validation */

describe('validateProduct', () => {
  it('accepts a complete product and normalises it', () => {
    const v = validateProduct({ ...base, sku: ' hod-009 ', price: '799.50', stock: '12' });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.deepEqual(v.product, { ...base, sku: 'HOD-009', price: 799.5, stock: 12 });
  });

  it('reports each bad field', () => {
    const v = validateProduct({ sku: 'x', name: '', price: '12.345', category: 'Spring', stock: '-1', apparel: 'yes', extra: 1 });
    assert.equal(v.ok, false);
    for (const f of ['sku', 'name', 'price', 'category', 'stock', 'apparel', 'extra']) assert.ok(v.errors[f], f);
  });

  it('turns Google Drive share links into thumbnail links and refuses hosts the store blocks', () => {
    assert.equal(driveThumbnail('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing'),
      'https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOp&sz=w1200');
    assert.equal(validateProduct({ ...base, imageUrl: 'https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp' }).product.imageUrl,
      'https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOp&sz=w1200');
    assert.ok(validateProduct({ ...base, imageUrl: 'https://imgur.com/a.png' }).errors.imageUrl);
    assert.ok(validateProduct({ ...base, imageUrl: 'http://drive.google.com/x' }).errors.imageUrl);
    assert.ok(validateProduct({ ...base, imageUrl: '/images/../secret' }).errors.imageUrl);
    assert.equal(validateProduct({ ...base, imageUrl: '/images/products/hod-001.webp' }).ok, true);
  });

  it('treats an empty stock as unlimited and 0 as sold out', () => {
    assert.equal(validateProduct({ ...base, stock: '' }).product.stock, null);
    assert.equal(validateProduct({ ...base, stock: 0 }).product.stock, 0);
  });
});

/* ------------------------------------------------------------------ handler + Sheet writes */

describe('/api/admin-catalogue', () => {
  let fake;
  let api;
  let cookie;

  function boot(env = {}) {
    h.setEnv({ SITE_URL: h.SITE_URL, ADMIN_PASSWORD: PASSWORD, LOCAL_DATA_DIR: h.makeTempDir('tedx-cat-'), ...env });
    h.freshModules();
    const sheets = h.requireLib('sheets');
    sheets._setRetryOptionsForTests({ maxAttempts: 1, sleep: async () => {} });
    fake = fakeSheets(seedRows());
    sheets._setSheetsClientForTests(fake);
    api = h.loadHandler('admin-catalogue');
  }
  const sheetsEnv = { GOOGLE_SHEET_ID: 'sheet', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'sa@example.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: 'x' };

  async function signIn() {
    const r = await h.postJson(h.loadHandler('admin-auth'), '/api/admin-auth?op=login', { password: PASSWORD });
    cookie = [].concat(r.headers['set-cookie'])[0].split(';')[0];
  }
  const get = () => h.invoke(api, { method: 'GET', url: '/api/admin-catalogue', headers: { cookie } });
  const post = (body) => h.postJson(api, '/api/admin-catalogue', body, { headers: { cookie } });

  beforeEach(async () => { boot(sheetsEnv); await signIn(); });
  after(() => h.restoreEnv());

  it('needs a session', async () => {
    const r = await h.invoke(api, { method: 'GET', url: '/api/admin-catalogue' });
    assert.equal(r.status, 401);
  });

  it('lists every product, including hidden ones, and flags rows the store skips', async () => {
    fake.tab[2][7] = false; // hide the mug
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.editable, true);
    assert.deepEqual(r.body.products.map((p) => [p.sku, p.active]), [['HOD-001', true], ['MUG-001', false]]);
    assert.equal(r.body.invalidRows.length, 1);
    assert.equal(r.body.invalidRows[0].row, 4);
    assert.ok(r.body.sections.some((s) => s.id === 'Winter'));
  });

  it('reprices and hides a product in its own row, leaving other rows alone', async () => {
    const r = await post({ action: 'update', sku: 'MUG-001', product: { sku: 'MUG-001', name: 'White Ceramic Mug', price: '150', category: 'Accessories', apparel: false, printing: false, imageUrl: '', active: false, stock: '' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(fake.tab[2], ['MUG-001', 'White Ceramic Mug', 150, 'Accessories', false, false, '', false, '']);
    assert.equal(fake.tab[1][2], 750, 'hoodie untouched');
  });

  it('refuses to change a SKU through an update', async () => {
    const r = await post({ action: 'update', sku: 'MUG-001', product: { ...base, sku: 'MUG-002' } });
    assert.equal(r.status, 400);
    assert.ok(r.body.error.fields.sku);
  });

  it('adds a new product and refuses a duplicate SKU', async () => {
    const r = await post({ action: 'create', product: base });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(fake.tab[fake.tab.length - 1], ['HOD-009', 'Test Hoodie', 799, 'Winter', true, true, '', true, '']);
    const dup = await post({ action: 'create', product: base });
    assert.equal(dup.status, 409);
  });

  it('stops formula injection in names', async () => {
    const r = await post({ action: 'create', product: { ...base, name: '=HYPERLINK("http://x")' } });
    assert.equal(r.status, 201);
    assert.equal(fake.tab[fake.tab.length - 1][1], '\'=HYPERLINK("http://x")');
  });

  it('returns field errors for bad input', async () => {
    const r = await post({ action: 'create', product: { ...base, price: 0 } });
    assert.equal(r.status, 400);
    assert.ok(r.body.error.fields.price);
  });

  it('deletes exactly the matching row', async () => {
    const r = await post({ action: 'delete', sku: 'HOD-001' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(fake.tab.map((row) => row[0]), ['sku', 'MUG-001', 'BAD']);
    const again = await post({ action: 'delete', sku: 'HOD-001' });
    assert.equal(again.status, 404);
  });

  it('is read-only in local demo mode', async () => {
    boot({});
    await signIn();
    const list = await get();
    assert.equal(list.status, 200);
    assert.equal(list.body.editable, false);
    assert.ok(list.body.products.length >= 30);
    const r = await post({ action: 'create', product: base });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'catalogue_readonly');
  });
});
