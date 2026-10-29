/*
 * Organiser product editor (/admin-products). Uses the admin session cookie from /admin.
 */
(function () {
  'use strict';

  var U = (window.Merch || {}).util;
  var $ = function (id) { return document.getElementById(id); };
  var el = U.el;
  var state = { products: [], sections: [], editable: false };

  async function call(method, body) {
    var res;
    try {
      res = await fetch('/api/admin-catalogue', {
        method: method,
        headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        cache: 'no-store'
      });
    } catch (e) {
      throw { status: 0, message: 'Could not reach the server. Check your connection and try again.' };
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.ok) return data;
    var err = (data && data.error) || {};
    throw { status: res.status, code: err.code, message: err.message || 'Something went wrong. Please try again.', fields: err.fields || null };
  }

  function message(kind, text) {
    var m = $('pageMessage');
    m.className = 'message' + (kind ? ' ' + kind : '');
    m.textContent = text || '';
    if (text) m.focus({ preventScroll: false });
  }

  function show(which) {
    $('loadingCard').hidden = which !== 'loading';
    $('signedOutCard').hidden = which !== 'signedout';
    $('editor').hidden = which !== 'editor';
  }

  function categoryOptions(select, selected) {
    U.clear(select);
    state.sections.forEach(function (s) {
      select.appendChild(el('option', { value: s.id, text: s.label, selected: s.id === selected }));
    });
  }

  /* ---------------------------------------------------------------- field errors */

  function setFieldErrors(container, fields) {
    container.querySelectorAll('[aria-invalid="true"]').forEach(function (n) { n.removeAttribute('aria-invalid'); });
    container.querySelectorAll('.field-error').forEach(function (n) { n.hidden = true; n.textContent = ''; });
    var first = null;
    Object.keys(fields || {}).forEach(function (name) {
      var input = container.querySelector('[name="' + name + '"]');
      if (!input) return;
      input.setAttribute('aria-invalid', 'true');
      var errBox = input.parentElement.querySelector('.field-error');
      if (errBox) { errBox.textContent = fields[name]; errBox.hidden = false; }
      else input.title = fields[name];
      if (!first) first = input;
    });
    if (first) first.focus();
  }

  function readFields(container) {
    var get = function (name) { return container.querySelector('[name="' + name + '"]'); };
    return {
      sku: get('sku').value.trim().toUpperCase(),
      name: get('name').value.trim(),
      category: get('category').value,
      price: get('price').value.trim(),
      stock: get('stock').value.trim(),
      imageUrl: get('imageUrl').value.trim(),
      apparel: get('apparel').checked,
      printing: get('printing').checked,
      active: get('active').checked
    };
  }

  /* ---------------------------------------------------------------- table */

  function input(name, value, attrs) {
    return el('input', Object.assign({ name: name, value: value == null ? '' : String(value) }, attrs ? { attrs: attrs } : {}));
  }
  function check(name, checked, label) {
    return el('label', { class: 'cell-check', attrs: { title: label } }, [
      el('input', { type: 'checkbox', name: name, checked: !!checked, attrs: { 'aria-label': label } })
    ]);
  }

  function productRow(p) {
    var tr = el('tr', { dataset: { sku: p.sku }, class: p.active ? '' : 'is-hidden-product' });
    var thumb = p.imageUrl ? el('img', { src: p.imageUrl, alt: '', class: 'thumb', attrs: { loading: 'lazy', referrerpolicy: 'no-referrer' } }) : el('span', { class: 'thumb empty', text: '—' });
    var cat = el('select', { name: 'category', attrs: { 'aria-label': 'Category for ' + p.sku } });
    categoryOptions(cat, p.category);
    var save = el('button', { type: 'button', class: 'btn-small', text: 'Save', disabled: true });
    var del = el('button', { type: 'button', class: 'btn-small btn-danger', text: 'Delete' });
    var hiddenSku = el('input', { type: 'hidden', name: 'sku', value: p.sku });

    tr.appendChild(el('td', {}, thumb));
    tr.appendChild(el('td', { class: 'mono' }, [document.createTextNode(p.sku), hiddenSku]));
    tr.appendChild(el('td', {}, input('name', p.name, { 'aria-label': 'Name for ' + p.sku, maxlength: '80' })));
    tr.appendChild(el('td', {}, cat));
    tr.appendChild(el('td', {}, input('price', p.price, { type: 'number', min: '1', step: '0.01', inputmode: 'decimal', 'aria-label': 'Price for ' + p.sku, class: 'narrow' })));
    tr.appendChild(el('td', {}, input('stock', p.stock == null ? '' : p.stock, { type: 'number', min: '0', step: '1', placeholder: '∞', 'aria-label': 'Stock for ' + p.sku + ' (blank = unlimited)', class: 'narrow' })));
    tr.appendChild(el('td', { class: 'center' }, check('apparel', p.apparel, 'Has sizes')));
    tr.appendChild(el('td', { class: 'center' }, check('printing', p.printing, 'Name printing')));
    tr.appendChild(el('td', { class: 'center' }, check('active', p.active, 'Show in store')));
    tr.appendChild(el('td', {}, input('imageUrl', p.imageUrl, { 'aria-label': 'Image link for ' + p.sku, class: 'wide' })));
    tr.appendChild(el('td', { class: 'actions' }, [save, del]));

    var original = JSON.stringify(readFields(tr));
    tr.addEventListener('input', function () { save.disabled = JSON.stringify(readFields(tr)) === original; });
    tr.addEventListener('change', function () { save.disabled = JSON.stringify(readFields(tr)) === original; });
    save.addEventListener('click', function () { saveRow(tr, p.sku, save); });
    del.addEventListener('click', function () { deleteRow(tr, p.sku, del); });
    return tr;
  }

  function render() {
    var q = $('search').value.trim().toLowerCase();
    var show = $('showFilter').value;
    var list = state.products.filter(function (p) {
      if (show === 'active' && !p.active) return false;
      if (show === 'hidden' && p.active) return false;
      return !q || p.sku.toLowerCase().indexOf(q) !== -1 || p.name.toLowerCase().indexOf(q) !== -1;
    });
    var table = U.clear($('productsTable'));
    var heads = ['', 'SKU', 'Name', 'Category', 'Price (₹)', 'Stock', 'Sizes', 'Printing', 'In store', 'Image link', ''];
    table.appendChild(el('thead', {}, el('tr', {}, heads.map(function (h) { return el('th', { text: h, attrs: { scope: 'col' } }); }))));
    var body = el('tbody');
    if (!list.length) body.appendChild(el('tr', {}, el('td', { class: 'empty', text: 'No products match.', attrs: { colspan: heads.length } })));
    list.forEach(function (p) { body.appendChild(productRow(p)); });
    table.appendChild(body);
  }

  /* ---------------------------------------------------------------- actions */

  async function load() {
    try {
      var data = await call('GET');
      state.products = data.products || [];
      state.sections = data.sections || [];
      state.editable = !!data.editable;
      categoryOptions($('new-category'), state.sections[0] && state.sections[0].id);
      var bad = $('invalidRows');
      if (data.invalidRows && data.invalidRows.length) {
        bad.hidden = false;
        bad.textContent = 'The store is skipping these Catalogue rows; fix them in the Sheet: ' +
          data.invalidRows.map(function (r) { return 'row ' + r.row + (r.sku ? ' (' + r.sku + ')' : '') + ': ' + r.reason; }).join('; ') + '.';
      } else bad.hidden = true;
      show('editor');
      render();
      if (!state.editable) message('info', 'Demo mode: products come from data/products.json and cannot be edited here.');
    } catch (err) {
      if (err.status === 401 || err.status === 404) { show('signedout'); return; }
      show('editor');
      message('error', err.message);
    }
  }

  function replaceProduct(p) {
    var i = state.products.findIndex(function (x) { return x.sku === p.sku; });
    if (i === -1) state.products.push(p); else state.products[i] = p;
  }

  async function saveRow(tr, sku, btn) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      var data = await call('POST', { action: 'update', sku: sku, product: readFields(tr) });
      replaceProduct(data.product);
      render();
      message('success', sku + ' saved.' + (data.product.active
        ? ' The store shows the change within about a minute.'
        : ' It is hidden from the store (tick "In store" to show it).'));
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Save';
      if (err.status === 401) { show('signedout'); return; }
      if (err.fields) setFieldErrors(tr, err.fields);
      message('error', sku + ': ' + (err.fields ? Object.keys(err.fields).map(function (k) { return err.fields[k]; }).join(' ') : err.message));
    }
  }

  async function deleteRow(tr, sku, btn) {
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Click again to delete';
      setTimeout(function () { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = 'Delete'; } }, 5000);
      return;
    }
    btn.disabled = true;
    try {
      await call('POST', { action: 'delete', sku: sku });
      state.products = state.products.filter(function (p) { return p.sku !== sku; });
      render();
      message('success', sku + ' deleted. Past orders keep their own copy of the item. To hide a product without deleting it, untick "In store" instead.');
    } catch (err) {
      btn.disabled = false;
      if (err.status === 401) { show('signedout'); return; }
      message('error', err.message);
    }
  }

  async function addProduct(e) {
    e.preventDefault();
    var form = $('addForm');
    var btn = $('addBtn');
    btn.disabled = true;
    try {
      var data = await call('POST', { action: 'create', product: readFields(form) });
      replaceProduct(data.product);
      form.reset();
      categoryOptions($('new-category'), state.sections[0] && state.sections[0].id);
      setFieldErrors(form, {});
      render();
      message('success', data.product.sku + (data.product.active
        ? ' added. It appears in the store within about a minute.'
        : ' added, hidden from the store. Tick "In store" when it is ready to sell.'));
    } catch (err) {
      if (err.status === 401) { show('signedout'); return; }
      if (err.fields) setFieldErrors(form, err.fields);
      else message('error', err.message);
    } finally {
      btn.disabled = false;
    }
  }

  function init() {
    $('addForm').addEventListener('submit', addProduct);
    $('search').addEventListener('input', render);
    $('showFilter').addEventListener('change', render);
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
