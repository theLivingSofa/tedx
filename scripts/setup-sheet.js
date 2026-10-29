#!/usr/bin/env node
'use strict';
/*
 * npm run setup-sheet [-- --dry-run]
 *
 * Prepares the Google Sheet used by the store (CONTRACT 4.3):
 *   - creates the tabs Catalogue, Orders and Config if they are missing,
 *   - writes the header row where row 1 is empty and freezes row 1,
 *   - seeds Catalogue from data/products.json and Config with defaults ONLY when those tabs have no data rows.
 * Existing data is never overwritten, so running it again is safe (idempotent).
 *
 * Reads GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY (and optional PRINTING_CHARGE) from the
 * environment, after loading .env.local and then .env if present (existing env vars win).
 *
 * --dry-run  prints what would be done and writes nothing. Works without credentials (prints the generic plan);
 *            with credentials it inspects the sheet read-only and prints the exact actions.
 * Owner: sheets-catalogue.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------------------------------------
// Tiny .env parser (no dependency)
// ---------------------------------------------------------------------------------------------------------

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return false;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    let value = m[2];
    if (/^"/.test(value)) {
      const end = value.lastIndexOf('"');
      value = value.slice(1, end > 0 ? end : undefined).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (/^'/.test(value)) {
      const end = value.lastIndexOf("'");
      value = value.slice(1, end > 0 ? end : undefined);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: npm run setup-sheet [-- --dry-run]\n\nCreates/prepares the Catalogue, Orders and Config tabs. Never overwrites existing data.');
  process.exit(0);
}
const unknown = args.filter((a) => a !== '--dry-run');
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(' ')}\nUsage: npm run setup-sheet [-- --dry-run]`);
  process.exit(2);
}
const DRY_RUN = args.includes('--dry-run');

const loaded = ['.env.local', '.env'].filter((f) => loadEnvFile(path.join(ROOT, f)));

const { ORDER_HEADERS, CATALOGUE_HEADERS, CONFIG_HEADERS, sanitizeCell } = require('../lib/sheets.js');

const products = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'products.json'), 'utf8')).products;

function defaultPrintingCharge() {
  const n = Number(String(process.env.PRINTING_CHARGE || '').trim() || 0);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}

const cell = (v) => (typeof v === 'string' ? sanitizeCell(v) : v);

const TABS = [
  {
    title: 'Catalogue',
    headers: CATALOGUE_HEADERS.slice(),
    lastCol: 'I',
    seed: () =>
      products.map((p) =>
        [p.sku, p.name, p.price, p.category || '', !!p.apparel, !!p.printing, p.imageUrl || '',
          p.active !== false, p.stock === null || p.stock === undefined ? '' : p.stock].map(cell)
      ),
    seedLabel: () => `${products.length} products from data/products.json`
  },
  {
    title: 'Orders',
    headers: ORDER_HEADERS.slice(),
    lastCol: 'Y',
    seed: null
  },
  {
    title: 'Config',
    headers: CONFIG_HEADERS.slice(),
    lastCol: 'B',
    seed: () => [
      ['PRINTING_CHARGE', defaultPrintingCharge()],
      ['STORE_OPEN', true],
      ['MAX_QUANTITY_PER_SKU', 20]
    ],
    seedLabel: () => `defaults PRINTING_CHARGE=${defaultPrintingCharge()}, STORE_OPEN=TRUE, MAX_QUANTITY_PER_SKU=20`
  }
];

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const rowBlank = (row) => !row || row.every(blank);

// ---------------------------------------------------------------------------------------------------------
// Google client
// ---------------------------------------------------------------------------------------------------------

function hasCredentials() {
  const e = process.env;
  return Boolean(e.GOOGLE_SHEET_ID && e.GOOGLE_SERVICE_ACCOUNT_EMAIL && e.GOOGLE_PRIVATE_KEY);
}

function makeClient() {
  const { sheets, auth } = require('@googleapis/sheets');
  let key = String(process.env.GOOGLE_PRIVATE_KEY).trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
  key = key.replace(/\\r/g, '').replace(/\\n/g, '\n');
  const jwt = new auth.JWT({
    email: String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL).trim(),
    key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return sheets({ version: 'v4', auth: jwt, retry: false, timeout: 20000 });
}

async function retry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err.response && err.response.status) || err.status;
      const transient = [429, 500, 502, 503, 504].includes(status) ||
        (!status && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|TimeoutError|fetch failed/.test(`${err.code} ${err.message}`));
      if (!transient || attempt >= 5) throw err;
      const delay = 500 * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);
      console.log(`  …transient error (${status || err.code}), retrying in ${Math.round(delay)} ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function explain(err) {
  const status = (err.response && err.response.status) || err.status;
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const msg = String(err.message || err);
  if (status === 403) {
    return `Permission denied. Open the spreadsheet → Share → add ${sa} as Editor, then run this again.`;
  }
  if (status === 404) return 'Spreadsheet not found. Check GOOGLE_SHEET_ID (the long id between /d/ and /edit in the sheet URL).';
  if (/invalid_grant|DECODER|PEM|private key|asn1|unsupported/i.test(msg)) {
    return 'Could not authenticate. Check GOOGLE_PRIVATE_KEY (the full "-----BEGIN PRIVATE KEY----- … -----END PRIVATE KEY-----" ' +
      'value from the JSON key file; literal \\n sequences are fine) and GOOGLE_SERVICE_ACCOUNT_EMAIL.';
  }
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) {
    return 'The Google Sheets API is not enabled for the service account\'s Cloud project. Enable it in Google Cloud Console → APIs & Services.';
  }
  return `Google Sheets error${status ? ` (${status})` : ''}: ${msg.slice(0, 300)}`;
}

// ---------------------------------------------------------------------------------------------------------
// Plan + apply
// ---------------------------------------------------------------------------------------------------------

/** Inspect the spreadsheet (read-only) and work out what to do for each tab. */
const ORDERS_PROTECTION = 'Written by the merch store. Do not sort, insert or delete rows here; use Data > Filter views or a separate tab with =SORT(Orders!A:Y).';

