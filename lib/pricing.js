'use strict';
/*
 * Server-side pricing — the single source of truth for what a customer pays (CONTRACT 4.1 + 6.4).
 * Owner: security-infra.
 *
 * All arithmetic is done in integer paise; rupee numbers are only produced at the edges via
 * fromPaise(). Client-supplied prices/totals are never an input here — only validated items
 * (lib/validate.js validateItems) and catalogue products.
 */

const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const HARD_MAX_QTY = 20;
const MAX_PRICE_PAISE = 100000 * 100;

/** Math.round(rupees * 100); throws on anything that is not a finite number. */
function toPaise(rupees) {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees)) {
    throw new TypeError('toPaise: amount must be a finite number');
  }
  const p = Math.round(rupees * 100);
  return p === 0 ? 0 : p; // no -0
}

/** paise / 100 */
function fromPaise(paise) {
  if (typeof paise !== 'number' || !Number.isFinite(paise)) {
    throw new TypeError('fromPaise: amount must be a finite number');
  }
  const r = Math.round(paise) / 100;
  return r === 0 ? 0 : r;
}

function groupIndian(intDigits) {
  // 1234567 -> 12,34,567 (last three digits, then groups of two)
  if (intDigits.length <= 3) return intDigits;
  const last3 = intDigits.slice(-3);
  let rest = intDigits.slice(0, -3);
  const groups = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) groups.unshift(rest);
  return `${groups.join(',')},${last3}`;
}

/** '₹1,630' (whole rupees, no decimals) / '₹12.50' / '₹1,00,000' (en-IN grouping). */
function formatINR(rupees) {
  const paise = toPaise(Number(rupees));
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const intPart = groupIndian(String(whole));
  return frac === 0 ? `${sign}₹${intPart}` : `${sign}₹${intPart}.${String(frac).padStart(2, '0')}`;
}

function toNumberOrNaN(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(v)) return Number(v);
  return NaN;
}

/** Rupee amounts equal to the paisa (numbers or plain numeric strings; anything else -> false). */
function amountsEqual(a, b) {
  const x = toNumberOrNaN(a);
  const y = toNumberOrNaN(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return toPaise(x) === toPaise(y);
}

/* ---------------------------------------------------------------- pricing */

function label(product, sku) {
  const name = product && typeof product.name === 'string' && product.name.trim() ? product.name.trim() : '';
  return name ? `${name} (${sku})` : sku;
}

const MESSAGES = {
  duplicate_sku: (p, sku) => `${sku} appears more than once in your order.`,
  unknown_sku: (p, sku) => `${sku} is not in the catalogue any more. Please remove it.`,
  inactive: (p, sku) => `${label(p, sku)} is not available right now. Please remove it.`,
  out_of_stock: (p, sku) => `${label(p, sku)} is out of stock. Please remove it.`,
  size_required: (p, sku) => `Choose a size for ${label(p, sku)}.`,
  size_not_applicable: (p, sku) => `${label(p, sku)} does not come in sizes.`,
  printing_not_available: (p, sku) => `Name printing is not available for ${label(p, sku)}.`,
  printed_name_required: (p, sku) => `Enter the name to print on ${label(p, sku)}.`,
  quantity_limit: (p, sku, max) => `You can order at most ${max} of ${label(p, sku)}.`,
  insufficient_stock: (p, sku, max, stock) =>
    `Only ${stock} of ${label(p, sku)} ${stock === 1 ? 'is' : 'are'} left. Please lower the quantity.`
};

function errorFor(index, sku, code, product, max, stock) {
  return { index, sku, code, message: MESSAGES[code](product, sku, max, stock) };
}

function priceIsValid(price) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return false;
  const p = toPaise(price);
  return p > 0 && p <= MAX_PRICE_PAISE;
}

function clampMaxQuantity(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return HARD_MAX_QTY;
  return Math.min(HARD_MAX_QTY, Math.max(1, Math.floor(n)));
}

/**
 * Prices validated items against the catalogue.
 * @param {Array<{sku,quantity,size,printing,printedName}>} items output of validateItems
 * @param {Array<object>} products catalogue products ({sku,name,price,category,apparel,printing,active,stock,…})
 * @param {{printingCharge?: number, maxQuantityPerSku?: number}} [opts]
 * @returns {{ok:true, lines:object[], subtotal:number, printingTotal:number, total:number, currency:'INR'}
 *          | {ok:false, errors:Array<{index,sku,code,message}>}}
 */
