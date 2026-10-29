'use strict';
// lib/pricing.js — CONTRACT 6.4. All money in integer paise internally; rupee numbers out.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const pricing = require(path.join(__dirname, '..', 'lib', 'pricing.js'));
const validate = require(path.join(__dirname, '..', 'lib', 'validate.js'));

const { priceOrder, toPaise, fromPaise, formatINR, amountsEqual, summariseItems } = pricing;

/** Catalogue products as lib/sheets getCatalogue returns them (5.1 shape plus active, stock). */
function product(overrides) {
  return {
    sku: 'X-1', name: 'Thing', price: 100, category: 'Accessories', apparel: false, printing: false,
    imageUrl: '', active: true, stock: null, ...overrides
  };
}

const PRODUCTS = [
  product({ sku: 'HOD-001', name: 'Hoodie', price: 750, category: 'Winter', apparel: true, printing: true, imageUrl: '/images/hoodie-black.svg' }),
  product({ sku: 'POL-001', name: 'Polo', price: 420, category: 'Summer', apparel: true, printing: true }),
  product({ sku: 'MUG-001', name: 'White Ceramic Mug', price: 130 }),
  product({ sku: 'MUG-002', name: 'Black Ceramic Mug', price: 200, stock: 1 }),
  product({ sku: 'TOT-002', name: 'White Tote - Design 2', price: 200, active: false }),
  product({ sku: 'BDG-001', name: 'Badge - Black', price: 40, stock: 0 }),
  product({ sku: 'DEC-001', name: 'Decimal Thing', price: 99.99 }),
  product({ sku: 'DIME-01', name: 'Ten paise', price: 0.1 }),
  product({ sku: 'DIME-02', name: 'Twenty paise', price: 0.2 }),
  product({ sku: 'KEY-001', name: 'KeyChain (MDF)', price: 50, stock: 5 })
];

/** Item as validateItems outputs it (all fields present, normalised). */
function item(overrides) {
  return { sku: 'MUG-001', quantity: 1, size: '', printing: false, printedName: '', ...overrides };
}

function errorFor(result, index) {
  assert.equal(result.ok, false, 'expected priceOrder to fail');
  assert.ok(Array.isArray(result.errors), 'errors must be an array');
  const e = result.errors.find((x) => x.index === index);
  assert.ok(e, `expected an error for index ${index}, got ${JSON.stringify(result.errors)}`);
  assert.equal(typeof e.message, 'string');
  assert.ok(e.message.length > 0);
  return e;
}

describe('toPaise / fromPaise', () => {
  it('converts rupees to integer paise and back', () => {
    assert.equal(toPaise(1630), 163000);
    assert.equal(toPaise(12.34), 1234);
    assert.equal(toPaise(99.99), 9999);
    assert.equal(toPaise(0.1 + 0.2), 30);
    assert.equal(fromPaise(163000), 1630);
    assert.equal(fromPaise(1250), 12.5);
    assert.ok(Number.isInteger(toPaise(19.99 * 3)));
  });

  it('throws on non-finite input', () => {
    assert.throws(() => toPaise(NaN));
    assert.throws(() => toPaise(Infinity));
    assert.throws(() => toPaise(-Infinity));
  });
});

