'use strict';
// vercel.json: the old *.vercel.app address forwards visitors to the custom domain, but never /api/*,
// so Cashfree webhooks and the cron keep working on either host.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const cfg = require(path.join(__dirname, '..', 'vercel.json'));

describe('vercel.json redirects', () => {
  const rules = cfg.redirects || [];

  it('only redirects requests for the old vercel.app host', () => {
    for (const r of rules) {
      assert.ok(Array.isArray(r.has) && r.has.some((c) => c.type === 'host'), 'every redirect is limited to one host');
    }
  });

  it('never redirects API routes (webhooks would not follow a redirect)', () => {
    for (const r of rules) {
      const re = new RegExp('^' + r.source + '$'); // Vercel sources here are plain regex paths
      assert.equal(re.test('/api/cashfree-webhook'), false, r.source);
      assert.equal(re.test('/api/reconcile'), false, r.source);
      assert.equal(re.test('/'), true, r.source);
      assert.equal(re.test('/admin'), true, r.source);
    }
  });
});
