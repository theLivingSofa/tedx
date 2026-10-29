# Build Contract — Merch Store (TEDxIIMRohtak)

This document is the single source of truth for every agent. **Do not change it.** If something here is
wrong or impossible, stop and report the problem to the orchestrator instead of working around it.

The site recreates the team's current Google Apps Script order page (same look, copy and catalogue) but
replaces "pay by UPI QR + type your UTR" with Cashfree checkout plus server-side payment verification.

Reference material (read-only, local to this sandbox — never copy into the repo):

| Path | What |
|---|---|
| `/tmp/claude-0/reference/original.html` | Current build, viewable offline (UPI details redacted). Open in a browser/Playwright. |
| `/tmp/claude-0/reference/original-{375,768,1240}[-full].png` | Screenshots of the current build. |
| `/tmp/claude-0/wa_scripts/app_clean.html` | Current build source (CSS lines 5–92, markup 94–378, JS 380–643). |
| `/tmp/claude-0/cashfree-sdk-ref/` | Official Cashfree Node SDK `cashfree-pg@6.0.6` (published 2026-09-11). `api.ts` holds models, endpoints, `XApiVersion`, `PGVerifyWebhookSignature`. |

---

## 1. Ground rules

- Runtime: Node.js ≥ 22 on Vercel serverless functions. **CommonJS** everywhere (`require` / `module.exports`).
- Frontend: plain HTML, CSS, vanilla JS. No frameworks, no bundler, no inline `<script>` code and no inline
  event-handler attributes (`onload=`, `onclick=`, …) — CSP forbids them. Inline `style=""` attributes are
  allowed but prefer classes.
- Only one runtime dependency: `@googleapis/sheets` (official per-API googleapis package; exports `sheets` and
  `auth`). Use global `fetch` for Cashfree and Resend. Tests use the built-in `node:test` + `node:assert`.
- API handlers must only use plain Node `req`/`res` (`res.statusCode`, `res.setHeader`, `res.end`) via
  `lib/http.js` helpers. **Never read `req.body`** — always use `readJsonBody` / `readRawBody`, so the
  handlers behave the same on Vercel, under `scripts/dev-server.js`, and in tests.
- Never log or return stack traces, secrets, tokens, emails, phone numbers, names or roll numbers. Use
  `log()` from `lib/http.js`.
- Each file has exactly one owner (section 2). Do not create or edit files you do not own. You may *read* any file.

## 2. Folder structure and ownership

```
/                               
├── api/
│   ├── catalogue.js            sheets-catalogue
│   ├── create-order.js         payments
│   ├── verify-payment.js       payments
│   ├── cashfree-webhook.js     payments
│   ├── order-status.js         payments
│   ├── reconcile.js            payments
│   └── mock-pay.js             payments   (mock payment mode only)
├── lib/
│   ├── sheets.js               sheets-catalogue  (storage: Google Sheets or local-file fallback; catalogue; config)
│   ├── cashfree.js             payments          (Cashfree PG REST client + mock gateway)
│   ├── orders.js               payments          (order state machine + syncOrder)
│   ├── email.js                payments          (optional Resend receipt email)
│   ├── validate.js             security-infra
│   ├── pricing.js              security-infra
│   ├── ratelimit.js            security-infra
│   ├── tokens.js               security-infra
│   └── http.js                 security-infra
├── data/products.json          sheets-catalogue  (fallback catalogue)
├── scripts/
│   ├── setup-sheet.js          sheets-catalogue  (creates tabs + headers + seeds Catalogue/Config)
│   └── dev-server.js           security-infra    (local server emulating Vercel; no vercel CLI needed)
├── public/                     frontend (everything below except the two orchestrator files)
│   ├── index.html
│   ├── order.html              (served at /order via cleanUrls)
│   ├── mock-checkout.html      (mock payment page, served at /mock-checkout)
│   ├── css/tokens.css          orchestrator (exists — do not edit)
│   ├── css/styles.css
│   ├── config/brand.js         orchestrator (exists — do not edit; served at /config/brand.js)
│   ├── js/*.js                 (app.js, api.js, cart.js, checkout.js, receipt.js, order.js, mock-checkout.js, util.js — frontend decides)
│   ├── js/api-mock.js          (temporary local API mock; removed in Phase 2)
│   └── images/*.svg            (placeholder product images)
├── tests/**                    tests-docs
├── README.md                   tests-docs
├── docs/CONTRACT.md            orchestrator
├── vercel.json                 security-infra
├── package.json                security-infra
├── .env.example                security-infra
└── .gitignore                  security-infra
```

## 3. Environment variables

