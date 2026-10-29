# Merch Store – TEDxIIMRohtak

The merchandise ordering site for TEDxIIMRohtak. It looks and works like the current Google Apps Script order
page (same catalogue, sizes, name printing and receipt), with one big change: **customers pay through Cashfree's
checkout, and the site confirms the payment by itself.** Nobody has to scan a UPI QR, type a UTR number, or
match UTRs against the bank statement by hand any more. An order turns **Paid** in the Google Sheet only after
our server has asked Cashfree directly and Cashfree has confirmed that the full amount was received.

- Frontend: plain HTML, CSS and JavaScript in `public/` (no framework, no build step).
- Backend: small Node.js (≥ 22) serverless functions in `api/`, hosted on Vercel.
- Data: a Google Sheet (tabs `Catalogue`, `Orders`, `Config`).
- Payments: Cashfree Payment Gateway (UPI, cards, net banking, wallets), sandbox first.

The full technical specification is in [`docs/CONTRACT.md`](docs/CONTRACT.md).

---

## Contents

1. [How payment confirmation works](#how-payment-confirmation-works)
2. [Quick start (demo mode, no accounts needed)](#quick-start-demo-mode-no-accounts-needed)
3. [Rebranding](#rebranding)
4. [Google Sheets setup](#google-sheets-setup)
5. [Cashfree sandbox setup](#cashfree-sandbox-setup)
6. [Environment variables](#environment-variables)
7. [Deploy to Vercel](#deploy-to-vercel)
8. [API reference](#api-reference)
9. [Security notes](#security-notes)
10. [Going-live checklist](#going-live-checklist)
11. [Known limitations](#known-limitations)
12. [Project structure, tests and checks](#project-structure-tests-and-checks)

---

## How payment confirmation works

```text
 Customer's browser                    Our server (Vercel /api)                  Cashfree           Google Sheet
 ──────────────────                    ────────────────────────                  ────────           ────────────
 1. Fill form, click "Pay securely"
    ── POST /api/create-order ───────▶ validate input, look up prices in the
                                        Catalogue, compute the total itself
                                        write row "Awaiting Payment" ────────────────────────────────▶ Orders row
                                        Create Order (server-to-server) ───────▶ order + session
    ◀── orderId, token, session ─────
 2. Cashfree checkout opens (modal) ────────────────────────────────────────────▶ customer pays
 3. Modal closes
    ── POST /api/verify-payment ─────▶ Get Order (server-to-server) ──────────▶ "PAID, ₹1630"
                                        amount matches? → mark Paid ──────────────────────────────────▶ Status = Paid
    ◀── order view (Paid) ───────────
                                        (in parallel, as a safety net)
                                        POST /api/cashfree-webhook ◀─────────── signed webhook
                                        check signature + timestamp,
                                        then Get Order again → same rule ─────────────────────────────▶ (no change if
                                                                                                          already Paid)
                                        GET /api/reconcile (daily cron)
                                        re-checks old unpaid orders ──────────▶ Get Order ───────────▶ Paid / Expired
 4. Receipt download, /order?id=… page polls GET /api/order-status
```

There are three independent ways an order can become Paid — the browser's `verify-payment` call, Cashfree's
webhook, and the scheduled `reconcile` job — so a payment is still recorded if the customer closes the tab, loses
network or the webhook is delayed. All three use the same rule.

### Why the "Paid" status can be trusted

- **The server sets the price.** The browser only sends SKUs, sizes and quantities. The server looks up prices
  in the Catalogue tab and computes the total in paise (whole numbers, no rounding errors). Any `price` or
  `total` sent by the browser is rejected.
- **Cashfree is asked directly.** Before marking an order Paid, the server calls Cashfree's *Get Order* API with
  our secret key. What the browser says, and what a webhook says, are never enough on their own.
- **The amount must match** to the paisa. If Cashfree reports a different amount, the order is *not* marked
  Paid and the `Review Flag` column says e.g. `AMOUNT_MISMATCH gateway=750.00 expected=1500.00`.
- **Webhooks are signed.** Each webhook must carry a valid HMAC-SHA256 signature made with our secret key
  over the timestamp and the exact raw body, and the timestamp must be recent (default ±5 minutes).
- **Idempotent.** Running a check twice, or receiving the same webhook twice, changes nothing the second time.
  The receipt email (if enabled) is sent once.
- **Paid never goes backwards.** Once an order is Paid, nothing (an expired session, a later failed attempt)
  can change it back.

### Order statuses (the `Status` column)

| Status | Meaning |
|---|---|
| `Awaiting Payment` | Order created, payment not confirmed yet. Usually changes within seconds. |
| `Paid` | Cashfree confirmed the full amount. Safe to fulfil. |
| `Failed` | The last payment attempt failed or was cancelled. It can still become Paid if the customer retries. |
| `Expired` | The payment window closed without a payment. It becomes Paid only if Cashfree later reports a full late payment. |

If the `Review Flag` column has anything in it, an organiser should look at that order (compare with the
Cashfree dashboard using the Order ID).

---

## Quick start (demo mode, no accounts needed)

You need [Node.js](https://nodejs.org/) 22 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

With no Google or Cashfree settings the site runs in **demo mode**:

- **Mock payments** — the payment step shows a "DEMO MODE — simulated payments" note, and clicking *Pay
  securely* opens a simulated checkout with **Simulate successful payment**, **Simulate failed payment** and
  **Cancel** buttons. No money moves.
- **Local file storage** — the catalogue comes from `data/products.json`, and orders are saved to
  `orders.json` in a temporary folder (set `LOCAL_DATA_DIR` to choose the folder).

To try it: add items to the cart, fill in the form, click *Pay securely*, then choose *Simulate successful
payment* (you get the green confirmation and a receipt download) or *Simulate failed payment* (you get an error
and can try again). The *View order status* link opens `/order?id=…`, which updates by itself.

To change settings locally, copy `.env.example` to `.env.local` and fill in values; `npm run dev` reads it.

---

## Rebranding

Two files control the look and wording. You don't need to touch any other code.

- **`public/config/brand.js`** — names and text: brand mark, page title, hero heading and intro, organisation
  name, order ID prefix (e.g. `TEDX` → `TEDX-20261029-K3F9QZ`), receipt file name, support email, catalogue
  sections (Winter / Summer / Accessories) and the image disclaimer.
- **`public/css/tokens.css`** — colours, fonts, sizes, corner radii and shadows. Change `--red` to change the
  accent colour everywhere, for example.

---

## Google Sheets setup

The site uses one Google Sheet as its database. A Google "service account" (a robot user) reads and writes it.

### 1. Create the service account

1. Go to <https://console.cloud.google.com/> and create a new project (e.g. "tedx-merch").
2. In **APIs & Services → Library**, search for **Google Sheets API** and click **Enable**.
3. In **APIs & Services → Credentials**, click **Create credentials → Service account**. Give it a name
   (e.g. "merch-store") and finish. No roles are needed.
4. Open the new service account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
   Keep it private — it is a password. Don't commit it, email it or put it in the Sheet.
5. From the JSON file you need two values: `client_email` and `private_key`.

### 2. Create and share the spreadsheet

1. Create a new Google Sheet (e.g. "TEDx Merch Orders").
2. Click **Share** and add the service account's email (the `client_email`, ending in
   `iam.gserviceaccount.com`) as **Editor**. Untick "Notify people".
3. **Share it only with the service account and the organisers who need it.** Never set it to "Anyone with
   the link" — it contains customers' names, emails and phone numbers.
4. Copy the sheet ID from the URL: `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

### 3. Set the environment variables

| Variable | Value |
|---|---|
| `GOOGLE_SHEET_ID` | the ID from the URL |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` from the JSON file |
| `GOOGLE_PRIVATE_KEY` | `private_key` from the JSON file |

About `GOOGLE_PRIVATE_KEY`: the key spans several lines. In the JSON file the line breaks are written as `\n`.
You can paste it exactly like that — the app turns `\n` into real line breaks. In `.env.local`, wrap it in double
quotes:

```bash
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...\n...\n-----END PRIVATE KEY-----\n"
```

On Vercel, paste the value without the surrounding quotes.

### 4. Create the tabs

```bash
npm run setup-sheet -- --dry-run   # shows what it would do, changes nothing
npm run setup-sheet                # creates the tabs and headers, fills Catalogue and Config
```

It creates the tabs **Catalogue**, **Orders** and **Config** if they're missing, writes the header rows and
freezes row 1. It fills Catalogue (from `data/products.json`) and Config only if those tabs are empty, so it's
safe to run again. It never overwrites existing data.

### 5. The three tabs

The exact columns are in [CONTRACT 4.3](docs/CONTRACT.md#43-google-sheet-tabs). In short:

- **Catalogue** — `sku`, `name`, `price`, `category`, `apparel`, `printing`, `imageUrl`, `active`, `stock`.
  One row per product.
- **Orders** — written by the site, one row per order: Order ID, dates, Status, customer details, Items,
  totals, payment details, Review Flag. Don't rename, reorder or edit these columns by hand. To track
  fulfilment (handed over, etc.), use a separate tab or a copy of the sheet.
- **Config** — `key` / `value` rows: `PRINTING_CHARGE` (rupees per printed item), `STORE_OPEN` (`TRUE`/`FALSE`;
  `FALSE` stops new orders) and `MAX_QUANTITY_PER_SKU` (1–20).

### Editing the catalogue

- **Prices**: change `price` (rupees, up to 2 decimals). New orders use the new price; existing orders keep
  theirs.
- **Hide a product**: set `active` to `FALSE`.
- **Stock**: leave `stock` blank for unlimited, `0` for "out of stock", or a number to cap the quantity per
  order. Stock is **not** reduced automatically when orders come in — update it yourself.
- **Category**: `Winter`, `Summer` or `Accessories`. If it's blank, the site guesses from the name (hoodie,
  jacket… → Winter; t-shirt, polo… → Summer; anything else → Accessories).
- **`apparel`** `TRUE` means the customer must pick a size. **`printing`** `TRUE` means name printing is offered.

Changes show up on the site within about **60 seconds** (the server keeps a 60-second cache).

### Product images from Google Drive

1. Upload the image to Google Drive.
2. Right-click → **Share** → General access: **Anyone with the link** (Viewer).
3. Copy the file ID from the share link (`https://drive.google.com/file/d/`**`FILE_ID`**`/view`).
4. In the `imageUrl` column put: `https://drive.google.com/thumbnail?id=FILE_ID&sz=w1200`

You can also use images in `public/images/` (e.g. `/images/hoodie-black.svg`). Leave `imageUrl` blank for no
image. Note: the site's security policy only loads images from the site itself, Google Drive
(`drive.google.com`, `*.googleusercontent.com`) and Cashfree. Images hosted elsewhere won't show unless the
`img-src` part of the Content-Security-Policy in `vercel.json` is extended.

---

## Cashfree sandbox setup

Start with the **sandbox** (test mode): it behaves like the real thing, but no real money moves.

1. Create a Cashfree merchant account at <https://merchant.cashfree.com/> (sign up for Payment Gateway).
2. In the dashboard, switch to **Test / Sandbox** mode (toggle at the top).
3. Go to **Developers → API Keys** and generate sandbox keys. You get an **App ID** and a **Secret Key**.
4. Set:
   ```bash
   CASHFREE_APP_ID=<sandbox App ID>
   CASHFREE_SECRET_KEY=<sandbox Secret Key>
   CASHFREE_ENV=sandbox
   SITE_URL=https://<your-domain>   # e.g. your Vercel preview/production URL
   ```
   When both keys are set the site switches from mock payments to Cashfree automatically. The payment
   section then shows "Sandbox mode — no real money is charged".
5. **Domain whitelisting**: if Cashfree asks you to whitelist your domain (Developers → Whitelisting), add
   your site's domain. Production always needs it.
6. **Webhook**: in the dashboard go to **Developers → Webhooks**, add
   `https://<your-domain>/api/cashfree-webhook` for **Payment Gateway** events, and pick the **latest webhook
   version**. Cashfree signs each webhook with your Secret Key; the site checks the signature.
   (Webhooks can't reach `localhost`. Locally the site still confirms payments through `verify-payment`.)

### Test payments

Cashfree publishes test UPI IDs, card numbers and net-banking options for the sandbox on its "Test data" page:
<https://www.cashfree.com/docs/payments/online/resources/sandbox-environment>. Use the values listed there
(they include both success and failure cases). We don't copy them here because Cashfree may change them.

### What to check after a sandbox payment

- [ ] The browser shows the green "Payment received" message and the receipt downloads.
- [ ] In the Sheet, the order's `Status` is `Paid`, with `Payment ID`, `Payment Method` and `Paid At` filled
      in and `Review Flag` empty.
- [ ] In the Cashfree dashboard (Test mode) the transaction shows with the same Order ID and amount.
- [ ] Under Developers → Webhooks the delivery log shows a successful (HTTP 200) delivery to
      `/api/cashfree-webhook`.
- [ ] A failed test payment shows the error message and leaves the order `Failed` (then try again and pay).
- [ ] The `/order?id=…` page shows the right status.

---

## Environment variables

| Name | Needed | Default | What it does |
|---|---|---|---|
| `SITE_URL` | production | the request's host (dev only) | Your public address, e.g. `https://merch.example.com`, no trailing slash. Used for CORS and Cashfree return/notify URLs. |
| `GOOGLE_SHEET_ID` | for Sheets | — | Spreadsheet ID. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | for Sheets | — | Service account email. |
| `GOOGLE_PRIVATE_KEY` 🔒 | for Sheets | — | Service account private key (PEM; `\n` allowed). |
| `CASHFREE_APP_ID` | for real payments | — | Cashfree App ID. |
| `CASHFREE_SECRET_KEY` 🔒 | for real payments | — | Cashfree Secret Key (also used to check webhook signatures). |
| `CASHFREE_ENV` | no | `sandbox` | `sandbox` or `production`. |
| `CASHFREE_API_VERSION` | no | `2026-01-01` | Cashfree API version header. |
| `PAYMENT_MODE` | no | auto | Empty = Cashfree if both keys are set, otherwise mock. `mock` forces demo payments. `cashfree` without keys makes ordering unavailable. |
| `ALLOW_MOCK_IN_PRODUCTION` | no | `false` | Mock payments are refused on a Vercel production deployment unless this is `true` (only for public demos). |
| `PRINTING_CHARGE` | no | `0` | Rupees per printed item. The Config tab overrides it. |
| `ORDER_EXPIRY_MINUTES` | no | `30` | How long a customer has to pay (minimum 16). |
| `RECONCILE_MIN_AGE_MINUTES` | no | `10` | The reconcile job only re-checks orders older than this. |
| `CRON_SECRET` 🔒 | production | — | Long random string; protects `/api/reconcile`. Vercel Cron sends it automatically. |
| `WEBHOOK_TOLERANCE_SECONDS` | no | `300` | How old/new a webhook timestamp may be. |
| `RESEND_API_KEY` 🔒 | no | — | Enables receipt emails via [Resend](https://resend.com/) (needs `EMAIL_FROM` too). |
| `EMAIL_FROM` | no | — | Sender, e.g. `TEDxIIMRohtak Merch <merch@yourdomain>` (domain verified in Resend). |
| `LOCAL_DATA_DIR` | no | `tedx-merch` in the system temp folder | Where demo mode stores `orders.json`. |
| `TRUST_PROXY` | no | `true` | Read the client IP from `x-forwarded-for` (correct on Vercel). |
| `PORT` | no | `3000` | Port for `npm run dev`. |

🔒 = secret. Never put these in `brand.js`, the Sheet, chat messages or Git.

**Locally:** copy `.env.example` to `.env.local` (it is git-ignored) and fill it in.

**On Vercel:** Project → **Settings → Environment Variables**. Add each variable, mark the 🔒 ones as
**Sensitive**, and choose the environments. Use **different values for Preview and Production**: sandbox
Cashfree keys (and ideally a test copy of the Sheet) for Preview, live keys and the real Sheet for Production.
After changing variables, redeploy for them to take effect.

---

## Deploy to Vercel

1. Push this repository to GitHub (or GitLab/Bitbucket).
2. In Vercel: **Add New → Project → Import** the repository.
3. Framework preset: **Other**. Build command: **none**. Output directory: `public` (already set in
   `vercel.json`, together with clean URLs, security headers and the cron job).
4. Add the environment variables (see above), including a `CRON_SECRET` — for example the output of
   `openssl rand -hex 32`.
5. Click **Deploy**.
6. Set `SITE_URL` to the final address (your custom domain, or the `*.vercel.app` URL) and **redeploy**.
7. In Cashfree, set the webhook URL to `https://<that address>/api/cashfree-webhook`.
8. Do one test order end to end (see the checklist above).

**The reconcile cron.** `vercel.json` runs `/api/reconcile` once a day (`0 3 * * *`, i.e. 03:00 UTC). That's the
most the Hobby plan allows, and Hobby may run it at any time within that hour. On the Pro plan you can run it more
often by changing the schedule in `vercel.json`, e.g. `"*/15 * * * *"` for every 15 minutes. You can also run it
yourself:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/reconcile
```

---

## API reference

All endpoints return JSON. Errors always look like
`{ "error": { "code": "…", "message": "…", "fields": { … } } }`. Full details are in
[CONTRACT section 5](docs/CONTRACT.md#5-http-api).

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /api/catalogue` | Active products, sizes, printing charge, store open, payment mode | Cached 60 s at the edge |
| `POST /api/create-order` | Validate, price on the server, store the order, create the Cashfree order | 10/min/IP. Returns `orderId`, `token`, `paymentSessionId`, `total` |
| `POST /api/verify-payment` | Ask Cashfree for the latest status and return the order | 30/min/IP. Needs `orderId` + `token` |
| `GET /api/order-status?id=…&token=…` | Order status page data | 60/min/IP. Wrong token = 404 |
| `POST /api/cashfree-webhook` | Cashfree payment notifications | Signature + timestamp checked; 404 in mock mode |
| `GET\|POST /api/reconcile` | Re-check old unpaid orders | `Authorization: Bearer <CRON_SECRET>` |
| `POST /api/mock-pay` | Simulated payment outcome | Demo mode only (404 otherwise) |

---

## Security notes

- **Secrets live only in environment variables** (Vercel or `.env.local`), never in the code, the browser, the
  Sheet or logs.
- **Server-side validation and pricing.** Every field is checked on the server (unknown fields are rejected), and
  prices and totals come only from the Catalogue tab.
- **Webhook signature and timestamp checks** on the raw request body, using constant-time comparison; stale or
  future timestamps are rejected.
- **Re-confirmation with Cashfree.** Status always comes from a server-to-server *Get Order* call, and the paid
  amount must match.
- **Token-protected order pages.** Each order gets a random 43-character access token, given only to the
  customer. The Sheet stores only its SHA-256 hash. A wrong token gets the same "not found" answer as a
  non-existent order, so order IDs can't be guessed or enumerated. The token is never put in Cashfree's return
  URL.
- **Constant-time comparisons** for tokens, the cron secret and signatures.
- **Rate limiting** per IP on the public endpoints.
- **Security headers and a strict Content Security Policy** (only our own scripts plus Cashfree's SDK; no inline
  scripts), HSTS, `X-Frame-Options`, `nosniff`, a restrictive Permissions-Policy.
- **CORS locked to `SITE_URL`.** Requests from other websites get `403 forbidden_origin`.
- **Spreadsheet formula-injection protection.** Text starting with `=`, `+`, `-`, `@`, tab or carriage return is
  stored with a leading `'` so Sheets never runs it as a formula.
- **No personal data in logs.** Names, emails, phones, roll numbers, tokens and secrets are never logged, and no
  stack traces are shown to users.
- **The Sheet is shared only with the service account** (and the organisers who need it).
- Customers' phone numbers are masked (`******3210`) on the order page and receipt.

---

## Going-live checklist

- [ ] Cashfree merchant account **KYC-approved and activated** (business verification done).
- [ ] **Production** API keys generated; `CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY` set for Production only,
      and `CASHFREE_ENV=production`.
- [ ] Production domain **whitelisted** in Cashfree.
- [ ] Webhook `https://<domain>/api/cashfree-webhook` configured in Cashfree **production** mode (latest version).
- [ ] A **Vercel plan suitable for commercial use**. The Hobby plan is for personal, non-commercial use; an
      organisation collecting payments should use **Pro**.
- [ ] Custom domain with HTTPS; `SITE_URL` set to it; redeployed.
- [ ] **Privacy policy, terms & conditions, refund/cancellation policy and contact page** on the site. Cashfree
      requires these for activation.
- [ ] Mock mode off: `PAYMENT_MODE` empty (or `cashfree`) and `ALLOW_MOCK_IN_PRODUCTION=false`. The payment
      section must *not* show "DEMO MODE".
- [ ] `CRON_SECRET` set; reconcile cron visible under the project's **Settings → Cron Jobs**.
- [ ] One **real low-value payment** end to end (check the Sheet, the Cashfree dashboard and the webhook log),
      then **refund it** from the Cashfree dashboard to make sure refunds work.
- [ ] Sheet sharing reviewed: only the service account and the organisers who need access.
- [ ] Receipt email (optional): domain verified in Resend, `RESEND_API_KEY` and `EMAIL_FROM` set; test email
      received.
- [ ] Sheet backed up (File → Make a copy, or File → Download) before and during the sale.

---

## Known limitations

- **Google Sheets is not a real database.** There are no transactions or row locks, so two updates to the same
  order at exactly the same moment could clash (the code re-reads before writing and never overwrites Paid, which
  is fine at our scale). Google's API quota is roughly 60 requests per minute per user. That's comfortable for a
  few hundred orders over a sale, not for a flash sale with hundreds of people paying in the same minute.
- **Stock is not reduced automatically.** The `stock` column caps quantities and marks items out of stock, but
  you update the numbers yourself.
- **Rate limits and status-check throttles are kept in memory.** They reset when Vercel starts a new instance
  and are per instance, so they are a speed bump, not a hard guarantee. For strict limits use a shared store
  such as Upstash Redis / Vercel KV.
- **One line per SKU.** Each product can appear only once per order, so two sizes of the same hoodie need two
  separate orders — the same as the current form.
- **Demo-mode storage is temporary.** Without Google settings, orders are saved in a local file. On Vercel that
  file is per instance and disappears; use demo mode only for trying the site.
- **Reconcile runs daily on Hobby.** Most payments are confirmed within seconds by `verify-payment` or the
  webhook; the cron is a safety net. Upgrade to Pro for a more frequent schedule.
- **Receipt email is optional** and only sent when Resend is configured. Customers can always download the
  receipt and open their order page.
- **Cashfree details were taken from Cashfree's official Node SDK (`cashfree-pg` v6.0.6) and search results**,
  because Cashfree's documentation site couldn't be reached from the build environment. Re-check the API
  version, webhook format and dashboard steps against Cashfree's live docs before going live.

---

## Project structure, tests and checks

```text
api/                  serverless functions (one file per endpoint)
  catalogue.js  create-order.js  verify-payment.js  order-status.js
  cashfree-webhook.js  reconcile.js  mock-pay.js
lib/                  shared server code
  sheets.js     Google Sheets / local-file storage, catalogue, config
  cashfree.js   Cashfree REST client, webhook signature check, mock gateway
  orders.js     order status rules and syncOrder
  pricing.js    server-side pricing (paise)
  validate.js   request validation
  tokens.js     access tokens, order IDs, constant-time compare
  ratelimit.js  in-memory rate limiting
  http.js       JSON responses, CORS, body reading, logging
  email.js      optional receipt email (Resend)
public/               the website (index.html, order.html, mock-checkout.html, css/, js/, images/)
  config/brand.js     ← rebrand here
  css/tokens.css      ← colours and fonts here
data/products.json    fallback catalogue (used in demo mode or if the Sheet can't be read)
scripts/
  dev-server.js       local server for `npm run dev`
  setup-sheet.js      creates the Sheet tabs (`npm run setup-sheet`)
tests/                automated tests (node:test, no extra dependencies)
docs/CONTRACT.md      full specification
vercel.json           routing, headers, cron
.env.example          template for .env.local
```

Run the tests (offline, about a second; they use mock payments, a stubbed Cashfree API and temporary local
storage, so no accounts or network are needed):

```bash
npm test
```

Check every JavaScript file for syntax errors:

```bash
npm run check
```
