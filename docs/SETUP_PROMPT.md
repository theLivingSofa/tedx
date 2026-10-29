# Setup prompt for Claude Code Desktop

Paste everything below the line into a Claude Code Desktop session on your own computer, with the Claude in
Chrome extension connected. Replace `<GITHUB_URL>` with the repository URL. Stay nearby: you will need to sign
in, enter one-time codes and approve a few steps yourself.

---

You are setting up and deploying the "Merch Store – TEDxIIMRohtak" site from <GITHUB_URL> (branch
`claude/festive-turing-bznk0k`). It is a plain HTML/JS frontend with Vercel serverless functions, Google Sheets as
the data store and Cashfree Payment Gateway (sandbox) for payments. Use the terminal for code and CLIs, and
Claude in Chrome for web dashboards. Work through the phases in order and give me a short status after each one.

## Ground rules
- Never paste secrets (private keys, Cashfree secret, CRON_SECRET, Resend key) into this chat, into files that get
  committed, or into any website other than the one they belong to. Secrets go only into `.env.local` (git-ignored)
  and Vercel environment variables. Before every commit, run `git status` and make sure no `.env*` file other than
  `.env.example` and no `*.json` key file is staged.
- Whenever a page needs my login, a one-time code, CAPTCHA, phone/email verification, PAN/KYC details, or a
  payment method, stop and ask me to do that step in Chrome, then continue.
- Use sandbox / test mode only. Do not request Cashfree production keys or submit KYC.
- Don't open browser dialogs you can't dismiss; if a page stops responding, tell me.
- Read `README.md` and `docs/CONTRACT.md` first; they are the source of truth for every setting below.

## Phase 1 – Get the code running locally
1. Clone the repo, check out `claude/festive-turing-bznk0k`, check `node -v` is 22 or newer, then run
   `npm install`, `npm test` (all tests must pass) and `npm run check`.
2. Run `npm run dev` and open http://localhost:3000 in Chrome. Place a demo order (add a hoodie with a size and a
   mug, fill the form, Pay securely, "Simulate successful payment"). Confirm the green "Payment received"
   message, the receipt download and the order page. Stop the dev server.

## Phase 2 – Google Sheets (README section "Google Sheets setup")
1. In Chrome, open https://console.cloud.google.com and create a project named `tedx-merch-store` (ask me to sign
   in with the Google account the organising team will own).
2. Enable the **Google Sheets API** for that project.
3. Create a service account `merch-store-writer` (no roles needed). Create a **JSON key** for it; Chrome downloads
   it. Move the file out of Downloads to a safe folder outside the repo and tell me where it is.
4. Create a new Google Sheet named `TEDxIIMRohtak Merch Orders`. Share it with the service account's email as
   **Editor** only (untick "Notify people"). Do not share it publicly.
5. Create `.env.local` in the repo (it is git-ignored) with `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL` and
   `GOOGLE_PRIVATE_KEY` taken from the sheet URL and the JSON key file. Use a small Node one-off script to read the
   key from the JSON file and write it into `.env.local`, so the key never appears in this chat.
6. Run `npm run setup-sheet -- --dry-run`, then `npm run setup-sheet`. Check in Chrome that the Catalogue,
   Orders and Config tabs exist with headers and 30 products.

## Phase 3 – Cashfree sandbox (README section "Cashfree sandbox setup")
1. In Chrome, open https://merchant.cashfree.com and sign up or log in (ask me for the login, OTP and any business
   details). Switch the dashboard to **Test / Sandbox** mode.
2. Developers → API Keys: generate sandbox keys. Put `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY` straight into
   `.env.local` together with `CASHFREE_ENV=sandbox` (ask me to copy the secret into the file myself if you can't
   do it without showing it in chat).
3. Read Cashfree's current docs for Create Order, Get Order, webhook signature verification and JS SDK v3 at
   https://www.cashfree.com/docs and compare them with `lib/cashfree.js`, `api/cashfree-webhook.js` and
   `public/js/checkout.js`. The code was written from the official Node SDK `cashfree-pg` 6.0.6 because the docs
   site was unreachable when it was built. Check especially: the `x-api-version` value (code uses `2026-01-01`), the
   webhook signature recipe (base64 HMAC-SHA256 of `x-webhook-timestamp` + raw body with the secret key) and the
   timestamp unit (code assumes milliseconds). Report any difference before changing code; if a change is
   needed, make it with a test, run `npm test`, and commit it on the same branch.
4. Run `npm run dev` again (now in Cashfree sandbox mode) and pay for a small order in Chrome with a test method
   from Cashfree's sandbox "test data" page. Confirm the order turns Paid in the Orders tab with Review Flag
   `TEST_PAYMENT_SANDBOX`. (Webhooks can't reach localhost; that is fine here.)

## Phase 4 – Deploy to Vercel (README section "Deploy to Vercel")
1. In Chrome, open https://vercel.com, sign in with GitHub (ask me), and import the repository. Framework preset
   "Other", no build command, leave the rest as `vercel.json` sets it. Use the `claude/festive-turing-bznk0k`
   branch as the production branch, or ask me whether to merge it into the default branch first.
2. Add environment variables for the **Production** environment only (not Preview): `GOOGLE_SHEET_ID`,
   `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`,
   `CASHFREE_ENV=sandbox`, and `CRON_SECRET` (generate a random 48-character value locally). Mark secrets as
   Sensitive. Prefer the Vercel CLI (`npx vercel link`, then `npx vercel env add NAME production` reading the
   value from `.env.local` on stdin) so secrets are never typed in the browser or shown in chat.
3. Deploy. Then set `SITE_URL` to the production URL (e.g. `https://<project>.vercel.app`, no trailing slash) and
   redeploy.
4. In the Cashfree sandbox dashboard, add the webhook URL `https://<production-url>/api/cashfree-webhook` for
   Payment Gateway events (latest webhook version).
5. Check that the reconcile cron appears under the project's Settings → Cron Jobs.

## Phase 5 – Verify the live sandbox deployment
1. Open the production URL in Chrome. `/api/catalogue` must show `"source": "sheet"` and
   `"payment": {"mode": "cashfree", "environment": "sandbox"}`.
2. Place a sandbox order and pay with Cashfree test data. Confirm: green "Payment received" message, receipt
   download, the `/order?id=…` page shows Paid, the Orders row is Paid with `TEST_PAYMENT_SANDBOX`, and the
   Cashfree dashboard's webhook log shows an HTTP 200 delivery to `/api/cashfree-webhook`.
3. Place one more order and choose a failing test method; it must show the failure message and the row must
   be `Failed`.
4. Run `curl -H "Authorization: Bearer $CRON_SECRET" https://<production-url>/api/reconcile` (read
   CRON_SECRET from `.env.local` without printing it) and check it returns `{"checked": …}`.
5. Check the browser console on the store page for CSP errors (the Cashfree SDK must load).

## Finish
Give me: the production URL, the Sheet URL, what passed, anything that failed or differed from the README or the
Cashfree docs, any commits you pushed, and what remains for going live (the README's "Going-live checklist":
production Cashfree keys after KYC, Vercel Pro for commercial use, custom domain, privacy/terms/refund/contact
pages). Close the browser tabs you opened.
