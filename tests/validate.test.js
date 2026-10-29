'use strict';
// lib/validate.js — CONTRACT 6.3 and the create-order request shape in 5.2.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const v = require(path.join(__dirname, '..', 'lib', 'validate.js'));

function validCustomer(overrides = {}) {
  return { name: 'Asha Verma', roll: 'IPM2023-045', email: 'asha@example.com', phone: '9876543210', notes: 'optional', ...overrides };
}
function validBody(overrides = {}) {
  return {
    customer: validCustomer(),
    items: [
      { sku: 'HOD-001', quantity: 2, size: 'M', printing: true, printedName: 'ASHA' },
      { sku: 'MUG-001', quantity: 1 }
    ],
    ...overrides
  };
}
function withItem(index, patch) {
  const b = validBody();
  b.items[index] = { ...b.items[index], ...patch };
  return b;
}
function withoutItemKey(index, key) {
  const b = validBody();
  delete b.items[index][key];
  return b;
}
function withCustomer(patch) {
  return validBody({ customer: validCustomer(patch) });
}

/** Expect failure with an error on exactly `key` (other keys allowed only when listed in `alsoAllowed`). */
function expectFieldError(result, key) {
  assert.equal(result.ok, false, `expected failure for ${key}, got ${JSON.stringify(result)}`);
  assert.ok(result.fields && typeof result.fields === 'object', 'fields object expected');
  assert.ok(key in result.fields, `expected fields[${JSON.stringify(key)}], got ${JSON.stringify(result.fields)}`);
  assert.equal(typeof result.fields[key], 'string');
  assert.ok(result.fields[key].length > 0, 'message must be a non-empty sentence');
  return result.fields[key];
}

