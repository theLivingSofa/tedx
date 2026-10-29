'use strict';
// lib/cashfree.js paymentMode / environment / baseUrl — env rules from CONTRACT 3 and 6.7.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers/http-mock.js');

let dir = null;
function load(env) {
  if (!dir) dir = h.makeTempDir('tedx-cfg-');
  h.setEnv({ LOCAL_DATA_DIR: dir, ...env });
  h.freshModules();
  return h.requireLib('cashfree');
}

afterEach(() => {
  h.restoreEnv();
  if (dir) h.removeDir(dir);
  dir = null;
});

const KEYS = { CASHFREE_APP_ID: 'app', CASHFREE_SECRET_KEY: 'secret' };

describe('paymentMode()', () => {
  const cases = [
    ['no keys → mock', {}, 'mock'],
    ['both keys → cashfree', KEYS, 'cashfree'],
    ['only APP_ID → mock', { CASHFREE_APP_ID: 'app' }, 'mock'],
    ['only SECRET_KEY → mock', { CASHFREE_SECRET_KEY: 'secret' }, 'mock'],
    ['PAYMENT_MODE=mock overrides keys', { ...KEYS, PAYMENT_MODE: 'mock' }, 'mock'],
    ['PAYMENT_MODE=cashfree with keys', { ...KEYS, PAYMENT_MODE: 'cashfree' }, 'cashfree'],
    ['PAYMENT_MODE=cashfree without keys → unavailable', { PAYMENT_MODE: 'cashfree' }, 'unavailable'],
    ['production deployment without keys → unavailable (mock refused)', { VERCEL_ENV: 'production' }, 'unavailable'],
    ['production + PAYMENT_MODE=mock → unavailable', { VERCEL_ENV: 'production', PAYMENT_MODE: 'mock' }, 'unavailable'],
    ['production + ALLOW_MOCK_IN_PRODUCTION=true → mock', { VERCEL_ENV: 'production', ALLOW_MOCK_IN_PRODUCTION: 'true' }, 'mock'],
    ['production + ALLOW_MOCK_IN_PRODUCTION=false → unavailable', { VERCEL_ENV: 'production', ALLOW_MOCK_IN_PRODUCTION: 'false' }, 'unavailable'],
    ['production with keys → cashfree', { VERCEL_ENV: 'production', ...KEYS }, 'cashfree'],
    ['preview deployment without keys → mock', { VERCEL_ENV: 'preview' }, 'mock']
  ];
  for (const [label, env, expected] of cases) {
    it(label, () => {
      assert.equal(load(env).paymentMode(), expected);
    });
  }
});

describe('environment() / baseUrl()', () => {
  it('defaults to sandbox', () => {
    const c = load(KEYS);
    assert.equal(c.environment(), 'sandbox');
    assert.equal(c.baseUrl(), 'https://sandbox.cashfree.com/pg');
  });
  it('CASHFREE_ENV=sandbox', () => {
    const c = load({ ...KEYS, CASHFREE_ENV: 'sandbox' });
    assert.equal(c.environment(), 'sandbox');
    assert.equal(c.baseUrl(), 'https://sandbox.cashfree.com/pg');
  });
  it('CASHFREE_ENV=production', () => {
    const c = load({ ...KEYS, CASHFREE_ENV: 'production' });
    assert.equal(c.environment(), 'production');
    assert.equal(c.baseUrl(), 'https://api.cashfree.com/pg');
  });
});
