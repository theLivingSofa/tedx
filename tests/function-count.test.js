'use strict';
// Vercel's Hobby plan refuses a deployment with more than 12 serverless functions (one per file in api/).
// Keep this test until the project is on Pro; then the limit can be raised.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIMIT = 12;

describe('Vercel function count', () => {
  it(`has at most ${LIMIT} files in api/`, () => {
    const files = fs.readdirSync(path.join(__dirname, '..', 'api')).filter((f) => /\.(js|mjs|cjs|ts)$/.test(f));
    assert.ok(files.length <= LIMIT, `${files.length} functions: ${files.join(', ')} — merge some (Hobby plan limit)`);
  });
});
