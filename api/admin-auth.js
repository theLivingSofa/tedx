'use strict';
/*
 * Admin sign-in, sign-out and password change in ONE serverless function (the Vercel Hobby plan allows at
 * most 12 functions per deployment).
 *
 *   POST /api/admin-auth?op=login     { password }                        -> { ok } + session cookie
 *   POST /api/admin-auth?op=logout                                         -> { ok } + cleared cookie
 *   POST /api/admin-auth?op=password  { currentPassword, newPassword }     -> { ok } + fresh session cookie
 *
 * 404 when ADMIN_PASSWORD is not configured. Login and password change: 5 attempts per 15 min per IP.
 * The password is the one set on /admin (stored as a hash in the Sheet) or, if none was set, ADMIN_PASSWORD.
 */

const { HttpError, sendJson, readJsonBody, applyCors, allowMethods, getQuery, log, withErrorHandling } = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const admin = require('../lib/admin');

async function login(req, res) {
  if (!enforceRateLimit(req, res, 'admin-login', { limit: 5, windowMs: 15 * 60000 })) return;
  const body = await readJsonBody(req, { limit: 2048 });
  const password = body && typeof body.password === 'string' ? body.password : '';
  const session = await admin.login(password);
  if (!session) {
    log('warn', 'admin_login_failed', {});
    throw new HttpError(401, 'invalid_password', 'Wrong password.');
  }
  log('info', 'admin_login', {});
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': admin.sessionCookie(session) });
}

function logout(req, res) {
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': admin.clearedCookie() });
}

async function changePassword(req, res) {
  if (!enforceRateLimit(req, res, 'admin-password', { limit: 5, windowMs: 15 * 60000 })) return;
  if (!(await admin.isAuthenticated(req))) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  const body = await readJsonBody(req, { limit: 2048 });
  const current = body && typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const next = body && typeof body.newPassword === 'string' ? body.newPassword : '';
  const result = await admin.changePassword(current, next);
  if (!result.ok) {
    if (result.field === 'currentPassword') log('warn', 'admin_password_change_rejected', {});
    throw new HttpError(400, 'validation_failed', result.message, { fields: { [result.field]: result.message } });
  }
  log('info', 'admin_password_changed', {});
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': admin.sessionCookie(result.session) });
}

const OPS = { login, logout, password: changePassword };

module.exports = withErrorHandling(async (req, res) => {
  if (!admin.adminEnabled()) throw new HttpError(404, 'not_found', 'Not found.');
  if (applyCors(req, res, { methods: ['POST'] })) return;
  if (!allowMethods(req, res, ['POST'])) return;
  const q = getQuery(req) || {};
  const op = typeof q.get === 'function' ? q.get('op') : q.op;
  const handler = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
  if (!handler) throw new HttpError(404, 'not_found', 'Not found.');
  await handler(req, res);
});
