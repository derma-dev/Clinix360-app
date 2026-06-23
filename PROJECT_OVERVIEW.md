# Clinix360 Cashup — Project Overview

A complete walkthrough of **what this project is, why it exists, how it works, how to run it, and where it runs.** Read this first; then dive into `HANDOFF.md` (developer detail), `SUPABASE_SCHEMA.sql` (the live database), and `README.md` (original setup steps).

---

## 1. What it is

Clinix360 Cashup is a **daily cash-up / end-of-day (EOD) reconciliation app** for a small chain of skin clinics (currently 3 branches in Delhi: Janakpuri, Kirti Nagar, Dwarka Sec 12).

At the end of each day, branch staff record every sale, split cash vs non-cash, log expenses and extra cash, then enter the actual money counted in the till. The app calculates what *should* be in the till, flags any **variance**, and lets the admin/accountant see KPIs, run reports, and manage the chain. A newer **Lead Hub** captures prospective customers (including auto-ingesting Instagram DMs via Meta webhooks).

Live at **https://clinix360.ai**.

> Naming note: the codebase still carries its original name "DSkin Cashup" in a few places (`package.json`, `config.js`, older comments). It is the same app — rebranded to Clinix360.

---

## 2. Why it exists

Manual cash reconciliation across multiple branches is error-prone and hard to audit. This app gives:

- **Staff** a phone-friendly sheet to close the day in minutes (no account, just a 4-digit branch PIN).
- **Owners/admin** a single view of every branch's cash position, automatic variance alerts when the till doesn't match, scheduled email/webhook reports, and a leads pipeline.
- **Accountants** read-only oversight.

It is deliberately **dependency-light** (no build step, no framework) so it is cheap to host and easy to hand off.

---

## 3. Tech stack

| Layer        | Technology |
|--------------|------------|
| Frontend     | Plain **HTML + CSS + vanilla JS** single-page app. No framework, no build step. |
| Charts       | **Chart.js** 4.4.1 (CDN) |
| Database     | **Supabase** (Postgres + PostgREST REST API) |
| DB client    | **supabase-js** v2 (CDN) — browser talks to Postgres directly with the public anon key |
| Serverless   | **Netlify Functions** (Node 18) for email, report automations, config delivery, and Meta webhooks |
| Email        | **Resend** API |
| Social        | **Meta Graph API** (Instagram DM ingestion → leads) |
| Hosting      | **Netlify** (static site + functions, auto HTTPS) |

### File map

```
index.html                 # all screens + modals in one file (home, PIN, dashboard, cashup, admin)
app.js                     # ALL app logic (~2800 lines): routing, auth, cashup math, admin, leads
styles.css                 # all styling
config.js                  # non-secret app config (admin email, currency ₹, timezone, app URL)
netlify.toml               # functions dir + webhook redirect + SPA catch-all redirect
package.json               # one dep: @netlify/functions (to bundle the scheduled function)
SUPABASE_SCHEMA.sql        # CURRENT live DB schema — source of truth for the database
supabase-schema.sql        # original day-1 schema (stale, kept for history)
.env.example               # template for local function env vars
HANDOFF.md / README.md     # developer handoff / original setup guide
netlify/functions/
  get-config.js            # returns Supabase URL + anon key to the browser from env vars
  meta-webhook.js          # GET verify + POST receive for Meta (Instagram) → /webhook/meta
  meta-send.js             # (stub) outbound Instagram/FB replies — Phase 2, not built
  send-feedback-email.js   # staff feedback  -> admin email
  send-variance-alert.js   # till variance   -> admin email
  send-pin-email.js        # "Forgot PIN"    -> emails the ADMIN PIN to the admin only
  send-automation-report.js# report automation: emails a .doc report (Resend)
  send-automation-webhook.js# report automation: POSTs report text to a webhook
  check-automations.js     # scheduled (cron) function: fires daily scheduled automations
  utils/meta-service.js    # Meta verify + webhook handling + Supabase REST helpers
```

---

## 4. How it works (architecture & flow)

### 4.1 Boot sequence

1. Browser loads `index.html`, which pulls supabase-js + Chart.js from CDN, then `config.js`, then `app.js`.
2. `app.js` → `init()`:
   - `fetch('/.netlify/functions/get-config')` to get the Supabase URL + anon key **at runtime** (so secrets live in Netlify env vars, not in shipped files).
   - Creates the Supabase client `db`.
   - Loads branches, the admin PIN, and payment modes in parallel.
   - Binds events and `routeFromHash()` restores the last screen.

