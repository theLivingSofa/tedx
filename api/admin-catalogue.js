'use strict';
/*
 * Organiser product editor.
 *   GET  /api/admin-catalogue                         -> { editable, products, invalidRows, sections }
 *   POST /api/admin-catalogue { action: 'create', product }
 *   POST /api/admin-catalogue { action: 'update', sku, product }   (the SKU itself cannot change)
 *   POST /api/admin-catalogue { action: 'delete', sku }
 * Needs the admin session. Writes go to the Catalogue tab; the store picks them up within about a minute.
 */

const { HttpError, sendJson, readJsonBody, applyCors, allowMethods, log, withErrorHandling } = require('../lib/http');
const { enforceRateLimit } = require('../lib/ratelimit');
const sheets = require('../lib/sheets');
const admin = require('../lib/admin');
const { validateProduct, SKU_RE } = require('../lib/admin-catalogue');
const brand = require('../public/config/brand.js');

function invalid(fields) {
  return new HttpError(400, 'validation_failed', 'Please fix the highlighted fields.', { fields });
}

module.exports = withErrorHandling(async (req, res) => {
  if (!admin.adminEnabled()) throw new HttpError(404, 'not_found', 'Not found.');
  if (applyCors(req, res, { methods: ['GET', 'POST'] })) return;
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  if (!enforceRateLimit(req, res, 'admin-catalogue', { limit: 60, windowMs: 60000 })) return;
  if (!admin.isAuthenticated(req)) throw new HttpError(401, 'unauthorized', 'Please sign in.');

  if (req.method === 'GET') {
    const data = await sheets.listCatalogueForAdmin();
    sendJson(res, 200, { ...data, sections: (brand.sections || []).map((s) => ({ id: s.id, label: s.label })) });
    return;
  }

  const body = await readJsonBody(req, { limit: 8192 });
  const action = body && body.action;
  if (action === 'delete') {
    const sku = typeof body.sku === 'string' ? body.sku.trim().toUpperCase() : '';
    if (!SKU_RE.test(sku)) throw invalid({ sku: 'Unknown SKU.' });
    await sheets.deleteCatalogueProduct(sku);
    log('info', 'admin_product_deleted', { sku });
    sendJson(res, 200, { deleted: sku });
    return;
  }
  if (action !== 'create' && action !== 'update') {
    throw new HttpError(400, 'invalid_request', 'action must be create, update or delete.');
  }
  const v = validateProduct(body.product);
  if (!v.ok) throw invalid(v.errors);
  if (action === 'update') {
    const sku = typeof body.sku === 'string' ? body.sku.trim().toUpperCase() : '';
    if (sku !== v.product.sku) throw invalid({ sku: 'The SKU cannot be changed. Add a new product instead.' });
  }
  const saved = await sheets.saveCatalogueProduct(v.product, { create: action === 'create' });
  log('info', action === 'create' ? 'admin_product_created' : 'admin_product_updated', { sku: saved.sku });
  sendJson(res, action === 'create' ? 201 : 200, { product: saved });
});
