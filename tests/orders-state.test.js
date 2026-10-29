'use strict';
// lib/orders.js resolveStatus — CONTRACT 4.2 and 6.8 (pure function).
//   resolveStatus(current, gateway = { orderStatus, amount, payments:[{status}] }, expectedTotal, { now, expiresAt })
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { STATUSES, resolveStatus } = require(path.join(__dirname, '..', 'lib', 'orders.js'));

const AWAITING = 'Awaiting Payment';
const PAID = 'Paid';
const FAILED = 'Failed';
const EXPIRED = 'Expired';

const EXPIRES_AT = '2026-10-29T14:10:00.000Z';
const BEFORE_EXPIRY = { now: new Date('2026-10-29T13:45:00.000Z'), expiresAt: EXPIRES_AT };
const JUST_AFTER_EXPIRY = { now: new Date('2026-10-29T14:20:00.000Z'), expiresAt: EXPIRES_AT }; // +10 min (< 15)
const LONG_AFTER_EXPIRY = { now: new Date('2026-10-29T14:26:00.000Z'), expiresAt: EXPIRES_AT }; // +16 min (> 15)

const TOTAL = 1630;

function gw(orderStatus, { amount = TOTAL, payments = [] } = {}) {
  return { orderStatus, amount, payments };
}
function resolve(current, gateway, expected = TOTAL, opts = BEFORE_EXPIRY) {
  const r = resolveStatus(current, gateway, expected, opts);
  assert.ok(r && typeof r === 'object', 'resolveStatus must return an object');
  return r;
}

describe('STATUSES', () => {
  it('matches CONTRACT 4.2', () => {
    assert.deepEqual({ ...STATUSES }, { AWAITING, PAID, FAILED, EXPIRED });
  });
});

describe('resolveStatus — from Awaiting Payment', () => {
  it('PAID with matching amount → Paid (no review flag)', () => {
    const r = resolve(AWAITING, gw('PAID', { payments: [{ status: 'SUCCESS' }] }));
    assert.equal(r.status, PAID);
    assert.ok(!r.reviewFlag);
  });

  it('PAID matches to the paisa with decimal totals (99.99 × 3)', () => {
    assert.equal(resolve(AWAITING, gw('PAID', { amount: 299.97 }), 99.99 * 3).status, PAID);
    assert.equal(resolve(AWAITING, gw('PAID', { amount: 1630.0 }), 1630).status, PAID);
  });

  it('PAID with a different amount → stays Awaiting Payment with AMOUNT_MISMATCH review flag', () => {
    const r = resolve(AWAITING, gw('PAID', { amount: 750, payments: [{ status: 'SUCCESS' }] }), 1500);
    assert.equal(r.status, AWAITING);
    assert.match(r.reviewFlag, /^AMOUNT_MISMATCH/);
    assert.match(r.reviewFlag, /750/);
    assert.match(r.reviewFlag, /1500/);
  });

  it('PAID with an amount off by one paisa is a mismatch', () => {
    const r = resolve(AWAITING, gw('PAID', { amount: 1629.99 }));
    assert.notEqual(r.status, PAID);
    assert.match(r.reviewFlag, /^AMOUNT_MISMATCH/);
  });

  it('PAID with a tiny amount (1.00 for a 1630 order) is never Paid', () => {
    const r = resolve(AWAITING, gw('PAID', { amount: 1 }));
    assert.notEqual(r.status, PAID);
    assert.match(r.reviewFlag, /^AMOUNT_MISMATCH/);
  });

  it('EXPIRED → Expired', () => {
    assert.equal(resolve(AWAITING, gw('EXPIRED')).status, EXPIRED);
  });

  it('TERMINATED → Expired', () => {
    assert.equal(resolve(AWAITING, gw('TERMINATED')).status, EXPIRED);
  });

  for (const ps of ['FAILED', 'USER_DROPPED', 'CANCELLED']) {
    it(`ACTIVE with latest payment ${ps} → Failed`, () => {
      assert.equal(resolve(AWAITING, gw('ACTIVE', { payments: [{ status: ps }] })).status, FAILED);
    });
  }

  it('ACTIVE with no payments → Awaiting Payment', () => {
    const r = resolve(AWAITING, gw('ACTIVE'));
    assert.equal(r.status, AWAITING);
    assert.ok(!r.reviewFlag);
  });

  it('ACTIVE with a PENDING payment → Awaiting Payment', () => {
    assert.equal(resolve(AWAITING, gw('ACTIVE', { payments: [{ status: 'PENDING' }] })).status, AWAITING);
  });

  it('ACTIVE and less than 15 min past expiresAt → still Awaiting Payment', () => {
    assert.equal(resolve(AWAITING, gw('ACTIVE'), TOTAL, JUST_AFTER_EXPIRY).status, AWAITING);
  });

  it('ACTIVE and more than 15 min past expiresAt → Expired', () => {
    assert.equal(resolve(AWAITING, gw('ACTIVE'), TOTAL, LONG_AFTER_EXPIRY).status, EXPIRED);
  });

  it('PAID wins even long after expiry (late success)', () => {
    assert.equal(resolve(AWAITING, gw('PAID'), TOTAL, LONG_AFTER_EXPIRY).status, PAID);
  });
});

