/*
 * Checkout: client-side validation, create-order, Cashfree modal or mock-checkout iframe,
 * then ALWAYS verify-payment and show the result (CONTRACT section 7).
 */
(function () {
  'use strict';

  var M = (window.Merch = window.Merch || {});
  var U = M.util;
  var el = U.el;
  var $ = function (id) { return document.getElementById(id); };

  var FIELDS = ['name', 'roll', 'email', 'phone', 'notes'];
  var FIELD_LABELS = {
    name: 'Full name', roll: 'Roll number', email: 'Email address', phone: 'Contact number', notes: 'Additional notes'
  };
  var VERIFY_RETRY_DELAY = 2500;

  var state = { busy: false, catalogue: null };

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* ---------- messages + field errors ---------- */

  function setFieldError(id, message) {
    M.catalogue.setFieldError($(id), $(id + '-error'), message, $(id).dataset.hint || null);
  }

  function clearAllErrors() {
    FIELDS.forEach(function (f) { setFieldError(f, null); });
    M.catalogue.clearErrors();
  }

  function showMessage(kind, children) {
    var box = $('message');
    U.clear(box);
    box.className = 'message ' + kind;
    U.append(box, children);
    box.hidden = false;
    return box;
  }

  function focusMessage() {
    var box = $('message');
    U.scrollIntoView(box, 'center');
    box.focus({ preventScroll: true });
  }

  function problemList(problems) {
    return el('ul', { class: 'problem-list' }, problems.map(function (p) { return el('li', { text: p.text }); }));
  }

  function payButtons() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-pay-button]'));
  }

  function setBusy(busy) {
    state.busy = busy;
    $('orderForm').setAttribute('aria-busy', busy ? 'true' : 'false');
    payButtons().forEach(function (btn) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.disabled = busy;
      btn.textContent = busy ? 'Processing…' : btn.dataset.label;
    });
  }

  /* ---------- request building ---------- */

  function collectItems() {
    var s = M.cart.summary(M.catalogue.products(), M.catalogue.printingChargePaise());
    return s.rows.map(function (row) {
      var item = { sku: row.product.sku, quantity: row.line.quantity };
      if (row.product.apparel) item.size = row.line.size;
      if (row.product.printing && row.line.printing) {
        item.printing = true;
        item.printedName = String(row.line.printedName || '').trim();
      }
      return item;
    });
  }

  function productLabel(sku) {
    var card = M.catalogue.card(sku);
    return card ? card.product.name + ' (' + sku + ')' : sku;
  }

  /** Maps server `fields` (CONTRACT 5.2) onto the form / product cards. Returns [{ text, target }]. */
  function applyServerFields(fields, items) {
    var out = [];
    Object.keys(fields || {}).forEach(function (key) {
      var msg = String(fields[key]);
      if (FIELDS.indexOf(key) !== -1) {
        setFieldError(key, msg);
        out.push({ text: FIELD_LABELS[key] + ': ' + msg, target: $(key) });
        return;
      }
      var m = /^items\[(\d+)\](?:\.(\w+))?$/.exec(key);
      if (m && items[Number(m[1])]) {
        var sku = items[Number(m[1])].sku;
        var card = M.catalogue.card(sku);
        var field = { size: 'size', printedName: 'printedName', printing: 'printing' }[m[2]] || 'item';
        var target = card ? card.showError(field, msg) : null;
        out.push({ text: productLabel(sku) + ': ' + msg, target: target });
        return;
      }
      out.push({ text: msg, target: null });
    });
    return out;
  }

  function handleApiError(err, items) {
    var problems = err.fields ? applyServerFields(err.fields, items) : [];
    var text = err.message || 'Something went wrong. Please try again.';
    if (err.status === 429 && err.retryAfter) text += ' (You can try again in about ' + err.retryAfter + ' seconds.)';
    showMessage('error', [el('strong', { text: text }), problems.length ? problemList(problems) : null]);
    var first = problems.filter(function (p) { return p.target; })[0];
    if (first) {
      U.scrollIntoView(first.target, 'center');
      first.target.focus({ preventScroll: true });
    } else {
      focusMessage();
    }
  }

  /* ---------- payment windows ---------- */

  function runCashfree(order) {
    var cashfree;
    try {
      cashfree = window.Cashfree({ mode: order.environment === 'production' ? 'production' : 'sandbox' });
    } catch (e) {
      return Promise.resolve({ outcome: 'error' });
    }
    return Promise.resolve()
      .then(function () {
        return cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: '_modal' });
      })
      .then(function (result) {
        if (result && result.error) return { outcome: 'error', detail: result.error.message };
        if (result && result.redirect) return { outcome: 'redirect' };
        if (result && result.paymentDetails) return { outcome: 'success' };
        return { outcome: 'unknown' };
      }, function () {
        return { outcome: 'error' };
      });
  }

  function runMockCheckout(order) {
    return new Promise(function (resolve) {
      var overlay = $('mockOverlay');
      var host = $('mockFrameHost');
      U.clear(host);
      var iframe = el('iframe', {
        class: 'mock-frame', title: 'Demo payment window',
        src: U.pageUrl('/mock-checkout', { order: order.orderId })
      });
      host.appendChild(iframe);
      var done = false;

      function finish(outcome) {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMessage);
        M.dialog.close('done', { restoreFocus: false });
        U.clear(host);
        resolve({ outcome: outcome });
      }

      function onMessage(e) {
        if (e.origin !== window.location.origin || e.source !== iframe.contentWindow) return;
        var d = e.data;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'mock-checkout-ready') {
          iframe.contentWindow.postMessage({
            type: 'mock-checkout-init', orderId: order.orderId, token: order.token,
            amount: order.total, currency: order.currency || 'INR'
          }, window.location.origin);
        } else if (d.type === 'mock-checkout' && ['success', 'failure', 'cancelled'].indexOf(d.outcome) !== -1) {
          finish(d.outcome === 'failure' ? 'failure' : d.outcome);
        }
      }

      window.addEventListener('message', onMessage);
      M.dialog.open(overlay, {
        initialFocus: iframe,
        onClose: function () { finish('cancelled'); }
      });
    });
  }

  async function verify(order, outcome) {
    var view = null;
    for (var attempt = 0; attempt < 4; attempt++) {
      try {
        view = await M.api.verifyPayment(order.orderId, order.token);
      } catch (err) {
        if (err.status === 404 || attempt >= 1) return view;
        await sleep(VERIFY_RETRY_DELAY);
        continue;
      }
      // Gateway said "paid" but our server has not seen it yet: give it a few more seconds.
      if (view.status !== 'Awaiting Payment' || outcome !== 'success') return view;
      await sleep(VERIFY_RETRY_DELAY);
    }
    return view;
  }

  /* ---------- result ---------- */

  function statusLink(order) {
    return el('a', {
      class: 'text-link', href: U.pageUrl('/order', { id: order.orderId, token: order.token }), text: 'View order status'
    });
  }

  function retryButton() {
    var b = el('button', { type: 'button', class: 'retry-button', text: 'Try again' });
    b.addEventListener('click', function () {
      $('orderForm').requestSubmit();
    });
    return b;
  }

  function orderLine(order, view) {
    return el('p', null, [
      'Order ID: ', el('strong', { class: 'order-id', text: order.orderId }),
      ' · Total: ', el('strong', { text: U.formatINR(view ? view.total : order.total) })
    ]);
  }

  function showResult(order, view, outcome) {
    if (!view) {
      showMessage('info', [
        el('strong', { text: 'We couldn’t confirm your payment status yet.' }),
        orderLine(order, null),
        el('p', { text: 'If you completed the payment, it will be confirmed automatically. Check the order status page in a minute.' }),
        el('div', { class: 'message-actions' }, [statusLink(order)])
      ]);
      focusMessage();
      return;
    }
    var status = view.status;
    if (status === 'Paid') {
      M.cart.clear();
      M.catalogue.resetAll();
      FIELDS.forEach(function (f) { $(f).value = ''; });
      showMessage('success', [
        el('strong', { text: view.message || 'Payment received. Your order is confirmed.' }),
        orderLine(order, view),
        el('p', { text: 'Keep your receipt for collection. You can come back to the status page any time.' }),
        el('div', { class: 'message-actions' }, [M.receipt.createLink(view), statusLink(order)])
      ]);
    } else if (status === 'Awaiting Payment') {
      var closed = outcome === 'cancelled' || outcome === 'error';
      showMessage('success', [
        el('strong', { text: closed ? 'The payment window was closed before the payment was completed.' : view.message }),
        orderLine(order, view),
        el('p', {
          text: closed
            ? 'If money was deducted, do not pay again — the order status page will update automatically. Otherwise you can try again.'
            : 'Do not pay again. The order status page updates automatically.'
        }),
        el('div', { class: 'message-actions' }, [closed ? retryButton() : null, statusLink(order)])
      ]);
    } else if (status === 'Failed') {
      showMessage('error', [
        el('strong', { text: view.message }),
        orderLine(order, view),
        el('div', { class: 'message-actions' }, [retryButton(), statusLink(order)])
      ]);
    } else {
      showMessage('error', [
        el('strong', { text: view.message || 'This order can no longer be paid. Please place a new order.' }),
        orderLine(order, view),
        el('div', { class: 'message-actions' }, [retryButton()])
      ]);
    }
    focusMessage();
  }

  /* ---------- submit ---------- */

  function firstAddButton() {
    return document.querySelector('#products .add-cart:not([disabled])');
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (state.busy) return;
    if (!state.catalogue) {
      showMessage('error', [el('strong', { text: 'The catalogue is still loading. Please wait a moment and try again.' })]);
      focusMessage();
      return;
    }
    clearAllErrors();

    var problems = [];
    var cv = M.validate.validateCustomer({
      name: $('name').value, roll: $('roll').value, email: $('email').value, phone: $('phone').value, notes: $('notes').value
    });
    FIELDS.forEach(function (f) {
      if (cv.fields[f]) {
        setFieldError(f, cv.fields[f]);
        problems.push({ text: FIELD_LABELS[f] + ': ' + cv.fields[f], target: $(f) });
      }
    });
    if (!M.cart.size()) {
      problems.push({ text: 'Please add at least one product to your cart.', target: firstAddButton() });
    } else {
      M.catalogue.validateCart().forEach(function (p) {
        problems.push({ text: productLabel(p.sku) + ': ' + p.message, target: p.target });
      });
    }
    if (problems.length) {
      var onlyCart = problems.length === 1 && !M.cart.size();
      showMessage('error', [
        el('strong', { text: onlyCart ? problems[0].text : 'Please fix the following before paying:' }),
        onlyCart ? null : problemList(problems)
      ]);
      var first = problems.filter(function (p) { return p.target; })[0];
      if (first) {
        U.scrollIntoView(first.target, 'center');
        first.target.focus({ preventScroll: true });
      }
      return;
    }

    if (state.catalogue.storeOpen === false) {
      showMessage('error', [el('strong', { text: 'The store is not accepting orders right now. Please check back later.' })]);
      focusMessage();
      return;
    }
    var payment = state.catalogue.payment || {};
    if (payment.mode === 'cashfree' && typeof window.Cashfree !== 'function') {
      showMessage('error', [
        el('strong', { text: 'The secure payment window could not be loaded.' }),
        el('p', { text: 'Please check your internet connection, turn off content blockers for this site, reload the page and try again. Your cart has been kept.' })
      ]);
      focusMessage();
      return;
    }

    var items = collectItems();
    setBusy(true);
    showMessage('info', [el('strong', { text: 'Creating your order…' })]);
    var order;
    try {
      order = await M.api.createOrder({ customer: cv.value, items: items });
    } catch (err) {
      setBusy(false);
      handleApiError(err, items);
      return;
    }
    U.saveLastOrder(order.orderId, order.token);

    var result;
    try {
      if (order.paymentMode === 'mock') {
        showMessage('info', [el('strong', { text: 'Complete the demo payment in the window that opened.' })]);
        result = await runMockCheckout(order);
      } else {
        showMessage('info', [el('strong', { text: 'Complete your payment in the secure Cashfree window.' })]);
        result = await runCashfree(order);
      }
    } catch (err) {
      result = { outcome: 'error' };
    }

    showMessage('info', [el('strong', { text: result.outcome === 'redirect' ? 'Redirecting to complete your payment…' : 'Confirming your payment…' })]);
    var view = await verify(order, result.outcome);
    setBusy(false);
    showResult(order, view, result.outcome);
  }

  function init() {
    var form = $('orderForm');
    form.addEventListener('submit', function (e) {
      onSubmit(e).catch(function () {
        setBusy(false);
        showMessage('error', [el('strong', { text: 'Something went wrong. Please try again.' })]);
        focusMessage();
      });
    });
    FIELDS.forEach(function (f) {
      $(f).addEventListener('input', function () {
        if ($(f).getAttribute('aria-invalid') === 'true') setFieldError(f, null);
      });
    });
    payButtons().forEach(function (btn) { btn.dataset.label = btn.textContent; });
    $('closeMock').addEventListener('click', function () { M.dialog.close('close'); });
  }

  M.checkout = {
    init: init,
    setCatalogue: function (data) { state.catalogue = data; }
  };
})();
