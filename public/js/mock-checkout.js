/*
 * Demo payment page shown inside the store's iframe modal when payment.mode === 'mock'.
 * The order token arrives ONLY via postMessage from the parent (same origin), never via the URL.
 * Calls POST /api/mock-pay, then reports { type: 'mock-checkout', outcome } back to the parent.
 */
(function () {
  'use strict';

  var M = window.Merch;
  var U = M.util;
  var $ = function (id) { return document.getElementById(id); };
  var ORIGIN = window.location.origin;
  var embedded = window.parent && window.parent !== window;
  var order = null;
  var busy = false;

  function showMessage(kind, text) {
    var box = $('mockMessage');
    box.className = 'message ' + kind;
    box.textContent = text;
    box.hidden = false;
  }

  function setButtons(enabled) {
    $('mockSuccess').disabled = !enabled;
    $('mockFailure').disabled = !enabled;
  }

  function report(outcome) {
    if (embedded) window.parent.postMessage({ type: 'mock-checkout', outcome: outcome }, ORIGIN);
  }

  async function pay(outcome) {
    if (!order || busy) return;
    busy = true;
    setButtons(false);
    showMessage('info', outcome === 'success' ? 'Simulating a successful payment…' : 'Simulating a failed payment…');
    try {
      await M.api.mockPay(order.orderId, order.token, outcome);
      report(outcome);
    } catch (err) {
      busy = false;
      setButtons(true);
      showMessage('error', (err && err.message) || 'The demo payment could not be recorded. Please try again.');
    }
  }

  function onMessage(e) {
    if (e.origin !== ORIGIN || e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || d.type !== 'mock-checkout-init') return;
    if (typeof d.orderId !== 'string' || typeof d.token !== 'string') return;
    var expected = U.params().get('order');
    if (expected && expected !== d.orderId) return;
    order = { orderId: d.orderId, token: d.token };
    $('mockOrderId').textContent = d.orderId;
    $('mockAmount').textContent = U.formatINR(d.amount) + (d.currency && d.currency !== 'INR' ? ' ' + d.currency : '');
    $('mockWaiting').hidden = true;
    $('mockOrder').hidden = false;
    setButtons(true);
    $('mockSuccess').focus();
  }

  function init() {
    $('mockSuccess').addEventListener('click', function () { pay('success'); });
    $('mockFailure').addEventListener('click', function () { pay('failure'); });
    $('mockCancel').addEventListener('click', function () {
      if (busy) return;
      report('cancelled');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !busy) report('cancelled');
    });
    if (!embedded) {
      $('mockWaiting').textContent = 'This demo payment page only works inside the store checkout. Please return to the store.';
      $('mockCancel').hidden = true;
      return;
    }
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'mock-checkout-ready' }, ORIGIN);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
