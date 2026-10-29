'use strict';
/*
 * Optional receipt email via the Resend REST API (CONTRACT 6.9). Owner: payments.
 * Sends only when RESEND_API_KEY and EMAIL_FROM are both set. Never throws; never logs addresses.
 */

const { log } = require('./http');

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10000;

function env(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

function emailEnabled() {
  return Boolean(env('RESEND_API_KEY') && env('EMAIL_FROM'));
}

function loadBrand() {
  try {
    return require('../public/config/brand.js');
  } catch (_) {
    return { organisation: 'Merch Store', pageTitle: 'Merch Store', supportEmail: '' };
  }
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inr(n) {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  const whole = Number.isInteger(v);
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  try {
    return new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';
  } catch (_) {
    return new Date(t).toISOString();
  }
}

/** Standalone receipt HTML (inline styles; every dynamic value escaped). view = order view (5.6). */
function renderReceiptHtml(view, brand) {
  const b = brand || loadBrand();
  const v = view || {};
  const c = v.customer || {};
  const items = Array.isArray(v.items) ? v.items : [];
  const td = 'padding:8px;border-bottom:1px solid #e5e5e5;vertical-align:top;';
  const tdr = td + 'text-align:right;white-space:nowrap;';
  const rows = items.map((l) => {
    const details = [];
    if (l.size) details.push('Size: ' + esc(l.size));
    if (l.printing) details.push('Name print: &quot;' + esc(l.printedName) + '&quot;');
    return '<tr>' +
      `<td style="${td}"><strong>${esc(l.name)}</strong><br><span style="color:#666;font-size:12px">SKU: ${esc(l.sku)}` +
      (details.length ? ' · ' + details.join(' · ') : '') + '</span></td>' +
      `<td style="${tdr}">${esc(l.quantity)}</td>` +
      `<td style="${tdr}">${esc(inr(l.unitPrice))}${l.printing && l.printingCharge ? ' + ' + esc(inr(l.printingCharge)) : ''}</td>` +
      `<td style="${tdr}">${esc(inr(l.lineTotal))}</td></tr>`;
  }).join('');
  const kv = (k, val) => val ? `<tr><td style="padding:3px 12px 3px 0;color:#666">${esc(k)}</td><td style="padding:3px 0">${esc(val)}</td></tr>` : '';

  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${esc(b.organisation)} — Order ${esc(v.orderId)}</title></head>` +
    '<body style="margin:0;background:#f5f5f5;font-family:Arial,sans-serif;color:#171717;font-size:14px">' +
    '<div style="max-width:640px;margin:0 auto;padding:20px 12px">' +
    '<div style="background:#111;color:#fff;border-radius:14px;border-top:5px solid #e62b1e;padding:20px">' +
    `<div style="color:#e62b1e;font-weight:700;font-size:24px">${esc(b.mark || '')}</div>` +
    `<h1 style="margin:6px 0 4px;font-size:22px">${esc(b.organisation)} — Order receipt</h1>` +
    `<div style="color:#ddd">Order ${esc(v.orderId)} · ${esc(v.status)}</div></div>` +
    '<div style="background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:16px;margin-top:14px">' +
    `<p style="margin:0 0 12px">${esc(v.message)}</p>` +
    '<table role="presentation" style="border-collapse:collapse;font-size:14px">' +
    kv('Order ID', v.orderId) + kv('Status', v.status) + kv('Placed', fmtDate(v.createdAt)) +
    kv('Paid', fmtDate(v.paidAt)) + kv('Payment method', v.paymentMethod) + kv('Payment ID', v.paymentId) +
    kv('Name', c.name) + kv('Roll number', c.roll) + kv('Email', c.email) + kv('Phone', c.phone) +
    '</table></div>' +
    '<div style="background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:16px;margin-top:14px">' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr>' +
    `<th style="${td}text-align:left">Item</th><th style="${tdr}">Qty</th><th style="${tdr}">Price</th><th style="${tdr}">Total</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    '<table role="presentation" style="width:100%;margin-top:10px;font-size:14px">' +
    `<tr><td style="color:#666">Subtotal</td><td style="text-align:right">${esc(inr(v.subtotal))}</td></tr>` +
    `<tr><td style="color:#666">Name printing</td><td style="text-align:right">${esc(inr(v.printingTotal))}</td></tr>` +
    `<tr><td style="font-weight:700;font-size:18px;padding-top:6px">Total</td><td style="text-align:right;font-weight:700;font-size:18px;padding-top:6px">${esc(inr(v.total))} ${esc(v.currency || 'INR')}</td></tr>` +
    '</table>' +
    (v.notes ? `<p style="margin:12px 0 0;color:#333"><strong>Notes:</strong> ${esc(v.notes).replace(/\n/g, '<br>')}</p>` : '') +
    '</div>' +
    `<p style="color:#666;font-size:12px;margin-top:14px">Keep this receipt for collection.` +
    (b.supportEmail ? ` Questions? Contact ${esc(b.supportEmail)}.` : '') + '</p>' +
    '</div></body></html>';
}

function renderText(view, brand) {
  const lines = (view.items || []).map((l) =>
    `- ${l.name} (${l.sku})${l.size ? ' size ' + l.size : ''}${l.printing ? ' print "' + l.printedName + '"' : ''} x${l.quantity}: ${inr(l.lineTotal)}`);
  return [
    `${brand.organisation} — Order receipt`,
    `Order ${view.orderId} · ${view.status}`,
    view.message,
    '',
    ...lines,
    '',
    `Total: ${inr(view.total)} ${view.currency || 'INR'}`,
    view.paymentId ? `Payment ID: ${view.paymentId}` : ''
  ].filter((x) => x !== undefined).join('\n');
}

/** POST https://api.resend.com/emails. Returns true on 2xx; never throws. */
async function sendReceiptEmail(record) {
  if (!emailEnabled() || !record || !record.email) return false;
  try {
    const { toOrderView } = require('./orders'); // lazy: orders.js requires this module too
    const brand = loadBrand();
    const view = toOrderView(record);
    // Uses the order view, so the phone number stays masked in the email too.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env('RESEND_API_KEY'),
          'Content-Type': 'application/json',
          'Idempotency-Key': 'receipt-' + String(record.orderId)
        },
        body: JSON.stringify({
          from: env('EMAIL_FROM'),
          to: [String(record.email)],
          subject: `${brand.organisation} order ${record.orderId} — payment received`,
          html: renderReceiptHtml(view, brand),
          text: renderText(view, brand),
          ...(brand.supportEmail ? { reply_to: brand.supportEmail } : {})
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      log('warn', 'resend_http_error', { orderId: record.orderId, status: res.status });
      return false;
    }
    return true;
  } catch (e) {
    log('warn', 'resend_network_error', { orderId: record && record.orderId, timedOut: Boolean(e && e.name === 'AbortError') });
    return false;
  }
}

module.exports = { emailEnabled, sendReceiptEmail, renderReceiptHtml };
