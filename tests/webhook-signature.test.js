'use strict';
// lib/cashfree.js verifyWebhookSignature — CONTRACT 5.4 / 6.7.
// expected = base64(HMAC_SHA256(key = secret, message = x-webhook-timestamp + rawBody)), timestamp in ms,
// reject when |now − ts| > toleranceSeconds. Must work on the RAW bytes (decimals such as 1630.00 matter).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { verifyWebhookSignature } = require(path.join(__dirname, '..', 'lib', 'cashfree.js'));
const { signWebhook, paymentSuccessWebhookBody } = require('./helpers/cashfree-fixtures.js');

const SECRET = 'cfsk_ma_test_0123456789abcdefTESTSECRET';
const NOW = 1793280732000; // 2026-10-29T13:32:12Z, fixed for determinism
const TS = String(NOW - 2000); // delivered 2 s ago
const TOL = 300;

const RAW = paymentSuccessWebhookBody({ orderId: 'TEDX-20261029-K3F9QZ', amount: '1630.00' });
const SIG = signWebhook(RAW, TS, SECRET);

function check(overrides = {}) {
  return verifyWebhookSignature({
    rawBody: RAW, signature: SIG, timestamp: TS, secret: SECRET, toleranceSeconds: TOL, now: NOW, ...overrides
  });
}

