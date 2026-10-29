'use strict';
// lib/tokens.js — CONTRACT 6.2.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const tokens = require(path.join(__dirname, '..', 'lib', 'tokens.js'));
const { validateOrderId, validateTokenFormat } = require(path.join(__dirname, '..', 'lib', 'validate.js'));
const brand = require(path.join(__dirname, '..', 'public', 'config', 'brand.js'));

describe('generateToken', () => {
  it('is 43 base64url characters (32 random bytes)', () => {
    const t = tokens.generateToken();
    assert.equal(typeof t, 'string');
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(t, 'base64url').length, 32);
    assert.equal(validateTokenFormat(t), true);
  });

  it('is unique across many calls', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i += 1) seen.add(tokens.generateToken());
    assert.equal(seen.size, 2000);
  });
});

describe('hashToken', () => {
  it('is sha256 hex', () => {
    assert.equal(tokens.hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const t = tokens.generateToken();
    assert.equal(tokens.hashToken(t), crypto.createHash('sha256').update(t).digest('hex'));
    assert.match(tokens.hashToken(t), /^[0-9a-f]{64}$/);
  });

  it('never returns the token itself', () => {
    const t = tokens.generateToken();
    assert.notEqual(tokens.hashToken(t), t);
    assert.ok(!tokens.hashToken(t).includes(t));
  });
});

describe('verifyToken', () => {
  const token = tokens.generateToken();
  const hash = tokens.hashToken(token);

  it('true for the matching token', () => {
    assert.equal(tokens.verifyToken(token, hash), true);
  });

  it('false for a different token or a tampered hash', () => {
    assert.equal(tokens.verifyToken(tokens.generateToken(), hash), false);
    const flipped = (hash[0] === 'a' ? 'b' : 'a') + hash.slice(1);
    assert.equal(tokens.verifyToken(token, flipped), false);
    assert.equal(tokens.verifyToken(token.slice(0, 42) + (token[42] === 'A' ? 'B' : 'A'), hash), false);
  });

  it('false (never throws) for non-string or malformed input', () => {
    const bad = [undefined, null, 42, {}, [], true, Buffer.from(token)];
    for (const b of bad) {
      assert.equal(tokens.verifyToken(b, hash), false, `token ${String(b)}`);
      assert.equal(tokens.verifyToken(token, b), false, `hash ${String(b)}`);
    }
    for (const badHash of ['', 'xyz', hash.slice(0, 63), hash + '0', 'z'.repeat(64)]) {
      assert.equal(tokens.verifyToken(token, badHash), false, `hash ${badHash}`);
    }
    assert.equal(tokens.verifyToken('', hash), false);
  });

  it('does not accept the hash itself as a token', () => {
    assert.equal(tokens.verifyToken(hash, hash), false);
  });
});

describe('safeEqual', () => {
  it('compares strings', () => {
    assert.equal(tokens.safeEqual('abc', 'abc'), true);
    assert.equal(tokens.safeEqual('abc', 'abd'), false);
    assert.equal(tokens.safeEqual('abc', 'ABC'), false);
    assert.equal(tokens.safeEqual('Bearer s3cret', 'Bearer s3cret'), true);
    assert.equal(tokens.safeEqual('héllo', 'héllo'), true);
    assert.equal(tokens.safeEqual('héllo', 'hello'), false);
  });

  it('false on length mismatch, without throwing', () => {
    assert.equal(tokens.safeEqual('abc', 'abcd'), false);
    assert.equal(tokens.safeEqual('abcd', 'abc'), false);
    assert.equal(tokens.safeEqual('', 'a'), false);
  });

  it('works on long secrets', () => {
    const a = 'x'.repeat(4096);
    assert.equal(tokens.safeEqual(a, 'x'.repeat(4096)), true);
    assert.equal(tokens.safeEqual(a, 'x'.repeat(4095) + 'y'), false);
  });
});

describe('generateOrderId', () => {
  // 13:40 UTC = 19:10 IST: the same calendar day in either timezone.
  const date = new Date('2026-10-29T13:40:00.000Z');

  it('has the format PREFIX-YYYYMMDD-XXXXXX and passes validateOrderId', () => {
    const id = tokens.generateOrderId('TEDX', date);
    assert.match(id, /^TEDX-20261029-[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(validateOrderId(id), true);
  });

  it('works with the brand prefix', () => {
    const id = tokens.generateOrderId(brand.orderIdPrefix, date);
    assert.ok(id.startsWith(brand.orderIdPrefix + '-20261029-'));
    assert.equal(validateOrderId(id), true);
  });

  it('never uses the ambiguous characters I, O, 0 or 1 in the random part', () => {
    const all = new Set();
    for (let i = 0; i < 1000; i += 1) {
      const suffix = tokens.generateOrderId('TEDX', date).split('-')[2];
      for (const ch of suffix) all.add(ch);
    }
    for (const ch of ['I', 'O', '0', '1']) assert.ok(!all.has(ch), `found ${ch}`);
    assert.ok(all.size > 20, 'random part should use most of the alphabet');
  });

  it('is unique across many calls', () => {
    const seen = new Set();
    // 32^6 ≈ 1.07e9 combinations: 300 ids collide with probability ≈ 4e-5.
    for (let i = 0; i < 300; i += 1) seen.add(tokens.generateOrderId('TEDX', date));
    assert.equal(seen.size, 300);
  });

  it('defaults the date to now', () => {
    const id = tokens.generateOrderId('TEDX');
    assert.equal(validateOrderId(id), true);
  });
});