async function inspect(client, spreadsheetId) {
  const meta = await retry(() =>
    client.spreadsheets.get({
      spreadsheetId,
      fields: 'properties.title,sheets.properties(sheetId,title,gridProperties.frozenRowCount),sheets.protectedRanges.description'
    })
  );
  const sheetsMeta = (meta.data.sheets || []).map((s) => ({
    ...s.properties,
    protectedDescriptions: (s.protectedRanges || []).map((r) => r.description || '')
  }));
  const plan = { title: meta.data.properties && meta.data.properties.title, tabs: [] };

  for (const tab of TABS) {
    const props = sheetsMeta.find((p) => p.title === tab.title) ||
      sheetsMeta.find((p) => String(p.title).toLowerCase() === tab.title.toLowerCase());
    const t = { tab, exists: !!props, actualTitle: props ? props.title : tab.title, sheetId: props ? props.sheetId : null,
      writeHeader: false, freeze: false, seed: false, warnings: [], errors: [],
      protect: tab.title === 'Orders' && !(props && props.protectedDescriptions.includes(ORDERS_PROTECTION)) };
    if (props && props.title !== tab.title) {
      t.warnings.push(`Tab is named "${props.title}"; rename it to exactly "${tab.title}".`);
    }
    if (!props) {
      t.writeHeader = true;
      t.freeze = true;
      t.seed = !!tab.seed;
    } else {
      const frozen = (props.gridProperties && props.gridProperties.frozenRowCount) || 0;
      t.freeze = frozen < 1;
      const range = tab.seed ? `'${props.title}'!A:${tab.lastCol}` : `'${props.title}'!A1:${tab.lastCol}1`;
      const res = await retry(() => client.spreadsheets.values.get({ spreadsheetId, range }));
      const rows = res.data.values || [];
      const header = rows[0] || [];
      const hasData = rows.slice(1).some((r) => !rowBlank(r));
      if (rowBlank(header) && tab.seed && hasData) {
        // Guessing the column order of existing data could mislabel it — leave it to a human.
        t.errors.push(`Row 1 is empty but the tab has data. Add this header row by hand, matching your columns: ${tab.headers.join(' | ')}`);
      } else if (rowBlank(header)) {
        t.writeHeader = true;
      } else {
        checkHeader(tab, header, t);
      }
      t.seed = !!tab.seed && !hasData && (t.writeHeader || t.errors.length === 0);
      if (tab.seed && hasData) t.skippedSeed = true;
    }
    plan.tabs.push(t);
  }
  return plan;
}

