'use strict';
/*
 * POST /api/admin-login { password } -> 200 { ok: true } + session cookie.
 * 404 when ADMIN_PASSWORD is not configured, 401 on a wrong password, 429 after 5 tries per 15 min per IP.
 */

const { HttpError, sendJson, readJsonBody, applyCors, allowMethods, log, withErrorHandling } = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const admin = require('../lib/admin');

module.exports = withErrorHandling(async (req, res) => {
  if (!admin.adminEnabled()) throw new HttpError(404, 'not_found', 'Not found.');
  if (applyCors(req, res, { methods: ['POST'] })) return;
  if (!allowMethods(req, res, ['POST'])) return;
  if (!enforceRateLimit(req, res, 'admin-login', { limit: 5, windowMs: 15 * 60000 })) return;

  const body = await readJsonBody(req, { limit: 2048 });
  const password = body && typeof body.password === 'string' ? body.password : '';
  if (!admin.checkPassword(password)) {
    log('warn', 'admin_login_failed', {});
    throw new HttpError(401, 'invalid_password', 'Wrong password.');
  }
  log('info', 'admin_login', {});
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': admin.sessionCookie(admin.createSession()) });
});
