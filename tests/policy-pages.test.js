'use strict';
// Cashfree requires contact, terms, refund/cancellation, shipping and privacy pages before activating live
// payments. They must exist, be linked from the store and order pages, and contain no unfilled placeholders.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const PAGES = ['contact', 'terms', 'refund-policy', 'shipping-policy', 'privacy'];
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');

describe('policy pages', () => {
  for (const page of PAGES) {
    it(`${page}.html exists, has a title and no unfilled {{placeholders}}`, () => {
      const html = read(`${page}.html`);
      assert.match(html, /<title>[^<]+<\/title>/);
      assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, 'fill in the {{…}} placeholders');
      assert.doesNotMatch(html, /example\.com/, 'no example addresses');
      assert.doesNotMatch(html, /<script/i, 'policy pages need no scripts');
    });
  }

  for (const file of ['index.html', 'order.html']) {
    it(`${file} links to every policy page`, () => {
      const html = read(file);
      for (const page of PAGES) assert.ok(html.includes(`href="/${page}"`), `${file} → /${page}`);
    });
  }

  it('the support email in brand.js is a real address', () => {
    const brand = require(path.join(pub, 'config', 'brand.js'));
    assert.match(brand.supportEmail, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i);
    assert.doesNotMatch(brand.supportEmail, /example\.com$/);
  });
});
