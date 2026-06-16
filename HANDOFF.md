# Clinix360 Cashup — Developer Handoff

A daily cash-up / EOD reconciliation app for a 3-branch clinic chain. Live at **https://clinix360.ai**.

## Stack
- **Frontend:** plain HTML/CSS/vanilla JS single-page app (no framework, no build step). Files: `index.html`, `app.js`, `styles.css`, `config.js`.
- **Backend:** Supabase (Postgres + PostgREST). Frontend talks to it directly with the public anon key in `config.js`.
- **Serverless:** Netlify Functions (`netlify/functions/`) for email + automations (Resend).
- **Hosting:** Netlify (static + functions). Auto HTTPS.
- **Charts:** Chart.js (CDN). **Supabase JS:** CDN. Both loaded over https in `index.html`.

## File map
```
index.html                     # all screens (home, PIN, branch panel, cashup form, admin panel) + modals
app.js                         # all app logic (~2800 lines)
styles.css                     # all styling
config.js                      # Supabase URL + anon key, admin email, currency, timezone
netlify.toml                   # functions dir + SPA redirect
package.json                   # only dep: @netlify/functions (needed to bundle the scheduled fn)
SUPABASE_SCHEMA.sql            # CURRENT db schema (read this for the DB)
supabase-schema.sql            # ORIGINAL day-1 schema (stale — kept for history)
netlify/functions/
  send-feedback-email.js       # staff feedback -> admin email
  send-variance-alert.js       # closing-variance -> admin email
  send-pin-email.js            # "Forgot PIN" -> emails the ADMIN PIN to admin only
  send-automation-report.js    # report automation: emails a .doc report via Resend
  send-automation-webhook.js   # report automation: POSTs report text to a webhook
  check-automations.js         # scheduled (cron) fn: fires scheduled automations daily
```

## How the app works (orientation for app.js)
- **Screens** are `<div class="screen">`; `showScreen(name)` toggles the active one. Screens: `home` (branch picker), `pin`, `dashboard` (branch panel), `cashup` (the sheet), `admin-panel`.
- **Auth is PIN-based.** `branches.pin` = branch login; `settings.admin_pin` = admin login. `verifyPIN()` routes to the branch dashboard or admin panel. There are no Supabase Auth users.
- **Routing & sessions:** hash routes (`#/branch/cashup|emails|leads`, `#/cashup/<date>`, `#/admin/<tab>`). `routeFromHash()` restores state on load; session persisted in `localStorage` key `clinix_session` (24h TTL) so refresh keeps you logged in on the same page. See `setRoute`, `saveSession/loadSession/clearSession`.
- **Branch view** = left sidebar with 3 tabs: **Daily Cashup** (the working screen), **Emails** and **Leads** (placeholders, "Coming soon").
- **Cashup form** (`openCashupForm`, `saveCashup`): sales entries, daily summary, extra-cash, expenses. On **Submit Final**, every entry with an amount must have a Product/Service (validated client-side before any write). `saveCashup` deletes that day's rows then re-inserts (full overwrite per save).
- **Closing math:** `closing = opening + cash_sales - cash_handover + add_extra - expenses`. "Less Scan" / non-cash = every entry where `payment_type != 'cash'`.
- **Admin panel tabs:** Overview (branches + KPIs), Reports, Notifications (alerts + feedback), Settings (Automations, **Payment Modes**, Change Admin PIN — all collapsible).
- **Payment Modes** are admin-managed in `settings.payment_modes` (JSON). The entry dropdown + report labels read from it live. `'cash'` is locked. (DB CHECK constraint on `payment_type` was dropped so new modes save freely.)
- **Forgot PIN** always emails the **admin PIN** to the admin email only (recovery path for admin; decoy for staff). The email names which branch triggered it.

## Supabase
- Project ref: `plxhbtsncfkuvnywstgn` — dashboard: https://supabase.com/dashboard/project/plxhbtsncfkuvnywstgn
- **Schema: see `SUPABASE_SCHEMA.sql`** (current). Tables: branches, cashup_entries, cashup_summaries, cashup_expenses, cashup_extras, cashup_alerts, cashup_feedback, cashup_automations, settings.
- **RLS is disabled** on all tables; the anon key (in `config.js`) has full read/write. Security is at the app/PIN layer. (A future hardening would be to add RLS + proper auth — note for the dev.)
- Migrations are run via the Supabase SQL editor (no migration framework in the repo).

## Netlify
- Site: **dskin-cashup**, site ID `eabc30b1-b8d9-4d57-978f-c37ab643f35e`. Primary domain **clinix360.ai** (+ www alias). Force HTTPS on.
- **Function env vars** (set in Netlify → Site settings → Environment, NOT in the repo):
  `RESEND_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`.
- Deploy (CLI): `npm install` then
  `NETLIFY_AUTH_TOKEN=<your token> npx netlify-cli@22 deploy --prod --dir . --site eabc30b1-b8d9-4d57-978f-c37ab643f35e`
  (Generate your own Netlify token — none is included in this package.)
- Email is sent via **Resend** (currently from the shared `onboarding@resend.dev` sender → for production, verify a domain in Resend and switch the `from:` address).

## Local dev
No build step. Serve the folder statically (e.g. `npx serve .` or VS Code Live Server) and it runs against the live Supabase. Netlify Functions need `netlify dev` (Netlify CLI) plus the env vars above to run locally.

## In progress / next feature — Clinicea auto-capture (NOT built yet)
Goal: when a **payment is registered** in Clinicea (the clinic's main software) — not when a bill is generated — it should auto-insert a row into that branch's cashup sheet for that day (amount + payment mode + branch prefilled; Product/Service + Staff left for staff to fill at EOD).
- Clinicea has a REST API (`https://api.clinicea.com/api/v3/`, header `api_key`, Enterprise/add-on) with `getPayments` and webhooks (Tools → Org → Integrations → Webhooks).
- Open questions being verified by the owner: does one webhook receive all branches, does the payload identify the clinic/branch, and does it fire on payment vs bill.
- Planned: a `clinicea-webhook` Netlify function that maps Clinicea clinic→branch_id and Clinicea mode→our payment codes, then inserts into `cashup_entries` (store the Clinicea payment id for dedupe/edit/refund handling). Add columns `clinicea_payment_id` (unique) + `source` to `cashup_entries`.

## Notes / quirks
- `config.js` anon key is the public client key (safe to ship in frontend). Do not commit the Netlify deploy token or `RESEND_API_KEY`.
- Timezone is Asia/Kolkata; date logic uses IST (`getISTDate`).
- No automated tests; validate changes by deploying and exercising the flows.
