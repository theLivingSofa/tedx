'use strict';
// lib/sheets.js — CONTRACT 4.3, 4.4, 4.5, 6.6. Runs against the LOCAL storage backend only (no Google env).
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./helpers/http-mock.js');
const brand = require(path.join(h.ROOT, 'public', 'config', 'brand.js'));

let dataDir;
let sheets;

before(() => {
  dataDir = h.makeTempDir('tedx-sheets-');
  h.setEnv({ LOCAL_DATA_DIR: dataDir, PAYMENT_MODE: 'mock' });
  h.freshModules();
  sheets = h.requireLib('sheets');
});

after(() => {
  h.restoreEnv();
  h.removeDir(dataDir);
});

describe('headers', () => {
  it('ORDER_HEADERS match CONTRACT 4.3 exactly', () => {
    assert.deepEqual([...sheets.ORDER_HEADERS], [
      'Order ID', 'Created At', 'Updated At', 'Status', 'Name', 'Roll Number', 'Email', 'Phone', 'Items', 'Items JSON',
      'Subtotal', 'Printing Total', 'Total', 'Currency', 'Notes', 'Token Hash', 'Payment Mode', 'Gateway Order ID',
      'Gateway Status', 'Payment ID', 'Payment Method', 'Paid At', 'Expires At', 'Email Sent At', 'Review Flag'
    ]);
  });
  it('CATALOGUE_HEADERS and CONFIG_HEADERS', () => {
    assert.deepEqual([...sheets.CATALOGUE_HEADERS], ['sku', 'name', 'price', 'category', 'apparel', 'printing', 'imageUrl', 'active', 'stock']);
    assert.deepEqual([...sheets.CONFIG_HEADERS], ['key', 'value']);
  });
});

describe('sanitizeCell / unsanitizeCell (formula injection, CONTRACT 4.4)', () => {
  const dangerous = ['=SUM(A1:A9)', '=HYPERLINK("http://evil.example","click")', '+911234', '-2+3', '@SUM(A1)', '\t=1+1', '\r=1+1', '=', '+', '-', '@'];

  for (const s of dangerous) {
    it(`prefixes ${JSON.stringify(s)} with a single quote`, () => {
      assert.equal(sheets.sanitizeCell(s), "'" + s);
    });
  }

  it('leaves ordinary strings untouched', () => {
    for (const s of ['Asha Verma', 'asha@example.com', 'HOD-001 Hoodie (M, print: "ASHA") ×2', "O'Brien", "'quoted already", '', ' =leading space', '9876543210', 'a=b', 'Notes\nline 2']) {
      assert.equal(sheets.sanitizeCell(s), s, JSON.stringify(s));
    }
  });

  it('leaves numbers (incl. negatives) and booleans untouched', () => {
    for (const n of [0, 1630, 12.5, -5, 99.99]) assert.equal(sheets.sanitizeCell(n), n);
    assert.equal(sheets.sanitizeCell(true), true);
    assert.equal(sheets.sanitizeCell(false), false);
  });

  it('unsanitizeCell removes the quote only before a dangerous character', () => {
    assert.equal(sheets.unsanitizeCell("'=SUM(A1)"), '=SUM(A1)');
    assert.equal(sheets.unsanitizeCell("'+91"), '+91');
    assert.equal(sheets.unsanitizeCell("'-5"), '-5');
    assert.equal(sheets.unsanitizeCell("'@x"), '@x');
    assert.equal(sheets.unsanitizeCell("'\tx"), '\tx');
    assert.equal(sheets.unsanitizeCell("'\rx"), '\rx');
    assert.equal(sheets.unsanitizeCell("'hello"), "'hello");
    assert.equal(sheets.unsanitizeCell("O'Brien"), "O'Brien");
    assert.equal(sheets.unsanitizeCell('plain'), 'plain');
    assert.equal(sheets.unsanitizeCell(''), '');
    assert.equal(sheets.unsanitizeCell(42), 42);
  });

  it('round-trips every string', () => {
    // Note: a string that already starts with ' followed by a dangerous character cannot round-trip
    // under the CONTRACT 4.4 scheme, so it is deliberately not listed here.
    for (const s of [...dangerous, 'Asha', "''=x", "'", "'abc", 'x', '']) {
      assert.equal(sheets.unsanitizeCell(sheets.sanitizeCell(s)), s, JSON.stringify(s));
    }
  });
});

