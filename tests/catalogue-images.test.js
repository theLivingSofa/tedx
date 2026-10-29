'use strict';
// Every local image the seed catalogue points at must exist in public/, or the product card shows a broken image.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(path.join(root, 'data', 'products.json'), 'utf8'));
const products = Array.isArray(raw) ? raw : raw.products;

describe('data/products.json images', () => {
  it('has a local image file for every product with a site-relative imageUrl', () => {
    for (const p of products) {
      if (!p.imageUrl || !p.imageUrl.startsWith('/')) continue;
      const file = path.join(root, 'public', p.imageUrl);
      assert.ok(fs.existsSync(file), `${p.sku}: ${p.imageUrl} is missing`);
      assert.ok(fs.statSync(file).size > 0, `${p.sku}: ${p.imageUrl} is empty`);
    }
  });

  it('keeps product photos small enough for phones (under 200 KB each)', () => {
    for (const p of products) {
      if (!p.imageUrl || !p.imageUrl.startsWith('/images/products/')) continue;
      const size = fs.statSync(path.join(root, 'public', p.imageUrl)).size;
      assert.ok(size < 200 * 1024, `${p.sku}: ${size} bytes`);
    }
  });
});
