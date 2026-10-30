/*
 * API client for the relative /api/* endpoints (docs/CONTRACT.md section 5).
 */
(function () {
  'use strict';

  var M = (window.Merch = window.Merch || {});

  function ApiError(status, code, message, fields, retryAfter) {
    var err = new Error(message);
    err.name = 'ApiError';
    err.status = status;
    err.code = code;
    err.fields = fields && typeof fields === 'object' ? fields : null;
    err.retryAfter = retryAfter;
    return err;
  }

  var DEFAULT_MESSAGES = {
    0: 'We couldn’t reach the server. Please check your connection and try again.',
    404: 'We couldn’t find what you were looking for.',
    429: 'Too many requests. Please wait a moment and try again.',
    500: 'Something went wrong on our side. Please try again.',
    502: 'The payment gateway did not respond. Please try again.',
    503: 'The store is temporarily unavailable. Please try again shortly.'
  };

  function defaultMessage(status) {
    return DEFAULT_MESSAGES[status] || DEFAULT_MESSAGES[status >= 500 ? 500 : 0] ||
      'Something went wrong. Please try again.';
  }

  function toResult(status, data, retryAfterHeader) {
    if (status >= 200 && status < 300) {
      if (data && typeof data === 'object') return data;
      throw ApiError(status, 'invalid_response', 'Unexpected response from the server. Please try again.');
    }
    var e = data && data.error && typeof data.error === 'object' ? data.error : {};
    var retryAfter = Number(e.retryAfter) || Number(retryAfterHeader) || undefined;
    throw ApiError(
      status,
      typeof e.code === 'string' ? e.code : 'http_' + status,
      typeof e.message === 'string' && e.message ? e.message : defaultMessage(status),
      e.fields,
      retryAfter
    );
  }

  async function request(method, path, body, opts) {
    opts = opts || {};
    var res;
    try {
      res = await fetch(path, {
        method: method,
        headers: Object.assign(body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' }, opts.headers || {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        cache: opts.cache || 'no-store'
      });
    } catch (e) {
      throw ApiError(0, 'network_error', defaultMessage(0));
    }
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    return toResult(res.status, data, res.headers.get('Retry-After'));
  }

  M.ApiError = ApiError;
  M.api = {
    getCatalogue: function () {
      return request('GET', '/api/catalogue', undefined, { cache: 'default' });
    },
    createOrder: function (payload) {
      return request('POST', '/api/create-order', payload);
    },
    verifyPayment: function (orderId, token) {
      return request('POST', '/api/verify-payment', { orderId: orderId, token: token });
    },
    orderStatus: function (orderId, token) {
      // The token travels in a header, not the URL, so it never lands in request logs or browser history.
      return request('GET', '/api/order-status?id=' + encodeURIComponent(orderId), undefined,
        { headers: { 'X-Order-Token': token } });
    },
    /** Re-confirms an unpaid order and, if it can still be paid, returns { …view, resume: { paymentSessionId, environment } }. */
    resumePayment: function (orderId, token) {
      return request('GET', '/api/order-status?resume=1&id=' + encodeURIComponent(orderId), undefined,
        { headers: { 'X-Order-Token': token } });
    },
    mockPay: function (orderId, token, outcome) {
      return request('POST', '/api/mock-pay', { orderId: orderId, token: token, outcome: outcome });
    }
  };
})();