function expectOk(result) {
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result.fields || result)}`);
  return result.value;
}

describe('constants', () => {
  it('SIZES and MAX_QTY', () => {
    assert.deepEqual([...v.SIZES], ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']);
    assert.equal(v.MAX_QTY, 20);
  });
});

describe('validateOrderRequest — valid input and normalisation', () => {
  it('accepts the contract example', () => {
    const value = expectOk(v.validateOrderRequest(validBody()));
    assert.equal(value.customer.name, 'Asha Verma');
    assert.equal(value.customer.roll, 'IPM2023-045');
    assert.equal(value.items.length, 2);
    assert.equal(value.items[0].sku, 'HOD-001');
    assert.equal(value.items[0].quantity, 2);
    assert.equal(value.items[0].size, 'M');
    assert.equal(value.items[0].printing, true);
    assert.equal(value.items[0].printedName, 'ASHA');
    assert.equal(value.items[1].printing, false, 'printing defaults to false');
  });

  it('normalises email to lower-case and phone to 10 digits', () => {
    const value = expectOk(v.validateOrderRequest(withCustomer({ email: '  Asha.Verma@Example.COM ', phone: '+91 98765-43210' })));
    assert.equal(value.customer.email, 'asha.verma@example.com');
    assert.equal(value.customer.phone, '9876543210');
  });

  for (const phone of ['9876543210', '+919876543210', '919876543210', '09876543210', '98765 43210', '98765-43210', '+91-98765-43210', '6123456789']) {
    it(`accepts phone ${JSON.stringify(phone)}`, () => {
      const value = expectOk(v.validateCustomer(validCustomer({ phone })));
      assert.match(value.phone, /^[6-9]\d{9}$/);
      assert.equal(value.phone, phone.replace(/\D/g, '').slice(-10));
    });
  }

  it('trims and collapses spaces in name; trims roll', () => {
    const value = expectOk(v.validateCustomer(validCustomer({ name: '  Asha    Verma  ', roll: '  IPM2023-045 ' })));
    assert.equal(value.name, 'Asha Verma');
    assert.equal(value.roll, 'IPM2023-045');
  });

  it("accepts Unicode letters and .'- in names", () => {
    expectOk(v.validateCustomer(validCustomer({ name: "José Núñez-O'Brien Jr." })));
    expectOk(v.validateCustomer(validCustomer({ name: 'Zoë D\'Souza' })));
  });

  it('notes are optional: omitted or empty', () => {
    const c = validCustomer();
    delete c.notes;
    expectOk(v.validateCustomer(c));
    expectOk(v.validateCustomer(validCustomer({ notes: '' })));
  });

  it('strips control characters from notes but keeps newlines', () => {
    const value = expectOk(v.validateCustomer(validCustomer({ notes: 'deliver\u0007 to\u0000 hostel\nroom 12' })));
    assert.equal(value.notes, 'deliver to hostel\nroom 12');
  });

  it('upper-cases sku and trims printedName', () => {
    const value = expectOk(v.validateItems([{ sku: 'hod-001', quantity: 1, size: 'L', printing: true, printedName: '  ASHA  ' }]));
    assert.equal(value[0].sku, 'HOD-001');
    assert.equal(value[0].printedName, 'ASHA');
  });

  it("accepts printedName characters [A-Za-z0-9 .'&-] up to 20 chars", () => {
    expectOk(v.validateItems([{ sku: 'HOD-001', quantity: 1, size: 'M', printing: true, printedName: "O'Neil & Co. 7-A" }]));
    expectOk(v.validateItems([{ sku: 'HOD-001', quantity: 1, size: 'M', printing: true, printedName: 'A'.repeat(20) }]));
  });

  it('accepts every size in SIZES and quantity 1 and 20', () => {
    for (const size of v.SIZES) expectOk(v.validateItems([{ sku: 'HOD-001', quantity: 1, size }]));
    expectOk(v.validateItems([{ sku: 'MUG-001', quantity: 20 }]));
  });

  it('accepts printing:false with empty printedName, and an empty size on non-apparel', () => {
    expectOk(v.validateItems([{ sku: 'MUG-001', quantity: 1, size: '', printing: false, printedName: '' }]));
  });

  it('accepts exactly 50 items', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ sku: `SKU-${i}`, quantity: 1 }));
    assert.equal(expectOk(v.validateItems(items)).length, 50);
  });
});

describe('validateOrderRequest — customer field rules', () => {
  const bad = {
    name: ['A', 'x'.repeat(81), 'Asha123', '<script>', '', '   ', 42, null],
    roll: ['', 'R'.repeat(31), 'IPM@2023', 'IPM;DROP', 12345, null],
    email: ['not-an-email', 'asha@@example.com', 'asha @example.com', '@example.com', 'asha@', `${'a'.repeat(250)}@example.com`, '', 42],
    phone: ['5876543210', '987654321', '98765432100', '+1 9876543210', 'abcdefghij', '', '+92 9876543210'],
    notes: ['n'.repeat(501), 42]
  };
  for (const [field, values] of Object.entries(bad)) {
    for (const value of values) {
      const label = typeof value === 'string' && value.length > 30 ? `${value.length} chars` : JSON.stringify(value);
      it(`rejects ${field} = ${label} with fields.${field}`, () => {
        expectFieldError(v.validateOrderRequest(withCustomer({ [field]: value })), field);
      });
    }
  }

  it('accepts notes of exactly 500 chars and roll of 30 chars', () => {
    expectOk(v.validateCustomer(validCustomer({ notes: 'n'.repeat(500), roll: 'R'.repeat(30) })));
    expectOk(v.validateCustomer(validCustomer({ roll: 'IPM2023/045_A -1' })));
  });

  for (const field of ['name', 'roll', 'email', 'phone']) {
    it(`requires ${field}`, () => {
      const b = validBody();
      delete b.customer[field];
      expectFieldError(v.validateOrderRequest(b), field);
    });
  }
});

describe('validateOrderRequest — item field rules', () => {
  it('rejects quantity given as a numeric string', () => {
    expectFieldError(v.validateOrderRequest(withItem(1, { quantity: '2' })), 'items[1].quantity');
  });
  for (const quantity of [0, 21, 1.5, -1, NaN, Infinity, null, true]) {
    it(`rejects quantity ${String(quantity)}`, () => {
      expectFieldError(v.validateOrderRequest(withItem(0, { quantity })), 'items[0].quantity');
    });
  }
  it('requires quantity', () => {
    expectFieldError(v.validateOrderRequest(withoutItemKey(1, 'quantity')), 'items[1].quantity');
  });
  it('requires sku', () => {
    expectFieldError(v.validateOrderRequest(withoutItemKey(1, 'sku')), 'items[1].sku');
    expectFieldError(v.validateOrderRequest(withItem(1, { sku: '' })), 'items[1].sku');
    expectFieldError(v.validateOrderRequest(withItem(1, { sku: 42 })), 'items[1].sku');
  });
  it('rejects printing given as the string "true"', () => {
    expectFieldError(v.validateOrderRequest(withItem(0, { printing: 'true' })), 'items[0].printing');
    expectFieldError(v.validateOrderRequest(withItem(0, { printing: 1 })), 'items[0].printing');
  });
  it('requires printedName when printing is true', () => {
    expectFieldError(v.validateOrderRequest(withoutItemKey(0, 'printedName')), 'items[0].printedName');
    expectFieldError(v.validateOrderRequest(withItem(0, { printedName: '' })), 'items[0].printedName');
    expectFieldError(v.validateOrderRequest(withItem(0, { printedName: '    ' })), 'items[0].printedName');
  });
  it('rejects printedName over 20 chars or with disallowed characters', () => {
    expectFieldError(v.validateOrderRequest(withItem(0, { printedName: 'A'.repeat(21) })), 'items[0].printedName');
    expectFieldError(v.validateOrderRequest(withItem(0, { printedName: 'ASHA<3' })), 'items[0].printedName');
    expectFieldError(v.validateOrderRequest(withItem(0, { printedName: 'ASHA"' })), 'items[0].printedName');
    expectFieldError(v.validateOrderRequest(withItem(0, { printedName: '=HYPERLINK()' })), 'items[0].printedName');
  });
  it('rejects a size that is not in SIZES', () => {
    expectFieldError(v.validateOrderRequest(withItem(0, { size: 'XXXXL' })), 'items[0].size');
    expectFieldError(v.validateOrderRequest(withItem(0, { size: 42 })), 'items[0].size');
  });
  it('rejects an empty items array and more than 50 items', () => {
    const r1 = v.validateOrderRequest(validBody({ items: [] }));
    assert.equal(r1.ok, false);
    assert.ok(Object.keys(r1.fields).some((k) => k.startsWith('items')), JSON.stringify(r1.fields));

    const items = Array.from({ length: 51 }, (_, i) => ({ sku: `SKU-${i}`, quantity: 1 }));
    const r2 = v.validateOrderRequest(validBody({ items }));
    assert.equal(r2.ok, false);
    assert.ok(Object.keys(r2.fields).some((k) => k.startsWith('items')), JSON.stringify(r2.fields));
  });
  it('rejects items that are not an array / item that is not an object', () => {
    assert.equal(v.validateOrderRequest(validBody({ items: { 0: { sku: 'MUG-001', quantity: 1 } } })).ok, false);
    assert.equal(v.validateOrderRequest(validBody({ items: 'MUG-001' })).ok, false);
    const r = v.validateOrderRequest(validBody({ items: [null] }));
    assert.equal(r.ok, false);
    assert.ok(Object.keys(r.fields).some((k) => k.startsWith('items')));
  });
});

describe('validateOrderRequest — unexpected keys', () => {
  function expectUnexpected(result, keyName) {
    const msg = expectFieldError(result, '_');
    assert.match(msg, new RegExp(keyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return msg;
  }
  it('at top level (client "total")', () => {
    expectUnexpected(v.validateOrderRequest(validBody({ total: 1 })), 'total');
  });
  it('in customer', () => {
    expectUnexpected(v.validateOrderRequest(withCustomer({ isAdmin: true })), 'isAdmin');
  });
  it('in an item (client "price")', () => {
    expectUnexpected(v.validateOrderRequest(withItem(1, { price: 1 })), 'price');
  });
  it('message reads "Unexpected field: X"', () => {
    assert.match(v.validateOrderRequest(validBody({ total: 1 })).fields._, /^Unexpected field: /);
  });
  it('__proto__ keys (as produced by JSON.parse) are rejected and do not pollute prototypes', () => {
    const top = JSON.parse('{"customer":' + JSON.stringify(validCustomer()) + ',"items":[{"sku":"MUG-001","quantity":1}],"__proto__":{"polluted":1}}');
    expectFieldError(v.validateOrderRequest(top), '_');
    const inCustomer = JSON.parse('{"customer":{"name":"Asha Verma","roll":"R1","email":"a@example.com","phone":"9876543210","__proto__":{"polluted":1}},"items":[{"sku":"MUG-001","quantity":1}]}');
    expectFieldError(v.validateOrderRequest(inCustomer), '_');
    const inItem = JSON.parse('{"customer":' + JSON.stringify(validCustomer()) + ',"items":[{"sku":"MUG-001","quantity":1,"__proto__":{"isAdmin":true}}]}');
    expectFieldError(v.validateOrderRequest(inItem), '_');
    assert.equal(({}).polluted, undefined);
    assert.equal(({}).isAdmin, undefined);
  });
  it('constructor / prototype keys are rejected', () => {
    expectFieldError(v.validateOrderRequest(validBody({ constructor: { prototype: { x: 1 } } })), '_');
    expectFieldError(v.validateOrderRequest(withItem(0, { constructor: 'x' })), '_');
    expectFieldError(v.validateOrderRequest(withCustomer({ prototype: 'x' })), '_');
  });
});

describe('validateOrderRequest — shape and aggregation', () => {
  for (const body of [null, undefined, [], 'string', 42, true]) {
    it(`rejects non-object body ${JSON.stringify(body)}`, () => {
      const r = v.validateOrderRequest(body);
      assert.equal(r.ok, false);
      assert.ok(r.fields && Object.keys(r.fields).length > 0);
    });
  }
  it('rejects a missing customer object', () => {
    const r = v.validateOrderRequest({ items: validBody().items });
    assert.equal(r.ok, false);
  });
  it('returns all errors at once, keyed exactly as in CONTRACT 5.2', () => {
    const body = validBody({
      customer: { name: 'A', roll: '', email: 'nope', phone: '123', notes: 'n'.repeat(501) },
      items: [
        { sku: 'HOD-001', quantity: 0, size: 'HUGE', printing: true, printedName: '' },
        { sku: 'MUG-001', quantity: '1', printing: 'yes' }
      ]
    });
    const r = v.validateOrderRequest(body);
    assert.equal(r.ok, false);
    for (const key of ['name', 'roll', 'email', 'phone', 'notes', 'items[0].quantity', 'items[0].size',
      'items[0].printedName', 'items[1].quantity', 'items[1].printing']) {
      assert.ok(key in r.fields, `missing ${key} in ${JSON.stringify(Object.keys(r.fields))}`);
    }
  });
  it('does not echo raw input or stack traces in messages', () => {
    const r = v.validateOrderRequest(withCustomer({ email: '<img src=x onerror=alert(1)>' }));
    for (const msg of Object.values(r.fields)) {
      assert.doesNotMatch(msg, /<img|onerror|at Object\.|\n\s+at /);
    }
  });
});

describe('validateOrderId / validateTokenFormat', () => {
  it('validateOrderId', () => {
    assert.equal(v.validateOrderId('TEDX-20261029-K3F9QZ'), true);
    assert.equal(v.validateOrderId('A1-20261029-ABCDEF'), true);
    assert.equal(v.validateOrderId('ABCDEFGH-20261029-ABCDEF'), true);
    for (const bad of ['tedx-20261029-K3F9QZ', 'TEDX-20261029-k3f9qz', 'TEDX-2026102-K3F9QZ', 'TEDX-20261029-K3F9Q',
      'TEDX-20261029-K3F9QZZ', 'TEDX-20261029-K3F9Q1', 'TEDX-20261029-K3F9Q0', 'ABCDEFGHI-20261029-ABCDEF',
      '-20261029-ABCDEF', 'TEDX_20261029_K3F9QZ', ' TEDX-20261029-K3F9QZ', 'TEDX-20261029-K3F9QZ\n', '', null, undefined, 42, {}]) {
      assert.equal(v.validateOrderId(bad), false, `expected false for ${JSON.stringify(bad)}`);
    }
  });
  it('validateTokenFormat', () => {
    assert.equal(v.validateTokenFormat('A'.repeat(43)), true);
    assert.equal(v.validateTokenFormat('abcABC012_-'.padEnd(43, 'x')), true);
    for (const bad of ['A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + '+', 'A'.repeat(42) + '/', 'A'.repeat(42) + '=',
      '', null, undefined, 43]) {
      assert.equal(v.validateTokenFormat(bad), false, `expected false for ${JSON.stringify(bad)}`);
    }
  });
});
