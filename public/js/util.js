/*
 * Shared helpers for every page (no dependencies).
 * Everything hangs off window.Merch so files can be split without a bundler.
 * All dynamic text must reach the DOM via textContent (see el()) or escapeHtml().
 */
(function () {
  'use strict';

  var M = (window.Merch = window.Merch || {});

  var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

  /** Strict HTML escape for building markup strings (used by the receipt only). */
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"'`]/g, function (ch) { return HTML_ESCAPES[ch]; });
  }

  /** Rupees (number) -> integer paise. Non-finite values become 0. */
  function toPaise(rupees) {
    var n = Number(rupees);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100);
  }

  function fromPaise(paise) {
    return Math.round(Number(paise) || 0) / 100;
  }

  /** '₹1,630' (whole rupees) or '₹12.50', en-IN digit grouping (₹1,00,000). */
  function formatPaise(paise) {
    var p = Math.round(Number(paise) || 0);
    var whole = p % 100 === 0;
    var sign = p < 0 ? '-' : '';
    var abs = Math.abs(p) / 100;
    return sign + '₹' + abs.toLocaleString('en-IN', {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function formatINR(rupees) {
    return formatPaise(toPaise(rupees));
  }

  function itemCountText(n) {
    return n + (n === 1 ? ' item' : ' items');
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return d.toLocaleString();
    }
  }

  /**
   * Tiny DOM builder. props: { class, text, attrs:{}, dataset:{}, hidden, ...plain properties }.
   * Children may be nodes, strings (become text nodes) or null/false (skipped). Never parses HTML.
   */
  function el(tag, props, children) {
    var node = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (key) {
      var val = props[key];
      if (val == null || val === false) return;
      if (key === 'class') node.className = val;
      else if (key === 'text') node.textContent = String(val);
      else if (key === 'attrs') {
        Object.keys(val).forEach(function (a) {
          if (val[a] != null && val[a] !== false) node.setAttribute(a, val[a] === true ? '' : String(val[a]));
        });
      } else if (key === 'dataset') {
        Object.keys(val).forEach(function (d) { node.dataset[d] = String(val[d]); });
      } else node[key] = val;
    });
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    if (children == null) return node;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (child) {
      if (child == null || child === false) return;
      node.appendChild(typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child)) : child);
    });
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /** Web Storage access that never throws (private mode, blocked storage, quota). */
  function storageGet(kind, key) {
    try {
      var raw = window[kind].getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function storageSet(kind, key, value) {
    try {
      window[kind].setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function storageRemove(kind, key) {
    try { window[kind].removeItem(key); } catch (e) { /* ignore */ }
  }

  function params() {
    return new URLSearchParams(window.location.search);
  }

  /** Builds a same-origin page URL with the given query parameters. */
  function pageUrl(path, query) {
    var qs = new URLSearchParams();
    Object.keys(query || {}).forEach(function (k) {
      if (query[k] != null && query[k] !== '') qs.set(k, String(query[k]));
    });
    var s = qs.toString();
    return path + (s ? '?' + s : '');
  }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function scrollIntoView(node, block) {
    if (!node) return;
    node.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: block || 'start' });
  }

  var LAST_ORDER_KEY = 'merch:lastOrder';
  var LAST_ORDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // forget the last order after a week (shared computers)

  function saveLastOrder(orderId, token) {
    storageSet('localStorage', LAST_ORDER_KEY, { orderId: orderId, token: token, savedAt: Date.now() });
  }

  function readLastOrder() {
    var v = storageGet('localStorage', LAST_ORDER_KEY);
    if (!v || typeof v.orderId !== 'string' || typeof v.token !== 'string') return null;
    if (typeof v.savedAt !== 'number' || Date.now() - v.savedAt > LAST_ORDER_MAX_AGE_MS) {
      storageRemove('localStorage', LAST_ORDER_KEY);
      return null;
    }
    return v;
  }

  /** Link to the order status page. The token goes in the #fragment, which browsers never send to servers. */
  function orderUrl(orderId, token) {
    return pageUrl('/order', { id: orderId }) + (token ? '#token=' + encodeURIComponent(token) : '');
  }

  function brand() {
    return window.BRAND || {};
  }

  M.util = {
    escapeHtml: escapeHtml,
    toPaise: toPaise,
    fromPaise: fromPaise,
    formatPaise: formatPaise,
    formatINR: formatINR,
    itemCountText: itemCountText,
    formatDateTime: formatDateTime,
    el: el,
    append: appendChildren,
    clear: clear,
    storageGet: storageGet,
    storageSet: storageSet,
    storageRemove: storageRemove,
    params: params,
    pageUrl: pageUrl,
    prefersReducedMotion: prefersReducedMotion,
    scrollIntoView: scrollIntoView,
    saveLastOrder: saveLastOrder,
    readLastOrder: readLastOrder,
    orderUrl: orderUrl,
    brand: brand
  };
})();
