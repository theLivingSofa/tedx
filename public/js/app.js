/*
 * Store page bootstrap: brand copy, side-nav, catalogue loading (with retry), payment panel notes.
 */
(function () {
  'use strict';

  var M = (window.Merch = window.Merch || {});
  var U = M.util;
  var el = U.el;
  var $ = function (id) { return document.getElementById(id); };

  var navButtons = [];
  var observer = null;

  function applyBrand() {
    var b = U.brand();
    if (b.pageTitle) document.title = b.pageTitle;
    if (b.mark) { $('navBrand').textContent = b.mark; $('heroMark').textContent = b.mark; }
    if (b.heading) $('heroHeading').textContent = b.heading;
    if (b.intro) $('heroIntro').textContent = b.intro;
    if (b.imageDisclaimer) $('disclaimerText').textContent = ' ' + b.imageDisclaimer;
  }

  function setActive(id) {
    navButtons.forEach(function (btn) {
      if (btn.dataset.target === id) btn.setAttribute('aria-current', 'true');
      else btn.removeAttribute('aria-current');
    });
  }

  function buildNav() {
    var nav = $('sideNav');
    (U.brand().sections || []).forEach(function (s, i) {
      var btn = el('button', {
        type: 'button', title: 'Go to ' + s.label, dataset: { target: s.id },
        attrs: { 'aria-label': s.label + ' section' }
      }, [
        el('span', { class: 'nav-icon', text: s.icon || '', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'nav-label', text: s.navLabel || s.label })
      ]);
      if (i === 0) btn.setAttribute('aria-current', 'true');
      btn.addEventListener('click', function () {
        var target = $('section-' + s.id) || $('products');
        setActive(s.id);
        U.scrollIntoView(target, 'start');
      });
      nav.appendChild(btn);
      navButtons.push(btn);
    });
  }

  function observeSections(sections) {
    var present = sections.map(function (s) { return s.id; });
    navButtons.forEach(function (btn) { btn.hidden = present.indexOf(btn.dataset.target) === -1; });
    if (present.length && present.indexOf(currentActive()) === -1) setActive(present[0]);
    if (observer) observer.disconnect();
    if (!('IntersectionObserver' in window) || !sections.length) return;
    // The observer fires whenever a section enters/leaves the top 35% of the viewport; the active section is
    // then the last one whose top has passed that line (robust to jumps, e.g. End key or anchor links).
    observer = new IntersectionObserver(function () {
      var line = window.innerHeight * 0.35;
      var active = sections[0].id;
      sections.forEach(function (s) {
        if (s.element.getBoundingClientRect().top <= line) active = s.id;
      });
      setActive(active);
    }, { rootMargin: '0px 0px -65% 0px' });
    sections.forEach(function (s) { observer.observe(s.element); });
  }

  function currentActive() {
    var a = navButtons.filter(function (b) { return b.getAttribute('aria-current') === 'true'; })[0];
    return a ? a.dataset.target : null;
  }

  function updatePaymentPanel(data) {
    var payment = data.payment || {};
    $('demoNote').hidden = payment.mode !== 'mock';
    $('sandboxNote').hidden = !(payment.environment === 'sandbox' && payment.mode !== 'mock');
    $('storeClosedNote').hidden = data.storeOpen !== false;
  }

  function showLoading(root) {
    U.clear(root);
    root.setAttribute('aria-busy', 'true');
    root.appendChild(el('div', { class: 'catalogue-status', attrs: { role: 'status' } }, [
      el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }),
      'Loading the catalogue…'
    ]));
  }

  function showLoadError(root, err) {
    U.clear(root);
    root.removeAttribute('aria-busy');
    var retry = el('button', { type: 'button', class: 'retry-button', text: 'Try again' });
    retry.addEventListener('click', function () { load(true); });
    root.appendChild(el('div', { class: 'message error catalogue-error', attrs: { role: 'status' } }, [
      el('strong', { text: 'We couldn’t load the catalogue.' }),
      el('p', { text: (err && err.message) || 'Please check your connection and try again.' }),
      el('div', { class: 'message-actions' }, [retry])
    ]));
    return retry;
  }

  async function load(focusAfter) {
    var root = $('products');
    showLoading(root);
    var data;
    try {
      data = await M.api.getCatalogue();
      if (!data || !Array.isArray(data.products)) throw M.ApiError(200, 'invalid_response', 'Unexpected response from the server.');
    } catch (err) {
      var retry = showLoadError(root, err);
      if (focusAfter) retry.focus();
      return;
    }
    root.removeAttribute('aria-busy');
    var bySku = new Map();
    data.products.forEach(function (p) { if (p && typeof p.sku === 'string') bySku.set(p.sku, p); });
    M.cart.restore(bySku, Array.isArray(data.sizes) ? data.sizes : []);
    var sections = M.catalogue.render(root, data);
    M.catalogue.applyCartToCards();
    M.checkout.setCatalogue(data);
    M.cartView.render();
    updatePaymentPanel(data);
    observeSections(sections);
    M.cart.subscribe(M.catalogue.syncAll);
    if (focusAfter) {
      var first = root.querySelector('.section-title');
      if (first) { first.setAttribute('tabindex', '-1'); first.focus(); }
    }
  }

  function init() {
    applyBrand();
    buildNav();
    M.cartView.init();
    M.checkout.init();
    load(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