> The `get-config` indirection means `config.js` itself contains **no** Supabase credentials — only non-secret config (admin email, currency, timezone, app URL). (`HANDOFF.md` predates this and describes the old "creds in config.js" approach.)

### 4.2 Screens & routing

- Each screen is a `<div class="screen">`; `showScreen(name)` toggles the active one. Screens: `home` (branch picker) → `pin` → `dashboard` (branch panel) → `cashup` (the sheet) → `admin-panel`.
- **Hash routing**: `#/branch/cashup|emails|leads`, `#/cashup/<date>`, `#/admin/<tab>`. Browser back/forward works.
- **Session** persisted in `localStorage` key `clinix_session` with a **24h TTL** (`saveSession`/`loadSession`/`clearSession`), so refresh keeps you logged in on the same page.

### 4.3 Authentication (PIN-based, no accounts)

- **Branch login** = 4-digit `branches.pin`. **Admin login** = `settings.admin_pin`.
- `verifyPIN()` routes to the branch dashboard or the admin panel. There are **no Supabase Auth users**.
- **Accountants**: emails listed in `config.js → ACCOUNTANT_EMAILS` get view-only access.
- **Forgot PIN**: always emails the **admin PIN to the admin email only** (recovery path for admin, decoy for staff); the email names which branch triggered it.

### 4.4 The cashup form (the core)

`openCashupForm` / `saveCashup`:

- Staff add **sales entries** (product/service, customer, amount, payment mode, staff), a **daily summary**, **add-extra cash** lines, and **expense** lines.
- **Smart fill**: product/service, staff, and names autocomplete from past entries.
- On **Submit Final**, every entry with an amount must have a Product/Service (validated client-side before any write).
- `saveCashup` **deletes that day's rows then re-inserts** them — a full overwrite per save.

**Closing math:**

```
closing = opening_balance + cash_sales − cash_handover + add_extra − expenses
```

- `cash_sales` = sum of entries where `payment_type == 'cash'`.
- "Less Scan" / non-cash = every entry where `payment_type != 'cash'`.
- At submit, staff enter the **actual** till count. `variance = actual − calculated`. A non-zero variance writes a row to `cashup_alerts` and (optionally) emails the admin via `send-variance-alert`.

### 4.5 Payment modes (admin-managed)

- Stored as JSON in `settings.payment_modes`; edited in Admin → Settings → Payment Modes.
- The entry dropdown and report labels read from it live. `'cash'` is locked (the cash/non-cash split depends on it).
- The old DB `CHECK` constraint on `payment_type` was **dropped** so new modes save freely. Codes in use: `cash, scan, upi, icici_machine, pinelab, bajaj_finance, savein, cheque`.

### 4.6 Admin panel

Tabs: **Overview** (branches + KPIs: this/last week, this/last month), **Reports**, **Notifications** (variance alerts + staff feedback), **Settings** (Automations, Payment Modes, Change Admin PIN — collapsible). Admin can override the date to view/edit any day for any branch.

### 4.7 Report automations

- Defined in `cashup_automations`: trigger `weekly | monthly | single_date`, mode `on_submit | scheduled`, action `email | webhook`.
- `on_submit` automations fire when a cashup is finalised.
- `scheduled` automations are fired daily by `check-automations.js` (a **Netlify scheduled/cron function**), which calls `send-automation-report` (Resend email) or `send-automation-webhook` (HTTP POST). `last_sent_at` guards against duplicates.

### 4.8 Lead Hub + Meta (Instagram) ingestion

- `leads`, `lead_notes`, `lead_messages` tables back a per-branch leads pipeline (status: new → contacted → converted → lost).
- **Inbound Instagram DMs**: Meta calls `/webhook/meta` (redirected to `meta-webhook.js`):
  - `GET` answers Meta's verification challenge (`META_VERIFY_TOKEN`).
  - `POST` → `handleWebhook()` in `utils/meta-service.js`: for each Instagram `messages` change it finds-or-creates a lead by `instagram_user_id` (branch = `META_BRANCH_ID`), then inserts the message into `lead_messages` (`direction: 'incoming'`).
- **Outbound replies** (`meta-send.js`, `sendInstagramMessage`) are **Phase 2 stubs — not yet built.**

### 4.9 Data model (Supabase)

Tables: `branches`, `cashup_entries`, `cashup_summaries`, `cashup_expenses`, `cashup_extras`, `cashup_alerts`, `cashup_feedback`, `cashup_automations`, `settings`, `leads`, `lead_notes`, `lead_messages`. Full DDL + comments live in **`SUPABASE_SCHEMA.sql`**.