| Name | Required | Default | Used by | Notes |
|---|---|---|---|---|
| `SITE_URL` | prod | derived from request host in dev | http, cashfree | Canonical origin, e.g. `https://merch.example.com`. CORS allow-list and Cashfree `return_url`/`notify_url`. No trailing slash. |
| `GOOGLE_SHEET_ID` | for Sheets | — | sheets | Spreadsheet ID. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | for Sheets | — | sheets | |
| `GOOGLE_PRIVATE_KEY` | for Sheets | — | sheets | PEM; may contain literal `\n` sequences — convert to newlines. |
| `CASHFREE_APP_ID` | for real payments | — | cashfree | Sent as `x-client-id`. |
| `CASHFREE_SECRET_KEY` | for real payments | — | cashfree | Sent as `x-client-secret`; also the webhook HMAC key. |
| `CASHFREE_ENV` | no | `sandbox` | cashfree, catalogue | `sandbox` or `production`. |
| `CASHFREE_API_VERSION` | no | `2026-01-01` | cashfree | `x-api-version` header (value from official SDK `XApiVersion`). |
| `PAYMENT_MODE` | no | auto | cashfree | `mock` forces mock mode. Auto = `cashfree` if APP_ID **and** SECRET_KEY set, else `mock`. `PAYMENT_MODE=cashfree` without keys → create-order returns 503 `payments_unavailable`. |
| `ALLOW_MOCK_IN_PRODUCTION` | no | `false` | cashfree | Mock mode is refused when `VERCEL_ENV=production` unless this is `true` (demo deployments). |
| `PRINTING_CHARGE` | no | `0` | sheets(getConfig) | Rupees per printed item. Config tab overrides env. |
| `ORDER_EXPIRY_MINUTES` | no | `30` | create-order | Cashfree `order_expiry_time` = now + this (min 16). |
| `RECONCILE_MIN_AGE_MINUTES` | no | `10` | reconcile | Only orders older than this are reconciled. |
| `CRON_SECRET` | prod | — | reconcile | Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. |
| `WEBHOOK_TOLERANCE_SECONDS` | no | `300` | webhook | Max clock skew for `x-webhook-timestamp`. |
| `RESEND_API_KEY` | no | — | email | Receipt email only if both this and `EMAIL_FROM` are set. |
| `EMAIL_FROM` | no | — | email | e.g. `TEDxIIMRohtak Merch <merch@yourdomain>` |
| `LOCAL_DATA_DIR` | no | `<os.tmpdir()>/tedx-merch` | sheets | Local-file storage when Sheets env vars are missing. |
| `TRUST_PROXY` | no | `true` | http | Read client IP from `x-forwarded-for` (Vercel sets it). |

Vercel-provided: `VERCEL_ENV`, `VERCEL_URL`.

**Demo mode without any credentials:** no Google vars → storage = local JSON file + `data/products.json`;
no Cashfree vars → mock payment mode. The whole flow must work like this under `npm run dev`.

## 4. Data model

### 4.1 Money
All arithmetic in **integer paise**. API responses carry rupee numbers (`price`, `total` …) with at most 2
decimals, computed as `paise / 100`. Currency is always `INR`.

### 4.2 Statuses
`Awaiting Payment` → `Paid` | `Failed` | `Expired`. Rules (implemented in `lib/orders.js` `resolveStatus`):
- `Paid` is terminal and never regresses.
- `Failed` may become `Paid` (customer retried in the still-active Cashfree order) or `Expired`.
- `Expired` may become `Paid` only if the gateway reports PAID with matching amount (late success).
- `Awaiting Payment` may become anything.

### 4.3 Google Sheet tabs

**Catalogue** (row 1 = headers, exact text, in this order):

| Col | Header | Type | Notes |
|---|---|---|---|
| A | `sku` | string | `^[A-Z0-9][A-Z0-9-]{1,19}$` (uppercase after trim). Unique. |
| B | `name` | string | ≤ 80 chars |
| C | `price` | number | Rupees, > 0, ≤ 100000, ≤ 2 decimals |
| D | `category` | string | Should be a `brand.sections[].id`. Blank/unknown → inferred (see 4.5) |
| E | `apparel` | boolean | `TRUE`/`FALSE`/`yes`/`no`/`1`/`0` (case-insensitive). Apparel requires a size. |
| F | `printing` | boolean | Name printing offered |
| G | `imageUrl` | string | `/images/…` path or `https://` URL (Drive thumbnail links allowed). Blank → no image box. |
| H | `active` | boolean | blank = TRUE |
| I | `stock` | integer | blank = unlimited; `0` = out of stock |

**Orders** (row 1 = headers, exact text, this order; one row per order):

| Col | Header | Record field | Notes |
|---|---|---|---|
| A | `Order ID` | `orderId` | |
| B | `Created At` | `createdAt` | ISO 8601 UTC |
| C | `Updated At` | `updatedAt` | ISO 8601 UTC |
| D | `Status` | `status` | one of 4.2 |
| E | `Name` | `name` | |
| F | `Roll Number` | `roll` | |
| G | `Email` | `email` | lower-cased |
| H | `Phone` | `phone` | 10 digits |
| I | `Items` | `itemsSummary` | human readable, e.g. `HOD-001 Hoodie (M, print: "ASHA") ×2; MUG-001 White Ceramic Mug ×1` |
| J | `Items JSON` | `items` | JSON string of the priced lines (see `priceOrder` lines) |
| K | `Subtotal` | `subtotal` | rupees (products only) |
| L | `Printing Total` | `printingTotal` | rupees |
| M | `Total` | `total` | rupees — the amount Cashfree must report |
| N | `Currency` | `currency` | `INR` |
| O | `Notes` | `notes` | customer notes |
| P | `Token Hash` | `tokenHash` | sha256 hex of the access token. The token itself is never stored. |
| Q | `Payment Mode` | `paymentMode` | `cashfree` \| `mock` |
| R | `Gateway Order ID` | `gatewayOrderId` | Cashfree `cf_order_id` (or `mock_…`) |
| S | `Gateway Status` | `gatewayStatus` | Last raw gateway order status (`ACTIVE`/`PAID`/`EXPIRED`/`TERMINATED`/…); in mock mode `MOCK_PAID`/`MOCK_FAILED`/`ACTIVE` |
| T | `Payment ID` | `paymentId` | `cf_payment_id` of the successful (or latest) payment |
| U | `Payment Method` | `paymentMethod` | e.g. `upi`, `card`, `netbanking`, `mock` |
| V | `Paid At` | `paidAt` | ISO |
| W | `Expires At` | `expiresAt` | ISO |
| X | `Email Sent At` | `emailSentAt` | ISO; set once, guards duplicate emails |
| Y | `Review Flag` | `reviewFlag` | e.g. `AMOUNT_MISMATCH gateway=750.00 expected=1500.00` — for organisers |