describe('normaliseCategory (CONTRACT 4.5)', () => {
  const sections = brand.sections;
  const p = (category, name, sku = 'X-001') => ({ sku, name, category });

  it('keeps an exact section id', () => {
    assert.equal(sheets.normaliseCategory(p('Winter', 'Mug'), sections), 'Winter');
    assert.equal(sheets.normaliseCategory(p('Summer', 'Hoodie'), sections), 'Summer');
    assert.equal(sheets.normaliseCategory(p('Accessories', 'Hoodie'), sections), 'Accessories');
  });

  it('matches section ids case-insensitively inside longer text', () => {
    assert.equal(sheets.normaliseCategory(p('winter wear', 'Mug'), sections), 'Winter');
    assert.equal(sheets.normaliseCategory(p('SUMMER COLLECTION', 'Mug'), sections), 'Summer');
    assert.equal(sheets.normaliseCategory(p('accessory', 'Hoodie'), sections), 'Accessories');
    assert.equal(sheets.normaliseCategory(p('Misc accessories', 'Polo'), sections), 'Accessories');
  });

  it('blank MAG-005 Fridge Magnet → Accessories', () => {
    assert.equal(sheets.normaliseCategory({ sku: 'MAG-005', name: 'Fridge Magnet (Plastic)', category: '' }, sections), 'Accessories');
    assert.equal(sheets.normaliseCategory({ sku: 'MAG-005', name: 'Fridge Magnet (Plastic)' }, sections), 'Accessories');
  });

  it('infers Winter from hoodie / varsity / zipper / jacket / sweat names', () => {
    for (const name of ['Hoodie', 'Zipper Hoodie', 'White Varsity Jacket', 'Denim jacket', 'Sweatshirt', 'HOODIE']) {
      assert.equal(sheets.normaliseCategory(p('', name), sections), 'Winter', name);
    }
  });

  it('infers Summer from t-shirt / tshirt / polo / tee names', () => {
    for (const name of ['Oversize T-shirt', 'Tshirt', 'Polo', 'Graphic Tee']) {
      assert.equal(sheets.normaliseCategory(p('', name), sections), 'Summer', name);
    }
  });

  it('infers from the sku too, and falls back to Accessories', () => {
    assert.equal(sheets.normaliseCategory(p('', 'Item', 'HOODIE-9'), sections), 'Winter');
    assert.equal(sheets.normaliseCategory(p('unknown-thing', 'Diary'), sections), 'Accessories');
    assert.equal(sheets.normaliseCategory(p('', 'KeyChain (MDF)'), sections), 'Accessories');
  });
});