> **Security model:** RLS is **disabled** on every table. The browser uses the public **anon key** with full read/write. Security is enforced at the **app/PIN layer only**. A future hardening would add RLS + real auth. Do not treat the anon key as a secret boundary.

---

## 5. How to run it

### 5.1 Prerequisites

- Node.js 18+ and npm.
- A Supabase project (schema applied from `SUPABASE_SCHEMA.sql`).
- A Resend API key (for emails).
- Meta app credentials (only if testing Instagram ingestion).
- Netlify CLI for functions/deploy: `npx netlify-cli@22`.

### 5.2 Local development

The frontend is fully static — no build step.

**Frontend only (against live Supabase):**

```bash
npx serve .          # or VS Code "Live Server"
```

Note: `init()` fetches `/.netlify/functions/get-config`, so a plain static server won't deliver Supabase creds. To exercise the full app locally, use `netlify dev` (below).

**Full app incl. functions:**

```bash
npm install
cp .env.example .env          # then fill in real values
npx netlify-cli@22 dev        # serves the site + functions locally with .env loaded
```

`.env` keys (see `.env.example`):

```
SUPABASE_URL, SUPABASE_ANON_KEY      # Supabase → Project Settings → API
RESEND_API_KEY                       # resend.com → API Keys
META_APP_ID, META_APP_SECRET,        # developers.facebook.com (Instagram ingestion)
META_VERIFY_TOKEN, META_ACCESS_TOKEN,
META_BRANCH_ID                       # branch UUID new IG leads attach to
```

### 5.3 First-time database setup

1. Create a Supabase project (Singapore region is closest to India).
2. SQL Editor → paste **`SUPABASE_SCHEMA.sql`** → Run. (`supabase-schema.sql` is the stale day-1 version — don't use it.)
3. Insert your branches with a starting PIN, and set `settings.admin_pin` and `settings.payment_modes`.

---

## 6. Where it runs (deployment)

- **Host:** Netlify site **dskin-cashup**, site ID `eabc30b1-b8d9-4d57-978f-c37ab643f35e`. Primary domain **clinix360.ai** (+ www), force-HTTPS on.
- **Function env vars** are set in **Netlify → Site settings → Environment** (NOT committed): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `RESEND_API_KEY`, and the `META_*` vars.
- **`netlify.toml`** wires: functions dir → `netlify/functions`; `/webhook/meta` → `meta-webhook` (must precede the catch-all); and `/*` → `/index.html` (SPA fallback).

**Deploy command:**

```bash
npm install
NETLIFY_AUTH_TOKEN=<your-token> npx netlify-cli@22 deploy --prod --dir . \
  --site eabc30b1-b8d9-4d57-978f-c37ab643f35e
```

> ⚠️ **Deploy-target warning (from README/HANDOFF):** this Cashup app deploys ONLY to site ID `eabc30b1-…f35e`. The separate Derma marketing site is a *different* Netlify site — never cross-deploy; doing so once (6–7 Jun 2026) overwrote the live Cashup app and broke staff access.

---

## 7. Quirks & gotchas

- **Timezone is Asia/Kolkata (IST).** All date logic uses `getISTDate()`; the cashup screen shows a live IST clock.
- **Save = full overwrite** of that branch/day's rows (delete-then-insert). Concurrent edits to the same day can clobber each other.
- The anon key is public by design (safe to ship). **Never commit** the Netlify deploy token or `RESEND_API_KEY`.
- **No automated tests.** Validate by running the flows locally (`netlify dev`) or after deploy.
- `meta-send.js` and the `sendInstagram/FacebookMessage` helpers are stubs — outbound replies aren't implemented.
- Resend currently sends from the shared `onboarding@resend.dev` sender; for production, verify a domain in Resend and switch the `from:` address.

---

## 8. Roadmap / in progress

- **Outbound Meta replies (Phase 2):** finish `meta-send.js` / `sendInstagramMessage` so staff can reply to IG/FB leads from the Lead Hub.
- **Clinicea auto-capture (not built):** when a *payment* is registered in Clinicea (the clinic's main software), auto-insert a prefilled row into that branch's cashup sheet. Plan: a `clinicea-webhook` function mapping Clinicea clinic→branch and mode→payment code, inserting into `cashup_entries` with a unique `clinicea_payment_id` + `source` for dedupe. (Open questions on webhook scope/branch identification are being verified by the owner.)
- **Security hardening:** add RLS + real auth instead of relying on the PIN/app layer.

---

*For deeper developer detail see `HANDOFF.md`; for the live database see `SUPABASE_SCHEMA.sql`.*
