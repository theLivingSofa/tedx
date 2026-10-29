'use strict';
/*
 * POST /api/admin-password { currentPassword, newPassword } -> 200 { ok: true } + a fresh session cookie.
 * Needs the admin session and the current password. Stores only a salted scrypt hash (Config tab), which signs
 * every other device out. 5 attempts per 15 minutes per IP.
 */

const { HttpError, sendJson, readJsonBody, applyCors, allowMethods, log, withErrorHandling } = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const admin = require('../lib/admin');

module.exports = withErrorHandling(async (req, res) => {
  if (!admin.adminEnabled()) throw new HttpError(404, 'not_found', 'Not found.');
  if (applyCors(req, res, { methods: ['POST'] })) return;
  if (!allowMethods(req, res, ['POST'])) return;
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
});
