/*
 * Cart state: one line per SKU (like the original build), persisted in sessionStorage.
 * Line: { sku, quantity, size, printing, printedName }. Money is computed in integer paise.
 */
(function () {
  'use strict';

  var M = (window.Merch = window.Merch || {});
  var U = M.util;
  var KEY = 'merch:cart';
  var MAX_QTY = 20;

  var lines = new Map();
  var listeners = [];

  function sanitiseLine(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.sku !== 'string') return null;
    var qty = Number(raw.quantity);
    if (!Number.isInteger(qty) || qty < 1) return null;
    return {
      sku: raw.sku,
      quantity: Math.min(qty, MAX_QTY),
      size: typeof raw.size === 'string' ? raw.size : '',
      printing: raw.printing === true,
      printedName: typeof raw.printedName === 'string' ? raw.printedName.slice(0, 20) : ''
    };
  }

  function save() {
    U.storageSet('sessionStorage', KEY, { v: 1, lines: Array.from(lines.values()) });
  }

  function emit() {
    save();
    listeners.forEach(function (fn) { fn(); });
  }

  /** Restores the saved cart, keeping only lines that still make sense for this catalogue. */
  function restore(productsBySku, sizes) {
    lines.clear();
    var saved = U.storageGet('sessionStorage', KEY);
    var list = saved && Array.isArray(saved.lines) ? saved.lines : [];
    list.forEach(function (raw) {
      var line = sanitiseLine(raw);
      if (!line || lines.has(line.sku)) return;
      var p = productsBySku.get(line.sku);
      if (!p || !p.available || !(p.maxQuantity > 0)) return;
      line.quantity = Math.min(line.quantity, p.maxQuantity);
      if (!p.apparel || sizes.indexOf(line.size) === -1) line.size = '';
      if (!p.printing) { line.printing = false; line.printedName = ''; }
      lines.set(line.sku, line);
    });
    save();
  }

  function get(sku) {
    var l = lines.get(sku);
    return l ? Object.assign({}, l) : null;
  }

  function set(sku, line) {
    var clean = sanitiseLine(Object.assign({}, line, { sku: sku }));
    if (clean) lines.set(sku, clean);
    else lines.delete(sku);
    emit();
  }

  function update(sku, patch) {
    var l = lines.get(sku);
    if (!l) return;
    set(sku, Object.assign({}, l, patch));
  }

  function remove(sku) {
    if (lines.delete(sku)) emit();
  }

  function clearAll() {
    lines.clear();
    emit();
  }

  function linePaise(product, line, printingChargePaise) {
    var unit = U.toPaise(product.price) + (line.printing ? printingChargePaise : 0);
    return unit * line.quantity;
  }

  /** -> { rows: [{ line, product, totalPaise }], count, totalPaise } in catalogue order. */
  function summary(products, printingChargePaise) {
    var rows = [];
    var count = 0;
    var total = 0;
    products.forEach(function (p) {
      var line = lines.get(p.sku);
      if (!line) return;
      var t = linePaise(p, line, printingChargePaise);
      rows.push({ line: Object.assign({}, line), product: p, totalPaise: t });
      count += line.quantity;
      total += t;
    });
    return { rows: rows, count: count, totalPaise: total };
  }

  M.cart = {
    MAX_QTY: MAX_QTY,
    restore: restore,
    get: get,
    set: set,
    update: update,
    remove: remove,
    clear: clearAll,
    size: function () { return lines.size; },
    summary: summary,
    linePaise: linePaise,
    subscribe: function (fn) { listeners.push(fn); }
  };
})();
