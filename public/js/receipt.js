/*
 * Client-side receipt: an A4 PDF built from the order view (CONTRACT 5.6 / 7) with public/js/pdf.js.
 * Colours come from the live design tokens when they are plain #rrggbb values, so a re-theme in
 * tokens.css also re-themes the receipt.
 */
(function () {
  'use strict';

  var M = (window.Merch = window.Merch || {});
  var U = M.util;
  var lastUrl = null;

  var DEFAULTS = {
    red: '#e62b1e', ink: '#171717', muted: '#666666', line: '#e5e5e5', 'hero-bg': '#111111', 'hero-muted': '#dddddd',
    'success-bg': '#eaf7ed', 'success-border': '#b6dfbe', 'error-bg': '#fff0ef', 'note-bg': '#f4f4f4'
  };

  function tokens() {
    var out = {};
    var cs = null;
    try { cs = getComputedStyle(document.documentElement); } catch (e) { cs = null; }
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = cs ? cs.getPropertyValue('--' + k).trim() : '';
      out[k] = /^#[0-9a-f]{6}$/i.test(v) ? v : DEFAULTS[k];
    });
    return out;
  }

  var MARGIN = 40;

  /** Builds the receipt and returns the PDF as a string. */
  function buildPdf(view) {
    var b = U.brand();
    var t = tokens();
    var doc = M.pdf.create({ title: 'Order receipt ' + (view.orderId || '') });
    var W = doc.width;
    var right = W - MARGIN;
    var bottomLimit = doc.height - 70;
    var top = 0;

    function newPage() {
      doc.page();
      top = MARGIN;
    }
    function ensure(space) {
      if (top + space > bottomLimit) newPage();
    }

    // Header band
    doc.page();
    doc.rect(0, 0, W, 112, t['hero-bg']);
    doc.rect(0, 0, W, 6, t.red);
    doc.text(b.mark || 'TEDx', MARGIN, 44, { size: 24, bold: true, color: t.red });
    doc.text('Order receipt', MARGIN, 72, { size: 18, bold: true, color: '#ffffff' });
    doc.text(b.organisation || b.pageTitle || '', MARGIN, 94, { size: 11, color: t['hero-muted'] });
    top = 140;

    // Status pill + message
    var status = String(view.status || '');
    var pillBg = status === 'Paid' ? t['success-bg'] : status === 'Awaiting Payment' ? t['note-bg'] : t['error-bg'];
    var pillW = doc.textWidth(status, 11, true) + 24;
    doc.rect(MARGIN, top - 14, pillW, 22, pillBg);
    doc.text(status, MARGIN + 12, top + 1, { size: 11, bold: true, color: t.ink });
    top += 26;
    if (view.message) {
      doc.wrap(view.message, right - MARGIN, 10).forEach(function (line) {
        doc.text(line, MARGIN, top, { size: 10, color: t.ink });
        top += 14;
      });
    }
    top += 8;

    // Order details
    var c = view.customer || {};
    var details = [
      ['Order ID', view.orderId],
      ['Order placed', U.formatDateTime(view.createdAt)],
      ['Paid at', U.formatDateTime(view.paidAt)],
      ['Name', c.name], ['Roll number', c.roll], ['Email', c.email], ['Contact number', c.phone],
      ['Payment method', view.paymentMethod], ['Payment reference', view.paymentId]
    ].filter(function (r) { return r[1] != null && r[1] !== ''; });
    var valueX = MARGIN + 150;
    details.forEach(function (r) {
      var lines = doc.wrap(r[1], right - valueX, 10);
      ensure(lines.length * 14 + 8);
      doc.text(r[0], MARGIN, top, { size: 10, bold: true, color: t.muted });
      lines.forEach(function (line, i) { doc.text(line, valueX, top + i * 14, { size: 10, color: t.ink }); });
      top += lines.length * 14 + 4;
      doc.line(MARGIN, top - 2, right, top - 2, t.line, 0.5);
      top += 10;
    });

    // Items
    top += 8;
    ensure(60);
    doc.text('Items', MARGIN, top, { size: 13, bold: true, color: t.ink });
    top += 20;
    var colQty = right - 190;
    var colUnit = right - 90;
    var itemWidth = colQty - 40 - MARGIN;
    function itemHeader() {
      doc.text('ITEM', MARGIN, top, { size: 8, bold: true, color: t.muted });
      doc.text('QTY', colQty, top, { size: 8, bold: true, color: t.muted, align: 'right' });
      doc.text('UNIT PRICE', colUnit, top, { size: 8, bold: true, color: t.muted, align: 'right' });
      doc.text('AMOUNT', right, top, { size: 8, bold: true, color: t.muted, align: 'right' });
      top += 6;
      doc.line(MARGIN, top, right, top, t.line, 0.75);
      top += 16;
    }
    itemHeader();
    (Array.isArray(view.items) ? view.items : []).forEach(function (it) {
      var sub = ['SKU: ' + it.sku];
      if (it.size) sub.push('Size: ' + it.size);
      if (it.printing && it.printedName) sub.push('Name printing: “' + it.printedName + '”');
      var nameLines = doc.wrap(it.name, itemWidth, 10, true);
      var subLines = doc.wrap(sub.join(' · '), itemWidth, 8);
      var h = nameLines.length * 13 + subLines.length * 11 + 10;
      if (top + h > bottomLimit) { newPage(); itemHeader(); }
      var unit = U.formatINR(it.unitPrice) + (Number(it.printingCharge) > 0 && it.printing ? ' + ' + U.formatINR(it.printingCharge) : '');
      doc.text(String(it.quantity), colQty, top, { size: 10, color: t.ink, align: 'right' });
      doc.text(unit, colUnit, top, { size: 10, color: t.ink, align: 'right' });
      doc.text(U.formatINR(it.lineTotal), right, top, { size: 10, color: t.ink, align: 'right' });
      nameLines.forEach(function (line) { doc.text(line, MARGIN, top, { size: 10, bold: true, color: t.ink }); top += 13; });
      subLines.forEach(function (line) { doc.text(line, MARGIN, top - 2, { size: 8, color: t.muted }); top += 11; });
      doc.line(MARGIN, top, right, top, t.line, 0.5);
      top += 16;
    });

    // Totals
    ensure(70);
    function totalRow(label, value, big) {
      doc.text(label, colUnit - 60, top, { size: big ? 13 : 10, bold: !!big, color: t.ink });
      doc.text(value, right, top, { size: big ? 13 : 10, bold: !!big, color: t.ink, align: 'right' });
      top += big ? 22 : 16;
    }
    totalRow('Subtotal', U.formatINR(view.subtotal));
    if (Number(view.printingTotal) > 0) totalRow('Name printing', U.formatINR(view.printingTotal));
    doc.line(colUnit - 60, top - 8, right, top - 8, t.line, 1.5);
    top += 6;
    totalRow('Total (' + (view.currency || 'INR') + ')', U.formatINR(view.total), true);

    // Notes
    if (view.notes) {
      top += 6;
      var noteLines = doc.wrap(view.notes, right - MARGIN, 10);
      ensure(24 + noteLines.length * 14);
      doc.text('Notes', MARGIN, top, { size: 12, bold: true, color: t.ink });
      top += 18;
      noteLines.forEach(function (line) { doc.text(line, MARGIN, top, { size: 10, color: t.ink }); top += 14; });
    }

    // Footer (last page)
    var foot = 'Generated ' + U.formatDateTime(new Date().toISOString()) + '. Keep this receipt for your records.' +
      (b.supportEmail ? ' Questions? Contact ' + b.supportEmail + '.' : '');
    var footLines = doc.wrap(foot, right - MARGIN, 8);
    var footTop = doc.height - 40 - (footLines.length - 1) * 11;
    doc.line(MARGIN, footTop - 14, right, footTop - 14, t.line, 0.5);
    footLines.forEach(function (line, i) { doc.text(line, MARGIN, footTop + i * 11, { size: 8, color: t.muted }); });

    return doc.output();
  }

  function fileName(orderId) {
    var prefix = String(U.brand().receiptFilePrefix || 'Order_Receipt').replace(/[^A-Za-z0-9_-]/g, '_');
    return prefix + '_' + String(orderId).replace(/[^A-Za-z0-9_-]/g, '_') + '.pdf';
  }

  /** Returns an <a class="receipt-button"> that downloads the receipt as a PDF. */
  function createLink(view) {
    if (lastUrl) { try { URL.revokeObjectURL(lastUrl); } catch (e) { /* ignore */ } }
    lastUrl = URL.createObjectURL(new Blob([buildPdf(view)], { type: 'application/pdf' }));
    return U.el('a', { class: 'receipt-button', href: lastUrl, download: fileName(view.orderId), text: 'Download receipt (PDF)' });
  }

  M.receipt = { buildPdf: buildPdf, createLink: createLink, fileName: fileName };
})();