**Config** (headers `key`, `value`; one setting per row). Recognised keys:

| key | value | default |
|---|---|---|
| `PRINTING_CHARGE` | rupees per printed item | env `PRINTING_CHARGE` or 0 |
| `STORE_OPEN` | `TRUE`/`FALSE` | TRUE — when FALSE create-order returns 503 `store_closed` |
| `MAX_QUANTITY_PER_SKU` | integer 1–20 | 20 (hard ceiling 20) |

Unknown keys are ignored.

### 4.4 Formula-injection protection
Every **string** written to any sheet passes through `sanitizeCell`: if it begins with `=`, `+`, `-`, `@`,
tab (`\t`) or carriage return (`\r`), prefix a single quote `'`. Writes use `valueInputOption: 'RAW'`.
When reading Orders back, `unsanitizeCell` removes that one leading `'` only when it is followed by one of
those characters. Numbers are written as JS numbers.

### 4.5 Category normalisation
`normaliseCategory(product, sections)`: if `category` case-insensitively contains a section id
(`winter` / `summer` / `accessor`), use that section id. Otherwise infer from `name + ' ' + sku`:
`/hoodie|varsity|zipper|jacket|sweat/` → `Winter`; `/t-shirt|tshirt|polo|tee/` → `Summer`; else `Accessories`.

---

## 5. HTTP API

Common rules for every `/api/*` endpoint:
- JSON responses with `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`
  (catalogue: `public, max-age=0, s-maxage=60, stale-while-revalidate=300`).
- **Error shape** (always):
  ```json
  { "error": { "code": "snake_case_code", "message": "Human-readable, safe to show to the user.", "fields": { "email": "Enter a valid email address." } } }
  ```
  `fields` only on `400 validation_failed`. Optional `"retryAfter": <seconds>` on 429.
- Generic codes: `400 invalid_json`, `400 validation_failed`, `403 forbidden_origin`, `404 not_found`,
  `405 method_not_allowed` (+ `Allow` header), `413 payload_too_large`, `429 rate_limited` (+ `Retry-After`
  header), `500 internal_error`, `503 …`.
- CORS: only `SITE_URL` origin. Same-origin requests with no `Origin` header are allowed. A request whose
  `Origin` is present and not allowed → `403 forbidden_origin` (except the webhook, which ignores Origin, and
  reconcile which is server-to-server). Preflight `OPTIONS` → 204 with allow headers for allowed origins.
- Body size limit 32 KB (webhook 64 KB).

### 5.1 `GET /api/catalogue`
Response 200:
```json
{
  "products": [
    { "sku": "HOD-001", "name": "Hoodie", "price": 750, "category": "Winter",
      "apparel": true, "printing": true, "imageUrl": "/images/hoodie-black.svg",
      "available": true, "maxQuantity": 20 }
  ],
  "sizes": ["XS", "S", "M", "L", "XL", "XXL", "XXXL"],
  "printingCharge": 0,
  "maxQuantityPerSku": 20,
  "storeOpen": true,
  "source": "sheet",
  "payment": { "mode": "mock", "environment": "sandbox" }
}
```
- Only `active` products. `available` = stock blank or > 0. `maxQuantity` = min(maxQuantityPerSku, stock) (or
  maxQuantityPerSku when unlimited; 0 when unavailable). Raw stock numbers are not exposed otherwise.
- `source`: `"sheet"` or `"fallback"` (products.json, used when Sheets is not configured or errors).
- `payment.mode`: `"cashfree"` | `"mock"`; `payment.environment`: `"sandbox"` | `"production"`.
- Product order: as in the sheet/file. Frontend groups by `category` in `brand.sections` order.

### 5.2 `POST /api/create-order`
Rate limit: 10 / minute / IP. Request (no other keys allowed anywhere → `400 validation_failed` with
`fields._` = "Unexpected field: X"):
```json
{
  "customer": { "name": "Asha Verma", "roll": "IPM2023-045", "email": "asha@example.com",
                "phone": "9876543210", "notes": "optional, may be omitted or empty" },
  "items": [
    { "sku": "HOD-001", "quantity": 2, "size": "M", "printing": true, "printedName": "ASHA" },
    { "sku": "MUG-001", "quantity": 1 }
  ]
}
```
Item fields: `sku` (required), `quantity` (required int 1–20), `size` (required for apparel, forbidden/ignored-if-empty
otherwise), `printing` (bool, default false), `printedName` (required iff printing true). Each SKU at most once.
1–50 items.

Server: validate (`lib/validate.js`), check `STORE_OPEN`, load catalogue, `priceOrder` (`lib/pricing.js`) —
**client prices/totals are never accepted** — generate `orderId` + token, write row with status
`Awaiting Payment`, then create the gateway order. If the gateway call fails, update the row to `Failed`
with `reviewFlag: "GATEWAY_CREATE_FAILED"` and return 502.

Response 201:
```json
{
  "orderId": "TEDX-20261029-K3F9QZ",
  "token": "base64url-43-chars",
  "paymentSessionId": "session_xxx (or mock_session_xxx)",
  "paymentMode": "cashfree",
  "environment": "sandbox",
  "total": 1630,
  "currency": "INR",
  "expiresAt": "2026-10-29T14:10:00.000Z"
}
```
Errors: `400 validation_failed` (shape/field problems, `fields` keyed by `name|roll|email|phone|notes` or
`items[0].size` style paths), `409 item_unavailable` (inactive / unknown SKU / out of stock / insufficient
stock; `fields` keyed by `items[i]`), `429`, `502 gateway_error`, `503 store_closed`,
`503 payments_unavailable`, `503 storage_unavailable`.