describe('resolveStatus — from Failed', () => {
  it('PAID with matching amount → Paid (customer retried)', () => {
    assert.equal(resolve(FAILED, gw('PAID', { payments: [{ status: 'SUCCESS' }] })).status, PAID);
  });
  it('PAID with mismatched amount → stays Failed + review flag', () => {
    const r = resolve(FAILED, gw('PAID', { amount: 999 }));
    assert.equal(r.status, FAILED);
    assert.match(r.reviewFlag, /^AMOUNT_MISMATCH/);
  });
  it('EXPIRED / TERMINATED → Expired', () => {
    assert.equal(resolve(FAILED, gw('EXPIRED')).status, EXPIRED);
    assert.equal(resolve(FAILED, gw('TERMINATED')).status, EXPIRED);
  });
  it('ACTIVE with a FAILED payment → stays Failed', () => {
    assert.equal(resolve(FAILED, gw('ACTIVE', { payments: [{ status: 'FAILED' }] })).status, FAILED);
  });
  it('ACTIVE long after expiry → Expired', () => {
    assert.equal(resolve(FAILED, gw('ACTIVE'), TOTAL, LONG_AFTER_EXPIRY).status, EXPIRED);
  });
});

describe('resolveStatus — from Expired', () => {
  it('PAID with matching amount → Paid (late success)', () => {
    assert.equal(resolve(EXPIRED, gw('PAID'), TOTAL, LONG_AFTER_EXPIRY).status, PAID);
  });
  it('PAID with mismatched amount → stays Expired + review flag', () => {
    const r = resolve(EXPIRED, gw('PAID', { amount: 1 }), TOTAL, LONG_AFTER_EXPIRY);
    assert.equal(r.status, EXPIRED);
    assert.match(r.reviewFlag, /^AMOUNT_MISMATCH/);
  });
  it('EXPIRED / TERMINATED → stays Expired', () => {
    assert.equal(resolve(EXPIRED, gw('EXPIRED')).status, EXPIRED);
    assert.equal(resolve(EXPIRED, gw('TERMINATED')).status, EXPIRED);
  });
  it('ACTIVE without payments → stays Expired', () => {
    assert.equal(resolve(EXPIRED, gw('ACTIVE'), TOTAL, LONG_AFTER_EXPIRY).status, EXPIRED);
  });
});

describe('resolveStatus — Paid never regresses', () => {
  const regressions = [
    ['EXPIRED', gw('EXPIRED'), BEFORE_EXPIRY],
    ['TERMINATED', gw('TERMINATED'), BEFORE_EXPIRY],
    ['TERMINATION_REQUESTED', gw('TERMINATION_REQUESTED'), BEFORE_EXPIRY],
    ['ACTIVE + FAILED', gw('ACTIVE', { payments: [{ status: 'FAILED' }] }), BEFORE_EXPIRY],
    ['ACTIVE + USER_DROPPED', gw('ACTIVE', { payments: [{ status: 'USER_DROPPED' }] }), BEFORE_EXPIRY],
    ['ACTIVE + CANCELLED', gw('ACTIVE', { payments: [{ status: 'CANCELLED' }] }), BEFORE_EXPIRY],
    ['ACTIVE, long after expiry', gw('ACTIVE'), LONG_AFTER_EXPIRY],
    ['ACTIVE, no payments', gw('ACTIVE'), BEFORE_EXPIRY],
    ['PAID with mismatched amount', gw('PAID', { amount: 1 }), BEFORE_EXPIRY],
    ['unknown gateway status', gw('SOMETHING_NEW'), BEFORE_EXPIRY]
  ];
  for (const [label, gateway, opts] of regressions) {
    it(`Paid + ${label} → Paid`, () => {
      assert.equal(resolve(PAID, gateway, TOTAL, opts).status, PAID);
    });
  }
});

describe('resolveStatus — unknown / transitional gateway statuses keep the current status', () => {
  for (const current of [AWAITING, FAILED, EXPIRED]) {
    it(`${current} + unrecognised status → ${current}`, () => {
      assert.equal(resolve(current, gw('SOMETHING_NEW')).status, current);
    });
  }
});

describe('resolveStatus — idempotency', () => {
  const scenarios = [
    [AWAITING, gw('PAID'), BEFORE_EXPIRY],
    [AWAITING, gw('PAID', { amount: 1 }), BEFORE_EXPIRY],
    [AWAITING, gw('EXPIRED'), BEFORE_EXPIRY],
    [AWAITING, gw('ACTIVE', { payments: [{ status: 'FAILED' }] }), BEFORE_EXPIRY],
    [AWAITING, gw('ACTIVE'), LONG_AFTER_EXPIRY],
    [FAILED, gw('PAID'), BEFORE_EXPIRY],
    [EXPIRED, gw('PAID'), LONG_AFTER_EXPIRY],
    [AWAITING, gw('ACTIVE'), BEFORE_EXPIRY]
  ];
  for (const [current, gateway, opts] of scenarios) {
    it(`applying ${gateway.orderStatus}${gateway.payments.length ? '/' + gateway.payments[0].status : ''} twice to ${current} is stable`, () => {
      const first = resolve(current, gateway, TOTAL, opts);
      const second = resolve(first.status, gateway, TOTAL, opts);
      assert.equal(second.status, first.status);
      const third = resolve(second.status, gateway, TOTAL, opts);
      assert.equal(third.status, first.status);
    });
  }

  it('is pure: does not mutate the gateway object', () => {
    const gateway = gw('ACTIVE', { payments: [{ status: 'FAILED' }, { status: 'PENDING' }] });
    const before = JSON.stringify(gateway);
    resolve(AWAITING, gateway);
    assert.equal(JSON.stringify(gateway), before);
  });
});
