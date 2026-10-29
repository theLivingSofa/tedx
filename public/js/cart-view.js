/*
 * Cart presentation: floating cart pill, cart popup dialog and the fixed bottom summary bar.
 */
(function () {
  'use strict';

  var M = (window.Merch = window.Merch || {});
  var U = M.util;
  var el = U.el;

  var $ = function (id) { return document.getElementById(id); };

  function describeLine(row) {
    var p = row.product;
    var line = row.line;
    var name = p.name;
    if (p.apparel) name += ' — ' + (line.size || 'size not selected');
    var parts = [name + ' ', el('span', { class: 'hint', text: '(' + p.sku + ') × ' + line.quantity })];
    if (line.printing) {
      var printed = String(line.printedName || '').trim();
      parts.push(el('span', { class: 'hint cart-line-print', text: printed ? 'Name printing: “' + printed + '”' : 'Name printing: name not entered' }));
    }
    return parts;
  }

  /** Re-renders every cart-derived piece of UI. */
  function render() {
    var s = M.cart.summary(M.catalogue.products(), M.catalogue.printingChargePaise());
    var total = U.formatPaise(s.totalPaise);
    $('grandTotal').textContent = total;
    $('itemCount').textContent = U.itemCountText(s.count) + ' in cart';
    $('cartTotal').textContent = total;
    $('floatingCartCount').textContent = String(s.count);
    $('openCart').setAttribute('aria-label', 'Open cart, ' + U.itemCountText(s.count) + ', total ' + total);

    var box = $('cartContents');
    U.clear(box);
    if (!s.rows.length) {
      box.className = 'cart-empty';
      box.textContent = 'Your cart is empty. Add products to get started.';
      return;
    }
    box.className = '';
    var list = el('ul', { class: 'cart-list' });
    s.rows.forEach(function (row) {
      list.appendChild(el('li', { class: 'cart-item' }, [
        el('span', { class: 'cart-line-name' }, describeLine(row)),
        el('strong', { class: 'cart-line-price', text: U.formatPaise(row.totalPaise) })
      ]));
    });
    box.appendChild(list);
  }

  function init() {
    var overlay = $('cartOverlay');
    $('openCart').addEventListener('click', function (e) {
      M.dialog.open(overlay, { opener: e.currentTarget, initialFocus: $('closeCart') });
    });
    $('closeCart').addEventListener('click', function () { M.dialog.close('close'); });
    $('continueCheckout').addEventListener('click', function () {
      M.dialog.close('checkout', { restoreFocus: false });
      var first = $('name');
      U.scrollIntoView($('details'), 'start');
      first.focus({ preventScroll: true });
    });
    M.cart.subscribe(render);
    render();
  }

  M.cartView = { init: init, render: render };
})();