describe('sample payload', () => {
  it('is a realistic PAYMENT_SUCCESS_WEBHOOK body', () => {
    const parsed = JSON.parse(RAW);
    assert.equal(parsed.type, 'PAYMENT_SUCCESS_WEBHOOK');
    assert.equal(parsed.data.order.order_id, 'TEDX-20261029-K3F9QZ');
    assert.equal(parsed.data.order.order_amount, 1630);
    assert.equal(parsed.data.payment.payment_status, 'SUCCESS');
    assert.equal(parsed.data.payment.cf_payment_id, '5114910392481');
    assert.equal(parsed.data.payment.payment_group, 'upi');
    assert.ok(parsed.event_time);
    assert.ok(RAW.includes('"order_amount":1630.00'), 'raw body keeps two decimals');
    assert.ok(RAW.includes('"payment_amount":1630.00'));
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed body (signed the SDK way)', () => {
    assert.equal(check(), true);
  });

  it('accepts the body as a Buffer or as a string', () => {
    assert.equal(check({ rawBody: Buffer.from(RAW, 'utf8') }), true);
    assert.equal(check({ rawBody: RAW }), true);
  });

  it('handles multi-byte UTF-8 identically for Buffer and string bodies', () => {
    const raw = paymentSuccessWebhookBody({ customerName: 'José Núñez — आशा' });
    const sig = signWebhook(raw, TS, SECRET);
    assert.equal(check({ rawBody: raw, signature: sig }), true);
    assert.equal(check({ rawBody: Buffer.from(raw, 'utf8'), signature: sig }), true);
  });

  it('rejects a tampered amount (1630.00 → 1.00)', () => {
    const tampered = RAW.split('1630.00').join('1.00');
    assert.notEqual(tampered, RAW);
    assert.equal(check({ rawBody: tampered }), false);
    assert.equal(check({ rawBody: Buffer.from(tampered) }), false);
  });

  it('rejects a tampered order id or status', () => {
    assert.equal(check({ rawBody: RAW.replace('K3F9QZ', 'K3F9QA') }), false);
    assert.equal(check({ rawBody: RAW.replace('"payment_status":"SUCCESS"', '"payment_status":"FAILED"') }), false);
  });

  it('rejects a whitespace-only change', () => {
    assert.equal(check({ rawBody: RAW + ' ' }), false);
    assert.equal(check({ rawBody: RAW + '\n' }), false);
    assert.equal(check({ rawBody: RAW.replace('{"data":', '{ "data":') }), false);
  });

  it('is sensitive to decimals: re-serialised JSON (1630.00 → 1630) no longer verifies', () => {
    const reserialised = JSON.stringify(JSON.parse(RAW));
    assert.notEqual(reserialised, RAW, 'JSON.stringify drops the trailing .00');
    assert.ok(reserialised.includes('"order_amount":1630,'));
    assert.equal(check({ rawBody: reserialised }), false);
  });

  it('rejects a signature made with a different secret', () => {
    assert.equal(check({ signature: signWebhook(RAW, TS, 'some-other-secret') }), false);
    assert.equal(check({ secret: 'some-other-secret' }), false);
  });

  it('rejects a signature computed for a different timestamp', () => {
    const otherTs = String(Number(TS) + 1000);
    assert.equal(check({ signature: signWebhook(RAW, otherTs, SECRET) }), false);
    // and a valid signature whose timestamp header was swapped
    assert.equal(check({ timestamp: otherTs }), false);
  });

  it('rejects a body signed without the timestamp prefix', () => {
    const crypto = require('node:crypto');
    const sig = crypto.createHmac('sha256', SECRET).update(RAW).digest('base64');
    assert.equal(check({ signature: sig }), false);
  });

  it('rejects a hex-encoded signature (must be base64)', () => {
    const crypto = require('node:crypto');
    const hex = crypto.createHmac('sha256', SECRET).update(TS + RAW).digest('hex');
    assert.equal(check({ signature: hex }), false);
  });

  it('accepts timestamps inside the tolerance (past and future)', () => {
    for (const offset of [0, 1000, 299000, -1000, -299000]) {
      const ts = String(NOW - offset);
      assert.equal(check({ timestamp: ts, signature: signWebhook(RAW, ts, SECRET) }), true, `offset ${offset}`);
    }
  });

  it('rejects stale timestamps beyond the tolerance (past and future), even when correctly signed', () => {
    for (const offset of [301000, 3600000, -301000, -3600000]) {
      const ts = String(NOW - offset);
      assert.equal(check({ timestamp: ts, signature: signWebhook(RAW, ts, SECRET) }), false, `offset ${offset}`);
    }
  });

  it('honours the toleranceSeconds argument', () => {
    const ts = String(NOW - 61000);
    const sig = signWebhook(RAW, ts, SECRET);
    assert.equal(check({ timestamp: ts, signature: sig, toleranceSeconds: 60 }), false);
    assert.equal(check({ timestamp: ts, signature: sig, toleranceSeconds: 120 }), true);
  });

  it('accepts a 10-digit epoch-seconds timestamp (what Cashfree webhook version 2026-01-01 sends)', () => {
    const seconds = String(Math.floor(NOW / 1000) - 2);
    assert.equal(check({ timestamp: seconds, signature: signWebhook(RAW, seconds, SECRET) }), true);
  });

  it('applies the tolerance to seconds timestamps too (past and future)', () => {
    for (const offset of [-301, 301]) {
      const seconds = String(Math.floor(NOW / 1000) + offset);
      assert.equal(check({ timestamp: seconds, signature: signWebhook(RAW, seconds, SECRET) }), false, `offset ${offset}s`);
    }
  });

  it('still accepts 13-digit epoch-milliseconds timestamps', () => {
    assert.equal(check(), true);
  });

  it('signs over the timestamp exactly as sent: a seconds signature does not validate as milliseconds', () => {
    const seconds = String(Math.floor(NOW / 1000));
    assert.equal(check({ timestamp: seconds + '000', signature: signWebhook(RAW, seconds, SECRET) }), false);
  });

  it('defaults `now` to Date.now()', () => {
    const ts = String(Date.now());
    const sig = signWebhook(RAW, ts, SECRET);
    assert.equal(verifyWebhookSignature({ rawBody: RAW, signature: sig, timestamp: ts, secret: SECRET, toleranceSeconds: TOL }), true);
  });

  it('returns false (never throws) for missing signature / timestamp / secret / body', () => {
    for (const o of [
      { signature: undefined }, { signature: '' }, { signature: null },
      { timestamp: undefined }, { timestamp: '' }, { timestamp: null },
      { secret: undefined }, { secret: '' },
      { rawBody: undefined }, { rawBody: null }
    ]) {
      let result;
      assert.doesNotThrow(() => { result = check(o); }, JSON.stringify(o));
      assert.equal(result, false, JSON.stringify(o));
    }
  });

  it('returns false (never throws) for garbage signatures and timestamps', () => {
    for (const o of [
      { signature: 'not base64 !!! %%%' },
      { signature: 'AAAA' },
      { signature: SIG.slice(0, -4) },
      { signature: SIG + 'AAAA' },
      { signature: SIG.toLowerCase() === SIG ? SIG.toUpperCase() : SIG.toLowerCase() },
      { signature: '\u0000'.repeat(44) },
      { signature: ['array'] },
      { signature: 12345 },
      { timestamp: 'abc' },
      { timestamp: '1793280730000abc' },
      { timestamp: 'NaN' },
      { timestamp: '-1' }
    ]) {
      let result;
      assert.doesNotThrow(() => { result = check(o); }, JSON.stringify(o));
      assert.equal(result, false, JSON.stringify(o));
    }
  });
});
