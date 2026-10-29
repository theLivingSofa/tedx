'use strict';
/*
 * Cashfree test fixtures: realistic webhook bodies, the SDK's signing method and a fetch stub that
 * emulates the Cashfree PG REST API (sandbox) plus Resend.
 *
 * Signing follows the official Node SDK cashfree-pg@6.0.6 `PGVerifyWebhookSignature`:
 *   crypto.createHmac('sha256', secretKey).update(timestamp + rawBody).digest('base64')
 */
const crypto = require('node:crypto');

const SANDBOX_BASE = 'https://sandbox.cashfree.com/pg';
const PRODUCTION_BASE = 'https://api.cashfree.com/pg';

/** Sign exactly like the SDK does (string concatenation of timestamp and raw body). */
function signWebhook(rawBody, timestamp, secret) {
  return crypto.createHmac('sha256', secret).update(String(timestamp) + rawBody).digest('base64');
}

/**
 * A PAYMENT_SUCCESS_WEBHOOK body as Cashfree sends it (2023-08-01+ webhook format), written by hand so the
 * amounts keep their two decimals ("1630.00") — JSON.stringify would turn them into 1630.
 */
function paymentSuccessWebhookBody({
  orderId = 'TEDX-20261029-K3F9QZ',
  amount = '1630.00',
  paymentId = '5114910392481',
  status = 'SUCCESS',
  type = 'PAYMENT_SUCCESS_WEBHOOK',
  customerName = 'Asha Verma'
} = {}) {
  return '{"data":{"order":{"order_id":"' + orderId + '","order_amount":' + amount +
    ',"order_currency":"INR","order_tags":null},' +
    '"payment":{"cf_payment_id":"' + paymentId + '","payment_status":"' + status + '","payment_amount":' + amount +
    ',"payment_currency":"INR","payment_message":"Simulated response message","payment_time":"2026-10-29T19:12:10+05:30",' +
    '"bank_reference":"1234567890","auth_id":null,"payment_method":{"upi":{"channel":null,"upi_id":"testsuccess@gocash"}},' +
    '"payment_group":"upi"},' +
    '"customer_details":{"customer_name":"' + customerName + '","customer_id":"cust_9876543210","customer_email":"asha@example.com","customer_phone":"9876543210"},' +
    '"payment_gateway_details":{"gateway_name":"CASHFREE","gateway_order_id":"2149460581","gateway_payment_id":"5114910392481","gateway_status_code":null},' +
    '"payment_offers":null},' +
    '"event_time":"2026-10-29T19:12:12+05:30","type":"' + type + '"}';
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'cf-test-' + Math.random().toString(36).slice(2) }
  });
}

/** Normalise the many ways fetch can be called into { url, method, headers (lower-case object), body (string) }. */
async function normaliseFetchArgs(input, init = {}) {
  let url; let method; let headers; let body;
  if (typeof input === 'string' || input instanceof URL) {
    url = String(input);
    method = (init.method || 'GET').toUpperCase();
    headers = new Headers(init.headers || {});
    body = init.body;
  } else {
    url = input.url;
    method = (init.method || input.method || 'GET').toUpperCase();
    headers = new Headers(init.headers || input.headers || {});
    body = init.body !== undefined ? init.body : await input.text();
  }
  if (body && typeof body !== 'string') {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) body = Buffer.from(body).toString('utf8');
    else body = String(body);
  }
  const plain = {};
  headers.forEach((v, k) => { plain[k.toLowerCase()] = v; });
  return { url, method, headers: plain, body: body || '' };
}

/**
 * Install a fetch stub emulating Cashfree PG + Resend. Returns a controller:
 *   calls            — every request seen ({url, method, headers, body, json})
 *   gateway          — Map orderId -> { status, amount, payments: [...] } (edit in tests)
 *   cfOrderId        — cf_order_id returned on create
 *   sessionId        — payment_session_id returned on create
 *   restore()        — put the real fetch back
 *   callsTo(re, method?) — filter helper
 */
