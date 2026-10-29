#!/usr/bin/env node
'use strict';
/*
 * npm run setup-dashboard [-- --dry-run]
 *
 * Adds three organiser tabs to the order Sheet, all driven by formulas from the Orders tab:
 *   Dashboard    paid orders, money collected, items sold, handover progress, quantities per product and size
 *   Handover     one row per order (same row as in Orders) with a "Handed over" checkbox (J) and a note (K);
 *                the /admin page reads and writes the same two columns
 *   Order Lines  one row per item of every paid order (size, printed name, quantity) for the vendor
 * Safe to run again: formulas are rewritten, formatting and protections are only added to newly created tabs,
 * and ticks/notes in Handover!J:K are never touched. Reads .env.local / .env like setup-sheet.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return false; }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if (/^"/.test(value)) { const end = value.lastIndexOf('"'); value = value.slice(1, end > 0 ? end : undefined).replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
    else if (/^'/.test(value)) { const end = value.lastIndexOf("'"); value = value.slice(1, end > 0 ? end : undefined); }
    else value = value.replace(/\s+#.*$/, '').trim();
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
if (args.some((a) => a !== '--dry-run')) {
  console.error('Usage: npm run setup-dashboard [-- --dry-run]');
  process.exit(2);
}
['.env.local', '.env'].forEach((f) => loadEnvFile(path.join(ROOT, f)));

const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'One size'];
const col = (n) => String.fromCharCode(64 + n);

const LINES = `=LET(inc,Dashboard!$C$4,ids,Orders!A2:A,st,Orders!D2:D,fl,Orders!Y2:Y,js,Orders!J2:J,
keep,IFERROR(FILTER(SEQUENCE(ROWS(ids)),st="Paid",js<>"",(inc=TRUE)+NOT(REGEXMATCH(fl&"","TEST_PAYMENT"))),""),
res,REDUCE("",keep,LAMBDA(acc,i,IF(i="",acc,LET(ch,TOCOL(SPLIT(INDEX(js,i),"}",FALSE,TRUE),3),itm,FILTER(ch,REGEXMATCH(ch,"""sku""")),
tx,LAMBDA(p,MAP(itm,LAMBDA(c,IFERROR(REGEXEXTRACT(c,p),"")))),
nm,LAMBDA(p,MAP(itm,LAMBDA(c,IFERROR(VALUE(REGEXEXTRACT(c,p)),0)))),
VSTACK(acc,HSTACK(MAP(itm,LAMBDA(c,INDEX(ids,i))),tx("""sku"":""([^""]*)"""),tx("""name"":""([^""]*)"""),
MAP(itm,LAMBDA(c,LET(z,IFERROR(REGEXEXTRACT(c,"""size"":""([^""]*)"""),""),IF(z="","One size",z)))),
MAP(itm,LAMBDA(c,REGEXMATCH(c,"""printing"":true"))),tx("""printedName"":""([^""]*)"""),
nm("""quantity"":(\\d+)"),nm("""lineTotal"":([\\d.]+)"))))))),
out,IFNA(res,""),IFERROR(FILTER(out,INDEX(out,,1)<>""),""))`.replace(/\n/g, '');

const NOT_TEST = 'Orders!Y2:Y,"<>*TEST_PAYMENT*"';
const metric = (label, real, all, fmt) => ({ label, f: `=IF($C$4,${all},${real})`, fmt });
const METRICS = [
  metric('Paid orders', `COUNTIFS(Orders!D2:D,"Paid",${NOT_TEST})`, 'COUNTIF(Orders!D2:D,"Paid")'),
  metric('Money collected', `SUMIFS(Orders!M2:M,Orders!D2:D,"Paid",${NOT_TEST})`, 'SUMIFS(Orders!M2:M,Orders!D2:D,"Paid")', 'money'),
  { label: 'Items sold', f: '=IFERROR(SUM(\'Order Lines\'!G2:G),0)' },
  { label: 'Items with name printing', f: '=IFERROR(SUMIFS(\'Order Lines\'!G2:G,\'Order Lines\'!E2:E,TRUE),0)' },
  metric('Orders handed over', 'COUNTIFS(Handover!J2:J,TRUE,Handover!B2:B,"Paid",Handover!I2:I,FALSE)', 'COUNTIFS(Handover!J2:J,TRUE,Handover!B2:B,"Paid")'),
  { label: 'Still to hand over', f: '=C6-C10' },
  metric('Awaiting payment', `COUNTIFS(Orders!D2:D,"Awaiting Payment",${NOT_TEST})`, 'COUNTIF(Orders!D2:D,"Awaiting Payment")'),
  metric('Failed / expired', `COUNTIFS(Orders!D2:D,"Failed",${NOT_TEST})+COUNTIFS(Orders!D2:D,"Expired",${NOT_TEST})`, 'COUNTIF(Orders!D2:D,"Failed")+COUNTIF(Orders!D2:D,"Expired")'),
  { label: 'Orders to check (Review Flag set)', f: '=COUNTIFS(Orders!A2:A,"<>",Orders!Y2:Y,"<>",Orders!Y2:Y,"<>TEST_PAYMENT_SANDBOX",Orders!Y2:Y,"<>TEST_PAYMENT_MOCK")' },
];
const T0 = 17; // product table header row

async function main() {
  const { GOOGLE_SHEET_ID: id, GOOGLE_SERVICE_ACCOUNT_EMAIL: email, GOOGLE_PRIVATE_KEY: key } = process.env;
  if (DRY) {
    console.log('Dry run: would create (if missing) the Dashboard, Handover and Order Lines tabs and (re)write their formulas.');
    return;
  }
  if (!id || !email || !key) {
    console.error('Missing GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY (see .env.example).');
    process.exit(1);
  }
  const { sheets, auth } = require('@googleapis/sheets');
  const a = new auth.JWT({ email, key: key.replace(/\\n/g, '\n'), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const s = sheets({ version: 'v4', auth: a });

  const meta = await s.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties' });
  const byTitle = Object.fromEntries(meta.data.sheets.map((x) => [x.properties.title, x.properties.sheetId]));
  if (byTitle.Orders === undefined) {
    console.error('The Orders tab is missing. Run npm run setup-sheet first.');
    process.exit(1);
  }
  const created = new Set();
  const reqs = [];
  if (byTitle.Dashboard === undefined) {
    // Reuse an empty default "Sheet1" tab if there is one, otherwise add a new tab.
    let sheet1Empty = false;
    if (byTitle.Sheet1 !== undefined) {
      const v = await s.spreadsheets.values.get({ spreadsheetId: id, range: 'Sheet1!A1:Z50' });
      sheet1Empty = !(v.data.values && v.data.values.length);
    }
    reqs.push(sheet1Empty
      ? { updateSheetProperties: { properties: { sheetId: byTitle.Sheet1, title: 'Dashboard', index: 0 }, fields: 'title,index' } }
      : { addSheet: { properties: { title: 'Dashboard', index: 0 } } });
    created.add('Dashboard');
  }
  if (byTitle.Handover === undefined) { reqs.push({ addSheet: { properties: { title: 'Handover', index: 1 } } }); created.add('Handover'); }
  if (byTitle['Order Lines'] === undefined) { reqs.push({ addSheet: { properties: { title: 'Order Lines', index: 2 } } }); created.add('Order Lines'); }
  if (reqs.length) await s.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: reqs } });
  const m2 = await s.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties' });
  const sid = Object.fromEntries(m2.data.sheets.map((x) => [x.properties.title, x.properties.sheetId]));

  const data = [];
  // Order Lines
  data.push({ range: "'Order Lines'!A1:H1", values: [['Order ID', 'SKU', 'Product', 'Size', 'Name printing', 'Printed name', 'Qty', 'Line total (₹)']] });
  data.push({ range: "'Order Lines'!A2", values: [[LINES]] });
  // Handover
  const hv = (src) => `=ARRAYFORMULA(IF(Orders!A2:A="",,${src}))`;
  data.push({ range: 'Handover!A1:K1', values: [['Order ID', 'Status', 'Name', 'Roll number', 'Phone', 'Items', 'Total (₹)', 'Paid at', 'Test payment?', 'Handed over ✓', 'Handed over on / by / notes']] });
  data.push({ range: 'Handover!A2:I2', values: [[hv('Orders!A2:A'), hv('Orders!D2:D'), hv('Orders!E2:E'), hv('Orders!F2:F'), hv('Orders!H2:H'), hv('Orders!I2:I'), hv('Orders!M2:M'), hv('Orders!V2:V'), hv('REGEXMATCH(Orders!Y2:Y&"","TEST_PAYMENT")')]] });
  // Dashboard
  data.push({ range: 'Dashboard!A1:A2', values: [['TEDxIIMRohtak Merch – Dashboard'], ['Updates by itself from the Orders tab. Only tick the box below and the "Handed over" column in Handover; everything else is formulas.']] });
  data.push({ range: 'Dashboard!A4', values: [['Include test (sandbox) payments?']] });
  data.push({ range: 'Dashboard!A6:C' + (5 + METRICS.length), values: METRICS.map((x) => [x.label, '', x.f]) });
  data.push({ range: `Dashboard!A${T0 - 1}`, values: [['Quantities to order from the vendor (paid orders only)']] });
  data.push({ range: `Dashboard!A${T0}:${col(4 + SIZES.length + 1)}${T0}`, values: [['SKU', 'Product', ...SIZES, 'Total qty', 'With name printing', 'Revenue (₹)']] });
  const r1 = T0 + 1, L = "'Order Lines'!";
  const sizeF = SIZES.map((sz, k) => `=MAP($A${r1}:$A,LAMBDA(k,IF(k="",,SUMIFS(${L}$G$2:$G,${L}$B$2:$B,k,${L}$D$2:$D,${col(3 + k)}$${T0}))))`);
  data.push({ range: `Dashboard!A${r1}:${col(2 + SIZES.length + 3)}${r1}`, values: [[
    '=FILTER(Catalogue!A2:B,Catalogue!A2:A<>"")', '', ...sizeF,
    `=MAP($A${r1}:$A,LAMBDA(k,IF(k="",,SUMIFS(${L}$G$2:$G,${L}$B$2:$B,k))))`,
    `=MAP($A${r1}:$A,LAMBDA(k,IF(k="",,SUMIFS(${L}$G$2:$G,${L}$B$2:$B,k,${L}$E$2:$E,TRUE))))`,
    `=MAP($A${r1}:$A,LAMBDA(k,IF(k="",,SUMIFS(${L}$H$2:$H,${L}$B$2:$B,k))))`]] });
  await s.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: 'USER_ENTERED', data } });

  const D = sid.Dashboard, H = sid.Handover, OL = sid['Order Lines'];
  const lastCol = 2 + SIZES.length + 3; // M
  const bold = (sheetId, r0, r1_, c0, c1, extra = {}) => ({ repeatCell: { range: { sheetId, startRowIndex: r0, endRowIndex: r1_, startColumnIndex: c0, endColumnIndex: c1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, ...extra } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } });
  const money = (sheetId, r0, r1_, c0, c1) => ({ repeatCell: { range: { sheetId, startRowIndex: r0, endRowIndex: r1_, startColumnIndex: c0, endColumnIndex: c1 }, cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"₹"#,##0' } } }, fields: 'userEnteredFormat.numberFormat' } });
  const checkbox = (sheetId, r0, r1_, c0, c1) => ({ setDataValidation: { range: { sheetId, startRowIndex: r0, endRowIndex: r1_, startColumnIndex: c0, endColumnIndex: c1 }, rule: { condition: { type: 'BOOLEAN' }, showCustomUi: true } } });
  const grey = { red: 0.95, green: 0.95, blue: 0.95 };
  const requests = [
    { repeatCell: { range: { sheetId: D, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 16 } } }, fields: 'userEnteredFormat.textFormat' } },
    bold(D, 3, 4, 0, 1), bold(D, T0 - 2, T0 - 1, 0, 1), bold(D, T0 - 1, T0, 0, lastCol, { backgroundColor: grey }),
    bold(D, 5, 5 + METRICS.length, 2, 3),
    money(D, 6, 7, 2, 3), money(D, T0, 200, lastCol - 1, lastCol),
    checkbox(D, 3, 4, 2, 3),
    bold(H, 0, 1, 0, 11, { backgroundColor: grey }), money(H, 1, 3000, 6, 7), checkbox(H, 1, 3000, 9, 10),
    bold(OL, 0, 1, 0, 8, { backgroundColor: grey }), money(OL, 1, 5000, 7, 8),
    { updateSheetProperties: { properties: { sheetId: H, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { updateSheetProperties: { properties: { sheetId: OL, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { updateDimensionProperties: { range: { sheetId: D, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 230 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: D, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 190 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: H, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 }, properties: { pixelSize: 320 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: H, dimension: 'COLUMNS', startIndex: 10, endIndex: 11 }, properties: { pixelSize: 260 }, fields: 'pixelSize' } },
    // grey out rows that are not real paid orders in Handover
    { addConditionalFormatRule: { index: 0, rule: { ranges: [{ sheetId: H, startRowIndex: 1, endRowIndex: 3000, startColumnIndex: 0, endColumnIndex: 11 }], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=AND($A2<>"",OR($B2<>"Paid",$I2=TRUE))' }] }, format: { textFormat: { foregroundColor: { red: 0.6, green: 0.6, blue: 0.6 } } } } } } },
    { addConditionalFormatRule: { index: 0, rule: { ranges: [{ sheetId: H, startRowIndex: 1, endRowIndex: 3000, startColumnIndex: 0, endColumnIndex: 11 }], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$J2=TRUE' }] }, format: { backgroundColor: { red: 0.88, green: 0.96, blue: 0.88 } } } } } },
    // warn before anyone edits formula areas (warning only, nobody is locked out)
    { addProtectedRange: { protectedRange: { range: { sheetId: OL }, description: 'Formulas: built from the Orders tab', warningOnly: true } } },
    { addProtectedRange: { protectedRange: { range: { sheetId: H, startRowIndex: 0, endRowIndex: 3000, startColumnIndex: 0, endColumnIndex: 9 }, description: 'Formulas: copied from Orders. Tick column J and write notes in K only. Do not sort.', warningOnly: true } } },
    { addProtectedRange: { protectedRange: { range: { sheetId: D, startRowIndex: 4, endRowIndex: 1000 }, description: 'Dashboard formulas', warningOnly: true } } },
  ];
  const tabOf = (r) => {
    const range = r.repeatCell || r.setDataValidation || r.updateDimensionProperties || r.addConditionalFormatRule || r.addProtectedRange || r.updateSheetProperties;
    const inner = range.range || (range.rule && range.rule.ranges && range.rule.ranges[0]) || (range.protectedRange && range.protectedRange.range) || range.properties;
    return Object.keys(sid).find((t) => sid[t] === inner.sheetId);
  };
  const fresh = requests.filter((r) => created.has(tabOf(r)));
  if (fresh.length) await s.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: fresh } });
  if (created.has('Dashboard')) {
    await s.spreadsheets.values.update({ spreadsheetId: id, range: 'Dashboard!C4', valueInputOption: 'USER_ENTERED', requestBody: { values: [['FALSE']] } });
  }
  console.log(created.size ? 'Created: ' + [...created].join(', ') + '.' : 'All three tabs already existed.', 'Formulas are up to date.');
}

main().catch((e) => { console.error('setup-dashboard failed:', e.message); process.exit(1); });
