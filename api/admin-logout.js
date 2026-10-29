'use strict';
/* POST /api/admin-logout -> clears the session cookie. */

const { HttpError, sendJson, applyCors, allowMethods, withErrorHandling } = require('../lib/http');
const admin = require('../lib/admin');

module.exports = withErrorHandling(async (req, res) => {
  if (!admin.adminEnabled()) throw new HttpError(404, 'not_found', 'Not found.');
  if (applyCors(req, res, { methods: ['POST'] })) return;
  if (!allowMethods(req, res, ['POST'])) return;
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': admin.clearedCookie() });
});
