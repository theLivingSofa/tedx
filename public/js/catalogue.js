/*
 * Catalogue rendering + per-product card behaviour (size, name printing, add to cart, qty stepper).
 * Products are grouped by category in BRAND.sections order (CONTRACT 5.1 / 7).
 */
(function () {
  'use strict';

  var M = (window.Merch = window.Merch || {});
  var U = M.util;
  var el = U.el;

  var cards = new Map(); // sku -> card controller
  var ctx = { sizes: [], printingChargePaise: 0, products: [] };
  var uid = 0;

  /** CONTRACT 4.5 normalisation, re-applied defensively in case a category is blank/unknown. */
  function sectionFor(product, sections) {
    var cat = String(product.category || '').trim().toLowerCase();
    var ids = sections.map(function (s) { return s.id; });
    for (var i = 0; i < ids.length; i++) if (ids[i].toLowerCase() === cat) return ids[i];
    var keys = { winter: 'Winter', summer: 'Summer', accessor: 'Accessories' };
    var found = null;
    Object.keys(keys).forEach(function (k) { if (!found && cat.indexOf(k) !== -1) found = keys[k]; });
    if (!found) {
      var text = (String(product.name || '') + ' ' + String(product.sku || '')).toLowerCase();
      if (/hoodie|varsity|zipper|jacket|sweat/.test(text)) found = 'Winter';
      else if (/t-shirt|tshirt|polo|tee/.test(text)) found = 'Summer';
      else found = 'Accessories';
    }
    return ids.indexOf(found) !== -1 ? found : ids[ids.length - 1];
  }

  function safeImageUrl(url) {
    if (typeof url !== 'string') return '';
    url = url.trim();
    if (/^\/(?!\/)/.test(url) || /^https:\/\//i.test(url)) return url;
    return '';
  }

  function fieldError(id) {
    return el('div', { class: 'field-error', id: id, hidden: true });
  }

  /** Shows/clears an inline error for an input and keeps aria-describedby in sync. */
  function setFieldError(input, errorEl, message, baseDescribedBy) {
    var ids = baseDescribedBy ? [baseDescribedBy] : [];
    if (message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
      ids.push(errorEl.id);
      if (input) input.setAttribute('aria-invalid', 'true');
    } else {
      errorEl.textContent = '';
      errorEl.hidden = true;
      if (input) input.removeAttribute('aria-invalid');
    }
    if (input) {
      if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
      else input.removeAttribute('aria-describedby');
    }
  }

  function buildImage(product) {
    var url = safeImageUrl(product.imageUrl);
    if (!url) return null;
    var loading = el('div', { class: 'image-loading', text: 'Loading image…', attrs: { 'aria-hidden': 'true' } });
    var img = el('img', {
      class: 'product-image',
      alt: product.name + ' (' + product.sku + ')',
      attrs: { loading: 'lazy', decoding: 'async', width: '400', height: '300' }
    });
    var wrap = el('div', { class: 'product-image-wrap' }, [loading, img]);
    img.addEventListener('load', function () {
      img.classList.add('loaded');
      loading.hidden = true;
    });
    img.addEventListener('error', function () {
      wrap.classList.add('is-error');
      loading.textContent = 'Image could not load. Please try refreshing.';
      loading.removeAttribute('aria-hidden');
    });
    img.src = url;
    return wrap;
  }

  function createCard(product, sectionLabel) {
    var n = 'p' + (uid++);
    var sku = product.sku;
    var label = product.name + ' (' + sku + ')';
    var available = !!product.available && product.maxQuantity > 0;
    var maxQty = Math.max(0, Math.min(Number(product.maxQuantity) || 0, M.cart.MAX_QTY));
    var refs = {};

    var top = el('div', { class: 'product-top' }, [
      el('div', null, [
        el('h3', { class: 'product-name', id: n + '-name', text: product.name }),
        el('div', { class: 'sku', text: 'SKU: ' + sku }),
        el('div', { class: 'hint', text: sectionLabel + (product.printing ? ' · Name printing available' : '') })
      ]),
      el('div', { class: 'price', text: U.formatINR(product.price) + ' each' })
    ]);

    var controls = null;
    if (product.apparel) {
      refs.size = el('select', { id: n + '-size', class: 'size', disabled: !available, attrs: { 'aria-required': 'true' } },
        [el('option', { value: '', text: 'Select size' })].concat(ctx.sizes.map(function (s) {
          return el('option', { value: s, text: s });
        })));
      refs.sizeError = fieldError(n + '-size-error');
      controls = el('div', { class: 'product-controls' }, [
        el('div', null, [el('label', { htmlFor: n + '-size', text: 'Size' }), refs.size, refs.sizeError])
      ]);
    }

    var printBlock = null;
    if (product.printing) {
      refs.print = el('input', { type: 'checkbox', id: n + '-print', class: 'printing', disabled: !available });
      refs.printed = el('input', {
        id: n + '-printed', type: 'text', maxLength: 20, placeholder: 'Enter name to print', disabled: !available,
        attrs: { autocomplete: 'off', spellcheck: 'false', 'aria-required': 'true', 'aria-describedby': n + '-printed-hint' }
      });
      refs.printedHintId = n + '-printed-hint';
      var hintText = 'Maximum 20 characters.' +
        (ctx.printingChargePaise > 0 ? ' +' + U.formatPaise(ctx.printingChargePaise) + ' per item.' : '');
      refs.printedError = fieldError(n + '-printed-error');
      refs.printDetails = el('div', { class: 'print-details', id: n + '-print-details', hidden: true }, [
        el('label', { htmlFor: n + '-printed', text: 'Name exactly as it should be printed *' }),
        refs.printed,
        el('div', { class: 'hint', id: n + '-printed-hint', text: hintText }),
        refs.printedError
      ]);
      printBlock = el('div', { class: 'conditional' }, [
        el('label', { class: 'check', htmlFor: n + '-print' }, [refs.print, ' Add name printing']),
        refs.printDetails
      ]);
    }

    refs.add = el('button', {
      type: 'button', class: 'add-cart' + (available ? '' : ' out-of-stock'),
      text: available ? 'Add to cart' : 'Out of stock', disabled: !available,
      attrs: { 'aria-label': (available ? 'Add to cart: ' : 'Out of stock: ') + label }
    });
    refs.minus = el('button', { type: 'button', text: '−', attrs: { 'aria-label': 'Decrease quantity of ' + label } });
    refs.plus = el('button', { type: 'button', text: '+', attrs: { 'aria-label': 'Increase quantity of ' + label } });
    refs.qtyValue = el('span', { text: '1' });
    refs.qtyRow = el('div', { class: 'cart-quantity', hidden: true }, [
      el('span', { text: 'In your cart' }),
      el('div', { class: 'qty-stepper' }, [
        refs.minus,
        el('span', { class: 'qty-number', attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } }, [
          el('span', { class: 'sr-only', text: 'Quantity of ' + label + ': ' }), refs.qtyValue
        ]),
        refs.plus
      ])
    ]);
    refs.itemError = fieldError(n + '-error');
    refs.subtotal = el('div', { class: 'hint subtotal', text: 'Item subtotal: ₹0' });

    var card = el('article', { class: 'product' + (available ? '' : ' is-unavailable'), attrs: { 'aria-labelledby': n + '-name' } }, [
      top, buildImage(product), controls, printBlock, refs.add, refs.qtyRow, refs.itemError, refs.subtotal
    ]);
    refs.card = card;

    var api = {
      product: product,
      refs: refs,
      sync: sync,
      applyLine: applyLine,
      reset: reset,
      validateLine: validateLine,
      showError: showError,
      clearErrors: clearErrors
    };

    function currentPrintedName() {
      return refs.printed ? refs.printed.value : '';
    }

    function wantsPrinting() {
      return !!(refs.print && refs.print.checked);
    }

    function showError(field, message) {
      if (field === 'size' && refs.size) { setFieldError(refs.size, refs.sizeError, message); return refs.size; }
      if (field === 'printedName' && refs.printed) {
        if (refs.print && !refs.print.checked) { refs.print.checked = true; refs.printDetails.hidden = false; }
        setFieldError(refs.printed, refs.printedError, message, refs.printedHintId);
        return refs.printed;
      }
      if (field === 'printing' && refs.print) { setFieldError(refs.print, refs.itemError, message); return refs.print; }
      setFieldError(null, refs.itemError, message);
      return M.cart.get(sku) ? refs.plus : refs.add;
    }

    function clearErrors() {
      if (refs.size) setFieldError(refs.size, refs.sizeError, null);
      if (refs.printed) setFieldError(refs.printed, refs.printedError, null, refs.printedHintId);
      if (refs.print) refs.print.removeAttribute('aria-invalid');
      setFieldError(null, refs.itemError, null);
    }

    /** Checks the card's current choices. Returns { field, message, focus } or null. */
    function validateLine(forQuantityChange) {
      if (product.apparel && !refs.size.value) {
        return { field: 'size', message: 'Please select a size for ' + product.name + (forQuantityChange ? '.' : ' before adding it to your cart.') };
      }
      if (wantsPrinting()) {
        var e = M.validate.checkPrintedName(currentPrintedName());
        if (e) return { field: 'printedName', message: e };
      }
      return null;
    }

    function failAndFocus(problem) {
      var target = showError(problem.field, problem.message);
      if (target) target.focus();
    }

    function sync() {
      var line = M.cart.get(sku);
      if (line) {
        refs.add.hidden = true;
        refs.qtyRow.hidden = false;
        refs.qtyValue.textContent = String(line.quantity);
        refs.plus.disabled = line.quantity >= maxQty;
        refs.subtotal.textContent = 'Item subtotal: ' + U.formatPaise(M.cart.linePaise(product, line, ctx.printingChargePaise));
      } else {
        refs.add.hidden = false;
        refs.qtyRow.hidden = true;
        refs.subtotal.textContent = 'Item subtotal: ₹0';
      }
    }

    /** Puts a (restored) cart line's choices back into the card controls. */
    function applyLine(line) {
      if (refs.size) refs.size.value = line.size || '';
      if (refs.print) {
        refs.print.checked = !!line.printing;
        refs.printDetails.hidden = !line.printing;
        refs.printed.value = line.printedName || '';
      }
    }

    function reset() {
      if (refs.size) refs.size.value = '';
      if (refs.print) { refs.print.checked = false; refs.printDetails.hidden = true; refs.printed.value = ''; }
      clearErrors();
      sync();
    }

    function lineFromControls(quantity) {
      var printing = wantsPrinting();
      return {
        quantity: quantity,
        size: refs.size ? refs.size.value : '',
        printing: printing,
        printedName: printing ? currentPrintedName() : ''
      };
    }

    refs.add.addEventListener('click', function () {
      if (!available) return;
      clearErrors();
      var problem = validateLine(false);
      if (problem) { failAndFocus(problem); return; }
      M.cart.set(sku, lineFromControls(1));
      refs.plus.focus();
    });

    refs.minus.addEventListener('click', function () {
      var line = M.cart.get(sku);
      if (!line) return;
      setFieldError(null, refs.itemError, null);
      if (line.quantity <= 1) {
        M.cart.remove(sku);
        refs.add.focus();
      } else {
        M.cart.update(sku, { quantity: line.quantity - 1 });
      }
    });

    refs.plus.addEventListener('click', function () {
      var line = M.cart.get(sku);
      if (!line || line.quantity >= maxQty) return;
      var problem = validateLine(true);
      if (problem) { failAndFocus(problem); return; }
      M.cart.update(sku, { quantity: line.quantity + 1 });
    });

    if (refs.size) {
      refs.size.addEventListener('change', function () {
        setFieldError(refs.size, refs.sizeError, null);
        if (M.cart.get(sku)) M.cart.update(sku, { size: refs.size.value });
      });
    }

    if (refs.print) {
      refs.print.addEventListener('change', function () {
        refs.printDetails.hidden = !refs.print.checked;
        refs.print.removeAttribute('aria-invalid');
        if (!refs.print.checked) setFieldError(refs.printed, refs.printedError, null, refs.printedHintId);
        if (M.cart.get(sku)) {
          M.cart.update(sku, { printing: refs.print.checked, printedName: refs.print.checked ? currentPrintedName() : '' });
        }
        if (refs.print.checked) refs.printed.focus();
      });
      refs.printed.addEventListener('input', function () {
        if (!refs.printedError.hidden) setFieldError(refs.printed, refs.printedError, null, refs.printedHintId);
        if (M.cart.get(sku) && wantsPrinting()) M.cart.update(sku, { printedName: currentPrintedName() });
      });
    }

    return api;
  }

  /**
   * render(root, catalogue) -> [{ id, label, element }] for sections that have products.
   */
  function render(root, data) {
    var sections = (U.brand().sections || []).slice();
    if (!sections.length) sections = [{ id: 'Accessories', label: 'Products', navLabel: 'Products', icon: '' }];
    ctx.sizes = Array.isArray(data.sizes) && data.sizes.length ? data.sizes : ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
    ctx.printingChargePaise = U.toPaise(data.printingCharge || 0);
    ctx.products = (data.products || []).filter(function (p) { return p && typeof p.sku === 'string'; });
    cards.clear();
    U.clear(root);

    var rendered = [];
    sections.forEach(function (section) {
      var items = ctx.products.filter(function (p) { return sectionFor(p, sections) === section.id; });
      if (!items.length) return;
      var grid = el('div', { class: 'grid' });
      var sec = el('section', { class: 'catalogue-section', id: 'section-' + section.id, attrs: { 'aria-labelledby': 'section-title-' + section.id } }, [
        el('h2', { class: 'section-title', id: 'section-title-' + section.id, text: section.label }),
        grid
      ]);
      items.forEach(function (p) {
        var card = createCard(p, section.label);
        cards.set(p.sku, card);
        grid.appendChild(card.refs.card);
      });
      root.appendChild(sec);
      rendered.push({ id: section.id, label: section.label, element: sec });
    });

    if (!rendered.length) {
      root.appendChild(el('p', { class: 'cart-empty', text: 'No products are available right now. Please check back later.' }));
    }
    return rendered;
  }

  function syncAll() {
    cards.forEach(function (c) { c.sync(); });
  }

  M.catalogue = {
    render: render,
    syncAll: syncAll,
    products: function () { return ctx.products; },
    printingChargePaise: function () { return ctx.printingChargePaise; },
    sizes: function () { return ctx.sizes; },
    card: function (sku) { return cards.get(sku) || null; },
    applyCartToCards: function () {
      cards.forEach(function (c, sku) {
        var line = M.cart.get(sku);
        if (line) c.applyLine(line);
        c.sync();
      });
    },
    resetAll: function () { cards.forEach(function (c) { c.reset(); }); },
    clearErrors: function () { cards.forEach(function (c) { c.clearErrors(); }); },
    /** Validates every cart line against its card; returns [{ sku, field, message, target }]. */
    validateCart: function () {
      var problems = [];
      cards.forEach(function (c, sku) {
        if (!M.cart.get(sku)) return;
        var problem = c.validateLine(true);
        if (problem) {
          problems.push({ sku: sku, field: problem.field, message: problem.message, target: c.showError(problem.field, problem.message) });
        }
      });
      return problems;
    },
    setFieldError: setFieldError
  };
})();
