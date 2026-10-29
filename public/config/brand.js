/*
 * Brand configuration — the ONE file to edit to rebrand the store.
 * Served to browsers at /config/brand.js (sets window.BRAND) and also
 * require()-able from Node (receipt emails, Cashfree order notes).
 * Owner: orchestrator (see docs/CONTRACT.md). Text only — never put secrets here.
 */
(function (root, factory) {
  var brand = factory();
  if (typeof module === 'object' && module.exports) module.exports = brand;
  else root.BRAND = brand;
})(typeof self !== 'undefined' ? self : this, function () {
  return Object.freeze({
    // Short mark shown in red (hero brand mark + vertical side-nav label).
    mark: 'TEDx',
    // Browser tab title and receipt title.
    pageTitle: 'Merch Store – TEDxIIMRohtak',
    // Hero heading.
    heading: 'IIM Rohtak Merchandise',
    // Hero intro paragraph.
    intro: 'Many Voices, One Future. Select your products, sizes and optional name printing. ' +
      'Product SKUs are shown for accurate order tracking; your total updates automatically.',
    // Organisation name used on receipts and in emails.
    organisation: 'TEDxIIMRohtak',
    // Prefix for order IDs (letters/digits only, max 8 chars), e.g. TEDX-20261029-K3F9QZ.
    orderIdPrefix: 'TEDX',
    // Receipt file name prefix: <prefix>_<orderId>.html
    receiptFilePrefix: 'TEDxIIMR_Order_Receipt',
    // Contact shown on receipts / help text.
    supportEmail: 'merch@example.com',
    // Catalogue sections, in display order. `id` must match the Catalogue `category` value.
    sections: [
      { id: 'Winter', label: 'Winter', navLabel: 'Winter', icon: '❄' },
      { id: 'Summer', label: 'Summer', navLabel: 'Summer', icon: '☀' },
      { id: 'Accessories', label: 'Accessories', navLabel: 'Access.', icon: '✦' }
    ],
    // Shown under the catalogue.
    imageDisclaimer: 'All product images and designs are for illustrative purposes only. Actual products may ' +
      'vary slightly from the illustrations in colour, appearance, print placement, material, and other design details.'
  });
});