function installCashfreeFetchStub({ base = SANDBOX_BASE, createStatus = 200 } = {}) {
  const realFetch = global.fetch;
  const ctl = {
    calls: [],
    gateway: new Map(),
    cfOrderId: '2149460581',
    sessionId: 'session_test_a1b2c3d4e5f6',
    createStatus,
    emails: [],
    restore() { global.fetch = realFetch; },
    callsTo(re, method) {
      return this.calls.filter((c) => re.test(c.url) && (!method || c.method === method));
    }
  };

  global.fetch = async (input, init) => {
    const req = await normaliseFetchArgs(input, init);
    let json = null;
    try { json = req.body ? JSON.parse(req.body) : null; } catch { json = null; }
    const call = { ...req, json };
    ctl.calls.push(call);
    const u = new URL(req.url);

    if (u.origin === 'https://api.resend.com' && u.pathname === '/emails' && req.method === 'POST') {
      ctl.emails.push(call);
      return jsonResponse(200, { id: 'email_' + ctl.emails.length });
    }

    if (!req.url.startsWith(base + '/')) {
      return jsonResponse(404, { message: 'unexpected host in test stub: ' + u.origin, code: 'not_found', type: 'invalid_request_error' });
    }
    const rest = req.url.slice(base.length).split('?')[0];

    // POST /orders — Create Order
    if (rest === '/orders' && req.method === 'POST') {
      if (ctl.createStatus !== 200) {
        return jsonResponse(ctl.createStatus, { message: 'simulated failure', code: 'request_failed', type: 'api_error' });
      }
      const orderId = json && json.order_id;
      const amount = json && json.order_amount;
      if (!ctl.gateway.has(orderId)) ctl.gateway.set(orderId, { status: 'ACTIVE', amount, payments: [] });
      return jsonResponse(200, {
        cf_order_id: ctl.cfOrderId,
        created_at: new Date().toISOString(),
        customer_details: json && json.customer_details,
        entity: 'order',
        order_amount: amount,
        order_currency: 'INR',
        order_expiry_time: (json && json.order_expiry_time) || new Date(Date.now() + 30 * 60000).toISOString(),
        order_id: orderId,
        order_meta: json && json.order_meta,
        order_note: (json && json.order_note) || null,
        order_splits: [],
        order_status: 'ACTIVE',
        order_tags: null,
        payment_session_id: ctl.sessionId
      });
    }

    // GET /orders/{id}/payments — Get Payments for an Order
    let m = rest.match(/^\/orders\/([^/]+)\/payments$/);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const g = ctl.gateway.get(id);
      if (!g) return jsonResponse(404, { message: 'order not found', code: 'order_not_found', type: 'invalid_request_error' });
      return jsonResponse(200, g.payments.map((p) => ({
        cf_payment_id: p.cf_payment_id,
        order_id: id,
        entity: 'payment',
        is_captured: p.payment_status === 'SUCCESS',
        order_amount: g.amount,
        payment_group: p.payment_group || 'upi',
        payment_currency: 'INR',
        payment_amount: p.payment_amount !== undefined ? p.payment_amount : g.amount,
        payment_time: p.payment_time || '2026-10-29T19:12:10+05:30',
        payment_completion_time: p.payment_time || '2026-10-29T19:12:12+05:30',
        payment_status: p.payment_status,
        payment_message: p.payment_status === 'SUCCESS' ? 'Transaction Success' : 'Transaction Failed',
        bank_reference: '1234567890',
        auth_id: null,
        payment_method: { upi: { channel: 'collect', upi_id: 'testsuccess@gocash' } }
      })));
    }

    // GET /orders/{id} — Get Order
    m = rest.match(/^\/orders\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const g = ctl.gateway.get(id);
      if (!g) return jsonResponse(404, { message: 'order not found', code: 'order_not_found', type: 'invalid_request_error' });
      return jsonResponse(200, {
        cf_order_id: ctl.cfOrderId,
        order_id: id,
        entity: 'order',
        order_currency: 'INR',
        order_amount: g.amount,
        order_status: g.status,
        payment_session_id: ctl.sessionId,
        order_expiry_time: new Date(Date.now() + 30 * 60000).toISOString(),
        order_note: null,
        created_at: new Date().toISOString()
      });
    }

    return jsonResponse(404, { message: 'route not emulated: ' + req.method + ' ' + rest, code: 'not_found', type: 'invalid_request_error' });
  };

  return ctl;
}

module.exports = {
  SANDBOX_BASE,
  PRODUCTION_BASE,
  signWebhook,
  paymentSuccessWebhookBody,
  installCashfreeFetchStub
};
