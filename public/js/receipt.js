/*
 * Client-side receipt: a standalone HTML file built from the order view (CONTRACT 5.6 / 7).
 * Every dynamic value goes through escapeHtml. Colours are read from the live design tokens (validated)
 * so a re-theme in tokens.css also re-themes the receipt.
 */
(function () {
  'use strict';

  var M = (window.Merch = window.Merch || {});
  var U = M.util;
  var esc = U.escapeHtml;
  var lastUrl = null;

  var DEFAULTS = {
    red: '#e62b1e', ink: '#171717', muted: '#666666', line: '#e5e5e5', 'page-bg': '#f5f5f5',
    'hero-bg': '#111111', 'hero-muted': '#dddddd', 'success-bg': '#eaf7ed', 'success-border': '#b6dfbe',
    'error-bg': '#fff0ef', 'error-border': '#ffc4bf', 'note-bg': '#f4f4f4'
  };

  function tokens() {
    var out = {};
    var cs = null;
    try { cs = getComputedStyle(document.documentElement); } catch (e) { cs = null; }
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = cs ? cs.getPropertyValue('--' + k).trim() : '';
      // Only plain colour literals may reach the generated stylesheet.
      out[k] = /^(#[0-9a-f]{3,8}|rgba?\([0-9.,\s%]+\))$/i.test(v) ? v : DEFAULTS[k];
    });
    return out;
  }

  function money(n) {
    return esc(U.formatINR(n));
  }

  function row(label, value) {
    if (value == null || value === '') return '';
    return '<tr><th scope="row">' + esc(label) + '</th><td>' + esc(value) + '</td></tr>';
  }

  function buildHtml(view) {
    var b = U.brand();
    var t = tokens();
    var status = String(view.status || '');
    var statusClass = status === 'Paid' ? 'ok' : (status === 'Awaiting Payment' ? 'wait' : 'bad');
    var c = view.customer || {};
    var items = Array.isArray(view.items) ? view.items : [];

    var itemRows = items.map(function (it) {
      var details = [];
      if (it.size) details.push('Size: ' + it.size);
      if (it.printing && it.printedName) details.push('Name printing: “' + it.printedName + '”');
      var charge = Number(it.printingCharge) > 0 && it.printing ? ' + ' + U.formatINR(it.printingCharge) + ' printing' : '';
      return '<tr><td><strong>' + esc(it.name) + '</strong><div class="sub">SKU: ' + esc(it.sku) +
        (details.length ? ' · ' + esc(details.join(' · ')) : '') + '</div></td>' +
        '<td class="num">' + esc(it.quantity) + '</td>' +
        '<td class="num">' + money(it.unitPrice) + esc(charge) + '</td>' +
        '<td class="num">' + money(it.lineTotal) + '</td></tr>';
    }).join('');

    var css =
      '*{box-sizing:border-box}body{margin:0;padding:24px 14px;background:' + t['page-bg'] + ';color:' + t.ink +
      ';font-family:Arial,sans-serif;line-height:1.45}.sheet{max-width:760px;margin:0 auto;background:#fff;border:1px solid ' +
      t.line + ';border-radius:12px;overflow:hidden}header{background:' + t['hero-bg'] + ';color:#fff;padding:22px 24px;border-top:6px solid ' +
      t.red + '}.mark{color:' + t.red + ';font-weight:900;font-size:26px;letter-spacing:-1px}h1{margin:6px 0 4px;font-size:22px}' +
      'header p{margin:0;color:' + t['hero-muted'] + '}main{padding:20px 24px}h2{font-size:16px;margin:22px 0 10px}' +
      'table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid ' + t.line +
      ';vertical-align:top}.meta th{width:38%;color:' + t.muted + ';font-weight:700}.items th{font-size:12px;color:' + t.muted +
      ';text-transform:uppercase;letter-spacing:.4px}.num{text-align:right;white-space:nowrap}.sub{color:' + t.muted +
      ';font-size:12px;margin-top:3px}.totals td{border:0;padding:4px 6px}.totals .grand td{font-size:18px;font-weight:800;border-top:2px solid ' +
      t.line + ';padding-top:10px}.status{display:inline-block;padding:5px 12px;border-radius:999px;font-weight:800;font-size:13px;border:1px solid}' +
      '.ok{background:' + t['success-bg'] + ';border-color:' + t['success-border'] + '}.bad{background:' + t['error-bg'] + ';border-color:' +
      t['error-border'] + '}.wait{background:' + t['note-bg'] + ';border-color:' + t.line + '}footer{padding:16px 24px 22px;color:' + t.muted +
      ';font-size:12px;border-top:1px solid ' + t.line + '}@media print{body{background:#fff;padding:0}.sheet{border:0}}';

    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Order receipt ' + esc(view.orderId) + ' – ' + esc(b.pageTitle || '') + '</title>' +
      '<style>' + css + '</style></head><body><div class="sheet">' +
      '<header><div class="mark">' + esc(b.mark || '') + '</div><h1>Order receipt</h1><p>' + esc(b.organisation || b.pageTitle || '') + '</p></header>' +
      '<main><p><span class="status ' + statusClass + '">' + esc(status) + '</span></p>' +
      (view.message ? '<p>' + esc(view.message) + '</p>' : '') +
      '<table class="meta"><tbody>' +
      row('Order ID', view.orderId) +
      row('Order placed', U.formatDateTime(view.createdAt)) +
      row('Paid at', U.formatDateTime(view.paidAt)) +
      row('Name', c.name) + row('Roll number', c.roll) + row('Email', c.email) + row('Contact number', c.phone) +
      row('Payment method', view.paymentMethod) + row('Payment reference', view.paymentId) +
      '</tbody></table>' +
      '<h2>Items</h2><table class="items"><thead><tr><th scope="col">Item</th><th scope="col" class="num">Qty</th>' +
      '<th scope="col" class="num">Unit price</th><th scope="col" class="num">Amount</th></tr></thead><tbody>' + itemRows + '</tbody></table>' +
      '<table class="totals"><tbody>' +
      '<tr><td>Subtotal</td><td class="num">' + money(view.subtotal) + '</td></tr>' +
      (Number(view.printingTotal) > 0 ? '<tr><td>Name printing</td><td class="num">' + money(view.printingTotal) + '</td></tr>' : '') +
      '<tr class="grand"><td>Total (' + esc(view.currency || 'INR') + ')</td><td class="num">' + money(view.total) + '</td></tr>' +
      '</tbody></table>' +
      (view.notes ? '<h2>Notes</h2><p>' + esc(view.notes) + '</p>' : '') +
      '</main><footer>Generated ' + esc(U.formatDateTime(new Date().toISOString())) + '. Keep this receipt for your records.' +
      (b.supportEmail ? ' Questions? Contact ' + esc(b.supportEmail) + '.' : '') + '</footer></div></body></html>';
  }

  function fileName(orderId) {
    var prefix = String(U.brand().receiptFilePrefix || 'Order_Receipt').replace(/[^A-Za-z0-9_-]/g, '_');
    return prefix + '_' + String(orderId).replace(/[^A-Za-z0-9_-]/g, '_') + '.html';
  }

  /** Returns an <a class="receipt-button"> that downloads the receipt. */
  function createLink(view) {
    if (lastUrl) { try { URL.revokeObjectURL(lastUrl); } catch (e) { /* ignore */ } }
    lastUrl = URL.createObjectURL(new Blob([buildHtml(view)], { type: 'text/html;charset=utf-8' }));
    return U.el('a', { class: 'receipt-button', href: lastUrl, download: fileName(view.orderId), text: 'Download order receipt' });
  }

  M.receipt = { buildHtml: buildHtml, createLink: createLink, fileName: fileName };
})();