function priceOrder(items, products, { printingCharge = 0, maxQuantityPerSku = 20 } = {}) {
  if (!Array.isArray(items)) throw new TypeError('priceOrder: items must be an array');
  if (!Array.isArray(products)) throw new TypeError('priceOrder: products must be an array');
  if (typeof printingCharge !== 'number' || !Number.isFinite(printingCharge) || printingCharge < 0) {
    throw new TypeError('priceOrder: printingCharge must be a finite number >= 0');
  }
  const printingPaise = toPaise(printingCharge);
  const maxQty = clampMaxQuantity(maxQuantityPerSku);

  const catalogue = new Map();
  for (const p of products) {
    if (!p || typeof p !== 'object' || typeof p.sku !== 'string') continue;
    const key = p.sku.trim().toUpperCase();
    if (key && !catalogue.has(key)) catalogue.set(key, p); // first row wins on duplicates
  }

  const errors = [];
  const lines = [];
  const seen = new Set();
  let subtotalPaise = 0;
  let printingTotalPaise = 0;

  items.forEach((item, index) => {
    const sku = item && typeof item.sku === 'string' ? item.sku.trim().toUpperCase() : '';
    if (seen.has(sku)) {
      errors.push(errorFor(index, sku, 'duplicate_sku', null));
      return;
    }
    seen.add(sku);

    const product = catalogue.get(sku);
    if (!sku || !product) {
      errors.push(errorFor(index, sku, 'unknown_sku', null));
      return;
    }
    if (product.active === false || !priceIsValid(product.price)) {
      errors.push(errorFor(index, sku, 'inactive', product));
      return;
    }

    const hasStock = product.stock !== null && product.stock !== undefined && product.stock !== '';
    const stock = hasStock ? Number(product.stock) : Infinity;
    if (hasStock && (!Number.isFinite(stock) || stock <= 0)) {
      errors.push(errorFor(index, sku, 'out_of_stock', product));
      return;
    }

    const apparel = product.apparel === true;
    const size = typeof item.size === 'string' ? item.size.trim().toUpperCase() : '';
    if (apparel && !SIZES.includes(size)) {
      errors.push(errorFor(index, sku, 'size_required', product));
      return;
    }
    if (!apparel && size !== '') {
      errors.push(errorFor(index, sku, 'size_not_applicable', product));
      return;
    }

    const printing = item.printing === true;
    const printedName = printing && typeof item.printedName === 'string' ? item.printedName.trim() : '';
    if (printing && product.printing !== true) {
      errors.push(errorFor(index, sku, 'printing_not_available', product));
      return;
    }
    if (printing && printedName === '') {
      errors.push(errorFor(index, sku, 'printed_name_required', product));
      return;
    }

    const quantity = item.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > maxQty) {
      errors.push(errorFor(index, sku, 'quantity_limit', product, maxQty));
      return;
    }
    if (quantity > stock) {
      errors.push(errorFor(index, sku, 'insufficient_stock', product, maxQty, Math.floor(stock)));
      return;
    }

    const unitPaise = toPaise(product.price);
    const linePrintPaise = printing ? printingPaise : 0;
    const productPaise = quantity * unitPaise;
    const printPaise = quantity * linePrintPaise;
    subtotalPaise += productPaise;
    printingTotalPaise += printPaise;

    lines.push({
      sku,
      name: typeof product.name === 'string' ? product.name : sku,
      category: typeof product.category === 'string' ? product.category : '',
      size: apparel ? size : '',
      printing,
      printedName: printing ? printedName : '',
      quantity,
      unitPrice: fromPaise(unitPaise),
      printingCharge: fromPaise(linePrintPaise),
      lineTotal: fromPaise(productPaise + printPaise)
    });
  });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    lines,
    subtotal: fromPaise(subtotalPaise),
    printingTotal: fromPaise(printingTotalPaise),
    total: fromPaise(subtotalPaise + printingTotalPaise),
    currency: 'INR'
  };
}

/** The Orders `Items` column: `HOD-001 Hoodie (M, print: "ASHA") ×2; MUG-001 White Ceramic Mug ×1`. */
function summariseItems(lines) {
  if (!Array.isArray(lines)) return '';
  return lines
    .filter((l) => l && typeof l === 'object')
    .map((l) => {
      const details = [];
      if (l.size) details.push(String(l.size));
      if (l.printing && l.printedName) details.push(`print: "${l.printedName}"`);
      const head = [l.sku, l.name].filter((s) => s !== undefined && s !== null && s !== '').join(' ');
      return `${head}${details.length ? ` (${details.join(', ')})` : ''} ×${l.quantity}`;
    })
    .join('; ');
}

module.exports = {
  toPaise,
  fromPaise,
  formatINR,
  amountsEqual,
  priceOrder,
  summariseItems
};
