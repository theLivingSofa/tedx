'use strict';
// public/js/pdf.js (tiny PDF writer) and public/js/receipt.js (receipt layout), run in Node.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');

const pdf = require(path.join(__dirname, '..', 'public', 'js', 'pdf.js'));

/** Checks the structural rules a PDF reader relies on: header, xref offsets, trailer, EOF. */
function assertValidPdf(out) {
  assert.ok(out.startsWith('%PDF-1.4\n'));
  assert.ok(out.endsWith('%%EOF\n'));
  assert.match(out, /^[\x0a\x20-\x7e]*$/, 'file is plain ASCII');
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(out)[1]);
  assert.equal(out.slice(startxref, startxref + 5), 'xref\n');
  const m = /xref\n0 (\d+)\n/.exec(out.slice(startxref));
  const count = Number(m[1]);
  const entries = out.slice(startxref).split('\n').slice(2, 2 + count);
  entries.slice(1).forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    assert.equal(out.slice(off, off + String(i + 1).length + 6), `${i + 1} 0 obj`, `object ${i + 1} offset`);
  });
  for (const s of out.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = s.index + s[0].length;
    assert.equal(out.slice(start + Number(s[1]), start + Number(s[1]) + 10), '\nendstream', 'stream length');
  }
  return { pages: Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(out)[1]) };
}

describe('pdf writer', () => {
  it('writes a valid one-page document', () => {
    const doc = pdf.create({ title: 'T' });
    doc.page().text('Hello', 40, 60, { size: 12, bold: true }).rect(0, 0, 100, 20, '#e62b1e').line(0, 0, 10, 10, '#000000');
    assert.equal(assertValidPdf(doc.output()).pages, 1);
  });

  it('escapes PDF special characters and maps non-ASCII text', () => {
    const doc = pdf.create();
    doc.page().text('a (b) c\\d ₹750 “é” 你', 0, 10);
    const out = doc.output();
    assert.ok(out.includes('(a \\(b\\) c\\\\d Rs. 750 \\223\\351\\224 ?) Tj'), out);
  });

  it('supports several pages', () => {
    const doc = pdf.create();
    doc.page().text('one', 10, 10);
    doc.page().text('two', 10, 10);
    assert.equal(assertValidPdf(doc.output()).pages, 2);
  });

  it('wraps long text to the given width and right-aligns using real glyph widths', () => {
    const lines = pdf.wrap('Name printing: "SUPERCALIFRAGILISTIC" on the back of the hoodie', 120, 10);
    assert.ok(lines.length > 1);
    for (const l of lines) assert.ok(pdf.textWidth(l, 10) <= 120, l);
    assert.equal(pdf.textWidth('iiii', 10) < pdf.textWidth('MMMM', 10), true);
  });
});

describe('receipt.js', () => {
  function loadReceipt() {
    const window = { Merch: { pdf } };
    window.Merch.util = {
      brand: () => ({ mark: 'TEDx', organisation: 'TEDxIIMRohtak', receiptFilePrefix: 'TEDxIIMR_Order_Receipt', supportEmail: 'tedx@iimrohtak.ac.in' }),
      formatINR: (n) => '₹' + Number(n).toLocaleString('en-IN'),
      formatDateTime: (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : ''),
      el: () => ({})
    };
    const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'receipt.js'), 'utf8');
    vm.runInNewContext(code, { window, document: undefined, getComputedStyle: undefined, URL, Blob });
    return window.Merch.receipt;
  }

  const view = (n) => ({
    orderId: 'TEDX-20261029-K3F9QZ', status: 'Paid', message: 'Payment received. Your order is confirmed.',
    createdAt: '2026-10-29T10:00:00Z', paidAt: '2026-10-29T10:01:00Z', paymentMethod: 'upi', paymentId: '5114910392481',
    customer: { name: 'Asha (Verma)', roll: 'IPM2023-045', email: 'asha@example.com', phone: '******3210' },
    items: Array.from({ length: n }, (_, i) => ({ sku: 'HOD-001', name: 'Hoodie', size: 'M', printing: i === 0, printedName: 'ASHA',
      quantity: 1, unitPrice: 750, printingCharge: 0, lineTotal: 750 })),
    subtotal: 750 * n, printingTotal: 0, total: 750 * n, currency: 'INR'
  });

  it('builds a valid single-page PDF for a normal order with every detail on it', () => {
    const r = loadReceipt();
    const out = r.buildPdf(view(2));
    assert.equal(assertValidPdf(out).pages, 1);
    for (const s of ['Order receipt', 'TEDX-20261029-K3F9QZ', 'Asha \\(Verma\\)', 'IPM2023-045', 'Rs. 1,500', 'Hoodie', 'tedx@iimrohtak.ac.in']) {
      assert.ok(out.includes(s), s);
    }
    assert.equal(r.fileName('TEDX-20261029-K3F9QZ'), 'TEDxIIMR_Order_Receipt_TEDX-20261029-K3F9QZ.pdf');
  });

  it('continues on a second page for long orders', () => {
    assert.ok(assertValidPdf(loadReceipt().buildPdf(view(40))).pages > 1);
  });
});