describe('priceOrder — totals', () => {
  it('prices the contract example in paise and returns rupee numbers', () => {
    const r = priceOrder(
      [item({ sku: 'HOD-001', quantity: 2, size: 'M', printing: true, printedName: 'ASHA' }), item({ sku: 'MUG-001', quantity: 1 })],
      PRODUCTS,
      { printingCharge: 0, maxQuantityPerSku: 20 }
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.subtotal, 1630);
    assert.equal(r.printingTotal, 0);
    assert.equal(r.total, 1630);
    assert.equal(r.currency, 'INR');
    assert.equal(r.lines.length, 2);
    assert.deepEqual(r.lines[0], {
      sku: 'HOD-001', name: 'Hoodie', category: 'Winter', size: 'M', printing: true, printedName: 'ASHA',
      quantity: 2, unitPrice: 750, printingCharge: 0, lineTotal: 1500
    });
    assert.deepEqual(r.lines[1], {
      sku: 'MUG-001', name: 'White Ceramic Mug', category: 'Accessories', size: '', printing: false, printedName: '',
      quantity: 1, unitPrice: 130, printingCharge: 0, lineTotal: 130
    });
  });

  it('adds the printing charge per printed item (quantity × charge)', () => {
    const r = priceOrder(
      [item({ sku: 'HOD-001', quantity: 2, size: 'L', printing: true, printedName: 'ASHA' }),
        item({ sku: 'POL-001', quantity: 1, size: 'S' }),
        item({ sku: 'MUG-001', quantity: 3 })],
      PRODUCTS,
      { printingCharge: 50 }
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    const [hoodie, polo, mug] = r.lines;
    assert.equal(hoodie.printingCharge, 50);
    assert.equal(hoodie.lineTotal, 1600); // 2 × (750 + 50)
    assert.equal(polo.lineTotal, 420); // no printing → no charge
    assert.equal(polo.printedName, '');
    assert.equal(mug.lineTotal, 390);
    assert.equal(r.subtotal, 1500 + 420 + 390);
    assert.equal(r.printingTotal, 100);
    assert.equal(r.total, 2410);
  });

  it('handles decimal prices exactly (99.99 × 3 = 299.97, 0.10 + 0.20 = 0.30)', () => {
    const r = priceOrder([item({ sku: 'DEC-001', quantity: 3 })], PRODUCTS);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.lines[0].lineTotal, 299.97);
    assert.equal(r.subtotal, 299.97);
    assert.equal(r.total, 299.97);

    const r2 = priceOrder([item({ sku: 'DIME-01' }), item({ sku: 'DIME-02' })], PRODUCTS);
    assert.equal(r2.ok, true);
    assert.equal(r2.total, 0.3);
  });

  it('handles a decimal printing charge', () => {
    const r = priceOrder(
      [item({ sku: 'HOD-001', quantity: 3, size: 'M', printing: true, printedName: 'A' })],
      PRODUCTS,
      { printingCharge: 12.5 }
    );
    assert.equal(r.ok, true);
    assert.equal(r.printingTotal, 37.5);
    assert.equal(r.total, 2287.5);
  });

  it('defaults printingCharge to 0 and maxQuantityPerSku to 20', () => {
    const r = priceOrder([item({ sku: 'HOD-001', quantity: 20, size: 'M', printing: true, printedName: 'X' })], PRODUCTS);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.printingTotal, 0);
    assert.equal(r.total, 15000);
    const r2 = priceOrder([item({ sku: 'MUG-001', quantity: 21 })], PRODUCTS);
    assert.equal(errorFor(r2, 0).code, 'quantity_limit');
  });

  it('ignores any client-supplied price fields on items', () => {
    const tampered = [
      { ...item({ sku: 'HOD-001', quantity: 2, size: 'M', printing: true, printedName: 'ASHA' }), price: 1, unitPrice: 1, lineTotal: 1, printingCharge: 0, total: 1 },
      { ...item({ sku: 'MUG-001', quantity: 1 }), price: 0.01, unitPrice: 0.01, lineTotal: 0.01 }
    ];
    const r = priceOrder(tampered, PRODUCTS, { printingCharge: 50 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.lines[0].unitPrice, 750);
    assert.equal(r.lines[0].printingCharge, 50);
    assert.equal(r.lines[1].unitPrice, 130);
    assert.equal(r.total, 1600 + 130);
  });

  it('does not mutate its inputs', () => {
    const items = [item({ sku: 'HOD-001', quantity: 1, size: 'M' })];
    const before = JSON.stringify(items);
    const productsBefore = JSON.stringify(PRODUCTS);
    priceOrder(items, PRODUCTS, { printingCharge: 10 });
    assert.equal(JSON.stringify(items), before);
    assert.equal(JSON.stringify(PRODUCTS), productsBefore);
  });

  it('works on the output of validateItems (pipeline)', () => {
    const v = validate.validateItems([
      { sku: 'hod-001', quantity: 2, size: 'M', printing: true, printedName: '  ASHA ' },
      { sku: 'MUG-001', quantity: 1 }
    ]);
    assert.equal(v.ok, true, JSON.stringify(v));
    const r = priceOrder(v.value, PRODUCTS, { printingCharge: 0 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.total, 1630);
    assert.equal(r.lines[0].sku, 'HOD-001');
    assert.equal(r.lines[0].printedName, 'ASHA');
    assert.equal(r.lines[1].size, '');
  });
});

describe('priceOrder — size and printing rules', () => {
  it('size_required for apparel without a size', () => {
    const r = priceOrder([item({ sku: 'HOD-001', quantity: 1, size: '' })], PRODUCTS);
    assert.equal(errorFor(r, 0).code, 'size_required');
  });

  it('size_not_applicable for a non-apparel item with a size', () => {
    const r = priceOrder([item({ sku: 'MUG-001', quantity: 1, size: 'M' })], PRODUCTS);
    assert.equal(errorFor(r, 0).code, 'size_not_applicable');
  });

  it('non-apparel lines always get size ""', () => {
    const r = priceOrder([item({ sku: 'MUG-001', size: '' })], PRODUCTS);
    assert.equal(r.ok, true);
    assert.equal(r.lines[0].size, '');
  });

  it('printing_not_available when printing is requested on a non-printing product', () => {
    const r = priceOrder([item({ sku: 'MUG-001', printing: true, printedName: 'ASHA' })], PRODUCTS);
    assert.equal(errorFor(r, 0).code, 'printing_not_available');
  });

  it('printed_name_required when printing is true but no name is given', () => {
    const r = priceOrder([item({ sku: 'HOD-001', size: 'M', printing: true, printedName: '' })], PRODUCTS);
    assert.equal(errorFor(r, 0).code, 'printed_name_required');
  });
});

describe('priceOrder — availability codes', () => {
  const cases = [
    ['unknown_sku', item({ sku: 'NOPE-999' })],
    ['inactive', item({ sku: 'TOT-002' })],
    ['out_of_stock', item({ sku: 'BDG-001' })],
    ['insufficient_stock', item({ sku: 'MUG-002', quantity: 2 })]
  ];
  for (const [code, it_] of cases) {
    it(code, () => {
      const r = priceOrder([item({ sku: 'MUG-001' }), it_], PRODUCTS);
      const e = errorFor(r, 1);
      assert.equal(e.code, code);
      assert.equal(e.sku, it_.sku);
    });
  }

  it('stock equal to the quantity is fine; stock null is unlimited', () => {
    assert.equal(priceOrder([item({ sku: 'MUG-002', quantity: 1 })], PRODUCTS).ok, true);
    assert.equal(priceOrder([item({ sku: 'KEY-001', quantity: 5 })], PRODUCTS).ok, true);
    assert.equal(errorFor(priceOrder([item({ sku: 'KEY-001', quantity: 6 })], PRODUCTS), 0).code, 'insufficient_stock');
    assert.equal(priceOrder([item({ sku: 'MUG-001', quantity: 20 })], PRODUCTS).ok, true);
  });

  it('quantity_limit when quantity exceeds maxQuantityPerSku', () => {
    const r = priceOrder([item({ sku: 'MUG-001', quantity: 6 })], PRODUCTS, { maxQuantityPerSku: 5 });
    assert.equal(errorFor(r, 0).code, 'quantity_limit');
    assert.equal(priceOrder([item({ sku: 'MUG-001', quantity: 5 })], PRODUCTS, { maxQuantityPerSku: 5 }).ok, true);
  });

  it('duplicate_sku when the same SKU appears twice', () => {
    const r = priceOrder([item({ sku: 'MUG-001' }), item({ sku: 'MUG-001', quantity: 2 })], PRODUCTS);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === 'duplicate_sku'), JSON.stringify(r.errors));
  });

  it('a failed result carries no totals', () => {
    const r = priceOrder([item({ sku: 'NOPE-999' })], PRODUCTS);
    assert.equal(r.ok, false);
    assert.equal(r.total, undefined);
  });
});