function checkHeader(tab, header, t) {
  const norm = (h) => String(h == null ? '' : h).trim().toLowerCase();
  if (tab.title === 'Orders') {
    const mismatch = tab.headers.findIndex((h, i) => norm(header[i]) !== h.toLowerCase());
    if (mismatch !== -1) {
      t.errors.push(`Orders header mismatch at column ${String.fromCharCode(65 + mismatch)}: expected "${tab.headers[mismatch]}", ` +
        `found "${header[mismatch] == null ? '' : header[mismatch]}". The app reads Orders by position — restore the ` +
        `columns in this exact order: ${tab.headers.join(' | ')}`);
    }
  } else if (tab.title === 'Catalogue') {
    const have = header.map((h) => norm(h).replace(/[\s_-]+/g, ''));
    const missing = tab.headers.filter((h) => !have.includes(h.toLowerCase()));
    const required = missing.filter((h) => ['sku', 'name', 'price'].includes(h));
    if (required.length) t.errors.push(`Catalogue is missing required column(s): ${required.join(', ')}.`);
    const optional = missing.filter((h) => !required.includes(h));
    if (optional.length) t.warnings.push(`Catalogue has no column(s) ${optional.join(', ')} (defaults will be used).`);
  } else if (norm(header[0]) !== 'key' || norm(header[1]) !== 'value') {
    t.warnings.push('Config row 1 should be "key | value".');
  }
}

function describe(plan, { offline }) {
  const lines = [];
  for (const t of plan.tabs) {
    const { tab } = t;
    const acts = [];
    if (!t.exists) acts.push('create tab');
    if (t.writeHeader) acts.push(`write header row (${tab.headers.length} columns)`);
    if (t.freeze) acts.push('freeze row 1');
    if (t.seed) acts.push(`seed ${tab.seedLabel()}`);
    if (t.skippedSeed) acts.push('already has data — leaving it untouched');
    if (t.protect) acts.push('add an edit warning (do not sort/insert rows)');
    if (offline) {
      acts.length = 0;
      acts.push('create tab if missing', 'write header row if row 1 is empty', 'freeze row 1');
      if (tab.title === 'Orders') acts.push('add an edit warning (do not sort/insert rows)');
      if (tab.seed) acts.push(`seed ${tab.seedLabel()} only if the tab has no data rows`);
    }
    lines.push(`  ${tab.title.padEnd(9)} ${acts.length ? acts.join('; ') : 'nothing to do'}`);
    for (const w of t.warnings) lines.push(`            ! ${w}`);
    for (const e of t.errors) lines.push(`            ✗ ${e}`);
  }
  return lines.join('\n');
}

async function apply(client, spreadsheetId, plan) {
  // 1) Create missing tabs (with row 1 frozen).
  const add = plan.tabs.filter((t) => !t.exists).map((t) => ({
    addSheet: {
      properties: {
        title: t.tab.title,
        gridProperties: { frozenRowCount: 1, columnCount: Math.max(26, t.tab.headers.length) }
      }
    }
  }));
  if (add.length) {
    const res = await retry(() => client.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: add } }));
    const replies = res.data.replies || [];
    replies.forEach((r) => {
      const props = r.addSheet && r.addSheet.properties;
      const t = props && plan.tabs.find((x) => x.tab.title === props.title);
      if (t) {
        t.sheetId = props.sheetId;
        t.exists = true;
        t.freeze = false;
      }
    });
  }

  // 2) Headers + seed rows (values only into empty areas).
  const data = [];
  for (const t of plan.tabs) {
    const title = t.actualTitle;
    const last = t.tab.lastCol;
    if (t.writeHeader) data.push({ range: `'${title}'!A1:${last}1`, values: [t.tab.headers] });
    if (t.seed) {
      const rows = t.tab.seed();
      data.push({ range: `'${title}'!A2:${last}${rows.length + 1}`, values: rows });
    }
  }
  if (data.length) {
    await retry(() => client.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: 'RAW', data }
    }));
  }

  // 3) Freeze row 1 where needed, bold freshly written header rows.
  const fmt = [];
  for (const t of plan.tabs) {
    if (t.sheetId === null || t.sheetId === undefined) continue;
    if (t.freeze) {
      fmt.push({
        updateSheetProperties: {
          properties: { sheetId: t.sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount'
        }
      });
    }
    if (t.writeHeader) {
      fmt.push({
        repeatCell: {
          range: { sheetId: t.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: t.tab.headers.length },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold'
        }
      });
    }
  }
  for (const t of plan.tabs) {
    if (t.protect && t.sheetId !== null && t.sheetId !== undefined) {
      // Warning-only protection: anyone editing the Orders tab by hand (sorting, inserting rows) is warned
      // first. The store writes rows by position, so sorting while an order is being updated can corrupt rows.
      fmt.push({ addProtectedRange: { protectedRange: { range: { sheetId: t.sheetId }, description: ORDERS_PROTECTION, warningOnly: true } } });
    }
  }
  if (fmt.length) {
    await retry(() => client.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: fmt } }));
  }
}

