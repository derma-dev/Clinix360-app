# Clinix360 Dashboard — Master Documentation

> **📌 MAINTENANCE RULE — read this first**
>
> **This file is the single source of truth for the project.** Every new integration,
> feature, schema change, env var, function, or behavioural change **must be reflected
> here in the same commit that ships it.** If you changed the website and this file
> still describes the old behaviour, the change is not done.
>
> Minimum update per change: the relevant section + a line in [§21 Change log](#21-change-log).
>
> Last updated: **2026-08-17** · Conversation-corpus export script (`scripts/export-conversations.js`, DB + `--meta` IG-history pull) — first step of the chatbot plan; corpus is dev test traffic only, see [§21](#21-change-log)

---

## Table of contents

1. [What this is](#1-what-this-is)
2. [Infrastructure & identifiers](#2-infrastructure--identifiers)
3. [Tech stack](#3-tech-stack)
4. [Complete file map](#4-complete-file-map)
5. [Boot sequence](#5-boot-sequence)
6. [Routing & session persistence](#6-routing--session-persistence)
7. [Authentication model](#7-authentication-model)
8. [Screens & UI](#8-screens--ui)
9. [The cashup form — exact math](#9-the-cashup-form--exact-math)
10. [Payment modes](#10-payment-modes)
11. [Admin panel](#11-admin-panel)
12. [Reports engine](#12-reports-engine)
13. [Report automations](#13-report-automations)
14. [Lead Hub / Unified Inbox](#14-lead-hub--unified-inbox)
15. [Messaging integrations (Instagram / Facebook / WhatsApp)](#15-messaging-integrations-instagram--facebook--whatsapp)
16. [Netlify Functions reference](#16-netlify-functions-reference)
17. [Database schema](#17-database-schema)
18. [Environment variables](#18-environment-variables)
19. [Local development, deploy & rollback](#19-local-development-deploy--rollback)
20. [Security model, quirks & known issues](#20-security-model-quirks--known-issues)
21. [Change log](#21-change-log)
22. [Roadmap / open items](#22-roadmap--open-items)
23. [Companion documents](#23-companion-documents)

---

## 1. What this is

**Clinix360 Cashup** is a daily cash-up / end-of-day (EOD) reconciliation app for a small
chain of skin clinics — currently **3 branches in Delhi**: Janakpuri, Kirti Nagar,
Dwarka Sec 12.

Two products live in one app:

| Product | Who uses it | What it does |
|---|---|---|
| **Cashup** | Branch staff, admin, accountants | Staff log every sale (cash / non-cash), extra cash, and expenses, then count the till. The app computes the expected closing balance, flags **variance**, and stores the day. Admin gets KPIs, reports, and automated email/webhook delivery. |
| **Lead Hub** | Branch staff, admin | A unified social inbox. Instagram DMs, Facebook Messenger messages, and WhatsApp messages land automatically as **leads** with a message timeline; staff can reply from the dashboard. Admin gets a cross-branch pipeline with KPIs and status tracking. |

Design constraint: **deliberately dependency-light** — no framework, no build step, no
bundler. Plain HTML + CSS + vanilla JS served statically, with Netlify Functions for
anything that needs a secret.

> **Naming note:** the codebase still carries the original name **"DSkin Cashup"** in
> `package.json`, `config.js`, `styles.css` headers, email templates and some comments.
> Same app — rebranded to **Clinix360**.

---

## 2. Infrastructure & identifiers

| Thing | Value |
|---|---|
| **Git repo** | `https://github.com/derma-dev/Clinix360-app.git` (branch `main`) |
| **Current Netlify site** | `eloquent-pothos-dc09dc` — site ID `8d124761-2d42-429e-84ab-ca963ec43250` (see [.netlify/state.json](.netlify/state.json)) |
| **Current site URL** | `https://eloquent-pothos-dc09dc.netlify.app` |
| **Legacy Netlify site** | `dskin-cashup` — site ID `eabc30b1-b8d9-4d57-978f-c37ab643f35e`, domain `clinix360.ai` (+ www). Referenced by older docs; the project was **migrated to a new GitHub repo + new Netlify account** in Jun 2026, Supabase reused. |
| **Supabase project ref** | `plxhbtsncfkuvnywstgn` → `https://plxhbtsncfkuvnywstgn.supabase.co` |
| **Supabase dashboard** | https://supabase.com/dashboard/project/plxhbtsncfkuvnywstgn |
| **Meta webhook endpoint** | `<site>/webhook/meta` (redirect defined in [netlify.toml](netlify.toml)) |
| **Privacy policy** | `<site>/privacy.html` — required by Meta App Review; has a `#data-deletion` anchor |
| **Email sender** | Resend, currently the shared `onboarding@resend.dev` address |
| **Admin email** | `hospitalitybee@gmail.com` (hardcoded in [config.js](config.js) **and** in three functions — see [§20](#20-security-model-quirks--known-issues)) |
| **Timezone** | `Asia/Kolkata` (IST) everywhere |
| **Currency** | `₹` (INR), `en-IN` formatting |

**Live branch UUIDs** (needed for `META_BRANCH_ID` and manual SQL):

```
Janakpuri      8db5a0fb-a7d4-435b-951e-6f1cb5d85fc9
Kirti Nagar    e1d26aab-025d-4136-8a91-867a16c5a9ef
Dwarka Sec 12  9a3aff6c-84b5-4c7f-95e8-6af3c9ec0556
```

> ⚠️ **Deploy-target warning (historical):** the legacy Cashup site (`eabc30b1-…`) is a
> *different* Netlify site from the Derma public marketing site
> (`2645c785-a8d5-4e06-b72b-aedf1fedca47`, `cosmic-cascaron-69cab5`). Cross-deploying them
> once (6–7 Jun 2026) overwrote the live Cashup app and broke staff access. Never mix them.

---

## 3. Tech stack

| Layer | Technology | Where |
|---|---|---|
| Frontend | Plain **HTML + CSS + vanilla JS** SPA, no framework, no build step | [index.html](index.html), [app.js](app.js), [styles.css](styles.css) |
| Fonts | **Geist** variable woff2, **self-hosted** (latin + latin-ext; ₹ U+20B9 lives in latin-ext) | [fonts/geist.css](fonts/geist.css) |
| Icons | **Phosphor (regular)** inline SVG sprite, referenced as `<svg class="icon"><use href="#i-…"/></svg>` | top of [index.html](index.html) |
| Charts | **Chart.js 4.4.1** via cdnjs | [index.html:14](index.html#L14) |
| DB client | **supabase-js v2** via jsDelivr — the browser talks to Postgres directly | [index.html:13](index.html#L13) |
| Database | **Supabase** (Postgres + PostgREST) | — |
| Serverless | **Netlify Functions** (Node 18, CommonJS, built-in `fetch`) | [netlify/functions/](netlify/functions/) |
| Scheduled jobs | **Netlify scheduled function** (cron) | [check-automations.js](netlify/functions/check-automations.js) |
| Email | **Resend** REST API | 4 functions |
| Social | **Meta Graph API** — Instagram Login API, Messenger, WhatsApp Cloud API | [meta-service.js](netlify/functions/utils/meta-service.js) |
| Hosting | **Netlify** — static site + functions, auto HTTPS, git-push auto-deploy | — |

**npm dependencies: exactly one.** `@netlify/functions@^2.8.2` — needed only so the
scheduled function bundles correctly. Everything else is CDN or stdlib.

**Design tokens** (`:root` in [styles.css](styles.css#L5-L23)):

```
--primary #C4922A   --primary-dark #8B6508   --primary-light #fdf3e3
--accent  #8B6508   --success #43a047        --warning #fb8c00   --danger #e53935
--text #1a1a2e      --text-muted #6b7280     --border #e5e7eb
--bg #faf6f1        --card #ffffff           --radius 14px / 8px
--font 'Geist', 'Segoe UI', system-ui, …
```

Money/data cells use `font-variant-numeric: tabular-nums` so columns align.

---

## 4. Complete file map

```
index.html                      1032 lines — every screen + modal + the icon sprite
app.js                          3742 lines — ALL client logic
styles.css                      2928 lines — all styling
config.js                       non-secret config (admin email, ₹, IST, APP_URL, accountants)
netlify.toml                    functions dir + /webhook/meta redirect + SPA catch-all
package.json                    one dep: @netlify/functions
privacy.html                    Meta-required privacy policy + #data-deletion anchor
favicon.png / dskin-logo.png    branding (logo is hot-linked in every email template)
fonts/                          geist.css + geist-latin.woff2 + geist-latin-ext.woff2
.env.example                    template for local function env vars
.env                            local secrets — GITIGNORED, never commit
SUPABASE_SCHEMA.sql             current live DB schema (source of truth for the DB)
supabase-schema.sql             day-1 schema — STALE, kept for history only

netlify/functions/
  get-config.js                 → Supabase URL + anon key to the browser from env vars
  meta-webhook.js               → GET verify + POST receive for Meta (IG/FB/WA)
  meta-send.js                  → outbound reply to a lead, platform resolved from the row
  meta-status.js                → live connection check for admin "Connected Accounts"
  send-feedback-email.js        → staff feedback  → admin email
  send-variance-alert.js        → till variance   → admin email
  send-pin-email.js             → "Forgot PIN"    → emails the ADMIN PIN to the admin only
  send-automation-report.js     → automation: emails a .doc report (Resend attachment)
  send-automation-webhook.js    → automation: POSTs a formatted text report to a webhook
  check-automations.js          → cron (0 18 * * * UTC = 23:30 IST): fires scheduled automations
  utils/meta-service.js         → shared Meta logic: verify, parse, store, send, comment automation + branch routing
  utils/meta-service.test.js    → the ONLY test in the repo (node, assert, no framework)

Docs (see §23):
  PROJECT_DOCUMENTATION.md      ← THIS FILE — the master reference
  PROJECT_OVERVIEW.md           earlier overview (Jun 2026, pre-WhatsApp)
  HANDOFF.md                    developer handoff (older, pre-get-config)
  README.md                     day-1 setup guide (STALE — describes creds in config.js)
  WHATSAPP_INTEGRATION.md       WhatsApp design + decision log (provider choice, routing)
  WHATSAPP_SETUP_RUNBOOK.md     WhatsApp click-by-click setup + client handover runbook
  NETLIFY_CREDITS_WORKAROUND.md how to test when production deploys are credit-blocked
  Clinix360_Instagram_GoLive_Session_2026-06-23.md   IG webhook go-live post-mortem
```

### app.js section map

`app.js` is one flat file with `// ====` banner comments. Sections in order:

| Lines | Section |
|---|---|
| 1–51 | Live IST clock + global `state` object (incl. default `paymentModes`) |
| 53–175 | Routing + session persistence, tab switching |
| 177–479 | **Lead Hub — unified inbox** (branch side) |
| 481–729 | **Admin — Leads pipeline** (cross-branch KPIs, table, chat modal) |
| 731–795 | **Admin — Connected Accounts** (integration toggles) |
| 797–818 | `init()` |
| 820–899 | Payment modes (load/save/render/add/remove) |
| 901–963 | **Instagram comment automation rules** (load/save/render/add/remove) |
| 965–973 | `showScreen()` |
| 975–1019 | Branch loading + cards |
| 1021–1068 | PIN entry + `verifyPIN()` |
| 1070–1178 | Admin panel open, alerts/feedback |
| 1180–1447 | Feedback modal, admin branches, admin stats/KPIs |
| 1449–1869 | Automations, admin PIN, branch CRUD, forgot-PIN |
| 1871–2052 | Branch dashboard (today status, yesterday warning, stats) |
| 2054–2477 | Cashup form (rows, staff dropdown portal, `recalcSummary`) |
| 2479–2669 | `saveCashup()` |
| 2671–2724 | Autocomplete / Smart Fill |
| 2726–2851 | Reports tab setup |
| 2853–3429 | Reports engine (charts, tables, .doc export) |
| 3431–3643 | `bindGlobalEvents()` |
| 3645–3742 | Date/format/util helpers, toast |

---

## 5. Boot sequence

1. Browser loads [index.html](index.html) → pulls supabase-js + Chart.js from CDN, then
   [config.js](config.js), then [app.js](app.js).
2. `init()` ([app.js:800](app.js#L800)):
   - `fetch('/.netlify/functions/get-config')` — gets `SUPABASE_URL` + `SUPABASE_ANON_KEY`
     **at runtime**, so no credentials are baked into any browser-served file.
   - `db = window.supabase.createClient(url, key)` — the single global DB handle.
   - `Promise.all([loadBranches(), loadAdminPIN(), loadPaymentModes()])`.
   - `bindGlobalEvents()`, `hashchange` listener, then `routeFromHash()` to restore
     wherever the user left off.

> **Consequence:** a plain static server (`npx serve .`) cannot boot the app — there's no
> `/.netlify/functions/get-config`. Use `netlify dev`.

---

## 6. Routing & session persistence

**Hash routes** — every page has a real URL and browser back/forward works:

| Route | Screen |
|---|---|
| `#/` | Home (branch picker) |
| `#/branch/cashup` | Branch dashboard — Daily Cashup tab (default) |
| `#/branch/emails` | Branch dashboard — Emails tab (placeholder, "Coming soon") |
| `#/branch/leads` | Branch dashboard — Leads inbox |
| `#/cashup/<YYYY-MM-DD>` | The cashup sheet for that date |
| `#/admin/<tab>` | Admin panel: `overview` \| `leads` \| `reports` \| `notifications` \| `settings` |

- `setRoute(hash)` updates the hash **without** re-triggering the router — a
  `_suppressHash` counter handles multiple synchronous calls from nested navigation
  ([app.js:79](app.js#L79)).
- `routeFromHash()` ([app.js:112](app.js#L112)) runs on first load and on back/forward.
  Every protected route re-checks the session and falls back to `showHome()`.
- **Session**: `localStorage` key **`clinix_session`**, shape `{auth, branchId, ts}`,
  **24 h TTL** — `loadSession()` clears it when expired ([app.js:57-75](app.js#L57-L75)).
- Switching an admin tab lazily loads that tab's data
  (`switchAdminTab`, [app.js:162](app.js#L162)); switching to the branch Leads tab calls
  `loadLeadsTab()`.

---

## 7. Authentication model

**There are no Supabase Auth users.** Everything is PIN-based:

| Role | Credential | Where stored |
|---|---|---|
| Branch staff | 4-digit PIN | `branches.pin` |
| Admin | 4-digit PIN | `settings.admin_pin` |
| Accountant | email allow-list, view-only | `CONFIG.ACCOUNTANT_EMAILS` in [config.js](config.js) (currently empty) |

- `verifyPIN()` ([app.js:977](app.js#L977)) matches the entered PIN against the selected
  branch, or against the admin PIN, and routes accordingly.
- **Forgot PIN** ([app.js:1749](app.js#L1749) → [send-pin-email.js](netlify/functions/send-pin-email.js)):
  the function **only ever sends the ADMIN PIN, only to the admin email**. Any other email
  gets a hard `403`. For staff it is effectively a decoy; the email names which branch
  triggered it so the admin knows.
- **Staff date guard**: non-admin users can only save **today or yesterday**
  ([app.js:2440](app.js#L2440)). Admin can open and edit any date for any branch.

---

## 8. Screens & UI

Each screen is a `<div class="screen">`; `showScreen(name)` toggles `.active`
([app.js:904](app.js#L904)).

| Screen id | Purpose |
|---|---|
| `screen-home` | Branch picker cards + "Admin" entry |
| `screen-pin` | 4-digit PIN pad with dots, Forgot PIN link |
| `screen-dashboard` | Branch panel: sidebar with 3 tabs + mobile bottom nav |
| `screen-cashup` | The cashup sheet (date hero + live IST clock) |
| `screen-admin-panel` | Admin: sidebar with 5 tabs + mobile bottom nav |

**Branch dashboard tabs**: **Daily Cashup** (working screen), **Emails** (placeholder),
**Leads** (the inbox).

The Daily Cashup tab shows:
- a **"yesterday incomplete" warning** card when yesterday's cashup wasn't finalised
  (`checkYesterdayWarning`, [app.js:1847](app.js#L1847)),
- a **today status** card (draft / submitted / not started) with a date navigator
  (`loadTodayStatus`, `navigateDashboardDate`),
- a stats grid (`loadDashboardStats`).

**Modals** (all in [index.html](index.html)): admin lead chat, feedback, add/edit branch,
add staff, automation editor, autocomplete dropdown, toast.

**Staff dropdown quirk**: the staff picker is a **portal-based custom dropdown** rendered
at `<body>` level so it escapes ancestor `overflow:hidden`
([app.js:2234-2341](app.js#L2234-L2341)). Staff names can be added/deleted inline.

---

## 9. The cashup form — exact math

Opened by `openCashupForm(date)` ([app.js:2038](app.js#L2038)). Four editable blocks:
**sales entries**, **daily summary**, **extra cash added**, **expenses**.

`recalcSummary()` ([app.js:2348](app.js#L2348)) runs on every input and computes, in order:

```
totalSale     = Σ entry.amount                       (all entries)
lessScan      = Σ entry.amount where payment_type != 'cash'    ("Less Scan" / non-cash)
totalExtras   = Σ extra.amount
totalExp      = Σ expense.amount

balance1      = opening_balance + totalSale
cashBalance   = balance1    − lessScan
balance2      = cashBalance − less_cash_handover
closing       = balance2    + totalExtras − totalExp

variance      = actual_closing_counted − closing      (only once actual is entered)
```

Equivalent single line: `closing = opening + cash_sales − handover + extras − expenses`.

- `opening_balance` comes from `state.openingBalance`, seeded from the previous day.
- Variance display: `|variance| < 0.01` → "✓ All good"; `> 0` → "over" (green);
  `< 0` → "short" (red).

### Save behaviour (`saveCashup(isFinal)`, [app.js:2418](app.js#L2418))

1. **Final submit requires** `Actual Closing` to be filled, else it aborts with a toast.
2. **Staff date guard** — non-admin, non-today/yesterday → abort.
3. **Final submit validation**: every entry with `amount > 0` must have a
   Product/Service. Offending fields get `.field-error`, the first one is scrolled to and
   focused, and **nothing is written to the DB**.
4. **Full overwrite**: `DELETE` all `cashup_entries`, `cashup_expenses`, `cashup_extras`
   rows for that `branch_id` + `entry_date`, then re-`INSERT` the current rows.
   Empty rows (no label and no amount) are filtered out.
5. `cashup_summaries` is **upserted** on `(branch_id, entry_date)`.
   `is_submitted = (actual_closing !== null)` — the on-submit automation gate queries this.
6. If `|variance| >= 0.01`: delete any existing alert for that date, insert a fresh
   `cashup_alerts` row, and fire-and-forget `send-variance-alert` (email to admin).
7. If `isFinal`: `checkOnSubmitAutomations(date)`.
8. Redirects back to **today's** dashboard after 1 s (prevents a stale status when
   submitting a previous day).

> ⚠️ **Delete-then-insert means concurrent edits to the same branch/day clobber each
> other.** Last save wins, silently.

### Smart Fill (autocomplete)

`loadAutocompleteData(branchId)` ([app.js:2610](app.js#L2610)) pulls distinct past
**products/services**, **staff**, and **customer names** for the branch; `bindAutocomplete`
attaches a shared dropdown to the relevant inputs.

---

## 10. Payment modes

- Stored as a **JSON array** in `settings.payment_modes`, e.g. `[{"code":"cash","label":"Cash"}, …]`.
- Edited in **Admin → Settings → Payment Modes** (`renderPaymentModesList`, `addPaymentMode`,
  `removePaymentMode`).
- `'cash'` is **locked and force-injected** if missing — the entire cash/non-cash split
  depends on it ([app.js:829](app.js#L829)).
- Defaults seeded in `state.paymentModes` ([app.js:40-49](app.js#L40-L49)):
  `cash, scan, upi, icici_machine, pinelab, bajaj_finance, savein, cheque`.
- `rebuildPaymentLabels()` **merges into** `PT_LABEL` rather than resetting it, so
  historical entries that used a since-deleted mode still render their proper label
  ([app.js:845](app.js#L845)).
- The DB `CHECK` constraint `cashup_entries_payment_type_check` (originally
  `('cash','scan')`) has been **DROPPED** so new modes save freely.

---

## 11. Admin panel

Opened by `openAdminPanel()` ([app.js:1009](app.js#L1009)). Five tabs:

### Overview
- Branch list with add / edit / delete (`loadAdminBranches`, `showAddBranchModal`,
  `editBranch`, `saveBranchModal`, `deleteBranch`).
- **KPI grid** with filter dropdowns (`initOverviewDropdowns`, `refreshAdminKPIs`):
  this week / last week / this month / last month, per branch or all.
- "View as branch" (`viewBranchAsAdmin`) drops the admin into a branch dashboard with
  `state.cameFromAdmin = true` so Back returns to the panel.
- A hidden date-override input keeps admin any-date editing functional.

### Leads
Cross-branch pipeline — see [§14](#14-lead-hub--unified-inbox).

### Reports
See [§12](#12-reports-engine).

### Notifications
`loadAdminAlerts()` ([app.js:1021](app.js#L1021)) merges **variance alerts**
(`cashup_alerts`) and **staff feedback** (`cashup_feedback`) into one list with an unread
badge; `markAlertRead` / `markFeedbackRead` flip `is_read`.

### Settings
Five collapsible cards:
1. **Connected Accounts** — Instagram / Facebook / WhatsApp status + Connect/Disconnect
   toggles ([§15](#15-messaging-integrations-instagram--facebook--whatsapp)).
2. **Automations** — see [§13](#13-report-automations).
3. **Comment Automation** — Instagram comment → public reply + auto-DM + branch routing
   ([§15](#instagram-comment-automation-comment--dm--branch-routing)).
4. **Payment Modes** — see [§10](#10-payment-modes).
5. **Change Admin PIN** (`saveAdminPIN`).

**Staff feedback** is submitted from the cashup screen (`openFeedbackModal`,
`submitFeedback`, [app.js:1119](app.js#L1119)) → writes `cashup_feedback` **and** emails
the admin via `send-feedback-email`.

---

## 12. Reports engine

Client-side, in the Admin → Reports tab. `initReportsTab()` ([app.js:2721](app.js#L2721))
wires the controls; `runReport()` ([app.js:2848](app.js#L2848)) builds the report.

**Filters**: date presets `today | week | month | lastmonth | custom` (+ from/to date
inputs) and a branch filter (`all` or one branch). Defaults to **This Month** each time the
tab opens. Validates `from <= to`.

**Data**: three parallel Supabase queries over `cashup_entries`, `cashup_expenses`,
`cashup_summaries` in the range.

**Output sections**:

| Section | Builder |
|---|---|
| KPI grid — Total Sale, Cash Sale, Non-Cash Sale, Expenses, Handovers, Cash Added | inline in `runReport` |
| Daily Sales Trend — stacked bar (cash/non-cash) + total line, only when range > 1 day | `queueChart` |
| All Transactions — one table with payment-type **filter pills** | `buildTransactionsSection` ([app.js:2953](app.js#L2953)) |
| Top Performing Branches | `buildTopBranchesSection` |
| Top Performing Staff | `buildTopStaffSection` |
| Top Paying Clients | `buildTopClientsSection` |
| Expenses | `buildExpensesSection` |
| Daily Summary (collapsible) | `buildDailySummarySection` |

**Charts** are queued (`queueChart`) and rendered after the HTML lands
(`renderAllCharts`), because Chart.js needs the canvas in the DOM. Palette:
`CHART_COLORS` ([app.js:2797](app.js#L2797)).

**Exports** — client-side `.doc` (HTML-in-a-Word-file) downloads:
`exportReportToDoc()`, `exportTransactionsToDoc()`, `exportExpensesToDoc()`.

---

## 13. Report automations

Config rows live in `cashup_automations`, edited in Admin → Settings → Automations
(`loadAutomations`, `showAutomationModal`, `saveAutomation`, `toggleAutomation`,
`deleteAutomation`).

| Field | Values |
|---|---|
| `trigger_type` | `weekly` \| `monthly` \| `single_date` |
| `trigger_mode` | `on_submit` \| `scheduled` |
| `action_type` | `email` \| `webhook` |
| `branches` | `['all']` or an array of branch UUIDs |
| `report_sections` | subset of `daily_summary, total_sale, all_transactions, staff_breakdown, payment_breakdown, expenses` |
| `email_to` / `webhook_url` | destination |
| `is_active`, `last_sent_at` | on/off + dedupe guard |

**Two firing paths:**

1. **`on_submit`** — `checkOnSubmitAutomations(date)` ([app.js:1583](app.js#L1583)) runs
   client-side right after a final cashup submit; `getAutomationDateRange()` derives the
   window and `fireAutomationEmail()` calls the function.
2. **`scheduled`** — [check-automations.js](netlify/functions/check-automations.js), a
   **Netlify scheduled function** on cron **`0 18 * * *` UTC = 23:30 IST**:
   - computes today's IST date, day-of-week and last-day-of-month,
   - fires `weekly` on **Sunday** (range = Mon–Sun), `monthly` on the **last day**
     (range = 1st–today), `single_date` when `trigger_date == today`,
   - skips anything whose `last_sent_at` is already today,
   - POSTs `{automation_id, date_from, date_to}` to `send-automation-report` or
     `send-automation-webhook`.

Both delivery functions update `last_sent_at` on success. The webhook sender retries
**3 times** with a 1.5 s × attempt backoff before returning `502`.

---

## 14. Lead Hub / Unified Inbox

Two views over the same `leads` + `lead_messages` tables.

### Branch inbox (`#/branch/leads`, [app.js:180-507](app.js#L180-L507))

- `loadLeadsTab()` queries leads for **the current branch only**, then pulls all their
  messages in **one** query and derives, per lead, the last message + unread count.
- **Centered leads table** on a light-beige canvas. A platform toggle
  (All / Instagram / Facebook / WhatsApp) filters by source without refetching
  (`bindLeadsToggle` / `applyLeadsFilter`, reusing the cached last-message map). Each row
  shows **Date · Name · Concern** (concern = last message text, truncated to 64 chars).
  Clicking a row opens the chat **over the leads area** (same footprint, with a dimmed
  backdrop); the back button or a click on the backdrop returns to the list.
- Opening a conversation calls `markConversationSeen()` — bulk-updates
  `is_seen = true, seen_at = now()` for that lead's incoming, unseen messages.
- **Sending** (`sendLeadMessage`) is **optimistic**: the bubble appears immediately in a
  "Sending…" state, then resolves to a timestamp (`markBubbleSent`) or
  "Failed — not sent" (`markBubbleFailed`). It POSTs to `/.netlify/functions/meta-send`.
- **Realtime since 2026-08-03** — the inbox subscribes to `lead_messages` INSERTs via
  Supabase Postgres Changes (`subscribeInbox` / `subscribeAdminChat` + an
  outgoing-echo DOM-marker dedupe in [app.js](app.js)), so inbound messages and cross-staff sends appear live with
  no refresh. Requires the `supabase_realtime` publication enabled on `lead_messages`
  and the `branch_id` backfill; see [artifacts/REALTIME_INBOX.md](artifacts/REALTIME_INBOX.md).
  With realtime off it silently degrades to the old load-on-open behaviour, and
  `syncCardPreview()` still patches a row's Concern cell when a thread is opened.
- Message text is inserted with `textContent` / `esc()` — **XSS-safe**.

### Admin leads pipeline (`#/admin/leads`, [app.js:480-728](app.js#L480-L728))

- `loadAdminLeads()` loads **all** leads across branches.
- **Filters**: branch, source, status, and a name search. KPIs deliberately ignore the
  *status* filter so the funnel stays meaningful; the table applies it on top
  ([app.js:554](app.js#L554)).
- **KPI tiles**: Total leads, New, Converted, Conversion %, and a "By source" chip row.
- **Table**: name, source badge, branch, an inline **status `<select>`**
  (`new | contacted | converted | lost` → `updateLeadStatus`), received time, and a chat
  button.
- **Chat modal** reuses `renderThreadHtml()` and the same `meta-send` endpoint
  (`openAdminChat`, `loadAdminChat`, `sendAdminChatMessage`).

### Platform labels

`sourceLabel()` → `IG | FB | WA` (fallback: first 2 chars uppercased);
`sourceLabelFull()` → `Instagram | Facebook | WhatsApp`. WhatsApp green `#25d366` styling
lives in [styles.css](styles.css).

---

## 15. Messaging integrations (Instagram / Facebook / WhatsApp)

All three platforms POST to **one endpoint**, `/webhook/meta`, and are handled by one
shared service: [netlify/functions/utils/meta-service.js](netlify/functions/utils/meta-service.js).

### Inbound flow

```
IG DM / FB message / WA message
  → Meta → POST <site>/webhook/meta
  → meta-webhook.js
  → handleWebhook(payload)
      ├ extractEvents(payload)  — platform + flattened event list
      ├ isPlatformEnabled(platform)  — admin toggle, FAIL-OPEN
      └ per event: skip echoes, skip missing sender/text
          → processIncomingMessage(senderId, text, platform, profileName)
              ├ findLeadByPlatformId(platform, senderId)
              ├ exists? backfill the real name if still a placeholder
              │  else   createLead({branch_id: META_BRANCH_ID, source, customer_name,
              │                     <platform>_user_id, status:'new'})
              └ insertMessage({lead_id, direction:'incoming', message, is_seen:false})
  → row appears in the Inbox
```

**Platform dispatch** (`platformFor`, [meta-service.js:260](netlify/functions/utils/meta-service.js#L260)):

| `payload.object` | Platform | Payload shape |
|---|---|---|
| `instagram` | Instagram | `entry[].messaging[]` (real DMs) |
| `page` | Facebook Messenger | `entry[].messaging[]` |
| `whatsapp_business_account` | WhatsApp | `entry[].changes[].field='messages'` with `value.messages[]` + `value.contacts[]` |

`extractEvents()` handles **both shapes**, because Meta's dashboard "Test" button sends
`changes[]` even for FB/IG — but with a *completely different* `value` shape than
WhatsApp, hence the explicit split at
[meta-service.js:294](netlify/functions/utils/meta-service.js#L294).

**Key invariants:**

- **`idColumnFor(platform)` throws on an unknown platform** rather than defaulting
  ([meta-service.js:36](netlify/functions/utils/meta-service.js#L36)). A silent default
  would write one platform's sender id into another's column and corrupt dedupe forever.
  This is the single most dangerous function in the integration.
- **Echo skip**: `message.is_echo === true` means it's a copy of *our own* outbound
  message — never ingest it.
- **Non-text messages** (image/audio/…) produce `messageText === undefined` and are
  skipped downstream. WhatsApp delivery receipts arrive as `value.statuses[]` with no
  `messages[]` and are skipped for free.
- **Profile names** (shown as the person's **name**, not their handle): Instagram uses
  the User Profile API (`graph.instagram.com`, `META_ACCESS_TOKEN`) → just the **`name`**
  ("Gaurav Soni"); the `@username` is a last-resort fallback only when no name resolves.
  Facebook uses the Graph API with the **PAGE** token (`META_PAGE_ACCESS_TOKEN`).
  **WhatsApp has no profile API** — the name rides inline in `contacts[].profile.name`
  and is passed in instead of fetched. Placeholders: `Instagram User` / `Facebook User` /
  `WhatsApp User`, backfilled on the next message once a real name is available.
  - **A fetched real name always beats a passed handle**: in `processIncomingMessage`
    the profile fetch is tried *before* the `profileName` arg. This matters for IG
    **comment** leads — the comment webhook carries only a `username` (no display name),
    so `processComment` used to store `@username` and never fetch. Now the messaging
    IGSID (from the private-reply `recipient_id`) is resolved into a real name when Meta
    returns one; the bare username is the fallback.
  - **Client strip**: `leadDisplayName()` in [app.js](app.js) strips any trailing
    ` (@handle)` from the stored `customer_name` at render, so older leads (stored as
    `Name (@user)`) also show just the name — no DB backfill needed.
- **Every inbound lead attaches to `META_BRANCH_ID`** — one hardcoded branch. Multi-branch
  routing is **unsolved**; see [§22](#22-roadmap--open-items).

### Outbound flow

[meta-send.js](netlify/functions/meta-send.js) — `POST {leadId, message}`. The recipient id
and platform are resolved **server-side** from the lead row; the client never sees a token
or a recipient id. Max **1000 bytes** per message. The message is persisted to
`lead_messages` (`direction:'outgoing'`, `is_seen:true`) **only after a successful send**.

| Platform | Endpoint | Token | Recipient |
|---|---|---|---|
| Instagram | `POST graph.instagram.com/v21.0/{META_IG_ID\|me}/messages` | `META_ACCESS_TOKEN` (Bearer) | IGSID |
| Facebook | `POST graph.facebook.com/v21.0/me/messages` (`messaging_type: RESPONSE`) | `META_PAGE_ACCESS_TOKEN` (query param) | PSID |
| WhatsApp | `POST graph.facebook.com/v21.0/{WHATSAPP_PHONE_NUMBER_ID}/messages` | `WHATSAPP_ACCESS_TOKEN` (Bearer) | `wa_id` (phone, international format) |

> **24-hour window applies to all three.** Free-form replies only work within 24 h of the
> customer's last message. Outside it the send **fails** and surfaces as a `502` →
> "Failed — not sent" in the UI. This is correct behaviour, not a bug. WhatsApp would need
> a paid template (~₹0.115 utility) to break the window; we send none.

### Instagram comment automation (comment → DM → branch routing)

Someone comments on a post → we post a **public reply** under their comment ("Check your
DM") **and** send **one** DM that answers briefly and ends in the **branch question**, with
a tappable button per branch. Their answer routes the lead **and** opens the 24-hour
messaging window, because the conversation is then customer-initiated — so staff can then
reply freely from the normal Leads inbox.

Full design, API research and build order:
[INSTAGRAM_COMMENT_AUTOMATION.md](INSTAGRAM_COMMENT_AUTOMATION.md).

```
── A. the comment ──────────────────────────────────────────────────────────
customer comments  → POST /webhook/meta  (object='instagram', changes[].field='comments')
  → extractComments()          — own stream, never mixes with DM events
  → processComment()
      ├ skip our own comment (from.id === entry.id)  ← infinite-loop guard
      ├ skip threaded replies (value.parent_id)
      ├ matchCommentRule(text, settings.comment_rules)
      ├ 1. PRIVATE REPLY  POST graph.instagram.com/v21.0/{IG}/messages
      │      { recipient:{comment_id}, message:{ attachment: button template } }
      ├ 2. PUBLIC REPLY   POST graph.instagram.com/v21.0/{comment_id}/replies
      └ 3. lead on META_BRANCH_ID + timeline: "[comment] <text>" in, the DM out

── B. their answer ─────────────────────────────────────────────────────────
customer taps [Dwarka] (or types "dwarka")
  → entry[].messaging[] — .postback for a tap, .message for typed text
  → processIncomingMessage() → routeLeadFromReply()
      ├ only while lead.branch_id is still the META_BRANCH_ID fallback
      ├ payload "BRANCH:<uuid>" → exact; else matchBranch() on active branch names
      └ 0 or 2+ matches → left unrouted for staff
  → right branch's inbox, 24h window OPEN, no send limits
```

**Rules** live in `settings.comment_rules` (JSON), edited in **Admin → Settings → Comment
Automation**. Case-insensitive substring, first hit wins, `*` is the catch-all tried last.
No match → the comment is left completely alone.

```json
[{ "keyword": "price", "public": "Check your DM 💬",
   "dm": "Laser starts from ₹X. Which branch works for you — Janakpuri, Kirti Nagar or Dwarka?" }]
```

**Key invariants:**

- **The private reply is sent FIRST, deliberately.** Meta permits exactly **one private
  reply per comment, ever**, so a redelivered webhook throws on the second attempt and we
  never double-post the public reply — and never publicly promise a DM that failed to send.
  Send order *is* the dedupe; there is no processed-comments table.
- **`recipient_id` from the private-reply response is the lead's `instagram_user_id`.** The
  comment's own `from.id` is a *different id space* from the messaging IGSID; using it would
  fork one person into two leads and break DM dedupe. Same bug class `idColumnFor()` guards.
- **Buttons are `postback`, never `web_url`.** A link tap sends us nothing — no event, no
  window, no routing. And buttons rather than **quick replies**, which do not render in the
  message-requests folder where a DM to a stranger lands. Max **3** buttons (we have exactly
  3 branches); titles truncate at 20 chars.
- **`messaging_postbacks` must be subscribed** or taps never arrive and the window never
  opens. A postback is *not* a message — `extractEvents()` reads `messaging[].postback` and
  uses `postback.title` as the timeline text.
- **7-day window on the private reply**, vs 24h for a normal DM reply. After their answer,
  standard 24h rules resume.
- **Routing is platform-agnostic and self-disabling** — it only moves a lead still parked on
  `META_BRANCH_ID`, so it can never move one staff already assigned, and a WhatsApp customer
  who names a branch is routed for free.
- **Top-level comments only**; anything with `parent_id` is skipped.

### Facebook comment automation (same pattern, shared rules)

Facebook Page comments run the **same** comment → public reply → one DM → branch-routing
flow on **shared `comment_rules`** (no separate rule set, no second settings card). Built
and unit-tested; **inert** until the Meta dashboard work below is done. Full spec:
[FACEBOOK_COMMENT_AUTOMATION.md](FACEBOOK_COMMENT_AUTOMATION.md).

The plumbing (`matchCommentRule`, `matchBranch`, `routeLeadFromReply`, `processIncomingMessage`,
postback handling in `extractEvents`) is platform-agnostic and reused verbatim. Only the
extractor and the two Graph calls are Facebook-specific — the existing `extractComments()`
now dispatches by `payload.object` and tags each event with `platform`, and `processComment()`
picks its sender from `c.platform`:

- **Webhook field `feed`** (not Instagram's `comments`), filtered to `value.item === 'comment'`
  and `value.verb === 'add'` — `feed` also carries posts/photos/likes and edits/removals.
  Field names differ: `comment_id` (not `id`), `message` (not `text`), `from.name` inline.
  Also: **`parent_id` is set on every FB comment, even top-level** (where it equals `post_id`);
  the extractor nulls it unless `parent_id !== post_id`, or all top-level comments get skipped
  as "threaded". (Instagram only sets `parent_id` for real threads.)
- **Private reply:** `POST graph.facebook.com/v21.0/{META_PAGE_ID|me}/messages` with
  `recipient: { comment_id }` + a button template (same one-private-reply-per-comment limit).
  Uses `META_PAGE_ACCESS_TOKEN`. **Not** the `/{comment-id}/private_replies` edge, which returns
  an app-scoped `user_id` (not the PSID) and supports no buttons. **No `messaging_type`** — a
  commenter hasn't messaged us, so `RESPONSE` would be a false assertion.
- **Public reply:** `POST /{comment-id}/comments` (Instagram uses `/replies`), Page token. Needs
  `pages_manage_engagement` — **and is non-fatal:** a failure here (missing scope, 403, rate limit)
  is logged and swallowed, because the DM has already been delivered. The lead is created regardless.
- **`recipient_id` (PSID)** from the send is the lead's `facebook_user_id`, never the comment's
  `from.id` (app-scoped) — same id-space guard as Instagram. FB hands the display name over
  inline in `from.name`, so leads start with a real name immediately.

**Dashboard (still to do — all fail silently):** subscribe the Page webhook **`feed`** field,
confirm **`messaging_postbacks`**, add **`pages_messaging` + `pages_read_user_content` +
`pages_manage_engagement`** (Advanced Access / App Review — a separate track from Instagram's; the
reply 403 names exactly these two),
and subscribe the Page to the app (`POST /{page-id}/subscribed_apps`). **Gated on Instagram
comment automation going live first** — Facebook inherits Instagram's answer to the two open
button/postback assumptions. Catch-all `*` is riskier on Facebook (more spam) — keyword-only
recommended.

### Connected Accounts toggle

- UI: Admin → Settings → Connected Accounts ([app.js:730-794](app.js#L730-L794)).
- **Live status** comes from [meta-status.js](netlify/functions/meta-status.js), which pings
  each Graph API with the server-side token and returns `{connected, name}` per platform.
  No secret ever leaves the server.
- **Enable flags** are stored as JSON in `settings.integrations`
  (e.g. `{"instagram":true,"facebook":false}`) and checked by `isPlatformEnabled()` in the
  webhook path.
- **FAIL-OPEN by design**: a missing key, unset DB creds, or any error → **enabled**
  ([meta-service.js:331](netlify/functions/utils/meta-service.js#L331)). A toggle glitch
  must never silently swallow real inbound messages.
- The button shows *effective* state: `liveConnected && enabled`.

### Meta app requirements (learned the hard way)

- **The app must be set to Live** in the App Dashboard or Meta sends **zero** real webhook
  notifications — even from tester accounts. The dashboard "Test" button still works
  because it's a manual sample. This blocked IG go-live for a full session.
- Going Live requires: app icon (1024×1024), a **privacy policy URL**
  (→ [privacy.html](privacy.html)), and a category ("Business and pages").
- **Verifying the callback URL ≠ subscribing the field.** You must separately subscribe
  `messages` (Messenger also: `messaging_postbacks`). This is the most commonly missed step.
- Per-account subscription for IG must also be confirmed via
  `graph.instagram.com/v21.0/me/subscribed_apps`.
- **One callback URL per product per app** — pointing it at a staging deploy diverts live
  messages away from production.
- **DMs from the general public** need **Advanced Access** on
  `instagram_business_manage_messages` via full **App Review**. Live + tester roles only
  gives Standard Access.

### WhatsApp provider decision

**Meta Cloud API direct — no BSP (no AiSensy).** Service conversations (customer messages
us, we reply within 24 h) have been **free and unlimited since 2024-11-01**, which is
exactly our entire scope → **₹0**. AiSensy would cost ₹18k/yr, mark up templates ~26%, and
— decisively — **owns the Meta webhook subscription**, which would kill the `/webhook/meta`
reuse and force a *second* integration instead of a third branch of one. Full reasoning and
the decision log live in [WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md).

---

## 16. Netlify Functions reference

All functions are Node 18 CommonJS using built-in `fetch`. CORS headers are `*`.

| Function | Route | Method | Input | Behaviour |
|---|---|---|---|---|
| [get-config](netlify/functions/get-config.js) | `/.netlify/functions/get-config` | GET | — | Returns `{supabaseUrl, supabaseAnonKey}` from env. `Cache-Control: public, max-age=300`. `500` if env missing. |
| [meta-webhook](netlify/functions/meta-webhook.js) | **`/webhook/meta`** | GET / POST | Meta payload | GET → `verifyWebhook()`, echoes `hub.challenge` as **plain text** (403 on mismatch). POST → `await handleWebhook()` then `200 {status:'ok'}`. The `await` matters — Supabase writes must finish before returning. |
| [meta-send](netlify/functions/meta-send.js) | `/.netlify/functions/meta-send` | POST | `{leadId, message}` | Resolves platform from the lead row, sends, then persists. `400` bad input / no recipient id / unsupported source, `404` lead not found, `502` send failure. Max 1000 bytes. |
| [meta-status](netlify/functions/meta-status.js) | `/.netlify/functions/meta-status` | GET | — | `{instagram:{connected,name}, facebook:{…}, whatsapp:{…}}`. `Cache-Control: no-store`. Never returns tokens. |
| [send-feedback-email](netlify/functions/send-feedback-email.js) | `/.netlify/functions/send-feedback-email` | POST | `{branch_name, entry_date, feedback_text, submitted_by}` | Resend email to the admin. |
| [send-variance-alert](netlify/functions/send-variance-alert.js) | `/.netlify/functions/send-variance-alert` | POST | `{branch_name, entry_date, calculated_closing, actual_closing, variance}` | Resend email; "Over by" green / "Short by" red. |
| [send-pin-email](netlify/functions/send-pin-email.js) | `/.netlify/functions/send-pin-email` | POST | `{email, branch_id}` | **403 unless `email` is the admin email.** Reads `settings.admin_pin`, emails it to the admin only, naming the branch that triggered it. |
| [send-automation-report](netlify/functions/send-automation-report.js) | `/.netlify/functions/send-automation-report` | POST | `{automation_id, date_from, date_to}` | Builds a styled HTML→`.doc`, base64-attaches it to a Resend email, updates `last_sent_at`. |
| [send-automation-webhook](netlify/functions/send-automation-webhook.js) | `/.netlify/functions/send-automation-webhook` | POST | `{automation_id, date_from, date_to}` | Builds a per-branch plain-text block `{report: "…"}`, POSTs to `webhook_url`, **3 retries** w/ backoff, updates `last_sent_at`, `502` on final failure. |
| [check-automations](netlify/functions/check-automations.js) | scheduled | cron | — | `schedule('0 18 * * *')`. Fires due scheduled automations (see [§13](#13-report-automations)). |

**Webhook payload emitted by `send-automation-webhook`** (one string, per branch):

```
Date - 18 May 2026

Janakpuri
Weekly Total Sale - ₹1,23,456
Scan Sale - ₹80,000
Cash Sale - ₹43,456
Cash Handover - ₹40,000
Closing Balance - ₹12,345
```

---

## 17. Database schema

Full DDL with comments: **[SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql)**.
(`supabase-schema.sql`, lowercase, is the day-1 version — **do not use it**.)

| Table | Purpose | Key columns |
|---|---|---|
| `branches` | one row per clinic | `id`, `name` (unique), `pin`, `state`, `active` |
| `cashup_entries` | individual sale lines | `branch_id`, `entry_date`, `product_service`, `customer_name`, `amount`, `payment_type`, `staff`, `sort_order` |
| `cashup_summaries` | one row per branch/day | `opening_balance`, `less_scan_override`, `less_cash_handover`, `add_extra`, `notes`, `is_submitted`, `submitted_at`, `closing_balance`, `actual_closing_balance`, `variance` · **UNIQUE(branch_id, entry_date)** |
| `cashup_expenses` | expense lines | `reason`, `amount`, `sort_order` |
| `cashup_extras` | "Add Extra (if any)" cash lines | `reason`, `amount` |
| `cashup_alerts` | variance alerts | `branch_name`, `calculated_closing`, `actual_closing`, `variance`, `is_read` |
| `cashup_feedback` | staff feedback | `feedback_text`, `submitted_by`, `is_read` |
| `cashup_automations` | report automations | see [§13](#13-report-automations) |
| `settings` | key/value app settings | `key` PK, `value` TEXT |
| `leads` | one row per prospective customer | `branch_id`, `customer_name`, `phone`, `source`, `service`, `status`, `instagram_user_id`, `facebook_user_id`, `whatsapp_user_id` |
| `lead_notes` | notes on a lead | `lead_id`, `note` |
| `lead_messages` | the chat timeline | `lead_id`, `direction`, `message`, `is_seen`, `seen_at`, `created_at` |

**`settings` keys in use:**

| Key | Value |
|---|---|
| `admin_pin` | 4-digit admin PIN (string) |
| `payment_modes` | JSON array `[{code,label}, …]` |
| `integrations` | JSON flags `{"instagram":true,"facebook":true,"whatsapp":true}` — only an explicit `false` disables |
| `comment_rules` | JSON array `[{keyword, public, dm}, …]` — Instagram & Facebook comment automation ([§15](#instagram-comment-automation-comment--dm--branch-routing)) |

**Indexes**: `idx_leads_branch`, `idx_leads_instagram_user`, `idx_leads_facebook_user`,
`idx_leads_whatsapp_user`, `idx_lead_notes_lead`, `idx_lead_messages_lead`.

**RLS is DISABLED on every table.** Migrations are run by hand in the Supabase SQL editor —
there is no migration framework in the repo.

### ⚠️ Known schema-file drift — trust the code, not the SQL file

| Table | `SUPABASE_SCHEMA.sql` says | Live DB + code actually use |
|---|---|---|
| `leads` | `name` | **`customer_name`** |
| `settings` | (no mention) | `integrations` key exists |

The `lead_messages` drift is **fixed (2026-08-03)**: `SUPABASE_SCHEMA.sql` now
documents `direction ('incoming'/'outgoing')`, `message`, `is_seen`, `seen_at` and
the populated `branch_id`. The code still tolerates both direction spellings when
*reading* (`['in','incoming'].includes(...)`) and always *writes*
`incoming`/`outgoing`.

---

## 18. Environment variables

Set in **Netlify → Site settings → Environment variables** (production) and in a local
`.env` (gitignored) for `netlify dev`. Template: [.env.example](.env.example).

| Var | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL` | all DB-touching functions | Supabase project URL |
| `SUPABASE_ANON_KEY` | all DB-touching functions | Public anon key (also served to the browser) |
| `RESEND_API_KEY` | 4 email functions | Resend API key — **secret** |
| `META_APP_ID` | meta-service `getConfig()` | Meta app id |
| `META_APP_SECRET` | `verifyMetaSignature()` | HMAC-verifies the `X-Hub-Signature-256` on every webhook POST (see [§20](#20-security-model-quirks--known-issues)) |
| `META_VERIFY_TOKEN` | `verifyWebhook()` | Webhook GET handshake — shared by IG, FB **and** WA |
| `META_ACCESS_TOKEN` | IG profile fetch + IG send | Instagram token (`IGAA…`) |
| `META_PAGE_ACCESS_TOKEN` | FB profile fetch + FB send | Facebook **Page** access token |
| `META_IG_ID` | IG send (optional) | Defaults to `me` |
| `META_BRANCH_ID` | `processIncomingMessage()` | Branch UUID every inbound lead attaches to |
| `WHATSAPP_PHONE_NUMBER_ID` | WA send + WA status | Numeric **phone number ID**, not the number |
| `WHATSAPP_ACCESS_TOKEN` | WA send + WA status | **Use a System User token with expiry Never** — the dashboard token dies in 24 h |
| `URL` | check-automations | Injected by Netlify; falls back to the hardcoded site URL |
| `INTERNAL_FUNCTION_SECRET` | check-automations → send-automation-* | Shared secret authorizing the cron's calls to the (now PIN/secret-gated) send endpoints. **Required** for scheduled automations to fire. |

> **Env vars are read at deploy time — after adding or changing one you must trigger a
> redeploy**, or the running deploy won't see it. A `403` on webhook verification with
> `VERIFY_TOKEN_ENV= (MISSING)` in the logs is exactly this.

`config.js` holds only **non-secret** values: `ADMIN_EMAIL`, `ACCOUNTANT_EMAILS`,
`APP_URL`, `CURRENCY`, `TIMEZONE`.

---

## 19. Local development, deploy & rollback

### Prerequisites
Node 18+, a Supabase project with the schema applied, a Resend API key, Meta credentials
(only for messaging), and the Netlify CLI.

### Run locally

```bash
npm install
cp .env.example .env      # fill in real values
npx netlify-cli@22 dev    # serves site + functions on :8888 with .env loaded
```

`npx serve .` will **not** work on its own — `init()` needs `/.netlify/functions/get-config`.

### Run the tests

There is exactly one test file, and it needs no framework and no env vars:

```bash
node netlify/functions/utils/meta-service.test.js
```

It asserts `idColumnFor()` maps correctly **and throws on unknown platforms**, that
`extractEvents()` parses real WhatsApp, FB/IG `messaging[]`, and `changes[]` test payloads
(and now carries `messageId` for inbound idempotency), that `extractComments()` handles the
IG/FB comment + self/top-level guards, rule + branch matching — and that `verifyMetaSignature()`
accepts a valid HMAC and rejects wrong / missing / malformed ones. Everything that touches the
DB or network (senders, `insertMessage`, `processComment`) is still manually verified.

### Deploy

Pushing to `main` on `github.com/derma-dev/Clinix360-app` **auto-deploys** to the linked
Netlify site. Manual CLI deploy:

```bash
NETLIFY_AUTH_TOKEN=<token> npx netlify-cli@22 deploy --prod --dir . --site <SITE_ID>
```

### Testing when production deploys are blocked

Netlify Free-plan credits only apply to **production** deploys. Draft/branch/preview
deploys are free and unlimited:

```bash
netlify deploy --alias staging      # → https://staging--<site>.netlify.app, 0 credits
```

…or run `netlify dev` behind `cloudflared tunnel --url http://localhost:8888`. Either way
you must repoint the Meta callback URL — and **that diverts live inbound messages away from
production** while it's set. Full procedure: [NETLIFY_CREDITS_WORKAROUND.md](NETLIFY_CREDITS_WORKAROUND.md).

### Rollback (messaging integrations)

- **Webhook**: clear the callback URL in the relevant Meta product → that platform's
  traffic stops instantly; the others have their own callbacks and never notice.
- **Code**: the WhatsApp branch only fires on `object === 'whatsapp_business_account'`, so
  it's inert once the webhook is cleared.
- **DB**: `whatsapp_user_id` is additive + nullable — leave it.

---

## 20. Security model, quirks & known issues

### Security model

- **RLS is enabled but permissive on every table** (`allow_anon_all` — see
  [SUPABASE_ENABLE_RLS.sql](SUPABASE_ENABLE_RLS.sql)). The browser holds the public **anon
  key** with full read/write; the net behaviour is identical to RLS-off. **Security is
  enforced at the app/PIN layer only** — the anon key is not a security boundary; anyone who
  opens devtools can read and write the database directly. (Tightening this needs Supabase
  Auth or moving writes to the service_role — deferred, see [§22](#22-roadmap--open-items).)
- The anon key is public *by design* and safe to ship. **Never commit** the Netlify deploy
  token or `RESEND_API_KEY`.
- **`X-Hub-Signature-256` is now verified (2026-08-13).** `META_APP_SECRET` HMAC-checks the
  POST body on every webhook ([meta-webhook.js](netlify/functions/meta-webhook.js) →
  `verifyMetaSignature()`); a mismatch is rejected with 403. If `META_APP_SECRET` is unset,
  verification is SKIPPED with a loud warning (dev fallback) — set it in prod.
  Base64-encoded bodies (`event.isBase64Encoded`) are decoded before HMAC, and a mismatch
  logs whether the body was base64 — persistent failures after that point to a wrong/stale
  `META_APP_SECRET`.
- **Send endpoints are now auth-gated (2026-08-13).** `meta-send`, `send-automation-report`
  and `send-automation-webhook` require either a browser `x-staff-pin` header (the logged-in
  admin/branch PIN) or a server `x-internal-secret` (`INTERNAL_FUNCTION_SECRET`, used by the
  scheduled cron). Without one, 401.
- Outbound tokens never reach the client: `meta-send` resolves the recipient from the lead
  row server-side.
- User-supplied text is escaped (`esc()`) or set via `textContent` before rendering.

### Quirks & gotchas

| # | Thing |
|---|---|
| 1 | **Everything is IST.** `getISTDate()` is the canonical "today"; the cashup screen runs a live IST clock. |
| 2 | **Save = full overwrite** of that branch/day (delete-then-insert). Concurrent edits clobber each other silently. |
| 3 | `ADMIN_EMAIL` is **duplicated** — `config.js` plus hardcoded constants in `send-pin-email.js`, `send-feedback-email.js`, `send-variance-alert.js`. Changing the admin email means changing it in **four** places. |
| 4 | Every email template **hot-links the logo** at `https://eloquent-pothos-dc09dc.netlify.app/dskin-logo.png`. Move the site and every historical email breaks its image. |
| 5 | Resend sends from the shared `onboarding@resend.dev`. For production, verify a domain and change the `from:`. |
| 6 | `README.md` is the day-1 guide and describes putting Supabase creds in `config.js` — **that is no longer true** (see [§5](#5-boot-sequence)). |
| 7 | The branch **Emails** tab is a "Coming soon" placeholder. |
| 8 | ~~The inbox is not realtime~~ **Resolved 2026-08-03** — the inbox now uses Supabase Postgres Changes to push messages live (no refresh). See [§14](#14-lead-hub--unified-inbox) and [artifacts/REALTIME_INBOX.md](artifacts/REALTIME_INBOX.md). Degrades to load-on-open if the `supabase_realtime` publication isn't enabled. |
| 9 | `less_scan_override` exists in `cashup_summaries` but the current UI always auto-calculates from entries. |
| 10 | The staff dropdown renders into a body-level portal to escape `overflow:hidden` — if it ever detaches visually, that's why. |
| 11 | WhatsApp/IG/FB non-text messages (image, audio, sticker) are **silently dropped** — only `text` is ingested. |
| 12 | A temporary WhatsApp dashboard token **expires in 24 h**. "Worked yesterday, 401 today" is always this. |
| 13 | **Comment automation needs TWO webhook fields**: `comments` *and* `messaging_postbacks`. Miss the second and branch buttons do nothing — no tap event, so the 24h window never opens. Both fail silently. |
| 14 | **Comment rules are global** — not per-post, not per-branch. Every comment lead starts on `META_BRANCH_ID` and only moves once the customer names a branch. |
| 15 | **`META_BRANCH_ID` points at a real branch**, so unrouted leads look like that branch's own. Pointing it at an inactive `Unassigned` branch is recommended — see [§22](#22-roadmap--open-items). |

---

## 21. Change log

Newest first. **Add a line here for every change that touches behaviour.**

| Date | Commit | Change |
|---|---|---|
| 2026-08-17 | — | **Conversation-corpus export (chatbot Phase 1 prep).** New dev-only [scripts/export-conversations.js](scripts/export-conversations.js): default mode dumps `leads`+`lead_messages` to `artifacts/data/conversations.jsonl` (11 convos / 97 msgs); `--meta` pulls the **full IG DM history** from Meta via `GET /{IG_ID}/conversations` + per-thread `messages` paging → `artifacts/data/ig_history.jsonl` (5 threads / 85 msgs, incl. one pre-DB thread) — confirms the Instagram-Login flavour *can* read history. Finding: **all of it is dev test traffic**; the real corpus must come from the client's IG account (same pull, their token). `artifacts/data/` gitignored (customer PII). Client's clarified bot priorities + session plan: [artifacts/CHATBOT_BRAINSTORM_2026-08-17.md](artifacts/CHATBOT_BRAINSTORM_2026-08-17.md); recorded in [artifacts/CHATBOT_AUTOMATION.md](artifacts/CHATBOT_AUTOMATION.md) too. |
| 2026-08-13 | — | **Security & correctness hardening (7 issues).** **(1) Webhook signature verification** — `verifyMetaSignature()` HMAC-checks `X-Hub-Signature-256` with `META_APP_SECRET` on every POST ([meta-webhook.js](netlify/functions/meta-webhook.js)); 403 on mismatch; GET verify-token compare now constant-time. **(2) Send endpoints auth-gated** — `meta-send`, `send-automation-report`, `send-automation-webhook` require `x-staff-pin` (browser, the logged-in PIN) or `x-internal-secret` (`INTERNAL_FUNCTION_SECRET`, the cron); new `authorizeRequest()` in [meta-service.js](netlify/functions/utils/meta-service.js); `check-automations` sends the secret. **(4) Inbound idempotency** — new `lead_messages.external_message_id` (UNIQUE, partial index) + `insertMessage` uses PostgREST `resolution=ignore-duplicates`, so Meta redeliveries no longer duplicate timeline rows; `extractEvents` now carries `messageId` (mid/wamid). **(5) Inbound realtime dedup** — message bubbles carry `data-msg-id`; the realtime appender skips a row already painted by the convo-load SELECT (closes the inbound side of the dup class `dddb8ce` fixed for outbound). **(9)** `esc()` now escapes `'`; branch Edit/Delete `onclick` JS-escape names (`Women's`/`O'Brien` no longer break the buttons). **(10)** `loadLeadMessages` re-checks `_activeLeadId` after the await — opening two convos quickly no longer paints the wrong thread. **(22)** Schema drift — `SUPABASE_SCHEMA.sql` `leads.name` → `customer_name` (matches code); legacy `supabase-schema.sql` marked DEPRECATED. Tests added for signature verification + message-id threading. New env var: `INTERNAL_FUNCTION_SECRET`. RLS/anon-key hardening (#3 in the audit) deliberately deferred — it needs Supabase Auth / service_role and would touch the client PIN model. |
| 2026-08-03 | — | **Lead names: show the person's name, not their Instagram handle.** `buildDisplayName` ([meta-service.js](netlify/functions/utils/meta-service.js)) now returns just the real `name` ("Gaurav Soni") and drops the appended `(@username)`; the bare username is a fallback only when no name resolves. `processIncomingMessage` now tries the profile fetch *before* the passed `profileName`, so IG **comment** leads (whose webhook carries only a username) resolve a real name from the messaging IGSID instead of being stored as `@username`. `processComment` passes the bare username (no `@`). Client-side `leadDisplayName()` ([app.js](app.js)) strips any trailing ` (@handle)` at render — branch card, branch chat header, admin table, admin chat — so existing leads stored as `Name (@user)` also show just the name, with no DB backfill. |
| 2026-08-03 | — | **Realtime inbox.** Branch inbox + admin chat now subscribe to `lead_messages` INSERTs via Supabase Postgres Changes (`subscribeInbox` / `subscribeAdminChat` + an outgoing-echo DOM-marker dedupe (`data-sent-key`) in [app.js](app.js)); inbound messages and cross-staff sends appear live with no manual refresh. `branch_id` is now populated on every `lead_messages` insert (`meta-service` inbound + `processComment`, `meta-send` outbound) so the branch channel filters server-side; `getLeadById` selects it too. `renderThreadHtml` refactored to share a `_messageBubbleHtml` helper with the realtime appender (identical output). Requires enabling the `supabase_realtime` publication on `lead_messages` (+ the one-shot `branch_id` backfill) — until then it degrades to load-on-open. Spec: [artifacts/REALTIME_INBOX.md](artifacts/REALTIME_INBOX.md). Also fixed the `lead_messages` schema-file drift ([§17](#17-database-schema)). |
| 2026-07-30 | — | **Facebook comment automation built (inert).** `extractComments()` generalized to also read FB Page `feed`/`item:'comment'` events (tagged `platform`); added `sendFacebookPrivateReply()` (`recipient:{comment_id}` → `/messages`, returns PSID, button template) + `replyToFacebookComment()` (`/comments`), shared `buildBranchButtonMessage()`, platform-aware `processComment()`. **Shared `comment_rules`** with Instagram — no new settings key, UI label edit only. Still needs Meta dashboard: Page `feed` + `messaging_postbacks` webhook fields, `pages_messaging`/`pages_read_engagement`/`pages_manage_engagement` + App Review, Page `subscribed_apps`. Spec: [FACEBOOK_COMMENT_AUTOMATION.md](FACEBOOK_COMMENT_AUTOMATION.md). |
| 2026-07-29 | — | **Instagram comment automation built.** `extractComments()` + `processComment()` (public reply + one private reply with 3 postback branch buttons), `matchCommentRule()`, `matchBranch()` + `routeLeadFromReply()` (branch routing from the customer's answer — closes multi-branch routing for IG), `extractEvents()` now handles `messaging[].postback`, `getSettingJson()` extracted from `isPlatformEnabled()`, new **Comment Automation** settings card + `settings.comment_rules`. **Still needs the `comments` and `messaging_postbacks` webhook fields subscribed and the `instagram_business_manage_comments` permission** — inert until then. |
| 2026-07-28 | — | Specced Instagram comment automation → [INSTAGRAM_COMMENT_AUTOMATION.md](INSTAGRAM_COMMENT_AUTOMATION.md). |
| 2026-07-28 | — | Added this master documentation file. |
| 2026-07-28 | `0c6e45f` | New **Leads** tab in the admin panel (cross-branch KPIs, filters, status pipeline, chat modal) + **Connected Accounts** panel in Settings. |
| 2026-07-22 | `fd6a878` | `.env` updated; WhatsApp integration + setup runbook docs added. |
| 2026-07-17 | `2b48849` | **WhatsApp integration** — `whatsapp_user_id` column, `idColumnFor()` 3-way map, `whatsapp_business_account` webhook branch + WA payload extractor, `sendWhatsAppMessage()`, `meta-service.test.js`. |
| 2026-07 | `256d1be` | Replaced emoji icons with a self-hosted Geist font + Phosphor SVG sprite. |
| 2026-07 | `0304ba5` | "You:" prefix on outbound inbox previews. |
| 2026-07 | `a132da1` | Fixed stale message-preview bug (`syncCardPreview`). |
| 2026-06 | `f87cd72` | **Facebook Messenger** support (inbound + outbound). |
| 2026-06 | `e0d43a3` | Optimistic outbound message bubbles. |
| 2026-06 | `0f83a34` | **Outbound Instagram replies** via the Send API (`meta-send`). |
| 2026-06 | `02f331b` | Fetch real IG name/username via the Profile API. |
| 2026-06-23 | `f54a281` | `privacy.html` added (required to take the Meta app Live). |
| 2026-06-23 | `4a07022` | Webhook handles real IG `messaging[]` payloads, not just test `changes[]`. |
| 2026-06-23 | `625b839` | `verifyWebhook()` decoupled from the full Meta config — needs only `META_VERIFY_TOKEN`. |
| 2026-06 | `13f4828` | Migrated to a new GitHub repo + new Netlify account (Supabase reused); all hardcoded URLs repointed. |
| 2026-06 | `43f351d` | Instagram webhook persistence (leads + messages). |

---

## 22. Roadmap / open items

1. **Multi-branch routing for WhatsApp (OPEN, blocking real rollout).** Every inbound lead
   on every platform lands in the single hardcoded `META_BRANCH_ID`. WhatsApp inbound
   carries **no location field** — `metadata.phone_number_id` is *our* number (identical for
   every branch) and a customer's phone prefix says nothing about which branch they use.
   All 3 branches are in the same city, so "nearest branch" is meaningless anyway — routing
   must be **intent-based**. Ranked options: **A** per-branch `wa.me` deep links / QR codes
   with a hidden branch tag, **B** manual assignment from an "Unassigned" inbox, **C** an
   interactive branch-picker auto-reply, **E** one number per branch (cleanest, but breaks
   the single-number requirement). Awaiting the client's answer on how patients first make
   contact. Detail: [WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md).
   > **Option C is now shipped for Instagram**: the comment automation (item 4) has to ask
   > the customer *something* to lift the send limit, so it asks the branch question.
   > `routeLeadFromReply()` is **platform-agnostic and already live**, so a WhatsApp or
   > Messenger customer who names a branch in an early message is routed for free — but
   > neither channel *asks*, so their unrouted leads still need manual assignment and this
   > item stays open for WA. Related and still to do: point `META_BRANCH_ID` at a dedicated
   > inactive **Unassigned** branch (option **B**) so unrouted leads stop masquerading as one
   > real branch's own.
2. **Client handover for WhatsApp** — replay Parts B–D of
   [WHATSAPP_SETUP_RUNBOOK.md](WHATSAPP_SETUP_RUNBOOK.md) on the client's Meta app with his
   real number and a **permanent System User token**. Long pole: Meta Business Verification
   (2–10 business days). Do **not** take over the AiSensy account — the number must be
   migrated off any BSP first.
3. **App Review / Advanced Access** so DMs from the general public (not just testers) reach
   the inbox.
4. **Instagram comment automation — CODE SHIPPED, not yet switched on.** Built and unit
   tested; see [§15](#instagram-comment-automation-comment--dm--branch-routing). Inert until
   three things happen in the Meta App Dashboard: subscribe **`comments`**, subscribe
   **`messaging_postbacks`**, and add **`instagram_business_manage_comments`** + re-authorise.
   Then two live checks that no documentation settles: (a) does Meta accept the **button
   template** on a `recipient:{comment_id}` send, and do the buttons render while the DM is
   still in the **Requests** folder; (b) does a **postback tap open the 24 h window**. If
   either fails, pass `[]` for `branches` in `sendCommentPrivateReply()` and ship plain text
   — the typed-answer path (`matchBranch`) already covers routing and is unit tested.
   Procedure: [INSTAGRAM_COMMENT_AUTOMATION.md §7 step 0](INSTAGRAM_COMMENT_AUTOMATION.md).
   Also still needs the client's keyword list and DM copy before it can go live.
5. ~~**Webhook signature verification**~~ — **DONE 2026-08-13.** `X-Hub-Signature-256` is
   now HMAC-checked with `META_APP_SECRET` on every POST for all three platforms
   ([meta-webhook.js](netlify/functions/meta-webhook.js) → `verifyMetaSignature()`). The
   remaining open security item is the RLS/anon-key model (the `allow_anon_all` policy +
   client-side PIN is still cosmetic) — tightening it needs Supabase Auth or service_role
   writes; deferred as its own project (it would touch the client's PIN login).
6. **Clinicea auto-capture (not built).** When a *payment* is registered in Clinicea (the
   clinic's main software) — not when a bill is generated — auto-insert a prefilled row into
   that branch's cashup sheet (amount + payment mode + branch; staff fill Product/Service +
   Staff at EOD). Plan: a `clinicea-webhook` function mapping Clinicea clinic→`branch_id`
   and Clinicea mode→our payment codes, inserting into `cashup_entries` with a unique
   `clinicea_payment_id` + `source` for dedupe/refund handling. Clinicea has a REST API
   (`https://api.clinicea.com/api/v3/`, `api_key` header, Enterprise/add-on) with
   `getPayments` and webhooks. Open: does one webhook cover all branches, does the payload
   identify the clinic, and does it fire on payment vs bill.
7. **Realtime inbox — DONE (2026-08-03).** The inbox now uses Supabase Postgres Changes to push messages live; see [§14](#14-lead-hub--unified-inbox) and [artifacts/REALTIME_INBOX.md](artifacts/REALTIME_INBOX.md). Requires the `supabase_realtime` publication enabled on `lead_messages` + the `branch_id` backfill; degrades to load-on-open otherwise.
8. **Security hardening** — RLS + real auth instead of relying on the PIN/app layer.
9. **Branch Emails tab** — still a placeholder.
10. **Fix the schema-file drift** listed in [§17](#17-database-schema).
11. **Facebook comment automation — CODE SHIPPED, not yet switched on.** Mirrors the
    Instagram feature on shared `comment_rules`; see
    [§15](#facebook-comment-automation-same-pattern-shared-rules). Inert until: subscribe the
    Page **`feed`** + **`messaging_postbacks`** webhook fields, add **`pages_messaging` +
    `pages_read_engagement` + `pages_manage_engagement`** (Advanced Access / App Review — a
    separate track from Instagram), and subscribe the Page to the app (`/{page-id}/subscribed_apps`).
    **Gated on Instagram going live first** — FB inherits IG's answer to the two open button/postback
    assumptions. Procedure: [FACEBOOK_COMMENT_AUTOMATION.md §12](FACEBOOK_COMMENT_AUTOMATION.md).
    Also still needs the client's keyword list/DM copy before it can go live.
12. **Chatbot automation — RESEARCH, not started.** An LLM assistant that deflects repetitive
    FAQs and pre-qualifies leads on Instagram / Facebook / WhatsApp, so staff reply only to
    engaged, qualified conversations and can focus on treatment. Plugs into the existing
    `processIncomingMessage` → `routeLeadFromReply` choke point and reuses the per-platform
    senders; adds only two columns on `leads` (`bot_active`, `bot_state`) and a `chatbot_config`
    settings row. Hybrid model: a constrained LLM (knowledge base + hard guardrails, structured
    output) with a classifier-first safety net so medical / emergency questions hand off
    **before** the LLM answers — the bot is never the doctor. **Gated** on the realtime inbox
    being stable (item 7), routing being settled (item 1), and client decisions (platform,
    model, qualification fields, KB source). Procedure:
    [CHATBOT_AUTOMATION.md §12](artifacts/CHATBOT_AUTOMATION.md).

---

## 23. Companion documents

| Doc | Read it for |
|---|---|
| **This file** | Everything. Start here, keep it current. |
| [SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql) | The live DDL (with the drift caveats in §17) |
| [artifacts/REALTIME_INBOX.md](artifacts/REALTIME_INBOX.md) | Realtime inbox — research + impl spec. Supabase Postgres Changes push for `lead_messages`, the publication/backfill steps, and the optimistic-echo dedupe. |
| [WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md) | WhatsApp design, provider cost analysis, decision log, multi-branch routing options |
| [INSTAGRAM_COMMENT_AUTOMATION.md](INSTAGRAM_COMMENT_AUTOMATION.md) | Comment → public reply → auto-DM that asks the branch question → routing + 24 h window. Build-vs-buy, Meta API mechanics, full implementation spec. Built, not yet switched on. |
| [FACEBOOK_COMMENT_AUTOMATION.md](FACEBOOK_COMMENT_AUTOMATION.md) | The Facebook counterpart, on shared `comment_rules`. FB `feed` webhook, `/messages` `recipient:{comment_id}` (PSID), `/comments` public reply, Page permissions. Built, not yet switched on; gated on IG going live. |
| [artifacts/CHATBOT_AUTOMATION.md](artifacts/CHATBOT_AUTOMATION.md) | Chatbot — research + impl spec. LLM assistant that deflects FAQs and pre-qualifies leads, plugging into the existing message choke point. Hybrid model (constrained LLM + KB + guardrails + classifier-first medical handoff), minimal schema, build-vs-buy. Research, not started; gated on inbox stability + client decisions. |
| [artifacts/CHATBOT_BRAINSTORM_2026-08-17.md](artifacts/CHATBOT_BRAINSTORM_2026-08-17.md) | Chatbot planning session — the client's clarified priorities (IG bot first: FAQ + qualification + soft booking + locality→branch), the corpus-extraction findings (all test traffic; real history must come from the client's IG account via the `--meta` pull), and the resulting build order. |
| [WHATSAPP_SETUP_RUNBOOK.md](WHATSAPP_SETUP_RUNBOOK.md) | Click-by-click Meta setup, test flow, client-handover replay, ranked gotchas |
| [NETLIFY_CREDITS_WORKAROUND.md](NETLIFY_CREDITS_WORKAROUND.md) | Deploying/testing when production deploys are credit-blocked |
| [Clinix360_Instagram_GoLive_Session_2026-06-23.md](Clinix360_Instagram_GoLive_Session_2026-06-23.md) | Why IG webhooks were silent (app in Development mode) and how it was fixed |
| [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) | Earlier narrative overview — superseded by this file |
| [HANDOFF.md](HANDOFF.md) | Earlier developer handoff — partly stale (pre-`get-config`) |
| [README.md](README.md) | Day-1 setup history — **stale**, do not follow step 3 |
