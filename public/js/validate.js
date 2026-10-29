/*
 * Client-side validation mirroring docs/CONTRACT.md section 6.3 (lib/validate.js).
 * The server stays authoritative; this only gives fast, friendly feedback.
 */
(function () {
  'use strict';

  var M = (window.Merch = window.Merch || {});

  var NAME_RE = /^[\p{L}\p{M} .'-]+$/u;
  var ROLL_RE = /^[A-Za-z0-9/_ -]+$/;
  var EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
  var PHONE_RE = /^[6-9]\d{9}$/;
  var PRINTED_NAME_RE = /^[A-Za-z0-9 .'&-]+$/;
  var ORDER_ID_RE = /^[A-Z0-9]{1,8}-\d{8}-[A-Z2-9]{6}$/;
  var TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

  function collapse(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  }

  /** Strips spaces/dashes and an optional +91 / 91 / 0 prefix. Returns '' if not a valid mobile. */
  function normalisePhone(value) {
    var s = String(value == null ? '' : value).trim().replace(/[\s-]/g, '');
    if (/^\+91\d{10}$/.test(s)) s = s.slice(3);
    else if (/^91\d{10}$/.test(s)) s = s.slice(2);
    else if (/^0\d{10}$/.test(s)) s = s.slice(1);
    return PHONE_RE.test(s) ? s : '';
  }

  function stripControls(value) {
    // Remove control characters except newline (CONTRACT 6.3 notes rule).
    return String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');
  }

  function checkName(v) {
    if (!v) return 'Enter your full name.';
    if (v.length < 2 || v.length > 80) return 'Your name must be 2–80 characters long.';
    if (!NAME_RE.test(v)) return 'Use letters, spaces and . \' - only in your name.';
    return null;
  }

  function checkRoll(v) {
    if (!v) return 'Enter your roll number.';
    if (v.length > 30) return 'Your roll number must be at most 30 characters.';
    if (!ROLL_RE.test(v)) return 'Use letters, digits, spaces and / _ - only in your roll number.';
    return null;
  }

  function checkEmail(v) {
    if (!v) return 'Enter your email address.';
    if (v.length > 254 || !EMAIL_RE.test(v)) return 'Enter a valid email address.';
    return null;
  }

  function checkPhone(raw) {
    if (!String(raw || '').trim()) return 'Enter your contact number.';
    if (!normalisePhone(raw)) return 'Enter a valid 10-digit Indian mobile number.';
    return null;
  }

  function checkNotes(v) {
    if (v.length > 500) return 'Notes must be at most 500 characters.';
    return null;
  }

  /** -> { ok, value, fields } where value is the normalised customer object for the API. */
  function validateCustomer(input) {
    var value = {
      name: collapse(input.name),
      roll: collapse(input.roll),
      email: String(input.email == null ? '' : input.email).trim().toLowerCase(),
      phone: normalisePhone(input.phone),
      notes: stripControls(input.notes).trim()
    };
    var fields = {};
    var e;
    if ((e = checkName(value.name))) fields.name = e;
    if ((e = checkRoll(value.roll))) fields.roll = e;
    if ((e = checkEmail(value.email))) fields.email = e;
    if ((e = checkPhone(input.phone))) fields.phone = e;
    if ((e = checkNotes(value.notes))) fields.notes = e;
    if (!value.notes) delete value.notes;
    return { ok: Object.keys(fields).length === 0, value: value, fields: fields };
  }

  /** Returns an error message or null. */
  function checkPrintedName(value) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return 'Enter the name to print.';
    if (v.length > 20) return 'The printed name can be at most 20 characters.';
    if (!PRINTED_NAME_RE.test(v)) return 'Use letters, digits, spaces and . \' & - only.';
    return null;
  }

  M.validate = {
    validateCustomer: validateCustomer,
    checkPrintedName: checkPrintedName,
    normalisePhone: normalisePhone,
    collapse: collapse,
    isOrderId: function (id) { return typeof id === 'string' && ORDER_ID_RE.test(id); },
    isToken: function (t) { return typeof t === 'string' && TOKEN_RE.test(t); }
  };
})();
