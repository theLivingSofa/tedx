/*
 * Order status page (/order?id=…&token=…), CONTRACT section 7:
 * token from the query or localStorage['merch:lastOrder'] when ids match; polls GET /api/order-status every 4 s,
 * backing off to 15 s after 1 minute, stopping after 10 minutes or on a terminal status (Paid / Expired).
 */
(function () {
  'use strict';

  var M = window.Merch;
  var U = M.util;
  var el = U.el;
  var $ = function (id) { return document.getElementById(id); };

  var FAST_MS = 4000;
  var SLOW_MS = 15000;
  var FAST_FOR_MS = 60 * 1000;
  var STOP_AFTER_MS = 10 * 60 * 1000;
  var TERMINAL = ['Paid', 'Expired'];
  var STATUS_CLASS = { 'Paid': 'is-paid', 'Failed': 'is-failed', 'Expired': 'is-expired', 'Awaiting Payment': 'is-awaiting' };

  var orderId = '';
  var token = '';
  var timer = null;
  var startedAt = 0;
  var lastStatus = null;
  var ui = {};

  function storeLink(text) {
    return el('a', { class: 'text-link', href: U.pageUrl('/', {}), text: text || 'Back to the store' });
  }

  function notFound() {
    stopPolling();
    var root = $('orderRoot');
    U.clear(root);
    var b = U.brand();
    var last = U.readLastOrder();
    var children = [
      el('h2', { id: 'statusTitle', text: 'We couldn’t find that order' }),
      el('p', { class: 'status-message', text: 'We couldn’t find that order. Please open the full link from your order confirmation, ' +
        'or open this page on the device and browser you used to place the order.' })
    ];
    if (b.supportEmail) {
      children.push(el('p', { class: 'small' }, [
        'If you paid and need help, contact ',
        el('a', { class: 'text-link', href: 'mailto:' + b.supportEmail, text: b.supportEmail }),
        ' with your order ID.'
      ]));
    }
    var actions = [storeLink()];
    if (last && last.orderId !== orderId && M.validate.isOrderId(last.orderId)) {
      actions.unshift(el('a', {
        class: 'receipt-button', href: U.pageUrl('/order', { id: last.orderId, token: last.token }),
        text: 'View your most recent order (' + last.orderId + ')'
      }));
    }
    children.push(el('div', { class: 'order-actions' }, actions));
    root.appendChild(el('section', { class: 'card', attrs: { 'aria-labelledby': 'statusTitle' } }, children));
    $('heroIntro').textContent = 'Track your merchandise order.';
  }

  function buildLayout() {
    var root = $('orderRoot');
    U.clear(root);
    ui.badge = el('span', { class: 'status-badge', text: '…' });
    ui.message = el('p', { class: 'status-message' });
    ui.announce = el('p', { class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } });
    ui.pollText = el('span');
    ui.pollSpinner = el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } });
    ui.poll = el('p', { class: 'hint poll-note' }, [ui.pollSpinner, ui.pollText]);
    ui.receiptSlot = el('span', { class: 'receipt-slot' });
    ui.checkAgain = el('button', { type: 'button', class: 'retry-button', text: 'Check again', hidden: true });
    ui.checkAgain.addEventListener('click', function () { startPolling(); });
    ui.meta = el('dl', { class: 'meta-list' });
    ui.itemsBody = el('tbody');
    ui.itemsFoot = el('tfoot');
    ui.notes = el('p', { class: 'small', hidden: true });

    root.appendChild(el('section', { class: 'card', attrs: { 'aria-labelledby': 'statusTitle' } }, [
      el('div', { class: 'status-head' }, [
        el('h2', { id: 'statusTitle', class: 'status-title' }, ['Order ', el('span', { class: 'order-id', text: orderId })]),
        ui.badge
      ]),
      ui.message,
      ui.announce,
      ui.poll,
      el('div', { class: 'order-actions' }, [ui.receiptSlot, ui.checkAgain, storeLink()])
    ]));
    root.appendChild(el('section', { class: 'card', attrs: { 'aria-labelledby': 'detailsTitle' } }, [
      el('h2', { id: 'detailsTitle', text: 'Order details' }),
      ui.meta
    ]));
    root.appendChild(el('section', { class: 'card', attrs: { 'aria-labelledby': 'itemsTitle' } }, [
      el('h2', { id: 'itemsTitle', text: 'Items' }),
      el('table', { class: 'items-table' }, [
        el('caption', { class: 'sr-only', text: 'Items in order ' + orderId }),
        el('thead', null, el('tr', null, [
          el('th', { scope: 'col', text: 'Item' }),
          el('th', { scope: 'col', class: 'num', text: 'Qty' }),
          el('th', { scope: 'col', class: 'num', text: 'Amount' })
        ])),
        ui.itemsBody,
        ui.itemsFoot
      ]),
      ui.notes
    ]));
  }

  function metaRow(label, value) {
    if (value == null || value === '') return null;
    return el('div', null, [el('dt', { text: label }), el('dd', { text: String(value) })]);
  }

  function render(view) {
    var status = String(view.status || '');
    ui.badge.textContent = status;
    ui.badge.className = 'status-badge ' + (STATUS_CLASS[status] || '');
    ui.message.textContent = view.message || '';
    if (status !== lastStatus) {
      ui.announce.textContent = 'Order status: ' + status + '. ' + (view.message || '');
      lastStatus = status;
    }

    U.clear(ui.receiptSlot);
    if (status === 'Paid') ui.receiptSlot.appendChild(M.receipt.createLink(view));

    var c = view.customer || {};
    U.clear(ui.meta);
    U.append(ui.meta, [
      metaRow('Name', c.name), metaRow('Roll number', c.roll), metaRow('Email', c.email), metaRow('Contact number', c.phone),
      metaRow('Order placed', U.formatDateTime(view.createdAt)), metaRow('Paid at', U.formatDateTime(view.paidAt)),
      metaRow('Payment method', view.paymentMethod), metaRow('Payment reference', view.paymentId),
      status === 'Awaiting Payment' ? metaRow('Payment window closes', U.formatDateTime(view.expiresAt)) : null
    ]);

    U.clear(ui.itemsBody);
    (Array.isArray(view.items) ? view.items : []).forEach(function (it) {
      var details = ['SKU: ' + it.sku];
      if (it.size) details.push('Size: ' + it.size);
      if (it.printing && it.printedName) details.push('Name printing: “' + it.printedName + '”');
      ui.itemsBody.appendChild(el('tr', null, [
        el('td', null, [el('strong', { text: it.name }), el('div', { class: 'hint', text: details.join(' · ') })]),
        el('td', { class: 'num', text: '× ' + it.quantity }),
        el('td', { class: 'num', text: U.formatINR(it.lineTotal) })
      ]));
    });
    U.clear(ui.itemsFoot);
    var foot = [el('tr', null, [el('td', { colSpan: 2, text: 'Subtotal' }), el('td', { class: 'num', text: U.formatINR(view.subtotal) })])];
    if (Number(view.printingTotal) > 0) {
      foot.push(el('tr', null, [el('td', { colSpan: 2, text: 'Name printing' }), el('td', { class: 'num', text: U.formatINR(view.printingTotal) })]));
    }
    foot.push(el('tr', { class: 'grand' }, [el('td', { colSpan: 2, text: 'Total' }), el('td', { class: 'num', text: U.formatINR(view.total) })]));
    U.append(ui.itemsFoot, foot);

    ui.notes.hidden = !view.notes;
    ui.notes.textContent = view.notes ? 'Notes: ' + view.notes : '';
  }

  function setPollNote(text, spinning) {
    ui.pollText.textContent = text;
    ui.pollSpinner.hidden = !spinning;
  }

  function stopPolling() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(ms) {
    stopPolling();
    timer = setTimeout(tick, ms);
  }

  function checkedAt() {
    try {
      return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
      return new Date().toLocaleTimeString();
    }
  }

  async function tick() {
    timer = null;
    var extraDelay = 0;
    try {
      var view = await M.api.orderStatus(orderId, token);
      render(view);
      if (TERMINAL.indexOf(view.status) !== -1) {
        setPollNote('Last checked at ' + checkedAt() + '.', false);
        ui.checkAgain.hidden = true;
        return;
      }
    } catch (err) {
      if (err.status === 404) { notFound(); return; }
      if (err.status === 429 && err.retryAfter) extraDelay = err.retryAfter * 1000;
      if (lastStatus === null) {
        ui.message.textContent = 'We couldn’t check your order right now. Retrying…';
      }
      setPollNote((err.message || 'Could not reach the server.') + ' Retrying automatically…', true);
      ui.checkAgain.hidden = true;
      return continuePolling(extraDelay);
    }
    setPollNote('Checking automatically · last checked at ' + checkedAt() + '.', true);
    continuePolling(0);
  }

  function continuePolling(extraDelay) {
    var elapsed = Date.now() - startedAt;
    if (elapsed >= STOP_AFTER_MS) {
      setPollNote('Automatic updates paused. Select “Check again” to refresh.', false);
      ui.checkAgain.hidden = false;
      return;
    }
    schedule(Math.max(elapsed < FAST_FOR_MS ? FAST_MS : SLOW_MS, extraDelay));
  }

  function startPolling() {
    startedAt = Date.now();
    ui.checkAgain.hidden = true;
    setPollNote('Checking…', true);
    stopPolling();
    tick();
  }

  function init() {
    var b = U.brand();
    if (b.pageTitle) document.title = 'Order status – ' + b.pageTitle;
    if (b.mark) { $('navBrand').textContent = b.mark; $('heroMark').textContent = b.mark; }
    $('navStore').href = U.pageUrl('/', {});

    var q = U.params();
    orderId = (q.get('id') || '').trim();
    token = (q.get('token') || '').trim();
    if (!token) {
      var last = U.readLastOrder();
      if (last && last.orderId === orderId) token = last.token;
    }
    if (!M.validate.isOrderId(orderId) || !M.validate.isToken(token)) {
      notFound();
      return;
    }
    $('heroIntro').textContent = 'Order ID: ' + orderId + '. This page checks the payment gateway automatically.';
    buildLayout();
    startPolling();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
