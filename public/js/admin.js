/*
 * Organiser dashboard (/admin). Talks to /api/admin-* with a same-origin session cookie.
 * Never stores customer data in the browser; the include-test toggle is the only thing remembered.
 */
(function () {
  'use strict';

  var M = window.Merch || {};
  var U = M.util;
  var $ = function (id) { return document.getElementById(id); };
  var el = U.el;
  var REFRESH_MS = 60000;
  var state = { data: null, timer: null, loading: false };

  /* ------------------------------------------------------------------ api */

  async function call(method, path, body) {
    var res;
    try {
      res = await fetch(path, {
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

  /* ------------------------------------------------------------------ ui helpers */

  function show(which) {
    $('loadingCard').hidden = which !== 'loading';
    $('loginCard').hidden = which !== 'login';
    $('dashboard').hidden = which !== 'dashboard';
  }

  function setMessage(node, kind, text) {
    node.className = 'message' + (kind ? ' ' + kind : '');
    node.textContent = text || '';
  }

  function money(n) { return U.formatINR(Number(n) || 0); }

  function td(text, cls) { return el('td', { text: text == null ? '' : String(text), class: cls }); }
  function th(text, cls) { return el('th', { text: text, class: cls, attrs: { scope: 'col' } }); }

  function fillTable(table, headers, rows, emptyText) {
    U.clear(table);
    table.appendChild(el('thead', {}, el('tr', {}, headers)));
    var body = el('tbody');
    if (!rows.length) body.appendChild(el('tr', {}, el('td', { text: emptyText, class: 'empty', attrs: { colspan: headers.length } })));
    rows.forEach(function (r) { body.appendChild(r); });
    table.appendChild(body);
  }

  /* ------------------------------------------------------------------ rendering */

  function renderMetrics(m) {
    var items = [
      ['Paid orders', m.paidOrders],
      ['Money collected', money(m.moneyCollected)],
      ['Items sold', m.itemsSold],
      ['Items with name printing', m.itemsPrinted],
      ['Handed over', m.handedOver],
      ['Still to hand over', m.toHandOver],
      ['Awaiting payment', m.awaiting],
      ['Failed / expired', m.failedOrExpired],
      ['Needs a look', m.needsReview, m.needsReview > 0 ? 'is-alert' : '']
    ];
    var box = U.clear($('metrics'));
    items.forEach(function (it) {
      box.appendChild(el('div', { class: 'metric ' + (it[2] || '') }, [
        el('div', { class: 'metric-value', text: String(it[1]) }),
        el('div', { class: 'metric-label', text: it[0] })
      ]));
    });
  }

  function renderProducts(d) {
    var rows = d.products.filter(function (p) { return p.total > 0; }).map(function (p) {
      var cells = [td(p.sku, 'mono'), td(p.name)];
      d.sizes.forEach(function (s) { cells.push(td(p.sizes[s] || '', 'num')); });
      cells.push(td(p.total, 'num strong'), td(p.printed || '', 'num'), td(money(p.revenue), 'num'));
      return el('tr', {}, cells);
    });
    var headers = [th('SKU'), th('Product')]
      .concat(d.sizes.map(function (s) { return th(s, 'num'); }))
      .concat([th('Total', 'num'), th('Printed', 'num'), th('Revenue', 'num')]);
    fillTable($('productsTable'), headers, rows, 'No paid orders yet.');
  }

  function renderNames(d) {
    var rows = d.printedNames.map(function (n) {
      return el('tr', {}, [td(n.printedName, 'strong'), td(n.product + ' (' + n.sku + ')'), td(n.size), td(n.quantity, 'num'), td(n.orderId, 'mono')]);
    });
    fillTable($('namesTable'), [th('Name to print'), th('Product'), th('Size'), th('Qty', 'num'), th('Order ID')], rows, 'No name printing ordered yet.');
  }

  function matchesFilter(o, filter) {
    switch (filter) {
      case 'paid': return o.status === 'Paid';
      case 'pending-handover': return o.status === 'Paid' && !o.handedOver;
      case 'handed-over': return o.status === 'Paid' && o.handedOver;
      case 'awaiting': return o.status === 'Awaiting Payment';
      case 'failed': return o.status === 'Failed' || o.status === 'Expired';
      case 'review': return o.needsReview;
      default: return true;
    }
  }

  function filteredOrders() {
    if (!state.data) return [];
    var q = $('search').value.trim().toLowerCase();
    var filter = $('statusFilter').value;
    return state.data.orders.filter(function (o) {
      if (!matchesFilter(o, filter)) return false;
      if (!q) return true;
      return [o.orderId, o.name, o.roll, o.phone, o.email].some(function (v) { return String(v || '').toLowerCase().indexOf(q) !== -1; });
    });
  }

  function handoverCell(o) {
    if (o.status !== 'Paid') return td('—', 'center muted');
    if (!state.data.handoverAvailable) return td('Set up the Handover tab', 'muted');
    var box = el('input', { type: 'checkbox', checked: o.handedOver, attrs: { 'aria-label': 'Handed over: ' + o.orderId } });
    box.addEventListener('change', function () { saveHandover(o, box); });
    return el('td', { class: 'center' }, box);
  }

  function renderOrders() {
    var list = filteredOrders();
    var rows = list.map(function (o) {
      var status = el('span', { class: 'status-badge' + (o.status === 'Paid' ? ' is-paid' : ''), text: o.status });
      var flags = [];
      if (o.test) flags.push(el('span', { class: 'tag', text: 'test' }));
      if (o.needsReview) flags.push(el('span', { class: 'tag is-alert', text: 'check', attrs: { title: o.reviewFlag } }));
      return el('tr', { class: o.handedOver ? 'is-done' : '' }, [
        handoverCell(o),
        el('td', { class: 'mono' }, [document.createTextNode(o.orderId)].concat(flags)),
        el('td', {}, status),
        td(o.name, 'strong'), td(o.roll), td(o.phone, 'mono'),
        td(o.items, 'items'),
        td(money(o.total), 'num'),
        td(o.paidAt ? U.formatDateTime(o.paidAt) : (o.createdAt ? U.formatDateTime(o.createdAt) : ''))
      ]);
    });
    fillTable($('ordersTable'),
      [th('Handed over', 'center'), th('Order ID'), th('Status'), th('Name'), th('Roll no.'), th('Phone'), th('Items'), th('Total', 'num'), th('Paid / placed')],
      rows, 'No orders match.');
    $('ordersCount').textContent = list.length + ' of ' + state.data.orders.length + ' orders shown';
  }

  function render() {
    var d = state.data;
    renderMetrics(d.metrics);
    renderProducts(d);
    renderNames(d);
    renderOrders();
    $('updatedAt').textContent = 'Updated ' + U.formatDateTime(d.generatedAt) + (d.storage === 'local' ? ' · demo data (local file)' : '');
  }

  /* ------------------------------------------------------------------ actions */

  async function load(opts) {
    if (state.loading) return;
    state.loading = true;
    $('refreshBtn').disabled = true;
    try {
      state.data = await call('GET', '/api/admin-summary');
      show('dashboard');
      render();
      if (!(opts && opts.keepMessage)) setMessage($('dashMessage'), '', '');
    } catch (err) {
      if (err.status === 401) { show('login'); $('adminPassword').focus(); }
      else if (err.status === 404) { show('login'); setMessage($('loginMessage'), 'error', 'The admin area is not switched on for this site.'); $('loginForm').hidden = true; }
      else { show(state.data ? 'dashboard' : 'login'); setMessage(state.data ? $('dashMessage') : $('loginMessage'), 'error', err.message); }
    } finally {
      state.loading = false;
      $('refreshBtn').disabled = false;
    }
  }

  async function saveHandover(o, box) {
    box.disabled = true;
    var want = box.checked;
    try {
      var saved = await call('POST', '/api/admin-handover', { orderId: o.orderId, handedOver: want });
      o.handedOver = saved.handedOver;
      var m = state.data.metrics;
      var paid = state.data.orders.filter(function (x) { return x.status === 'Paid'; });
      m.handedOver = paid.filter(function (x) { return x.handedOver; }).length;
      m.toHandOver = m.paidOrders - m.handedOver;
      renderMetrics(m);
      renderOrders();
      setMessage($('dashMessage'), 'success', o.orderId + (want ? ' marked as handed over.' : ' marked as not handed over.'));
    } catch (err) {
      box.checked = !want;
      box.disabled = false;
      if (err.status === 401) { show('login'); return; }
      setMessage($('dashMessage'), 'error', 'Could not save ' + o.orderId + ': ' + err.message);
    }
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets running it as a formula
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsv() {
    var cols = ['orderId', 'status', 'name', 'roll', 'email', 'phone', 'items', 'total', 'paymentMethod', 'paidAt', 'createdAt', 'handedOver', 'handoverNote', 'reviewFlag'];
    var lines = [cols.join(',')].concat(filteredOrders().map(function (o) {
      return cols.map(function (c) { return csvCell(o[c]); }).join(',');
    }));
    var url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    var a = el('a', { href: url, download: 'merch-orders-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  async function login(e) {
    e.preventDefault();
    var input = $('adminPassword');
    if (!input.value) { setMessage($('loginMessage'), 'error', 'Enter the admin password.'); return; }
    $('loginBtn').disabled = true;
    setMessage($('loginMessage'), 'info', 'Signing in…');
    try {
      await call('POST', '/api/admin-auth?op=login', { password: input.value });
      input.value = '';
      setMessage($('loginMessage'), '', '');
      // Only same-site admin pages are allowed as a return target.
      var next = new URLSearchParams(location.search).get('next');
      if (next === '/admin-products') { location.assign(next); return; }
      await load();
    } catch (err) {
      setMessage($('loginMessage'), 'error', err.status === 401 ? 'Wrong password.' : err.message);
      $('loginMessage').focus();
    } finally {
      $('loginBtn').disabled = false;
    }
  }

  function passwordFieldError(name, text) {
    var input = $(name);
    var box = input.parentElement.querySelector('.field-error');
    if (text) { input.setAttribute('aria-invalid', 'true'); box.textContent = text; box.hidden = false; }
    else { input.removeAttribute('aria-invalid'); box.textContent = ''; box.hidden = true; }
  }

  async function changePassword(e) {
    e.preventDefault();
    var current = $('currentPassword').value;
    var next = $('newPassword').value;
    var again = $('confirmPassword').value;
    ['currentPassword', 'newPassword', 'confirmPassword'].forEach(function (n) { passwordFieldError(n, ''); });
    setMessage($('passwordMessage'), '', '');
    if (!current) { passwordFieldError('currentPassword', 'Enter your current password.'); $('currentPassword').focus(); return; }
    if (next.length < 12) { passwordFieldError('newPassword', 'Use at least 12 characters.'); $('newPassword').focus(); return; }
    if (next !== again) { passwordFieldError('confirmPassword', 'The two new passwords do not match.'); $('confirmPassword').focus(); return; }
    $('passwordBtn').disabled = true;
    try {
      await call('POST', '/api/admin-auth?op=password', { currentPassword: current, newPassword: next });
      $('passwordForm').reset();
      setMessage($('passwordMessage'), 'success', 'Password changed. Use the new password next time you sign in.');
    } catch (err) {
      if (err.status === 401) { show('login'); return; }
      var field = err.fields && Object.keys(err.fields)[0];
      if (field === 'currentPassword' || field === 'newPassword') { passwordFieldError(field, err.message); $(field).focus(); }
      else setMessage($('passwordMessage'), 'error', err.message);
    } finally {
      $('passwordBtn').disabled = false;
    }
  }

  async function logout() {
    try { await call('POST', '/api/admin-auth?op=logout', {}); } catch (e) { /* ignore */ }
    state.data = null;
    show('login');
  }

  function init() {
    $('loginForm').addEventListener('submit', login);
    $('refreshBtn').addEventListener('click', function () { load(); });
    $('csvBtn').addEventListener('click', downloadCsv);
    $('logoutBtn').addEventListener('click', logout);
    $('passwordForm').addEventListener('submit', changePassword);
    $('search').addEventListener('input', function () { if (state.data) renderOrders(); });
    $('statusFilter').addEventListener('change', function () { if (state.data) renderOrders(); });
    state.timer = setInterval(function () {
      if (!document.hidden && state.data && !$('dashboard').hidden) load({ keepMessage: true });
    }, REFRESH_MS);
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
