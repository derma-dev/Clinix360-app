-# Instagram Integration — Build Spec (Client Handoff)

> **Purpose of this document.** This is a self-contained spec for implementing the
> **Instagram-only** integration described inside. It was extracted from a working
> Clinix360 dashboard where Instagram (IG) is one of three messaging channels
> (Instagram, Facebook, WhatsApp) running through a shared inbox. **Only the Instagram
> pieces are described here.** Facebook/WhatsApp code paths are mentioned only where they
> share infrastructure with IG, and are clearly marked *skip*.
>
> **Who this is for.** Hand this file to Claude (or a developer) working against the
> client's own codebase. It contains: what IG does, the data model it depends on, the Meta
> app configuration, the exact Graph API calls, the webhook payload shapes, the comment
> automation engine, and a phased build order.
>
> **Do Step 0 first.** The spec below is extracted from a working reference project
> (vanilla JS + Supabase + Netlify Functions). The client's stack, schema, and conventions
> will differ. **Examine the client's codebase and database before writing or changing any
> code** — then adapt this spec to what you find. The **Step 0** box immediately below this
> is mandatory and comes before everything else.

---

## 🔒 Scope — Instagram ONLY, but IG must keep working

**This engagement integrates Instagram, and only Instagram.** The #1 rule: **the IG flow must
work end-to-end** — webhook → lead + message → inbox → staff reply, plus comment automation.
Do **not** build new Facebook or WhatsApp features. But do **not** break the shared
infrastructure IG depends on, either. IG shares its webhook receiver, parser, lead/message
layer, and Supabase client with FB/WA, so those shared functions must stay intact even though
only the IG branch ever actually runs.

What "Instagram only" means in practice:

- **Don't build new FB/WA features.** No Facebook Page or WhatsApp webhook subscriptions,
  tokens, number setup, or UI rows. FB/WA are a **separate** later engagement.
- **Leave FB/WA env vars unset** (`META_PAGE_ACCESS_TOKEN`, `META_PAGE_ID`, `WHATSAPP_*`) and
  don't subscribe their webhook fields. This is correct and **does not affect IG** — IG uses
  its own token (`META_ACCESS_TOKEN`) and the `object === 'instagram'` webhook branch, both
  independent of the FB/WA paths.
- **Port the shared functions INTACT.** `platformFor`, `extractEvents`,
  `processIncomingMessage`, `createSupabaseClient` (the multi-platform `ID_COLUMNS`),
  `meta-send`'s source dispatch, and the `facebook_user_id` / `whatsapp_user_id` columns all
  sit alongside the IG code. Their FB/WA branches are **inert** (nothing fires without the
  matching webhooks/tokens) but **do not strip them out** — the IG branch lives in the same
  functions and tables, and a careless removal is the easiest way to break IG. If a FB/WA
  piece is genuinely needed for the IG path to run, **keep it**; we'll wire FB/WA properly
  later.
- **Admin UI:** build the Leads pages, Comment Automation, and Connected Accounts for
  Instagram. Comment automation fires on IG comments only.

In short: **IG working > IG-only purity.** Never sacrifice a working IG path to enforce the
scope limit — just don't *add* new FB/WA functionality.

---

## ⚠️ Step 0 — Examine the client codebase & database FIRST

**Do this before writing a single line of code or running any DDL.** This spec describes
*what the IG integration does* and *how it's built in the reference project*. It is **not**
a literal copy-paste — the client's stack and database will be different, and the
integration must be adapted to fit what already exists. Mapping it wrongly (wrong table
names, wrong DB-access pattern, wrong auth) is the #1 way this goes wrong.

### 0.1 Examine the codebase

Read enough of the repo to answer:

- **Stack & framework** — React/Next/Vue/Svelte? Express/Fastify/PHP/Laravel/.NET? TypeScript
  or plain JS? Is there a build step, or is it static files? (The reference is framework-less
  vanilla JS — the client's almost certainly isn't.)
- **How the app talks to its database** — direct SDK in the browser (supabase-js)? A REST/ORM
  server layer the frontend calls? This decides whether the "frontend → DB" and "function → DB"
  patterns in §6–§7 even apply, or whether all DB access must go through the client's existing
  server/API layer. **Match the client's existing pattern; don't introduce a new one.**
- **Existing integration / messaging / webhook code** — is there already a webhook receiver,
  a "connected accounts" or integrations table, a settings/config store, a contacts/leads/
  inbox feature, a scheduled-job runner? **Reuse what exists.** Don't build a parallel system.
- **Auth model** — sessions, JWT, API keys, PIN? The webhook + send endpoints in §6 are
  currently unauthenticated (Meta calls the webhook; the dashboard calls send). Decide how
  that fits the client's auth — at minimum, the send endpoint should be protected, and the
  webhook should be HMAC-verified (see §11).
- **Secrets / env loading** — where are env vars read (`.env`, platform dashboard, a config
  module)? Match it for the `META_*` / `SUPABASE_*` vars in §5.

### 0.2 Examine the database schema

Dump the **full** schema (every table + columns + types + constraints + RLS status). If
Supabase, check the Table Editor or `\d` in the SQL editor; if SQL Server/MySQL/Postgres,
the equivalent catalog query. Specifically look for tables that already resemble:

| Reference table (this doc) | What it holds | Likely client aliases to look for |
|---|---|---|
| `leads` | one row per prospective customer | `customers`, `contacts`, `enquiries`, `patients`, `crm_leads` |
| `lead_messages` | the conversation timeline | `messages`, `conversations`, `chat_messages`, `dm_log` |
| `branches` | one row per location/clinic | `locations`, `clinics`, `stores`, `outlets` |
| `settings` | key/value JSON config | `config`, `app_settings`, `options` |

Record, for each: the **exact** table name and the **exact** column names. You will map every
`db.from('leads')` / `db.from('lead_messages')` / `db.from('branches')` / `db.from('settings')`
call in §6–§7, and every column the code reads/writes (`source`, `instagram_user_id`,
`direction`, `branch_id`, `is_seen`, `status`, `customer_name`, etc.), onto these real
names. **The client's DB is known to lack the `leads` infrastructure** — so expect to either
create it (§2.1) or extend an existing table with the missing columns.

Also check:
- **RLS — likely already ON in the client's DB; check it.** The backend *and* the browser
  both use the **public anon key** (no service-role key). If RLS is enabled on a table
  without an `anon` policy, that table is silently invisible/unwritable to both — webhooks
  insert nothing, replies 401, and the failure gives no error. Run the check query in §2.3
  and record which of `leads`, `lead_messages`, `branches`, `settings` have RLS on. Note the
  trap: `authorizeRequest` (§6.6) reads `settings.admin_pin` + `branches.pin` with the anon
  key — those two must stay anon-readable or **auth itself breaks**.
- **Realtime** — if Supabase, does the `supabase_realtime` publication exist, and which tables
  are in it? The live inbox (§9) needs `lead_messages` (or its mapped equivalent) added to it.

### 0.3 Write down the mapping before coding

Before changing anything, record (in your plan / a scratch file):

1. The stack and the DB-access pattern you'll use (reuse the client's existing one).
2. The **table & column mapping**: reference name → client name, for all four tables and the
   columns listed in §2.1. Flag every column that doesn't exist yet and must be added.
3. The list of tables/columns to **create** (the ones with no existing equivalent).
4. The RLS posture and whether realtime publication needs a table added.

Only once that mapping exists, proceed to §2 (create or extend the tables) and §10 (build
order). The DDL in §2.1 is the **reference shape** — create it verbatim only if the client has
no equivalent tables; otherwise adapt the code to the real names you just recorded.

---

## Table of contents