function nextSteps() {
  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '<service-account-email>';
  return [
    'Next steps:',
    `  1. Make sure the spreadsheet is shared with ${sa} as Editor.`,
    '  2. Add GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY to your Vercel project',
    '     (Settings → Environment Variables, Production + Preview). Paste the private key as-is; literal \\n is fine.',
    '  3. Redeploy, then open /api/catalogue — it should show "source": "sheet".',
    '  4. Edit products in the Catalogue tab (sku, name, price, category, apparel, printing, imageUrl, active, stock).',
    '     Blank stock = unlimited, 0 = sold out, active FALSE hides a product. Changes appear within about a minute.',
    '  5. Config tab: PRINTING_CHARGE (₹ per printed item), STORE_OPEN (TRUE/FALSE), MAX_QUANTITY_PER_SKU (1–20).',
    '  6. Do not rename, reorder or insert columns in the Orders tab, and do not sort or insert/delete rows there:',
    '     the app writes rows by position. To view orders sorted, use Data → Filter views (they do not move rows)',
    '     or a separate tab containing =SORT(Orders!A:Y, 2, FALSE). The Orders tab now shows a warning when edited.'
  ].join('\n');
}

async function main() {
  console.log(`Merch store — Google Sheet setup${DRY_RUN ? ' (dry run: nothing will be written)' : ''}`);
  if (loaded.length) console.log(`Loaded env from ${loaded.join(', ')}`);

  if (!hasCredentials()) {
    if (!DRY_RUN) {
      console.error('\nMissing GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL and/or GOOGLE_PRIVATE_KEY.\n' +
        'Set them in .env.local (see .env.example) or your shell, or run with --dry-run to preview.');
      process.exitCode = 1;
      return;
    }
    console.log('\nNo Google credentials found — showing the generic plan:\n');
    const plan = { tabs: TABS.map((tab) => ({ tab, warnings: [], errors: [] })) };
    console.log(describe(plan, { offline: true }));
    console.log('\nHeaders:');
    for (const tab of TABS) console.log(`  ${tab.title}: ${tab.headers.join(' | ')}`);
    console.log(`\n${nextSteps()}`);
    return;
  }

  const spreadsheetId = process.env.GOOGLE_SHEET_ID.trim();
  let client;
  try {
    client = makeClient();
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      console.error('The @googleapis/sheets package is not installed. Run `npm install` first.');
    } else {
      console.error(explain(err));
    }
    process.exitCode = 1;
    return;
  }

  let plan;
  try {
    plan = await inspect(client, spreadsheetId);
  } catch (err) {
    console.error(`\n${explain(err)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nSpreadsheet: ${plan.title || '(untitled)'}\n`);
  console.log(describe(plan, { offline: false }));
  const errors = plan.tabs.reduce((n, t) => n + t.errors.length, 0);

  if (DRY_RUN) {
    console.log('\nDry run — no changes made.');
  } else {
    try {
      await apply(client, spreadsheetId, plan);
      console.log('\nDone. Existing data was left untouched.');
    } catch (err) {
      console.error(`\n${explain(err)}`);
      process.exitCode = 1;
      return;
    }
  }
  if (errors) {
    console.error(`\n${errors} problem(s) need fixing by hand (marked ✗ above).`);
    process.exitCode = 1;
  }
  console.log(`\n${nextSteps()}`);
}

main().catch((err) => {
  console.error(`Unexpected error: ${String((err && err.message) || err).slice(0, 300)}`);
  process.exitCode = 1;
});