describe('formatINR', () => {
  it('formats whole rupees without decimals', () => {
    assert.equal(formatINR(1630), '₹1,630');
    assert.equal(formatINR(750), '₹750');
    assert.equal(formatINR(0), '₹0');
  });
  it('formats fractional rupees with two decimals', () => {
    assert.equal(formatINR(12.5), '₹12.50');
    assert.equal(formatINR(99.99), '₹99.99');
    assert.equal(formatINR(1234.5), '₹1,234.50');
  });
});

describe('amountsEqual', () => {
  it('compares to the paisa', () => {
    assert.equal(amountsEqual(1630, 1630.0), true);
    assert.equal(amountsEqual(0.1 + 0.2, 0.3), true);
    assert.equal(amountsEqual(99.99 * 3, 299.97), true);
    assert.equal(amountsEqual(1630, 1630.01), false);
    assert.equal(amountsEqual(1630, 1), false);
    assert.equal(amountsEqual(750, 1500), false);
  });
});

describe('summariseItems', () => {
  it('produces the Items column string from CONTRACT 4.3', () => {
    const r = priceOrder(
      [item({ sku: 'HOD-001', quantity: 2, size: 'M', printing: true, printedName: 'ASHA' }), item({ sku: 'MUG-001', quantity: 1 })],
      PRODUCTS
    );
    assert.equal(summariseItems(r.lines), 'HOD-001 Hoodie (M, print: "ASHA") ×2; MUG-001 White Ceramic Mug ×1');
  });

  it('mentions sku, size and quantity for apparel without printing', () => {
    const r = priceOrder([item({ sku: 'POL-001', quantity: 3, size: 'XL' })], PRODUCTS);
    const s = summariseItems(r.lines);
    assert.match(s, /POL-001/);
    assert.match(s, /XL/);
    assert.match(s, /×3/);
    assert.doesNotMatch(s, /print:/);
  });
});
