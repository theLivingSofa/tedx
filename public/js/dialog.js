/*
 * Accessible modal dialogs: role="dialog" + aria-modal markup lives in the HTML; this adds
 * open/close, focus trap, Esc + overlay-click to close, background inert, and focus return to the opener.
 */
(function () {
  'use strict';

  var M = (window.Merch = window.Merch || {});
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

  var current = null;

  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (node) {
      return !node.hidden && node.getClientRects().length > 0;
    });
  }

  function onKeydown(e) {
    if (!current) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close('escape');
      return;
    }
    if (e.key !== 'Tab') return;
    var list = focusables(current.panel);
    if (!list.length) {
      e.preventDefault();
      current.panel.focus();
      return;
    }
    var first = list[0];
    var last = list[list.length - 1];
    var active = document.activeElement;
    if (e.shiftKey && (active === first || !current.panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !current.panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  function onOverlayClick(e) {
    if (current && e.target === current.overlay) close('overlay');
  }

  /**
   * open(overlay, { opener, initialFocus, onClose(reason) })
   * overlay: the full-screen .overlay element (hidden attribute toggled); its first .popup child is the panel.
   */
  function open(overlay, opts) {
    opts = opts || {};
    if (current) close('replaced', { restoreFocus: false });
    var panel = overlay.querySelector('.popup') || overlay;
    var inerted = [];
    Array.prototype.forEach.call(document.body.children, function (child) {
      if (child === overlay || child.tagName === 'SCRIPT' || child.inert) return;
      child.inert = true;
      inerted.push(child);
    });
    current = {
      overlay: overlay, panel: panel, opener: opts.opener || document.activeElement,
      onClose: opts.onClose, inerted: inerted
    };
    overlay.hidden = false;
    document.body.classList.add('modal-open');
    document.addEventListener('keydown', onKeydown, true);
    overlay.addEventListener('click', onOverlayClick);
    var target = opts.initialFocus || focusables(panel)[0] || panel;
    target.focus();
  }

  function close(reason, closeOpts) {
    if (!current) return;
    closeOpts = closeOpts || {};
    var c = current;
    current = null;
    c.overlay.hidden = true;
    c.inerted.forEach(function (node) { node.inert = false; });
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', onKeydown, true);
    c.overlay.removeEventListener('click', onOverlayClick);
    if (closeOpts.restoreFocus !== false && c.opener && document.contains(c.opener) &&
        typeof c.opener.focus === 'function') {
      c.opener.focus();
    }
    if (typeof c.onClose === 'function') c.onClose(reason || 'close');
  }

  M.dialog = {
    open: open,
    close: close,
    isOpen: function (overlay) { return !!current && (!overlay || current.overlay === overlay); }
  };
})();