describe('local storage backend', () => {
  beforeEach(() => {
    sheets._resetForTests();
  });

  it('storageMode() is local without Google env vars', () => {
    assert.equal(sheets.storageMode(), 'local');
  });

  it('getCatalogue() falls back to data/products.json with every seed product', async () => {
    const { products, source } = await sheets.getCatalogue();
    assert.equal(source, 'fallback');
    assert.equal(products.length, 30);
    const hoodie = products.find((x) => x.sku === 'HOD-001');
    assert.deepEqual(
      { sku: hoodie.sku, name: hoodie.name, price: hoodie.price, category: hoodie.category, apparel: hoodie.apparel, printing: hoodie.printing, active: hoodie.active },
      { sku: 'HOD-001', name: 'Hoodie', price: 750, category: 'Winter', apparel: true, printing: true, active: true }
    );
    const mag5 = products.find((x) => x.sku === 'MAG-005');
    assert.equal(mag5.category, 'Accessories', 'blank category is normalised');
    for (const prod of products) {
      for (const key of ['sku', 'name', 'price', 'category', 'apparel', 'printing', 'imageUrl', 'active', 'stock']) {
        assert.ok(key in prod, `${prod.sku} missing ${key}`);
      }
      assert.equal(typeof prod.price, 'number');
    }
  });

  it('getConfig() uses defaults / env', async () => {
    const cfg = await sheets.getConfig();
    assert.deepEqual(cfg, { printingCharge: 0, storeOpen: true, maxQuantityPerSku: 20 });
  });

  it('getConfig() reads PRINTING_CHARGE from env', async () => {
    process.env.PRINTING_CHARGE = '50';
    try {
      h.freshModules();
      const fresh = h.requireLib('sheets');
      const cfg = await fresh.getConfig();
      assert.equal(cfg.printingCharge, 50);
    } finally {
      delete process.env.PRINTING_CHARGE;
      h.freshModules();
      sheets = h.requireLib('sheets');
    }
  });

  function record(orderId, overrides = {}) {
    const now = new Date().toISOString();
    return {
      orderId, createdAt: now, updatedAt: now, status: 'Awaiting Payment', name: 'Asha Verma', roll: 'IPM2023-045',
      email: 'asha@example.com', phone: '9876543210', itemsSummary: 'MUG-001 White Ceramic Mug ×1',
      items: [{ sku: 'MUG-001', name: 'White Ceramic Mug', category: 'Accessories', size: '', printing: false, printedName: '', quantity: 1, unitPrice: 130, printingCharge: 0, lineTotal: 130 }],
      subtotal: 130, printingTotal: 0, total: 130, currency: 'INR', notes: '', tokenHash: 'a'.repeat(64),
      paymentMode: 'mock', gatewayOrderId: '', gatewayStatus: '', paymentId: '', paymentMethod: '', paidAt: '',
      expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), emailSentAt: '', reviewFlag: '', ...overrides
    };
  }

  it('appendOrder / getOrder round-trip (numbers parsed, items parsed from JSON)', async () => {
    await sheets.appendOrder(record('TEDX-20261029-AAAAAA', { notes: '=HYPERLINK("http://evil.example")', name: 'Asha Verma' }));
    const got = await sheets.getOrder('TEDX-20261029-AAAAAA');
    assert.ok(got);
    assert.equal(got.orderId, 'TEDX-20261029-AAAAAA');
    assert.equal(got.status, 'Awaiting Payment');
    assert.equal(got.total, 130);
    assert.equal(typeof got.total, 'number');
    assert.equal(typeof got.subtotal, 'number');
    assert.ok(Array.isArray(got.items));
    assert.equal(got.items[0].sku, 'MUG-001');
    assert.equal(got.notes, '=HYPERLINK("http://evil.example")', 'formula text comes back exactly as entered');
    assert.ok(fs.existsSync(path.join(dataDir, 'orders.json')), 'local store is orders.json under LOCAL_DATA_DIR');
  });

  it('getOrder returns null for an unknown order', async () => {
    assert.equal(await sheets.getOrder('TEDX-20261029-ZZZZZZ'), null);
  });

  it('updateOrder merges the patch and bumps updatedAt', async () => {
    const created = record('TEDX-20261029-BBBBBB', { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    await sheets.appendOrder(created);
    const updated = await sheets.updateOrder('TEDX-20261029-BBBBBB', { status: 'Paid', paymentId: '5114910392481' });
    assert.equal(updated.status, 'Paid');
    assert.equal(updated.paymentId, '5114910392481');
    assert.equal(updated.name, 'Asha Verma', 'other fields kept');
    assert.notEqual(updated.updatedAt, '2026-01-01T00:00:00.000Z');
    const again = await sheets.getOrder('TEDX-20261029-BBBBBB');
    assert.equal(again.status, 'Paid');
    assert.equal(again.total, 130);
  });

  it('updateOrder throws a 404 HttpError for an unknown order', async () => {
    await assert.rejects(sheets.updateOrder('TEDX-20261029-NNNNNN', { status: 'Paid' }), (err) => {
      assert.equal(err.status ?? err.statusCode, 404);
      return true;
    });
  });

  it('listOrders filters by status and age, oldest first, honouring limit', async () => {
    const base = Date.now() - 3 * 3600 * 1000;
    const iso = (mins) => new Date(base + mins * 60000).toISOString();
    await sheets.appendOrder(record('TEDX-20261029-LLLLLC', { createdAt: iso(30), status: 'Awaiting Payment' }));
    await sheets.appendOrder(record('TEDX-20261029-LLLLLA', { createdAt: iso(10), status: 'Failed' }));
    await sheets.appendOrder(record('TEDX-20261029-LLLLLB', { createdAt: iso(20), status: 'Awaiting Payment' }));
    await sheets.appendOrder(record('TEDX-20261029-LLLLLD', { createdAt: iso(40), status: 'Paid' }));
    await sheets.appendOrder(record('TEDX-20261029-LLLLLE', { createdAt: new Date().toISOString(), status: 'Awaiting Payment' }));

    const olderThan = new Date(Date.now() - 60 * 60000);
    const list = await sheets.listOrders({ statuses: ['Awaiting Payment', 'Failed'], olderThan, limit: 25 });
    const ids = list.map((o) => o.orderId).filter((id) => id.startsWith('TEDX-20261029-LLLLL'));
    assert.deepEqual(ids, ['TEDX-20261029-LLLLLA', 'TEDX-20261029-LLLLLB', 'TEDX-20261029-LLLLLC']);

    const limited = await sheets.listOrders({ statuses: ['Awaiting Payment', 'Failed'], olderThan, limit: 2 });
    assert.ok(limited.length <= 2);
  });
});
