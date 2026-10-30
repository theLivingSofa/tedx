'use strict';
// scripts/setup-dashboard.js writes Sheet formulas that read the Orders and Catalogue tabs. The site appends orders
// with INSERT_ROWS, and Google Sheets shifts plain references such as Orders!A2:A to A3:A, A4:A, … as rows are
// inserted, which silently dropped orders from the Handover and Dashboard tabs (2026-10-29). Every reference to
// those tabs must go through INDIRECT("…"), which Sheets never rewrites.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Code only: drop /* … */ blocks and // line comments so explanations may mention plain references.
const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'setup-dashboard.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('setup-dashboard formulas', () => {
  it('reference Orders and Catalogue only through INDIRECT', () => {
    const plain = src.match(/(?<!INDIRECT\(")\b(Orders|Catalogue)![A-Z]+\d+:[A-Z]+\d*/g) || [];
    assert.deepEqual(plain, [], 'use INDIRECT("Orders!A2:A") instead of Orders!A2:A');
    assert.ok((src.match(/INDIRECT\("Orders!/g) || []).length >= 20, 'formulas still read the Orders tab');
  });

  it('do not count rows with an empty Review Flag as needing a look', () => {
    assert.doesNotMatch(src, /INDIRECT\("Orders!Y2:Y"\),"<>",/, 'COUNTIFS "<>" counts empty strings written by the site');
  });
});