### 5.3 `POST /api/verify-payment`
Rate limit 30 / minute / IP. Request `{ "orderId": "...", "token": "..." }`. Runs `syncOrder` (server-to-server
Get Order) and returns the **order view** (5.6) with 200. Idempotent. Wrong/missing token or unknown order →
`404 not_found` (same response for both; never reveal existence).

### 5.4 `POST /api/cashfree-webhook`
Reads the **raw** body. Verification (from official SDK `PGVerifyWebhookSignature` and Cashfree webhook docs):
`expected = base64( HMAC_SHA256( key = CASHFREE_SECRET_KEY, message = x-webhook-timestamp + rawBody ) )`,
compared with header `x-webhook-signature` using constant-time comparison. `x-webhook-timestamp` is epoch
**seconds** (10 digits; observed from webhook version 2026-01-01 on 2026-10-29) or epoch **milliseconds**
(13 digits; Cashfree's docs example); the HMAC covers the string exactly as sent. Reject if
`|now − ts| > WEBHOOK_TOLERANCE_SECONDS`.
- Missing headers / bad signature / stale timestamp → `401 invalid_signature`.
- Non-JSON body after valid signature → `400 invalid_json`.
- Order id is read from `data.order.order_id`. Unknown order → 200 `{ "received": true }` (ignored).
- Known order → `syncOrder(orderId, { source: 'webhook' })` (always re-confirms via Get Order; the webhook
  payload's own status/amount is never trusted) → 200 `{ "received": true }`.
- Duplicate deliveries are harmless (sync is idempotent).
- In mock mode the endpoint returns `404 not_found` (no secret to verify with).

### 5.5 `GET|POST /api/reconcile`
Auth: `Authorization: Bearer <CRON_SECRET>` (constant-time compare). Missing `CRON_SECRET` env → 503
`not_configured`; wrong/missing header → `401 unauthorized`. Finds orders with status `Awaiting Payment` or
`Failed` whose `createdAt` is older than `RECONCILE_MIN_AGE_MINUTES`, max 25 per run, oldest first, and runs
`syncOrder(orderId, { source: 'reconcile' })` for each. If the gateway says ACTIVE but `expiresAt` passed
by more than 15 minutes, the order becomes `Expired`.
Response 200: `{ "checked": 3, "changed": [ { "orderId": "...", "from": "Awaiting Payment", "to": "Paid" } ], "errors": 0 }`.

### 5.6 `GET /api/order-status?id=<orderId>&token=<token>`
Rate limit 60 / minute / IP. Token compared via `tokens.verifyToken` (sha256 + `crypto.timingSafeEqual`).
Unknown order or bad token → `404 not_found`. If status is `Awaiting Payment` or `Failed` and the last
gateway check for this order was > 15 s ago (in-memory throttle), runs `syncOrder` first.

**Order view** (returned by order-status and verify-payment):
```json
{
  "orderId": "TEDX-20261029-K3F9QZ",
  "status": "Paid",
  "paymentMode": "cashfree",
  "createdAt": "2026-10-29T13:40:00.000Z",
  "paidAt": "2026-10-29T13:42:10.000Z",
  "expiresAt": "2026-10-29T14:10:00.000Z",
  "customer": { "name": "Asha Verma", "roll": "IPM2023-045", "email": "asha@example.com", "phone": "******3210" },
  "items": [
    { "sku": "HOD-001", "name": "Hoodie", "size": "M", "printing": true, "printedName": "ASHA",
      "quantity": 2, "unitPrice": 750, "printingCharge": 0, "lineTotal": 1500 }
  ],
  "subtotal": 1630, "printingTotal": 0, "total": 1630, "currency": "INR",
  "paymentMethod": "upi", "paymentId": "5114910392481",
  "notes": "optional",
  "message": "Payment received. Your order is confirmed."
}
```
`message` per status: Paid → "Payment received. Your order is confirmed."; Awaiting Payment → "We are waiting
for confirmation from the payment gateway. This page updates automatically."; Failed → "The payment did not go
through. No money was taken, or it will be refunded automatically by your bank."; Expired → "This order expired
before payment was completed. Please place a new order."

### 5.7 `POST /api/mock-pay` (mock mode only)
Returns `404 not_found` unless payment mode is `mock`. Rate limit 20 / minute / IP.
Request `{ "orderId": "...", "token": "...", "outcome": "success" | "failure" }`. Verifies token, then sets
`gatewayStatus` to `MOCK_PAID` / `MOCK_FAILED` (only if the order is not already Paid), then runs `syncOrder`
and returns the order view (200).

---

## 6. Shared `lib` signatures

All functions are CommonJS exports with exactly these names. `async` = returns a Promise.

### 6.1 `lib/http.js` (security-infra)
```js
class HttpError extends Error { constructor(status, code, message, extra /* {fields, retryAfter} */) }
sendJson(res, status, body, headers = {})              // sets JSON content-type + no-store unless headers override Cache-Control
sendError(res, status, code, message, extra = {})       // writes the error shape (5.)
async readRawBody(req, { limit = 32768 } = {})          // -> Buffer; throws HttpError(413,'payload_too_large')
async readJsonBody(req, { limit = 32768 } = {})         // -> parsed value; throws HttpError(400,'invalid_json') / 413
applyCors(req, res, { methods })                        // sets CORS headers for allowed origin; returns true if it fully handled the request (OPTIONS preflight or 403 forbidden_origin) — caller must then return
allowMethods(req, res, methods /* ['GET'] */)           // returns true if allowed; otherwise sends 405 with Allow header and returns false
getClientIp(req)                                        // string
getSiteUrl(req)                                         // SITE_URL or `${proto}://${host}` fallback (dev only)
getQuery(req)                                           // URLSearchParams-like plain object from req.url
log(level /* 'info'|'warn'|'error' */, event, fields = {}) // JSON line to console; drops keys named email, phone, name, roll, token, notes, printedName, authorization, secret, key; never includes stacks
withErrorHandling(handler)                              // wraps (req,res) => …; HttpError -> sendError; anything else -> log('error', …, {message}) + 500 internal_error
```

### 6.2 `lib/tokens.js` (security-infra)
```js
generateToken()                 // 32 random bytes, base64url (43 chars)
hashToken(token)                // sha256 hex
verifyToken(token, tokenHash)   // boolean; constant-time; false for non-string/malformed input
safeEqual(a, b)                 // constant-time string compare (false on length mismatch, without early exit on content)
generateOrderId(prefix, date = new Date()) // `${prefix}-${YYYYMMDD}-${6 chars [A-Z2-9 minus I,O]}` (crypto random), prefix from brand.orderIdPrefix
```

### 6.3 `lib/validate.js` (security-infra)
```js
SIZES                                   // ['XS','S','M','L','XL','XXL','XXXL']
MAX_QTY                                 // 20
validateOrderRequest(body)              // -> { ok: true, value: { customer, items } } | { ok: false, fields: { path: message } }
validateCustomer(customer)              // -> same shape; normalises: trims, collapses spaces, email lower-case, phone -> 10 digits
validateItems(items)                    // -> same shape; structural only (no catalogue lookups); sku upper-cased; printedName trimmed
validateOrderId(id)                     // boolean: /^[A-Z0-9]{1,8}-\d{8}-[A-Z2-9]{6}$/
validateTokenFormat(token)              // boolean: /^[A-Za-z0-9_-]{43}$/
```
Field rules: `name` 2–80 chars, letters (Unicode), spaces, `.'-`; `roll` 1–30 chars `[A-Za-z0-9/_ -]`;
`email` ≤ 254, practical RFC-5322-lite regex; `phone` Indian mobile: optional `+91`/`91`/`0` prefix, spaces or
dashes allowed, result must match `^[6-9]\d{9}$`; `notes` optional ≤ 500 chars, control characters stripped
except newline; `printedName` 1–20 chars `[A-Za-z0-9 .'&-]`; `quantity` integer 1–20 (numeric strings rejected);
`printing` boolean only. Unknown keys rejected (`fields._`). Error messages are short, user-facing sentences.

### 6.4 `lib/pricing.js` (security-infra)
```js
toPaise(rupees)                      // Math.round(rupees*100); throws on non-finite
fromPaise(paise)                     // paise/100
formatINR(rupees)                    // '₹1,630' (no decimals if whole) / '₹12.50'
amountsEqual(a, b)                   // rupee numbers equal to the paisa
priceOrder(items, products, { printingCharge = 0, maxQuantityPerSku = 20 } = {})
// items: output of validateItems. products: catalogue products (shape of 5.1 plus `active`, `stock`).
// -> { ok: true, lines: [{ sku, name, category, size, printing, printedName, quantity, unitPrice,
//        printingCharge, lineTotal }], subtotal, printingTotal, total, currency: 'INR' }
//  | { ok: false, errors: [{ index, sku, code, message }] }
// codes: unknown_sku, inactive, out_of_stock, insufficient_stock, quantity_limit, size_required,
//        size_not_applicable, printing_not_available, printed_name_required, duplicate_sku
// lineTotal = quantity * (unitPrice + (printing ? printingCharge : 0)); subtotal = Σ quantity*unitPrice;
// printingTotal = Σ printing lines quantity*printingCharge; total = subtotal + printingTotal. All via paise.
// Non-apparel lines always get size ''. Non-printing lines get printedName ''.
summariseItems(lines)                // the `Items` column string (4.3)
```

### 6.5 `lib/ratelimit.js` (security-infra)
```js
rateLimit(key, { limit, windowMs })  // -> { ok, remaining, retryAfter /* seconds */ } ; in-memory fixed/sliding window, bounded map (evicts old keys, max 10k)
enforceRateLimit(req, res, name, { limit, windowMs }) // uses getClientIp; on limit sends 429 + Retry-After and returns false; else true
```

### 6.6 `lib/sheets.js` (sheets-catalogue)
```js
ORDER_HEADERS, CATALOGUE_HEADERS, CONFIG_HEADERS   // arrays exactly as in 4.3
storageMode()                       // 'sheets' | 'local'
sanitizeCell(value), unsanitizeCell(value)
normaliseCategory(product, sections)
async getCatalogue({ fresh = false } = {})  // -> { products: [{sku,name,price,category,apparel,printing,imageUrl,active,stock}], source: 'sheet'|'fallback' }  (ALL rows incl. inactive; 60 s memory cache; any Sheets error -> fallback products.json + log warn)
async getConfig()                   // -> { printingCharge: number, storeOpen: boolean, maxQuantityPerSku: number } (60 s cache; defaults per 4.3)
async appendOrder(record)           // record with Order fields (4.3); writes one row
async getOrder(orderId)             // -> record | null (numbers parsed, `items` parsed from JSON)
async updateOrder(orderId, patch)   // merges patch into the row, sets updatedAt; -> updated record; throws HttpError(404) if missing
async listOrders({ statuses, olderThan /* Date */, limit = 25 })  // oldest first
_resetForTests()                    // clears caches & local store pointer
```
Sheets backend: auth via `auth.JWT` / `GoogleAuth` with scope `https://www.googleapis.com/auth/spreadsheets`,
retries with exponential backoff + jitter (max 4 attempts, base 400 ms, 8 s per-request timeout) on 429, 500, 502, 503, 504 and network
errors. Order rows are located by scanning column A. Local backend: one JSON file `orders.json` under
`LOCAL_DATA_DIR`, written atomically (write temp + rename); catalogue from `data/products.json`; config from env.

### 6.7 `lib/cashfree.js` (payments)
```js
paymentMode()                       // 'cashfree' | 'mock' | 'unavailable' (per env rules in 3)
environment()                       // 'sandbox' | 'production'
baseUrl()                           // https://sandbox.cashfree.com/pg | https://api.cashfree.com/pg
async createGatewayOrder({ orderId, amount, customer: {id, name, email, phone}, returnUrl, notifyUrl, expiresAt, note })
                                    // POST /orders -> { gatewayOrderId, paymentSessionId, status, expiresAt }
async getGatewayOrder(orderId)      // GET /orders/{order_id} -> { orderId, gatewayOrderId, status /* ACTIVE|PAID|EXPIRED|TERMINATED|TERMINATION_REQUESTED */, amount, currency }
async getGatewayPayments(orderId)   // GET /orders/{order_id}/payments -> [{ paymentId, status /* SUCCESS|FAILED|PENDING|USER_DROPPED|CANCELLED|… */, amount, method, time }]
verifyWebhookSignature({ rawBody /* Buffer|string */, signature, timestamp, secret, toleranceSeconds, now = Date.now() }) // -> boolean (pure, testable)
```
Headers on every request: `x-client-id`, `x-client-secret`, `x-api-version`, `x-request-id` (uuid),
`Content-Type: application/json`; create order also sends `x-idempotency-key: <orderId>`. Retries (max 3,
backoff) only on network errors / 5xx / 429 for GET, and for POST only with the idempotency key.
Mock gateway: `createGatewayOrder` → `{ gatewayOrderId: 'mock_<orderId>', paymentSessionId: 'mock_session_<random>' }`;
`getGatewayOrder` derives status from the stored order's `gatewayStatus` (`MOCK_PAID` → `PAID` with
amount = stored total; `MOCK_FAILED` → `ACTIVE` + one FAILED payment; otherwise `ACTIVE`).

### 6.8 `lib/orders.js` (payments)
```js
STATUSES                             // { AWAITING:'Awaiting Payment', PAID:'Paid', FAILED:'Failed', EXPIRED:'Expired' }
resolveStatus(current, gateway, expectedTotal, { now, expiresAt })
  // pure. gateway = { orderStatus, amount, payments:[{status}] }.
  // -> { status, reviewFlag? }:
  //   orderStatus PAID & amountsEqual -> Paid
  //   orderStatus PAID & amount mismatch -> current unchanged (never Paid), reviewFlag AMOUNT_MISMATCH …
  //   orderStatus EXPIRED|TERMINATED -> Expired (unless current Paid)
  //   ACTIVE & latest payment FAILED|USER_DROPPED|CANCELLED -> Failed (unless current Paid)
  //   ACTIVE & now > expiresAt + 15 min -> Expired (unless Paid)
  //   otherwise -> current
  //   Paid never changes.
async syncOrder(orderId, { source })  // load order, query gateway, resolveStatus, updateOrder only if something changed,
                                      // on first transition to Paid set paidAt/paymentId/paymentMethod and send email once (emailSentAt guard).
                                      // -> updated record. Concurrency-safe enough for Sheets: re-reads before writing and never overwrites Paid.
toOrderView(record)                   // -> order view JSON (5.6)
```

### 6.9 `lib/email.js` (payments)
```js
emailEnabled()                        // RESEND_API_KEY && EMAIL_FROM
async sendReceiptEmail(record)        // POST https://api.resend.com/emails; returns boolean; never throws
renderReceiptHtml(view, brand)        // same receipt layout the frontend downloads (escape all values)
```

---

## 7. Frontend contract (frontend agent)

- Visual target = the current build (`/tmp/claude-0/reference/*`) and the user's design spec, reproduced in
  `public/css/styles.css` using **only** tokens from `tokens.css` for colours/radii/shadows/fonts.
  `index.html` loads, in order: `css/tokens.css`, `css/styles.css`, `config/brand.js`,
  `https://sdk.cashfree.com/js/v3/cashfree.js` (deferred, only used in cashfree mode), then app scripts (`defer`).
- Copy from the current build is kept verbatim (hero text from `brand.js`, section intro paragraph, disclaimer,
  cart texts), except the payment section, which becomes **"3. Pay securely"** with a "Pay securely with
  Cashfree" panel: accepted methods ("UPI, cards, net banking and wallets"), a sandbox note when
  `payment.environment === 'sandbox'` ("Sandbox mode — no real money is charged"), a clearly labelled
  **"DEMO MODE — simulated payments"** badge/note when `payment.mode === 'mock'`, the notes textarea, and the
  Pay button. The bottom summary-bar button reads "Pay securely" (submits the form). No UPI ID, QR or UTR field.
- Checkout flow: validate client-side → `POST /api/create-order` → store `{orderId, token}` in
  `localStorage['merch:lastOrder']` (wrapped in try/catch) → cashfree mode: `Cashfree({ mode: environment })`
  then `cashfree.checkout({ paymentSessionId, redirectTarget: '_modal' })`; mock mode: open an accessible modal
  containing an `<iframe src="/mock-checkout?order=…">` (page posts back via `postMessage` with
  `{type:'mock-checkout', outcome}` to `location.origin`; mock page gets the token from the parent via
  postMessage, never from the URL) → in every case then `POST /api/verify-payment` → show Paid (success box +
  receipt download + "View order status" link) / Failed (error box + "Try again") / Awaiting Payment (info in
  success styling + link to `/order?id=…&token=…`).
- Receipt: generated client-side from the order view as a standalone HTML file (inline styles OK inside the
  downloaded file), all values escaped, download name `${brand.receiptFilePrefix}_${orderId}.html`.
- `/order?id=…&token=…` (order.html): token from query or from `localStorage['merch:lastOrder']` when ids match;
  polls `GET /api/order-status` every 4 s (backoff to 15 s after 1 min, stop after 10 min or a terminal status
  Paid/Expired); shows status, items, total, receipt download. Same visual language (hero + cards).
- `return_url` used by the server is `${SITE_URL}/order?id=${orderId}` (no token).
- API base path is relative (`/api/...`). While the backend is not ready the frontend may use
  `js/api-mock.js`, enabled **only** when the page URL has `?mockapi=1`.
- Accessibility: every input has a `<label for>`; visible `:focus-visible` outlines (token `--focus-ring`);
  cart dialog has `role="dialog"`, `aria-modal`, focus trap, Esc to close, returns focus to the opener;
  qty steppers have `aria-label`s and an `aria-live` quantity; nav buttons reachable by keyboard and set
  `aria-current` on the active one; message box `role="status" aria-live="polite"`; respects
  `prefers-reduced-motion`. Images have meaningful `alt`.
- Placeholder images: simple SVGs in `public/images/` (e.g. `hoodie-black.svg`, `hoodie-white.svg`,
  `zip-hoodie-*.svg`, `varsity-white.svg`, `varsity-black.svg`, `polo-*.svg`, `tshirt-*.svg`, `mug-white.svg`,
  `mug-black.svg`, `tote-white.svg`, `tote-black.svg`, `badge-*.svg`, `diary-*.svg`, `magnet-*.svg`,
  `keychain-*.svg`), each labelled "Placeholder". The filenames used in `data/products.json` are listed in
  section 8 and must exist.

## 8. Seed catalogue (`data/products.json` and the sheet seed)

Same SKUs, names, prices and flags as the current build. `active: true`, `stock: null` (unlimited) unless noted.
JSON shape: `{ "products": [ { "sku", "name", "price", "category", "apparel", "printing", "imageUrl", "active", "stock" } ] }`.

| sku | name | price | category | apparel | printing | imageUrl |
|---|---|---|---|---|---|---|
| HOD-001 | Hoodie | 750 | Winter | true | true | /images/hoodie-black.svg |
| HOD-002 | Hoodie | 750 | Winter | true | true | /images/hoodie-white.svg |
| HOD-003 | Hoodie | 750 | Winter | true | true | /images/hoodie-grey.svg |
| ZHD-001 | Zipper Hoodie | 800 | Winter | true | true | /images/zip-hoodie-black.svg |
| ZHD-002 | Zipper Hoodie | 800 | Winter | true | true | /images/zip-hoodie-white.svg |
| VAR-001 | White Varsity Jacket | 850 | Winter | true | true | /images/varsity-white.svg |
| VAR-002 | Black Varsity Jacket | 850 | Winter | true | true | /images/varsity-black.svg |
| POL-001 | Polo | 420 | Summer | true | true | /images/polo-black.svg |
| POL-004 | Polo | 420 | Summer | true | true | /images/polo-white.svg |
| TSH-001 | Oversize T-shirt | 420 | Summer | true | true | /images/tshirt-black.svg |
| TSH-002 | Oversize T-shirt | 420 | Summer | true | true | /images/tshirt-white.svg |
| TSH-003 | Oversize T-shirt | 420 | Summer | true | true | /images/tshirt-red.svg |
| MUG-001 | White Ceramic Mug | 130 | Accessories | false | false | /images/mug-white.svg |
| MUG-002 | Black Ceramic Mug | 200 | Accessories | false | false | /images/mug-black.svg |
| TOT-002 | White Tote - Design 2 | 200 | Accessories | false | false | /images/tote-white.svg |
| TOT-003 | Black Tote - Design 1 | 200 | Accessories | false | false | /images/tote-black.svg |
| BDG-001 | Badge - Black | 40 | Accessories | false | false | /images/badge-black.svg |
| BDG-002 | Badge - White | 40 | Accessories | false | false | /images/badge-white.svg |
| DIA-001 | Diary | 120 | Accessories | false | false | /images/diary-black.svg |
| DIA-002 | Diary | 120 | Accessories | false | false | /images/diary-red.svg |
| DIA-003 | Diary | 120 | Accessories | false | false | /images/diary-white.svg |
| DIA-004 | Diary | 120 | Accessories | false | false | /images/diary-grey.svg |
| DIA-005 | Diary | 120 | Accessories | false | false | /images/diary-cream.svg |
| MAG-001 | Fridge Magnet (Plastic) | 70 | Accessories | false | false | /images/magnet-1.svg |
| MAG-002 | Fridge Magnet (Plastic) | 70 | Accessories | false | false | /images/magnet-2.svg |
| MAG-003 | Fridge Magnet (Plastic) | 70 | Accessories | false | false | /images/magnet-3.svg |
| MAG-004 | Fridge Magnet (Plastic) | 70 | Accessories | false | false | /images/magnet-4.svg |
| MAG-005 | Fridge Magnet (Plastic) | 70 | *(blank — tests inference)* | false | false | /images/magnet-5.svg |
| KEY-001 | KeyChain (MDF) | 50 | Accessories | false | false | /images/keychain-1.svg |
| KEY-002 | KeyChain (MDF) | 50 | Accessories | false | false | /images/keychain-2.svg |

## 9. Infrastructure

- `vercel.json`: `"cleanUrls": true`; `"crons": [{ "path": "/api/reconcile", "schedule": "0 3 * * *" }]`
  (daily — Hobby-plan compatible; README explains raising frequency on Pro); function `maxDuration` 30 s
  (reconcile 60 s); security headers on all routes; CSP on HTML:
  `default-src 'self'; script-src 'self' https://sdk.cashfree.com; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://drive.google.com https://*.googleusercontent.com https://*.cashfree.com;
  connect-src 'self' https://sdk.cashfree.com https://api.cashfree.com https://sandbox.cashfree.com;
  frame-src 'self' https://sdk.cashfree.com https://api.cashfree.com https://sandbox.cashfree.com https://payments.cashfree.com https://payments-test.cashfree.com;
  form-action 'self' https://*.cashfree.com; frame-ancestors 'self'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests`
  plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: SAMEORIGIN`, `Strict-Transport-Security: max-age=63072000; includeSubDomains`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(self "https://sdk.cashfree.com")`,
  `Cross-Origin-Opener-Policy: same-origin-allow-popups`. `/api/*`: `Cache-Control: no-store`.
- `scripts/dev-server.js` (`npm run dev`, port `PORT` or 3000): loads `.env.local` then `.env` if present (tiny
  parser, no dependency), serves `public/` with clean URLs, routes `/api/<name>` to `api/<name>.js`, applies
  the headers from `vercel.json`, and must not expose anything outside `public/`.
- `package.json` scripts: `dev`, `test` (`node --test "tests/**/*.test.js"`), `setup-sheet`, `check` (syntax check all JS
  via `node --check`).
- `.gitignore`: `node_modules/`, `.env*` except `!.env.example`, `.vercel/`, `.data/`, `*.log`, `.DS_Store`.

## 10. Orchestrator decisions after Phase 1 (binding)

1. Node ≥ 22 (`@googleapis/sheets@18` requires it; Node 20 is end-of-life). `npm test` = `node --test "tests/**/*.test.js"`.
2. `GET /api/catalogue` `payment.mode` maps `'unavailable'` to `'cashfree'` (create-order then answers 503 `payments_unavailable`).
3. `fields` may also appear on `409 item_unavailable` (keyed `items[i]`), as 5.2 says.
4. `resolveStatus` precedence for gateway `ACTIVE`: the expiry check (`now > expiresAt + 15 min` → Expired) runs before the failed-payment check. An `Expired` order only ever moves to `Paid` (matching amount), which also sets `reviewFlag: PAID_AFTER_EXPIRY`. "Latest payment" = newest by payment time, else last array element.
5. `createdAt` and `orderId` are immutable in `updateOrder`.
6. `STORE_OPEN` and `MAX_QUANTITY_PER_SKU` are also accepted as env defaults (Config tab wins).
7. The webhook answers 503 on storage/sync failure so Cashfree retries delivery.
8. `SITE_URL` should be set for the Production environment only; preview deployments derive their own origin.

## 11. Changes after the Phase 3 security review (binding)

1. `paymentMode()` also returns `'unavailable'` for mock when Google Sheets is configured unless
   `ALLOW_MOCK_WITH_SHEETS=true`; `VERCEL_ENV` is compared case-insensitively.
2. New orders get `reviewFlag` `TEST_PAYMENT_MOCK` (mock) or `TEST_PAYMENT_SANDBOX` (Cashfree sandbox).
   `reviewFlag` holds several flags joined by ` | ` (`lib/orders.js` `addFlag`); later flags never erase earlier ones.
   A Paid transition after `AMOUNT_MISMATCH` adds `RESOLVED_PAID_WITH_MATCHING_AMOUNT`; Expired → Paid adds `PAID_AFTER_EXPIRY`.
3. Storage (`mergeOrder`) never changes `status`, `paidAt`, `paymentId`, `paymentMethod`, `total`, `tokenHash`, `items`
   once a row is Paid, and `emailSentAt` is first-write-wins; only the request whose email claim landed sends the receipt.
4. Sheets updates re-check column A of the target row before and after writing; a duplicate Order ID or a moved row is
   a storage error (503) and is logged (`orders_row_overwritten`). `setup-sheet` adds a warning-only protection to Orders.
5. Gateway amounts count as a match only if they are positive with at most two decimals and equal the stored total in paise.
6. Reconcile also re-checks up to 10 `Expired` orders whose `expiresAt` is within the last 3 days (newest first);
   order-status refreshes recently expired orders too (same 15 s throttle). verify-payment syncs at most once per 2 s per order.
7. order-status accepts the token in the `X-Order-Token` header (preferred; `?token=` still accepted). Order page links
   carry the token in the URL fragment: `/order?id=<id>#token=<token>`. `merch:lastOrder` expires after 7 days.
8. Frontend: the Cashfree sandbox note is shown only in cashfree mode with `environment === 'sandbox'`; in mock mode
   the "DEMO MODE" note replaces it (the sandbox note's "use Cashfree test details" text would be wrong there).
   The Cashfree SDK script is loaded `async` (not `defer`) so a slow sdk.cashfree.com cannot block the page.