1. [What the IG integration does](#1-what-the-ig-integration-does)
2. [Data model — **read first; client DB is missing this**](#2-data-model--read-first-client-db-is-missing-this)
3. [Architecture & data flow](#3-architecture--data-flow)
4. [Meta app setup (the part with lead time)](#4-meta-app-setup-the-part-with-lead-time)
5. [Environment variables](#5-environment-variables)
6. [Backend implementation](#6-backend-implementation)
7. [Frontend implementation](#7-frontend-implementation)
8. [Comment automation — the non-obvious Meta mechanics](#8-comment-automation--the-non-obvious-meta-mechanics)
9. [Realtime inbox (live DMs without refresh)](#9-realtime-inbox-live-dms-without-refresh)
10. [Build order — start here](#10-build-order--start-here)
11. [Critical gotchas (the things that fail silently)](#11-critical-gotchas-the-things-that-fail-silently)
12. [Testing](#12-testing)

---

## 1. What the IG integration does

Four capabilities, all in one shared inbox:

| # | Capability | What happens |
|---|---|---|
| 1 | **Inbound DM ingestion** | A customer DMs the IG account → Meta POSTs a webhook → a lead + message row are created → the message appears in the dashboard inbox in real time. |
| 2 | **Outbound replies** | Staff type a reply in the inbox → it is sent to IG via the Graph API and stored as an outgoing message. (Subject to Meta's 24-hour messaging window.) |
| 3 | **Comment automation** | A customer comments on a public post → the matched rule posts a public reply under the comment **and** sends exactly **one** DM to the commenter (a "private reply"), with tappable branch buttons. Their answer routes the lead to a branch and opens the 24h window. |
| 4 | **Connection status** | An admin panel pings the Graph API and reports whether the IG account is connected. |

IG is identified throughout by the literal string `source = 'instagram'`. There is **no
separate IG table, IG screen, IG OAuth button, IG media grid, or IG stories** anywhere.
IG is a `source` value flowing through a unified Leads/Inbox. Implement it that way.

---

## 2. Data model — **read first; client DB is missing this**

> ⚠️ **The client's database is known to lack the `leads` table (and related columns) that
> this integration is built on.** Every IG code path — inbound, outbound, comment
> automation, the inbox, realtime — reads/writes these tables. **After Step 0**, you know
> what already exists. Then:
>
> - **If no equivalent tables exist** → create them verbatim from the DDL below. All the code
>   in §6–§7 then works unchanged (the lead-name column is `customer_name`).
> - **If equivalent tables exist** (e.g. a `customers` / `messages` pair) → do **not** create
>   duplicates. Extend them with any missing columns (notably `instagram_user_id`, `source`,
>   `branch_id`, `direction`, `is_seen`) and map every `db.from(...)` call + column in §6–§7
>   onto the real names you recorded in Step 0.3.
>
> The DDL below is the **reference shape** — the contract the code expects — not a command to
> run it blindly. Reuse > create > duplicate, in that order.

### 2.1 Tables IG depends on

Run this in the client's Supabase SQL editor. (Adapted from the working project's live
schema.) Four tables matter for IG: `branches`, `leads`, `lead_messages`, `settings`.

```sql
-- ── branches — one row per location/clinic ──────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  pin         TEXT NOT NULL,                 -- 4-digit staff login (if you use PIN auth)
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- Insert at least one branch. New IG leads attach to a "fallback" branch id
-- (META_BRANCH_ID env var) until the customer's answer routes them.
-- Recommended: also create an "Unassigned" catch-all branch.

-- ── leads — one row per prospective customer ────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_id          UUID REFERENCES branches(id) ON DELETE CASCADE,
  source             TEXT DEFAULT '',         -- 'instagram' | 'facebook' | 'whatsapp' | …
  service            TEXT DEFAULT '',
  status             TEXT DEFAULT 'new',      -- 'new' | 'contacted' | 'converted' | 'lost'
  notes              TEXT DEFAULT '',
  customer_name      TEXT NOT NULL DEFAULT '',  -- shown in the inbox; the code reads/writes customer_name everywhere
  instagram_user_id  TEXT,                    -- ★ the IG-scoped sender id (IGSID); dedupe key for IG
  facebook_user_id   TEXT,                    -- (skip — FB only)
  whatsapp_user_id   TEXT,                    -- (skip — WhatsApp only)
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_instagram_user ON leads(instagram_user_id);
CREATE INDEX IF NOT EXISTS idx_leads_branch         ON leads(branch_id, created_at DESC);

-- ── lead_messages — the conversation timeline for a lead ────────────
CREATE TABLE IF NOT EXISTS lead_messages (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id     UUID REFERENCES leads(id) ON DELETE CASCADE,
  branch_id   UUID REFERENCES branches(id) ON DELETE CASCADE,  -- ★ set on EVERY row (realtime filter)
  direction   TEXT NOT NULL DEFAULT 'outgoing',  -- 'incoming' (customer→us) | 'outgoing' (us→customer)
  message     TEXT NOT NULL DEFAULT '',
  is_seen     BOOLEAN DEFAULT false,             -- inbound messages staff haven't read yet
  seen_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_messages_lead ON lead_messages(lead_id, created_at ASC);
-- Idempotency: Meta redelivers a webhook POST on timeout. external_message_id holds the
-- Meta message id (IG/FB mid, WA wamid); a redelivery is a silent no-op via the UNIQUE
-- index + PostgREST resolution=ignore-duplicates. Nullable: the comment path and outgoing
-- staff sends carry no Meta id (exempted by the partial index).
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS external_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS lead_messages_external_message_id_key
  ON lead_messages(external_message_id) WHERE external_message_id IS NOT NULL;

-- ── settings — key/value JSON store for app config ──────────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT                       -- stores JSON strings
);
-- Keys IG uses:
--   'comment_rules'   -> JSON array, see §8.3
--   'integrations'    -> JSON object { "instagram": true } — per-platform on/off (pause) flag
--   'admin_pin'       -> (only if you use the PIN auth model)
```

> **Column-name note.** The lead-name column is **`customer_name`** — the code reads/writes
> it everywhere (the schema's `CREATE TABLE` plus an `ALTER … ADD COLUMN IF NOT EXISTS
> customer_name` migration confirm it). The backend dedupes IG leads on
> `leads.instagram_user_id`. The frontend reads `leads` as
> `id, customer_name, source, status, created_at, branch_id` and `lead_messages` as
> `id, lead_id, message, direction, created_at, is_seen, seen_at, branch_id,
> external_message_id`. If you map onto the client's existing tables, update every reference
> in §6–§7 to the real names.

### 2.2 Realtime publication (required for the live inbox — see §9)

`lead_messages` (and `leads`) must be in the `supabase_realtime` publication or the
inbox's live push does nothing:

```sql
alter publication supabase_realtime add table leads;
alter publication supabase_realtime add table lead_messages;
-- (If they're already added, this errors harmlessly.)
```

### 2.3 Row-Level Security (RLS) — **check first; the client's DB likely already has it ON**

The backend functions talk to Supabase with the **public anon key** (no service-role key).
So does the browser. If RLS is enabled on a table and there's no policy for the `anon` role,
that table is **invisible and unwritable** to both — and the failure is **silent**
(PostgREST returns empty rows / 0 inserts; no error is thrown). The client's DB is very
likely already RLS-enabled, so **don't assume it's off — check**.

**Step 1 — check what's actually on:**

```sql
select relname as table_name, relrowsecurity as rls_on
from pg_class
where relname in ('leads','lead_messages','branches','settings')
order by relname;
```

**Step 2 — if RLS is ON (likely), the `anon` role must be able to do the following** or IG
breaks silently:

| Table | anon must… | why |
|---|---|---|
| `leads` | `select`, `insert`, `update` | webhook finds / creates / routes leads; inbox lists them |
| `lead_messages` | `select`, `insert`, `update` | webhook + send insert rows; inbox reads + marks-seen |
| `branches` | `select` | comment buttons, branch routing, **and `authorizeRequest` reads `branches.pin`** |
| `settings` | `select`, `insert`/`update` | `comment_rules` / `integrations` CRUD, **and `authorizeRequest` reads `settings.admin_pin`** |

> ⚠️ **The auth trap.** `authorizeRequest` (§6.6) reads `settings.admin_pin` and
> `branches.pin` **with the anon key**. If RLS blocks anon `select` on those rows, the send
> endpoint 401s everyone — including legit staff — so the integration looks "broken" when the
> real cause is a missing read policy. The pin tables **must** be anon-readable for auth to
> work at all.

Two ways to satisfy the requirements — pick one:

- **(A) Permissive `anon` policies** on the four tables (simplest; matches the reference,
  which relies on app/PIN-layer security rather than RLS for these). Postgres requires *some*
  policy to exist when RLS is on; these grant full access to the anon role the functions and
  browser use:
  ```sql
  create policy "anon_all_leads"          on leads          for all to anon, authenticated using (true) with check (true);
  create policy "anon_all_lead_messages"  on lead_messages  for all to anon, authenticated using (true) with check (true);
  create policy "anon_all_branches"       on branches       for all to anon, authenticated using (true) with check (true);
  create policy "anon_all_settings"       on settings       for all to anon, authenticated using (true) with check (true);
  ```
- **(B) Use a SERVICE-ROLE key server-side** in the functions (`createSupabaseClient`,
  `getSettingJson`, `authorizeRequest`) instead of the anon key. The service role bypasses
  RLS, so webhook/send paths work regardless of policies — but **never ship the service-role
  key to the browser** (the browser keeps the anon key). More moving parts (two keys, two
  client constructors) but tighter if the client's RLS is intentionally restrictive.

If the §2.3 check shows RLS **off** on all four tables, nothing extra is needed — but re-run
the check after any schema migration, since migration tooling can flip it back on.

---

## 3. Architecture & data flow

```
                        ┌──────────────────────────────────────────────┐
   Instagram user ──DM──►  Meta  ──POST /webhook/meta──►  Netlify fn    │
                        │  meta-webhook.js (GET verify + POST receive)  │
                        │            │                                  │
                        │            ▼                                  │
                        │  utils/meta-service.js                        │
                        │   • extractEvents()   → DMs / postbacks       │
                        │   • extractComments() → comments              │
                        │   • processIncomingMessage() → leads table    │
                        │   • processComment()   → reply + DM + lead    │
                        │            │                                  │
                        │            ▼  (anon key, REST)                │
                        │  Supabase: leads + lead_messages              │
                        └──────────────────────────────────────────────┘
                                   ▲                          ▲
                                   │                          │
            (Postgres Changes,     │           (REST write,   │
             WebSocket — §9)        │            anon key)     │
                                   │                          │
   Browser dashboard ──────────────┘          Staff reply ─────┘
   app.js: inbox list + thread             POST /.netlify/functions/meta-send
```

**Stack:** plain HTML + vanilla JS frontend (no framework, no build step); Supabase
(Postgres + REST + Realtime); Netlify Functions (Node 18, built-in `fetch`); Meta Graph
API `v21.0` at `graph.instagram.com`.

**The four Netlify function files IG touches:**

| File | Role |
|---|---|
| `netlify/functions/meta-webhook.js` | Public entry. GET = Meta's verify handshake; POST = parse JSON, call `handleWebhook`. |
| `netlify/functions/meta-send.js` | Outbound. Body `{ leadId, message }`. Reads the lead, sends via IG, stores outgoing message. |
| `netlify/functions/meta-status.js` | Read-only. Pings `graph.instagram.com/me`, returns `{ instagram: { connected, name } }`. |
| `netlify/functions/utils/meta-service.js` | All the logic: webhook verify/handle, IG-vs-FB detection, profile fetch, lead create/find, comment engine, branch routing, the `sendInstagramMessage` helper. |

`netlify.toml` routes `/webhook/meta` → `meta-webhook` (this redirect **must** come before
the SPA catch-all `/*` → `/index.html`, or webhooks get the HTML page back):

```toml
[functions]
  directory = "netlify/functions"

[[redirects]]
  from = "/webhook/meta"
  to   = "/.netlify/functions/meta-webhook"
  status = 200
  force  = true

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

---

## 4. Meta app setup (the part with lead time)

This is the long-pole item — start it first, in parallel with the code. Verified against
Meta's docs, July 2026. The flavour is **Instagram API with Instagram Login**
(`graph.instagram.com`, token starts `IGAA…`) — *not* the Facebook-Login/Page-token
flavour that most blog posts show.

### 4.1 Create the app & get the IG token

1. developers.facebook.com → create a **Business** app.
2. Add the **Instagram** product → **API setup with Instagram login** → **Generate access
   tokens**. The token you get is `META_ACCESS_TOKEN` (looks like `IGAA…`). This is a
   long-lived user token; there is **no automatic refresh** in the code — when it expires,
   a human regenerates it (see §11).

### 4.2 Permissions (scopes) needed for IG

| Permission | Enables | Access level needed to go live to the public |
|---|---|---|
| `instagram_business_manage_messages` | Inbound DM ingestion, outbound replies, **private reply** to a comment | **Advanced Access** — requires full **App Review** |
| `instagram_manage_comments` | **Public reply** under a comment (the `/replies` edge) | Advanced Access — App Review |
| `pages_show_list` / `pages_read_engagement` | Often required by the App Review submission | as review dictates |

> In **Development mode** with **tester roles**, DMs and comments work between the IG
> account and added testers. For DMs/comments from the **general public**, the app must be
> **Live** AND have **Advanced Access** on these permissions via App Review. Budget weeks
> for review. Until then, test with tester accounts.

### 4.3 Webhook subscription

- **Callback URL:** `https://<your-site>/webhook/meta`
- **Verify token:** any random string you choose → set as `META_VERIFY_TOKEN` env var →
  must match exactly what you enter in the Meta dashboard. (Gotcha: don't leave the literal
  `<TOKEN>` placeholder in the URL during the browser test — it returns "Forbidden".)
- **Subscribe these fields** for the IG account:
  - `messages` — inbound DMs
  - `comments` — comments on your media (for comment automation)
  - `messaging_postbacks` — button taps (for comment-automation branch routing)
- **Subscribing the field ≠ verifying the URL.** After the URL verifies, you must also
  tick each field and see it show **Subscribed**.

### 4.4 Per-account subscription (`subscribed_apps`)

Even after the webhook fields are subscribed at the app level, the specific IG account
must be subscribed to the app for those fields. Check / subscribe via the Graph (PowerShell
example — on Windows, `curl` is aliased to `Invoke-WebRequest`, so use `Invoke-RestMethod`):

```powershell
# Check:
(Invoke-RestMethod "https://graph.instagram.com/v21.0/me/subscribed_apps?access_token=YOUR_IG_TOKEN").data.subscribed_fields
# → should list: messages, comments, messaging_postbacks

# Subscribe if empty/missing:
Invoke-RestMethod -Method Post "https://graph.instagram.com/v21.0/me/subscribed_apps?subscribed_fields=messages,comments,messaging_postbacks&access_token=YOUR_IG_TOKEN"
```

### 4.5 Going Live (the single most common blocker)

Meta sends **zero** real webhook notifications while the app is in **Development mode** —
even from tester accounts. (The dashboard "Test" button still works because it's a manual
sample, which is why everything looks fine until you test with a real DM.)

To flip the app to **Live**, App Settings → Basic requires:
- App icon (1024×1024 PNG)
- **Privacy policy URL** — a public `privacy.html` (see §4.6). Satisfies two Meta fields at
  once: the Privacy Policy URL and the Data Deletion Instructions URL.
- Category → "Business and Pages"

After that, App Review (§4.2) gates public access.

### 4.6 Privacy policy page (`privacy.html`) — required to go Live

Meta will **not** let you flip the app from **Development → Live** without a public **Privacy
Policy URL**, and App Review needs a **Data Deletion Instructions URL**. Both are hard
blockers — and without Live mode Meta sends **zero** real webhooks (§11 #1), so the entire
integration stays dead until this page exists and is reachable.

It's a single static HTML page at a public HTTPS URL, e.g. `https://<your-site>/privacy.html`
(served as-is by the host; no build step). Base it on the reference `privacy.html`. It must
cover, at minimum:

- **What you collect** — Instagram message data (the sender's Instagram-scoped ID + message
  content received via the Meta Platform) and the lead/message records stored from it.
- **How you use it** — to read and reply to customer enquiries.
- **Data sharing** — Meta/Instagram, plus your hosting + DB providers (e.g. Netlify + Supabase).
- **Data retention.**
- **A `#data-deletion` section** — a contact path (email) for users to request deletion and a
  timeframe. Put the `id="data-deletion"` anchor on that section: its URL
  (`https://<site>/privacy.html#data-deletion`) is what you paste into Meta's **Data
  Deletion Instructions URL** field.
- **Contact.**

Fill in the client's real business name, the data-deletion contact email, and an "updated"
date. The page must be live at the exact URL **before** you set it in the Meta dashboard and
flip the app to Live.

---

## 5. Environment variables

Set in `.env` locally and in **Netlify → Site settings → Environment variables** in
production (not committed to the repo). Any change requires a **redeploy**. The reference
project ships a **`.env.example`** template listing every variable below with comments —
copy it to `.env` and fill in the values; only the IG-relevant subset is shown here (leave
the FB/WA vars in the template unset, per the scope box up top).

```bash
# Supabase — required by every function
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here

# Meta / Instagram — required for IG
META_ACCESS_TOKEN=your_instagram_access_token_here   # the IGAA… token from §4.1
META_VERIFY_TOKEN=any_random_string_you_choose       # must match the Meta dashboard webhook field
META_BRANCH_ID=your_fallback_branch_uuid_here        # UUID of the branch new IG leads attach to
META_APP_ID=your_app_id_here                         # declared by getConfig(); keep set
META_APP_SECRET=your_app_secret_here                 # ★ ALSO verifies the webhook HMAC (§6.2) — set it in prod

# Security — protects the write/send endpoints from forgery (§6.6)
# The browser sends x-staff-pin (the logged-in PIN); server-to-server callers (e.g. a
# scheduled cron) send x-internal-secret = this value. Required for staff replies /
# automations to fire once meta-send is auth-gated. Generate a long random string.
INTERNAL_FUNCTION_SECRET=your_random_internal_secret_here

# Optional (IG only)
# META_IG_ID=your_ig_account_numeric_id_here        # defaults to 'me' (resolved via the token)

# Skip these — they are Facebook / WhatsApp only:
# META_PAGE_ACCESS_TOKEN, META_PAGE_ID, WHATSAPP_*
```

> **Where does `META_BRANCH_ID` come from?** It's not from Meta — it's the **`id` (UUID) of a
> row in your own `branches` table** (§2.1). Create the table, insert a branch (plus an
> "Unassigned" catch-all), then copy the generated `id` into this var:
>
> ```sql
> insert into branches (name, pin, active)
> values ('Unassigned', '0000', true)
> returning id;          -- ← paste this UUID into META_BRANCH_ID
> ```
>
> This is the **fallback** `branch_id` written on every new IG lead (DMs + comment-automation
> leads). Comment automation later moves the lead to the real branch once the customer answers
> "which branch?" (`routeLeadFromReply`, §6.8). Changing the var later only affects *new* leads;
> existing leads keep their assigned `branch_id`.

---

## 6. Backend implementation

All IG backend logic lives in `netlify/functions/utils/meta-service.js` (~870 lines in the
reference). Below are the exact contracts and the non-obvious pieces. The pure helper
sections (payload extraction, rule matching) are copied verbatim because they are the
load-bearing, easy-to-get-wrong parts.

### 6.1 Endpoint contracts

| Path | Method | Body / Query | Returns |
|---|---|---|---|
| `/webhook/meta` | GET | `?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` | `200` → the `hub.challenge` as **plain text**; else `403 Forbidden` |
| `/webhook/meta` | POST | a Meta webhook payload (JSON) + `X-Hub-Signature-256` header | `200 { status: "ok" }`; `403` if the HMAC signature is missing/invalid (when `META_APP_SECRET` is set) |
| `/.netlify/functions/meta-send` | POST | `{ "leadId", "message" }` + `x-staff-pin` (browser) or `x-internal-secret` (cron) header | `200 { ok: true, message: <row> }`; `401` unauthorized; `400/404/502` on error |
| `/.netlify/functions/meta-status` | GET | — | `200 { instagram: { connected: bool, name: "@handle" } }` |

### 6.2 `meta-webhook.js` — thin wrapper

```js
const { verifyWebhook, verifyMetaSignature, handleWebhook } = require('./utils/meta-service');

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    const result = verifyWebhook(event.queryStringParameters || {});
    return result.valid
      ? { statusCode: 200, body: result.challenge }          // plain text, NOT json
      : { statusCode: 403, body: 'Forbidden' };
  }
  if (event.httpMethod === 'POST') {
    // Verify Meta's HMAC over the RAW body BEFORE trusting it. Without this, anyone who
    // knows the public webhook URL can forge inbound DMs / comment automation.
    if (!verifyMetaSignature(event.body || '', event.headers['x-hub-signature-256'])) {
      return { statusCode: 403, body: 'Invalid signature' };
    }
    const payload = JSON.parse(event.body || '{}');           // let JSON errors 400
    await handleWebhook(payload);                             // must finish before 200
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ status: 'ok' }) };
  }
  return { statusCode: 405, body: 'Method Not Allowed' };
};
```

The signature check HMAC-SHA256s the **raw body** with `META_APP_SECRET` and constant-time
compares it to the `sha256=…` header. **Dev fallback:** if `META_APP_SECRET` isn't set it
logs a warning and **allows** (so local dev without the secret isn't broken) — **prod must
set it** to actually enforce. Port the helper verbatim:

```js
const crypto = require('crypto');
function safeEqual(a, b) {                                     // constant-time compare
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function verifyMetaSignature(rawBody, signatureHeader) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return true;                                 // dev: warn + allow — SET IN PROD
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  return safeEqual(signatureHeader, expected);
}
```

### 6.3 Webhook verification (GET) — depends ONLY on `META_VERIFY_TOKEN`

```js
function verifyWebhook(query) {
  const expected = process.env.META_VERIFY_TOKEN;
  if (!expected) return { valid: false };
  if (query['hub.mode'] === 'subscribe' && safeEqual(String(query['hub.verify_token']), expected)) {
    return { valid: true, challenge: query['hub.challenge'] };   // constant-time compare (§6.2)
  }
  return { valid: false };
}
```

`safeEqual` (constant-time, §6.2) keeps the verify-token comparison from being a timing
oracle, and the token value from the URL is no longer logged. Crucial: do **not** require
the other `META_*` vars on the GET path. A missing app secret/access token must not block
the URL verification handshake — Meta won't let you subscribe fields until the URL verifies.

### 6.4 Platform detection + payload extraction (the core parser)

All platforms POST to the same URL; the payload's `object` field discriminates:

```js
function platformFor(object) {
  return object === 'instagram' ? 'instagram'
       : object === 'page' ? 'facebook'                         // skip — FB only
       : object === 'whatsapp_business_account' ? 'whatsapp'    // skip — WA only
       : null;
}

// Flatten a webhook payload into message events (DMs + button taps).
function extractEvents(payload) {
  const platform = platformFor(payload.object);
  if (!platform) return { platform: null, events: [] };
  const events = [];
  for (const entry of (payload.entry || [])) {
    // Shape A — real IG DMs arrive as entry[].messaging[]
    for (const msg of (entry.messaging || [])) {
      events.push({
        senderId:    msg.sender?.id,
        messageText: msg.message?.text ?? msg.postback?.title,   // a button tap's label becomes the text
        messageId:   msg.message?.mid ?? msg.postback?.mid,      // Meta id → inbound idempotency (§6.5)
        isEcho:      msg.message?.is_echo === true,              // our own outbound — skip
        payload:     msg.postback?.payload ?? msg.message?.quick_reply?.payload, // button-tap routing data
        profileName: null,
        shape:       'messaging',
      });
    }
    // Shape B — entry[].changes[].field='messages' is the Meta dashboard "Test" button
    // shape for IG. Real IG DMs use Shape A, but accept this too.
    for (const change of (entry.changes || [])) {
      if (change.field !== 'messages') continue;     // comments handled separately (§6.7)
      const value = change.value || {};
      events.push({ senderId: value.sender?.id, messageText: value.message?.text,
                    messageId: value.message?.mid,
                    isEcho: value.message?.is_echo === true, profileName: null, shape: 'changes' });
    }
  }
  return { platform, events };
}
```

> **Why two shapes matter.** Real IG DMs come in `entry[].messaging[]`. Meta's dashboard
> "Test" button sends `entry[].changes[].field='messages'`. The reference originally only
> read `changes[]`, so real DMs were silently dropped. Handle **both** — this was a real
> bug.

### 6.5 Inbound DM → lead + message

```js
const ID_COLUMNS = { instagram: 'instagram_user_id' /*, facebook:…, whatsapp:… */ };
const PLACEHOLDER_NAMES = { instagram: 'Instagram User' };

async function processIncomingMessage(senderId, messageText, platform = 'instagram', profileName = null, messageId = null) {
  const branchId = process.env.META_BRANCH_ID;     // throws if missing
  const db = createSupabaseClient();

  let lead = await db.findLeadByPlatformId(platform, senderId);   // lookup by instagram_user_id
  if (lead) {
    // backfill the real display name on older leads still showing the placeholder
    if (!lead.customer_name || lead.customer_name === PLACEHOLDER_NAMES[platform]) {
      const display = buildDisplayName(await fetchInstagramProfile(senderId)) || profileName;
      if (display) await db.updateLead(lead.id, { customer_name: display });
    }
  } else {
    const display = buildDisplayName(await fetchInstagramProfile(senderId)) || profileName || PLACEHOLDER_NAMES[platform];
    lead = await db.createLead({
      branch_id:     branchId,
      source:        platform,
      customer_name: display,
      [ID_COLUMNS[platform]]: senderId,             // instagram_user_id = the IGSID
      status:        'new',
    });
  }

  await db.insertMessage({
    lead_id:             lead.id,
    branch_id:           lead.branch_id,            // ★ set on every row (realtime filter)
    direction:           'incoming',
    message:             messageText,
    is_seen:             false,
    external_message_id: messageId || null,         // ★ dedupes Meta webhook redeliveries (UNIQUE, §2.1)
  });
  return lead;
}
```

The profile fetch resolves the sender's real name so the inbox shows "Priya Sharma", not
"Instagram User":

```js
async function fetchInstagramProfile(igsid) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return null;
  const res = await fetch(
    `https://graph.instagram.com/v21.0/${encodeURIComponent(igsid)}` +
    `?fields=name,username,profile_pic&access_token=${encodeURIComponent(token)}`);
  return res.ok ? await res.json() : null;          // swallow errors — never drop a DM
}
function buildDisplayName(profile) {
  return profile?.name || profile?.username || null; // real name, not the @handle
}
```

### 6.6 Outbound reply (`meta-send.js`)

The frontend only sends `{ leadId, message }`. The function resolves the recipient + the
24h-window rules from the lead row.

```js
exports.handler = async (event) => {
  // … CORS, OPTIONS, method guard, parse body …
  const { leadId, message } = body;
  if (!leadId || !message) return { statusCode: 400, /* … */ };
  if (Buffer.byteLength(message, 'utf8') > 1000) return { statusCode: 400, /* too long */ };

  if (!(await authorizeRequest(event))) return { statusCode: 401, /* Unauthorized */ };

  const db   = createSupabaseClient();
  const lead = await db.getLeadById(leadId);            // selects id, branch_id, instagram_user_id, source
  if (!lead) return { statusCode: 404, /* not found */ };

  if ((lead.source || '').toLowerCase() !== 'instagram')
    return { statusCode: 400, /* "outbound not supported for source" — IG-only build */ };
  if (!lead.instagram_user_id) return { statusCode: 400, /* no recipient id */ };

  try {
    await sendInstagramMessage(lead.instagram_user_id, message);   // Graph call (below)
    await db.insertMessage({ lead_id: leadId, branch_id: lead.branch_id,
                            direction: 'outgoing', message, is_seen: true });  // only after a successful send
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };  // e.g. 24h window closed
  }
};
```

> **Auth gate (`authorizeRequest`).** Every send must come from either the browser — header
> `x-staff-pin` equal to the logged-in admin PIN or any branch PIN (looked up from
> `settings.admin_pin` / `branches.pin`, constant-time compared) — or a server caller — header
> `x-internal-secret` equal to `INTERNAL_FUNCTION_SECRET` (used by scheduled automations).
> Anything else → `401`. Without this the public URL would let anyone DM every customer from
> the business's account. The frontend sends the PIN on every write via a `_staffPin()` helper
> (`state.adminPIN || state.currentBranch?.pin`).

```js
// POST https://graph.instagram.com/v21.0/{me|META_IG_ID}/messages  (Bearer token)
// Note the 24-HOUR WINDOW: you may only reply within 24h of the user's last message.
async function sendInstagramMessage(recipientId, text) {
  const token = process.env.META_ACCESS_TOKEN;
  const igId  = process.env.META_IG_ID || 'me';
  const res = await fetch(`https://graph.instagram.com/v21.0/${igId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Instagram send failed: ${res.status} ${data?.error?.message || JSON.stringify(data)}`);
  return data;   // { recipient_id, message_id }
}
```

### 6.7 Comment automation engine (the clever part)

Comments arrive on the **same** webhook under `entry[].changes[].field === 'comments'` — a
shape `extractEvents` deliberately ignores, so it gets its own stream:

```js
function extractComments(payload) {
  const comments = [];
  if (payload.object !== 'instagram') return comments;     // IG only here
  for (const entry of (payload.entry || [])) {
    for (const change of (entry.changes || [])) {
      if (change.field !== 'comments') continue;
      const v = change.value || {};
      comments.push({
        commentId: v.id,
        text:      v.text,
        fromId:    v.from?.id,
        username:  v.from?.username,
        name:      null,                                   // IG gives a username, not a display name
        // Null parent_id when it points at the media (the post), not another comment —
        // only a real reply-in-a-thread has a different parent. Keeps the top-level guard honest.
        parentId:  v.parent_id && v.parent_id !== v.media?.id ? v.parent_id : null,
        accountId: v.recipient_id || entry.id,             // OUR ig account id (self-loop guard)
      });
    }
  }
  return comments;
}
```

Rule matching — first keyword hit wins; `'*'` is the catch-all tried only after everything
misses; case-insensitive substring:

```js
function matchCommentRule(text, rules) {
  const t = (text || '').toLowerCase();
  return rules.find(r => r?.keyword && r.keyword !== '*' && t.includes(r.keyword.toLowerCase()))
      || rules.find(r => r?.keyword === '*')
      || null;     // no rules / no match → leave the comment alone
}
```

The driver (`processComment`) runs three guards, then DM-first, then public reply, then
creates the lead:

```js
async function processComment(c) {
  if (!c.commentId || !c.text || !c.fromId) return;       // guard: incomplete
  if (c.fromId === c.accountId) return;                   // guard: OUR OWN comment → infinite loop
  if (c.parentId) return;                                 // guard: reply inside a thread

  const rule = matchCommentRule(c.text, (await getSettingJson('comment_rules')) || []);
  if (!rule) return;                                      // no match → do nothing

  const db = createSupabaseClient();
  const branches = await db.listBranches();               // active branches → buttons

  // 1) DM FIRST (deliberate). Meta allows exactly ONE private reply per comment, ever,
  //    so a redelivered webhook throws here and we never double-post the public reply.
  const sent = rule.dm
    ? await sendCommentPrivateReply(c.commentId, rule.dm, branches)
    : null;

  // 2) Public reply is cosmetic — a failure (403 scope, rate limit) is logged and swallowed.
  if (rule.public) {
    try { await replyToComment(c.commentId, rule.public); }
    catch (e) { console.error('public reply failed (DM already sent):', e.message); }
  }
  if (!sent) return;

  // 3) Create the lead using the SEND response's recipient_id (the commenter's IGSID) —
  //    NOT the comment's from.id, which is a DIFFERENT id space. Using from.id would fork
  //    one person into two leads and break DM dedupe forever.
  const lead = await processIncomingMessage(sent.recipient_id, `[comment] ${c.text}`, 'instagram', c.username);
  await db.insertMessage({ lead_id: lead.id, branch_id: lead.branch_id,
                           direction: 'outgoing', message: rule.dm, is_seen: true });
}
```

The two Graph calls:

```js
// PRIVATE REPLY (the DM) — passing comment_id as the recipient is what makes DMing a
// stranger legal. It opens a 7-day window (vs the usual 24h) and Meta allows exactly ONE
// per comment. Buttons are POSTBACK (never web_url): a link tap sends us nothing — no
// event, no 24h window, no routing.
async function sendCommentPrivateReply(commentId, text, branches = []) {
  const token = process.env.META_ACCESS_TOKEN;
  const igId  = process.env.META_IG_ID || 'me';
  const buttons = branches.slice(0, 3).map(b => ({        // max 3 buttons (Meta's cap)
    type: 'postback', title: String(b.name).slice(0, 20), payload: `BRANCH:${b.id}` }));
  const message = buttons.length
    ? { attachment: { type: 'template',
        payload: { template_type: 'button', text, buttons } } }
    : { text };                                            // no branches → plain text fallback
  const res = await fetch(`https://graph.instagram.com/v21.0/${igId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`IG private reply failed: ${res.status} ${data?.error?.message}`);
  return data;   // { recipient_id, message_id }  ← recipient_id is the IGSID
}

// PUBLIC REPLY — posted under the comment. Needs instagram_manage_comments.
async function replyToComment(commentId, text) {
  const token = process.env.META_ACCESS_TOKEN;
  const res = await fetch(`https://graph.instagram.com/v21.0/${encodeURIComponent(commentId)}/replies`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`IG comment reply failed: ${res.status} ${data?.error?.message}`);
  return data;   // { id }
}
```

### 6.8 Branch routing from the customer's reply

When the customer taps a branch button or types a branch name, that reply both **routes
the lead** and **opens the 24h window** (it's a customer-initiated message). Runs on every
inbound DM, but only ever moves a lead still parked on the fallback `META_BRANCH_ID`:

```js
function matchBranch(text, branches) {
  const t = (text || '').toLowerCase();
  const hits = branches.filter(b => {
    const n = (b.name || '').toLowerCase();
    return n && (t.includes(n) || t.includes(n.split(' ')[0]));   // full name OR first word
  });
  return hits.length === 1 ? hits[0] : null;     // null on zero OR ambiguous — never guesses
}

async function routeLeadFromReply(lead, text, payload) {
  const fallback = process.env.META_BRANCH_ID;
  if (!lead || !fallback || lead.branch_id !== fallback) return;   // already routed → stop

  if (payload && payload.startsWith('BRANCH:')) {                   // button tap → exact id
    await db.updateLead(lead.id, { branch_id: payload.slice('BRANCH:'.length) });
    return;
  }
  const branch = matchBranch(text, await db.listBranches());        // typed answer
  if (branch) await db.updateLead(lead.id, { branch_id: branch.id });
}
```

And in `handleWebhook`, after each inbound event is processed:

```js
for (const ev of events) {
  if (ev.isEcho) continue;                                  // skip our own outbound
  if (!ev.senderId || (!ev.messageText && !ev.payload)) continue;
  const lead = await processIncomingMessage(
    ev.senderId, ev.messageText || '(button tap)', 'instagram', ev.profileName, ev.messageId);
  await routeLeadFromReply(lead, ev.messageText, ev.payload);   // ← routing hook
}
for (const c of extractComments(payload)) await processComment(c);  // comments stream
```

### 6.9 Connection status (`meta-status.js`, IG part)

```js
async function checkInstagram() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { connected: false };
  try {
    const res = await fetch(`https://graph.instagram.com/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
    if (!res.ok) return { connected: false };
    const d = await res.json();
    return { connected: true, name: d.username ? '@' + d.username : 'Connected' };
  } catch { return { connected: false }; }
}
// returns { instagram: { connected, name } }   (add FB/WA only if you port those later)
```

### 6.10 Supabase REST client (the one the functions use)

Node 18 built-in `fetch`, anon key as both `apikey` and `Authorization: Bearer`. No SDK,
no service-role key. Methods needed: `findLeadByPlatformId`, `getLeadById`, `createLead`,
`updateLead`, `insertMessage`, `listBranches` — each is a one-liner against
`${SUPABASE_URL}/rest/v1/<table>` with the standard PostgREST headers
(`{ apikey, Authorization, 'Content-Type', Prefer: 'return=representation' }`). The message
inserter adds `resolution=ignore-duplicates` to `Prefer`, so an insert whose
`external_message_id` already exists (a Meta webhook redelivery) is a silent no-op — this is
the inbound-dedupe mechanism (see §2.1 + §6.5).

---

## 7. Frontend implementation

The frontend is vanilla JS (single `app.js`, ~3900 lines in the reference) talking to
Supabase directly with the anon key plus two function calls. **There is no IG OAuth flow in
the frontend** — IG connection is established entirely server-side via the token in env; the
dashboard is read-only on connection state except for a pause/enable flag.

### 7.1 Boot sequence

1. `fetch('/.netlify/functions/get-config')` → returns `{ supabaseUrl, supabaseAnonKey }`
   (so creds live in env, not in shipped code). Create the supabase-js client `db`.
2. Load `branches`, then bind the inbox.

### 7.2 The Leads pages (branch inbox + admin)

There is **no separate IG tab**. IG lives inside the Leads screens — the **branch inbox**
and the **admin Leads page** — both keyed by `source`. (The concrete layout, design tokens,
and brand-badge helper are in **§7.5** — match the client's design system.) For the
**branch** view:

- **Load:** `db.from('leads').select('id, customer_name, source, status, created_at, branch_id').eq('branch_id', currentBranch)`; then `db.from('lead_messages').select('lead_id, message, direction, created_at, is_seen').in('lead_id', ids)` to build last-message previews + unread counts.
- **Open a thread:** `db.from('lead_messages').select('id, direction, message, created_at').eq('lead_id', id)` (ascending). **Stale-thread guard:** bail if the user switched conversation while the fetch was in flight (`_activeLeadId !== leadId`), or you'll paint the wrong thread.
- **Mark seen:** `db.from('lead_messages').update({ is_seen: true, seen_at: now }).eq('lead_id', id).in('direction', ['in','incoming']).eq('is_seen', false)`.
- **Send:** optimistic bubble, then `POST /.netlify/functions/meta-send` with `{ leadId, message }` **and header `x-staff-pin: <logged-in PIN>`** (the endpoint is auth-gated — §6.6). Two client-side dedupes keep the thread clean: (a) your own send's realtime echo is consumed by matching `data-sent-key = "${lead_id}|${message}"` on the optimistic bubble; (b) each bubble is stamped `data-msg-id`, so a realtime INSERT that a just-finished convo-load SELECT already painted is skipped.
- **Platform badge:** for `source === 'instagram'` render the IG logo; IG leads are identified solely by `source`.

**Admin Leads page** (`admin-tab-leads`) — the cross-branch view where IG leads are managed:

- **KPI strip** (`leads-kpi-grid`): Total / New / Contacted / Converted tiles + per-source
  chips (each IG chip uses the brand PNG via `sourceBadgeInner`). Conversion % is computed
  client-side. Rendered by `renderLeadsKpis(leads)`.
- **Filters** (`leads-filters-row`), all applied client-side against the cached
  `_adminLeadsAll` array: **Branch**, **Source** (a `<select>` dynamically populated from
  the distinct `source` values present — "Instagram" appears only once an IG lead exists),
  **Status** (`new / contacted / converted / lost`, mapped to the `status` column), and a
  name **Search**.
- **Table** (`leads-admin-table`, `renderLeadsTable`): name (brand badge + display name),
  source, branch, a per-row **status `<select>`** (`updateLeadStatus` →
  `db.from('leads').update({ status })`), and created time. Each row has a chat button →
  `openAdminChat(id)`.
- **Lead-chat modal** (`modal-lead-chat`): opens on row click. Header shows the brand avatar
  + name + platform label (`admin-chat-avatar/name/platform`); body is the `lead_messages`
  thread (`admin-convo-log`); the compose box sends via `POST /.netlify/functions/meta-send`
  with the `x-staff-pin` header — the **same** send path and 24h-window rules as the branch
  inbox. It runs its **own** realtime channel (`admin-msg`, unfiltered) so an incoming reply
  lands live while the modal is open (deduped by `data-msg-id`); unsubscribe on close.
- **Load:** `db.from('leads').select('id, customer_name, source, status, branch_id, created_at')`
  (all branches, admin-scoped), then per-lead last-message/unread like the branch inbox.

### 7.3 Comment Automation (Admin → Settings card)

A collapsible card under **Admin → Settings → "Comment Automation"** that manages the
`settings.comment_rules` JSON array. **The frontend never matches or sends** — it only CRUDs
the rules; the match + the public reply + the DM all happen server-side when the `comments`
webhook fires (§6.7, §8).

Card structure (from `index.html`):
- A description line restating the contract: public reply under the comment + one DM that
  ends in the branch question; a per-branch button is appended automatically; first keyword
  wins; `*` catches all; name the branches in the text too (buttons don't show on desktop).
- A rules list (`comment-rules-list`) — each saved rule rendered as a card with a delete
  control (`removeCommentRule`).
- An add row: `new-rule-keyword` (or `*`), `new-rule-public` (the public reply), `new-rule-dm`
  (textarea — the DM body), and `btn-add-comment-rule`.

CRUD — all through the `settings` table under key `comment_rules`:

```js
// Load (when the Settings tab opens):
db.from('settings').select('value').eq('key','comment_rules').single()
// Save (on add / delete):
db.from('settings').upsert({ key:'comment_rules', value: JSON.stringify(rules) }, { onConflict:'key' })
```

Validation in `addCommentRule`: require a keyword; require at least one of `public` / `dm`;
block duplicate keywords (case-insensitive). `keyword === '*'` renders as "Any comment". See
§8.3 for the rule shape and the copy rules that fall out of Meta's mechanics (always end on a
question, spell the branch names, no prices in the public field).

### 7.4 Connected Accounts (Admin → Settings card)

A collapsible card under **Admin → Settings → "Connected Accounts"** showing one row per
platform. For IG it reports whether the token is live and lets the admin **pause** ingestion.

- **Rows** are generated from a constant list, e.g.
  `INTEGRATION_PLATFORMS = [{ key:'instagram', label:'Instagram', badge:'IG' }, …]`, each
  rendered with the brand PNG via `sourceBadgeInner`.
- **Live status** comes from the server (source of truth), not the DB:
  `GET /.netlify/functions/meta-status` → `{ instagram: { connected: bool, name: '@handle' } }`.
  Each row shows a status pill — Connected (`@handle`) vs Not connected.
- **The button is a pause toggle, not OAuth.** Connect/Disconnect only writes the
  per-platform flag in `settings.integrations`:

  ```js
  db.from('settings').upsert({ key:'integrations', value: JSON.stringify({ instagram: on }) }, { onConflict:'key' });
  ```

  The IG connection itself is established entirely **server-side** via `META_ACCESS_TOKEN`
  in env — there is **no OAuth flow in the frontend**. "Disconnect" stops ingesting new IG
  DMs; it does **not** revoke the token and leaves existing leads/history untouched.
- The backend reads this flag **fail-open** (`isPlatformEnabled`, §6.4): only an explicit
  `integrations.instagram === false` pauses ingestion — a missing key, missing DB creds, or
  any read error leaves it **enabled**, so a settings glitch never silently drops real DMs.

### 7.5 UI design — the current inbox layout (match the client's design system)

> The dashboard's Leads/Inbox UI was recently restyled to **match the client's own design
> language** (commit `3e05dbd`, "show similar design as the client one"). This subsection
> documents what those IG-facing screens currently look like, so the implementation can match
> the client's design system rather than invent a new look. **These are reference values** —
> swap them for the client's real design tokens where they differ.

**Design language.** Warm, light, cream-and-gold (not the Instagram gradient). The palette
the reference uses:

| Token | Value | Used for |
|---|---|---|
| `--primary` | `#C4922A` | gold accent — active toggle button, unread dot, links |
| `--primary-dark` | `#8B6508` | hovered/pressed gold |
| `--primary-light` | `#fdf3e3` | gold tint backgrounds |
| `--bg` | `#faf6f1` | app background (warm off-white) |
| leads area bg | `#f4eee2` | the Leads tab background (warm cream) |
| card/table bg | `#fff` | the leads table + cards |
| borders | `#e7ddc9` / `#ece3d2` / `#efe7d6` | warm tan hairlines |
| text | `#2b2b2b` | primary (near-black) |
| secondary text | `#6b6356` / `#8a7f6b` / `#9a8f7b` | concern text, headers, labels |
| hover / active row | `#fbf7ef` / `#f6efe0` | lead row states |

**Layout — table, not a messenger sidebar.** The branch Leads tab is a **centered table**
with three columns, topped by a title + a platform toggle. Structure:

```html
<div class="leads-hub">
  <div class="leads-center">
    <div class="leads-toolbar">
      <h2 class="leads-page-title">Leads</h2>
      <div class="leads-platform-toggle" id="leads-platform-toggle">
        <button class="plat-btn active" data-src="all">All</button>
        <button class="plat-btn" data-src="instagram">Instagram</button>
        <button class="plat-btn" data-src="facebook">Facebook</button>
        <button class="plat-btn" data-src="whatsapp">WhatsApp</button>
      </div>
    </div>
    <div class="leads-table">
      <div class="leads-table-head"><span>Date</span><span>Name</span><span>Concern</span></div>
      <div id="leads-list"><!-- .lead-card rows --></div>
    </div>
  </div>

  <div class="leads-backdrop" id="leads-backdrop"></div>   <!-- dims leads area when chat open -->

  <div class="leads-detail-col" id="leads-detail-col">     <!-- slide-over chat panel -->
    <!-- header (back btn + avatar + name + platform label), convo log, compose -->
  </div>
</div>
```

Key behaviours:

- **Platform toggle** filters the table client-side by `lead.source` **without refetching** —
  it reuses the cached last-message map. The active button gets `var(--primary)` gold + white
  text. Bind it once (`bindLeadsToggle`, guarded by `dataset.bound`), set `_leadsSourceFilter`,
  call `applyLeadsFilter()` → `renderConversationList(filtered, …)`.
- **Each lead row** (`.lead-card`) is a 3-cell grid: **Date** · **Name** (platform badge +
  name + unread dot) · **Concern** (last message truncated to 64 chars, or italic "No
  messages yet"). Unread rows bold the name + concern and show a gold `.lead-unread-dot`
  inside the Name cell.
- **Chat is a slide-over**, not a second column: opening a lead adds `.active` to
  `.leads-detail-col` and fades in `.leads-backdrop` (CSS `:has(.leads-detail-col.active)`).
  Clicking the backdrop (or the back button) closes the chat. On mobile the grid collapses to
  Date · Name and the Concern column hides.
- **Empty state:** title "No leads yet", subtext "Messages from Instagram, Facebook and
  WhatsApp will appear here" (a centered icon + the two lines).

**Platform badges are brand PNGs, not letters.** The recent redesign replaced every 2-letter
badge (`IG`/`FB`/`WA`) with the brand logo via one helper used everywhere (lead rows, chat
avatars, admin KPI chips, admin table, Connected Accounts):

```js
// Inner markup for a platform badge: brand PNG for the 3 social platforms,
// otherwise the 2-letter fallback (Walk-in, Google, Referral, …).
function sourceBadgeInner(src) {
  const s = (src || '').toLowerCase();
  if (s === 'instagram' || s === 'facebook' || s === 'whatsapp') {
    return `<img class="platform-icon-img" src="assets/icons8-${s}-48.png" alt="${sourceLabelFull(s)}">`;
  }
  return esc(sourceLabel(s));   // 2-letter fallback for non-social sources
}
```

Assets needed: `assets/icons8-instagram-48.png`, `assets/icons8-facebook-48.png`,
`assets/icons8-whatsapp-48.png`. The `.conv-platform-icon` for these three has
`background: transparent` so the logo shows with no coloured circle behind it (the gold
circle is only for the 2-letter fallback sources). A smaller variant `.conv-platform-icon.sm`
(30×30, 8px radius) is used inside the dense lead rows.

> **Why this matters for IG:** the IG badge is `assets/icons8-instagram-48.png`, rendered by
> `sourceBadgeInner('instagram')`, shown on every IG lead row, the open-conversation header
> avatar, the incoming-message bubble avatar, and (in admin) the KPI chip and table. If the
> client's design uses different brand marks, drop in those assets and keep the helper — the
> `source === 'instagram'` branching is the only IG-specific part.

---

## 8. Comment automation — the non-obvious Meta mechanics

This is the feature most likely to be built wrong, because the mechanics are
counter-intuitive. Read before implementing §6.7.

### 8.1 The two replies, and the one-reply ceiling

When a comment matches a rule:

1. **One private reply (DM)** to the commenter, using `recipient: { comment_id }` (not
   `recipient: { id }`). This is the trick that makes DMing a stranger legal.
2. **One public reply** posted under the comment (cosmetic — "Check your DM 💬").

Meta allows **exactly ONE private reply per comment, ever.** A second call errors. This is
why the code sends the DM **first**: a redelivered webhook fails at the DM step (already
sent) and never reaches the public-reply step, so you can't double-post.

### 8.2 The windows

| | Normal DM reply | Private reply to a comment |
|---|---|---|
| Window | **24 hours** from their last message | **7 days** from the comment |
| Prior contact needed? | Yes (they must DM first) | **No** |
| How many | Unlimited within the window | **Exactly one, ever** |

After the private reply, **if they answer**, that answer is a customer-initiated message —
it opens a fresh 24h window and staff can then reply freely forever. **This is why the DM
copy must end in a question** (the branch question). A statement gives them nothing to
reply to, and the conversation dies with the allowance already spent.

### 8.3 Rule format (`settings.comment_rules`)

```json
[
  { "keyword": "price", "public": "Check your DM 💬",
    "dm": "Hi! Laser packages start from ₹X per session and depend on the area treated. Which branch works for you — Janakpuri, Kirti Nagar or Dwarka? I'll send the full price list and open slots." },
  { "keyword": "book",  "public": "Sent you a DM ✨",
    "dm": "Happy to get you booked in! Which branch is easiest for you — Janakpuri, Kirti Nagar or Dwarka?" },
  { "keyword": "*",     "public": "Check your DM",
    "dm": "Thanks for reaching out! Which branch are you closest to — Janakpuri, Kirti Nagar or Dwarka? I'll connect you with that team." }
]
```

- Case-insensitive substring; **first hit wins**; `*` is the catch-all tried only after
  every specific keyword misses; no rules / no match → comment is left alone.
- Either field may be blank: `public` only = public reply, no DM; `dm` only = silent DM.

**Copy rules that fall out of the mechanics:**

1. **Always end the DM on a question.** (Reopens the window.)
2. **Name the branches in the DM text too**, even though buttons exist — buttons don't
   render on instagram.com in a browser, and typed answers are matched against those exact
   strings.
3. **Spell branches exactly as in the `branches` table** — that string is what
   `matchBranch` matches. "Which branch?" alone gets "the nearest one", which routes nowhere.
4. **No prices or medical claims in `public`** — that's what the DM is for.

### 8.4 Buttons: POSTBACK, never web_url

The DM lands in the recipient's **message-requests** folder (they've never messaged us).
Quick replies **don't render** there; **template buttons** do. So buttons, not quick
replies. And `postback`, not `web_url`:

- **postback** — the tap sends us an event (the `payload`) → it's a customer-initiated
  interaction → **opens the 24h window AND hands us the exact branch id.** ✅
- **web_url** — the tap opens a link, sends us nothing → no window, no routing, no lead. ❌

Max **3 buttons** (Meta's cap) → **3 branches max** on buttons. A fourth branch forces a
fallback to typed answers. The button titles truncate at 20 chars. `payload` is
`BRANCH:<branch uuid>` — zero parsing, one tap.

The router accepts **postback payload, quick-reply payload, and free text** — all three
paths — so buttons are the *quality* path, never the *only* path. If Meta rejects the
button template entirely, the plain-text fallback keeps the feature working.

---

## 9. Realtime inbox (live DMs without refresh)

The inbox uses **Supabase Realtime Postgres Changes** (WebSocket), not polling.

```js
db.channel(`inbox-msg:${branchId}`)
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'lead_messages',
      filter: `branch_id=eq.${branchId}` },
    payload => onMessageInsert(payload.new))
  .subscribe();
```

Two requirements that **fail silently if missed** (see §11):

1. **Publication gate** — `lead_messages` must be added to the `supabase_realtime`
   publication (§2.2). Without it, the subscription "works" but never fires.
2. **`branch_id` on every row** — the channel filters `branch_id=eq.<id>` server-side.
   Every `insertMessage` call (inbound and outgoing) must set `branch_id`. In the reference
   this is backfilled on the table; without it, the filter matches nothing.

Subscribe on inbox entry, unsubscribe on exit/logout. Dedupe your own optimistic send by
matching a `data-sent-key` DOM attribute on the optimistic bubble — the realtime echo of
your own outgoing row should be consumed, not rendered as a duplicate.

---

## 10. Build order — start here

Each step is independently verifiable. The very first thing is **reconnaissance** (Step 0) —
examine the client's codebase and database before writing anything. In parallel, start the
**Meta app** setup, because it has the longest lead time (App Review can take weeks).

**Step 0 — Reconnaissance (do this first)** — see the Step 0 box near the top
- [ ] Map the client's stack, DB-access pattern, auth model, and env conventions.
- [ ] Dump the DB schema; identify existing tables that resemble `leads`, `lead_messages`,
      `branches`, `settings` and record their exact names + columns.
- [ ] Decide: create the reference tables as-is (§2.1) **or** map the code onto the client's
      existing tables. Write the table/column mapping down before coding.
- [ ] Check RLS posture and (if Supabase) the `supabase_realtime` publication.
- [ ] *Verify:* you have a written table/column mapping and a list of what's missing.

**Phase 0 — Meta app (parallel, long pole; start now)** — §4
- [ ] Create Business app; add Instagram product; generate `IGAA…` token.
- [ ] Subscribe webhook fields: `messages`, `comments`, `messaging_postbacks`.
- [ ] `subscribed_apps` per-account for those fields.
- [ ] Privacy policy URL; flip app **Live**; begin **App Review** for
      `instagram_business_manage_messages` + `instagram_manage_comments`.

**Phase 1 — Database** — §2
- [ ] Create `branches`, `leads`, `lead_messages`, `settings` (DDL in §2.1).
- [ ] Add `leads` + `lead_messages` to `supabase_realtime` publication (§2.2).
- [ ] Check RLS with the §2.3 query (the client's DB likely already has it ON); add the
      permissive anon policies (or switch the server to a service-role key) so the anon-key
      functions can read/write. Insert the fallback branch + an "Unassigned" branch.
- [ ] Set `META_BRANCH_ID` to the fallback branch UUID.

**Phase 2 — Backend, pure logic (no network)** — §6
- [ ] `meta-service.js`: `platformFor`, `extractEvents`, `extractComments`,
      `matchCommentRule`, `matchBranch`, `verifyWebhook`. Write the assertion tests (§12).
- [ ] *Verify:* `node netlify/functions/utils/meta-service.test.js` → all checks pass.

**Phase 3 — Backend, network paths** — §6
- [ ] `fetchInstagramProfile`, `processIncomingMessage`, `sendInstagramMessage`,
      `sendCommentPrivateReply`, `replyToComment`, `processComment`, `routeLeadFromReply`.
- [ ] `meta-webhook.js`, `meta-send.js`, `meta-status.js`. `netlify.toml` redirect.
- [ ] *Verify:* `GET /webhook/meta` handshake with `META_VERIFY_TOKEN`; send a tester DM
      → watch the function log → a `leads` + `lead_messages` row appears.

**Phase 4 — Frontend inbox** — §7
- [ ] Boot (`get-config`), branch inbox: load, open thread, mark seen, send via `meta-send`.
- [ ] Realtime subscription on `lead_messages` (§9).
- [ ] *Verify:* a tester DM appears live with no refresh; a staff reply round-trips.

**Phase 5 — Comment automation** — §6.7, §8
- [ ] `processComment` + `extractComments` wired into `handleWebhook`.
- [ ] Comment-rules settings card (§7.3).
- [ ] *Verify:* tester comments with the keyword → public reply + DM appear; tapping a
      branch button routes the lead and lets a subsequent staff reply send.

**Phase 6 — Harden + docs**
- [ ] Wire `X-Hub-Signature-256` HMAC verification into the webhook POST (§6.2) and
      `authorizeRequest` onto the send endpoint (§6.6); set `META_APP_SECRET` + `INTERNAL_FUNCTION_SECRET`.
- [ ] Decide token rotation strategy (no auto-refresh today).
- [ ] Update the project's master docs in the same commit as each change.

---

## 11. Critical gotchas (the things that fail silently)

In roughly the order they'll bite:

1. **App in Development mode.** Meta sends zero real webhook notifications in dev mode —
   not even from testers. The dashboard "Test" button works (manual sample), so everything
   looks fine until a real DM produces an empty log. Go **Live** (§4.5).
2. **Webhook signature — verify it (the reference now does).** `verifyMetaSignature`
   HMAC-SHA256s the raw body with `META_APP_SECRET` and rejects on mismatch. **Gotcha: it
   fails open if `META_APP_SECRET` is unset** (dev convenience) — so in prod you MUST set the
   var, or verification is silently skipped and the webhook is forgeable. (§6.2.)
3. **No token refresh.** The system consumes one long-lived `IGAA…` token from env. When
   it expires, every send/profile fetch fails softly (`connected: false`, DMs stop). Humans
   must regenerate. Consider a System User token with expiry **Never** for production.
4. **Id spaces — do not mix.** A comment's `from.id` is **not** the DM IGSID. The lead must
   be created from the **send response's `recipient_id`**, or one person forks into two
   leads and DM dedupe breaks permanently. (§6.7, step 3.)
5. **Realtime publication gate.** `lead_messages` not in `supabase_realtime` → the inbox
   subscription subscribes but never fires. (§2.2, §9.)
6. **`branch_id` filter.** The realtime channel filters `branch_id=eq.<id>`. If
   `insertMessage` doesn't set `branch_id`, the channel matches nothing. (§6.5, §9.)
7. **Self-comment infinite loop.** Without the `fromId === accountId` guard, our own public
   reply re-triggers the webhook and the account answers itself forever. (§6.7.)
8. **`web_url` instead of `postback`.** A link-tap button sends us nothing — no event, no
   24h window, no routing. Buttons must be `postback`. (§8.4.)
9. **`messaging_postbacks` unsubscribed.** Button taps vanish and the 24h window never
   opens. Subscribe the field (§4.3).
10. **Echo handling.** Skip `message.is_echo === true` or our own outbound DMs get ingested
    as inbound and create phantom leads. (§6.4.)
11. **Two webhook shapes for IG DMs.** Real DMs arrive as `entry[].messaging[]`; Meta's
    "Test" button sends `entry[].changes[].field='messages'`. Handle both. (§6.4.)
12. **RLS + anon key (the client's DB likely already has RLS ON).** The functions and
    browser use the anon key; if RLS is on without an `anon` policy on
    `leads`/`lead_messages`/`branches`/`settings`, every read returns empty and every insert
    is a silent no-op. **Including `authorizeRequest`'s read of `admin_pin`/`branches.pin` —
    so auth 401s too.** Run the §2.3 check; add permissive anon policies or switch the server
    to a service-role key.
13. **One private reply per comment, ever.** Send the DM **first** so a webhook redelivery
    fails at the DM step and doesn't double-post the public reply. (§8.1.)
14. **Send endpoint auth.** `meta-send` is gated by `authorizeRequest` (browser `x-staff-pin`
    or cron `x-internal-secret`). Deploy without `INTERNAL_FUNCTION_SECRET` set — or with the
    browser not sending a valid PIN — and every staff reply silently 401s. (§6.6.)
15. **Inbound dedupe needs the column.** Meta redelivers a webhook POST on timeout. Without
    `lead_messages.external_message_id` + its partial UNIQUE index (and
    `resolution=ignore-duplicates` on the insert), each redelivery creates a duplicate row →
    duplicate bubbles in the inbox. (§2.1, §6.5.)

---

## 12. Testing

**Pure-logic assertions (no Meta creds needed).** The reference ships a no-framework test
file `netlify/functions/utils/meta-service.test.js` — runnable with plain Node:

```bash
node netlify/functions/utils/meta-service.test.js
# → "meta-service: all checks passed"
```

It asserts the load-bearing edge cases: IG-vs-FB payload extraction, echo skipping,
postback title becoming message text, self-comment guard, `parent_id`-vs-media normalization
(top-level comment not wrongly skipped), rule matching (first-hit-wins, `*` catch-all,
case-insensitive), branch matching (full name vs first word, ambiguous → null), **webhook
signature verification** (valid HMAC passes; wrong / missing / malformed header reject;
unset `META_APP_SECRET` → dev allow), and **message-id extraction** (WA `wamid`, IG/FB
`message.mid`, postback `mid` all carried for dedup). **Port these tests** — they are the
single source of truth for webhook-shape edge cases.

**End-to-end smoke test (needs Live app + tester account):**

1. `GET /webhook/meta?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=X` → `200 X`.
2. Tester DMs the account → function log shows `Processing instagram message` → `leads` +
   `lead_messages` rows created → message appears live in the inbox.
3. Staff replies from the inbox → DM is delivered to the tester → outgoing row stored.
4. Tester comments the keyword on a public post → public reply posted + DM received (with
   branch buttons) → lead created from the DM's `recipient_id`.
5. Tester taps a branch button (or types the branch name) → `lead.branch_id` updates → a
   subsequent staff reply (now inside the 24h window) sends successfully.
6. Comment again on the **same** comment → second private reply errors (expected — the
   one-reply ceiling). Public reply is **not** double-posted.

---

*End of spec. Build the Instagram path only — don't add new Facebook/WhatsApp functionality,
but keep the shared infrastructure intact so IG keeps working. FB/WA are a separate later
engagement.*
