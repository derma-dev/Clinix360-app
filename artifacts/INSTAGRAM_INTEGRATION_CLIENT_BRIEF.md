# Instagram Integration — Build Spec (Client Handoff)

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
> **Read §2 (data model) first.** The integration is built on a `leads` + `lead_messages`
> table pair. **The client's database does not currently have these.** Everything below
> depends on them existing with the columns named, so §2 gives you the DDL to create them.

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

> ⚠️ **The client's database does NOT have the `leads` table (and related columns) that
> this integration is built on.** Every IG code path — inbound, outbound, comment
> automation, the inbox, realtime — reads/writes these tables by these exact names and
> columns. **You must create them (DDL below) before anything will work.**
>
> If the client already has a leads-like table under a different name, you have two
> choices: (a) create these tables as-is (simplest — all the code below works unchanged),
> or (b) adapt every `db.from('leads')` / `db.from('lead_messages')` call to the client's
> existing table and map the columns. Option (a) is strongly recommended.

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
  name               TEXT DEFAULT '',         -- shown in the inbox; staff-facing
  source             TEXT DEFAULT '',         -- 'instagram' | 'facebook' | 'whatsapp' | …
  service            TEXT DEFAULT '',
  status             TEXT DEFAULT 'new',      -- 'new' | 'contacted' | 'converted' | 'lost'
  notes              TEXT DEFAULT '',
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

> **Column-name note.** The backend dedupes IG leads on `leads.instagram_user_id`. The
> frontend reads `leads` as `id, name, source, status, created_at, branch_id` and
> `lead_messages` as `id, lead_id, message, direction, created_at, is_seen, seen_at,
> branch_id`. If you change any column name, you must update every reference in §6 and §7.
> In the working project the lead name column is `customer_name`; below I've written
> `name` for readability — **pick one and use it consistently** (search-and-replace
> `customer_name` ↔ `name` if you want to match the reference code verbatim).

### 2.2 Realtime publication (required for the live inbox — see §9)

`lead_messages` (and `leads`) must be in the `supabase_realtime` publication or the
inbox's live push does nothing:

```sql
alter publication supabase_realtime add table leads;
alter publication supabase_realtime add table lead_messages;
-- (If they're already added, this errors harmlessly.)
```

### 2.3 Row-Level Security (RLS) — important decision

The backend functions talk to Supabase using the **public anon key** (not a service-role
key). Two valid setups — pick one:

- **RLS disabled on these tables** (simplest, matches the reference project's original
  posture): the anon key can read/write everything, security is enforced at the app/PIN
  layer.
  ```sql
  alter table leads          disable row level security;
  alter table lead_messages  disable row level security;
  alter table branches       disable row level security;
  alter table settings       disable row level security;
  ```
- **RLS enabled** (harder, the reference project later moved to this): you must add
  policies that let the anon role `select`/`insert`/`update` on `leads`, `lead_messages`,
  `branches`, `settings`. Without those policies, **every webhook and every staff reply
  silently fails** (Supabase returns empty rows / 401). The browser client also uses the
  anon key, so the same policies serve both.

If unsure, start with RLS **disabled** and harden after the integration is working.

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
- **Privacy policy URL** (serve a static `privacy.html` — required by Meta; include a
  `#data-deletion` section for the data-deletion URL field)
- Category → "Business and Pages"

After that, App Review (§4.2) gates public access.

---

## 5. Environment variables

Set in `.env` locally and in **Netlify → Site settings → Environment variables** in
production (not committed to the repo). Any change requires a **redeploy**.

```bash
# Supabase — required by every function
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here

# Meta / Instagram — required for IG
META_ACCESS_TOKEN=your_instagram_access_token_here   # the IGAA… token from §4.1
META_VERIFY_TOKEN=any_random_string_you_choose       # must match the Meta dashboard webhook field
META_BRANCH_ID=your_fallback_branch_uuid_here        # UUID of the branch new IG leads attach to
META_APP_ID=your_app_id_here                         # declared by getConfig(); keep set
META_APP_SECRET=your_app_secret_here                 # declared by getConfig(); keep set

# Optional (IG only)
# META_IG_ID=your_ig_account_numeric_id_here        # defaults to 'me' (resolved via the token)

# Skip these — they are Facebook / WhatsApp only:
# META_PAGE_ACCESS_TOKEN, META_PAGE_ID, WHATSAPP_*
```

> `META_BRANCH_ID` is the **fallback** branch for every newly-created IG lead. Comment
> automation later moves the lead to the correct branch once the customer answers
> "which branch?". It must be a real `branches.id` UUID.

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
| `/webhook/meta` | POST | a Meta webhook payload (JSON) | `200 { status: "ok" }` |
| `/.netlify/functions/meta-send` | POST | `{ "leadId": "<uuid>", "message": "<text>" }` | `200 { ok: true, message: <row> }`; `400/404/502` on error |
| `/.netlify/functions/meta-status` | GET | — | `200 { instagram: { connected: bool, name: "@handle" } }` |

### 6.2 `meta-webhook.js` — thin wrapper

```js
const { verifyWebhook, handleWebhook } = require('./utils/meta-service');

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    const result = verifyWebhook(event.queryStringParameters || {});
    return result.valid
      ? { statusCode: 200, body: result.challenge }          // plain text, NOT json
      : { statusCode: 403, body: 'Forbidden' };
  }
  if (event.httpMethod === 'POST') {
    const payload = JSON.parse(event.body || '{}');           // let JSON errors 400
    await handleWebhook(payload);                             // must finish before 200
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ status: 'ok' }) };
  }
  return { statusCode: 405, body: 'Method Not Allowed' };
};
```

> ⚠️ **Security gap to be aware of (and ideally fix):** the reference POST handler does
> **not** verify Meta's `X-Hub-Signature-256` HMAC. `META_APP_SECRET` is required by config
> but never used at runtime. For a production client, add HMAC verification: hash the raw
> request body with `META_APP_SECRET` using HMAC-SHA256 and compare to the header. See §11.

### 6.3 Webhook verification (GET) — depends ONLY on `META_VERIFY_TOKEN`

```js
function verifyWebhook(query) {
  const expected = process.env.META_VERIFY_TOKEN;
  if (!expected) return { valid: false };
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === expected) {
    return { valid: true, challenge: query['hub.challenge'] };
  }
  return { valid: false };
}
```

Crucial: do **not** require the other `META_*` vars on the GET path. A missing app
secret/access token must not block the URL verification handshake — Meta won't let you
subscribe fields until the URL verifies.

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

async function processIncomingMessage(senderId, messageText, platform = 'instagram', profileName = null) {
  const branchId = process.env.META_BRANCH_ID;     // throws if missing
  const db = createSupabaseClient();

  let lead = await db.findLeadByPlatformId(platform, senderId);   // lookup by instagram_user_id
  if (lead) {
    // backfill the real display name on older leads still showing the placeholder
    if (!lead.name || lead.name === PLACEHOLDER_NAMES[platform]) {
      const display = buildDisplayName(await fetchInstagramProfile(senderId)) || profileName;
      if (display) await db.updateLead(lead.id, { name: display });
    }
  } else {
    const display = buildDisplayName(await fetchInstagramProfile(senderId)) || profileName || PLACEHOLDER_NAMES[platform];
    lead = await db.createLead({
      branch_id: branchId,
      source:    platform,
      name:      display,
      [ID_COLUMNS[platform]]: senderId,             // instagram_user_id = the IGSID
      status:    'new',
    });
  }

  await db.insertMessage({
    lead_id:   lead.id,
    branch_id: lead.branch_id,                      // ★ set on every row (realtime filter)
    direction: 'incoming',
    message:   messageText,
    is_seen:   false,
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
    ev.senderId, ev.messageText || '(button tap)', 'instagram', ev.profileName);
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
(`{ apikey, Authorization, 'Content-Type', Prefer: 'return=representation' }`).

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

### 7.2 The inbox (unified — IG is one `source`)

There is **no separate IG tab**. IG lives inside one "Leads/Inbox" view with a platform
toggle (All / Instagram / …). For the branch view:

- **Load:** `db.from('leads').select('id, name, source, status, created_at, branch_id').eq('branch_id', currentBranch)`; then `db.from('lead_messages').select('lead_id, message, direction, created_at, is_seen').in('lead_id', ids)` to build last-message previews + unread counts.
- **Open a thread:** `db.from('lead_messages').select('id, direction, message, created_at').eq('lead_id', id)` (ascending).
- **Mark seen:** `db.from('lead_messages').update({ is_seen: true, seen_at: now }).eq('lead_id', id).in('direction', ['in','incoming']).eq('is_seen', false)`.
- **Send:** optimistic bubble, then `POST /.netlify/functions/meta-send` with `{ leadId, message }`. On success the realtime echo of your own row is deduped by matching `data-sent-key = "${lead_id}|${message}"` (DOM presence, not a time window — survives a slow Graph send).
- **Platform badge:** for `source === 'instagram'` render the IG logo; IG leads are identified solely by `source`.

Admin view is the same pattern, unscoped by branch, with a Source `<select>` dynamically
populated from the distinct `source` values present (so "Instagram" only appears once an IG
lead exists) and a status filter (`new/contacted/converted/lost` → the `status` column).

### 7.3 Comment automation settings UI

A settings card that manages the `comment_rules` JSON array. **The frontend never matches
or sends** — it only CRUDs the rules; matching happens server-side on the `comments`
webhook (§6.7).

```js
// Load:  db.from('settings').select('value').eq('key','comment_rules').single()
// Save:  db.from('settings').upsert({ key:'comment_rules', value: JSON.stringify(rules) }, { onConflict:'key' })
```

HTML inputs per rule: `keyword` (or `*` for any), `public` reply text, `dm` body. Validate:
require a keyword and at least one of public/dm; block duplicate keywords (case-insensitive).
See §8.3 for the rule shape and copy guidelines.

### 7.4 Connected Accounts

A settings card rendering one row per platform from a constant list
(`{ key:'instagram', label:'Instagram', badge:'IG' }`). Live status comes from
`GET /.netlify/functions/meta-status`. The Connect/Disconnect button only flips
`settings.integrations.instagram` (a **pause** flag for ingestion, not an OAuth revoke):

```js
// { instagram: true } in settings.integrations
db.from('settings').upsert({ key:'integrations', value: JSON.stringify({ instagram: on }) }, { onConflict:'key' });
```

The backend reads this fail-open (`isPlatformEnabled`): only an explicit `false` pauses
ingestion — a missing key or a DB error leaves it enabled so a toggle glitch never silently
drops real DMs.

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

Each step is independently verifiable. Do §4 (Meta app) **first** — it has the longest lead
time, in parallel with the code.

**Phase 0 — Meta app (parallel, long pole)** — §4
- [ ] Create Business app; add Instagram product; generate `IGAA…` token.
- [ ] Subscribe webhook fields: `messages`, `comments`, `messaging_postbacks`.
- [ ] `subscribed_apps` per-account for those fields.
- [ ] Privacy policy URL; flip app **Live**; begin **App Review** for
      `instagram_business_manage_messages` + `instagram_manage_comments`.

**Phase 1 — Database** — §2
- [ ] Create `branches`, `leads`, `lead_messages`, `settings` (DDL in §2.1).
- [ ] Add `leads` + `lead_messages` to `supabase_realtime` publication (§2.2).
- [ ] Decide RLS posture (§2.3); insert the fallback branch + an "Unassigned" branch.
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
- [ ] Add `X-Hub-Signature-256` HMAC verification (§11).
- [ ] Decide token rotation strategy (no auto-refresh today).
- [ ] Update the project's master docs in the same commit as each change.

---

## 11. Critical gotchas (the things that fail silently)

In roughly the order they'll bite:

1. **App in Development mode.** Meta sends zero real webhook notifications in dev mode —
   not even from testers. The dashboard "Test" button works (manual sample), so everything
   looks fine until a real DM produces an empty log. Go **Live** (§4.5).
2. **`X-Hub-Signature-256` not verified.** The reference POST handler trusts any caller.
   For a production client, HMAC-verify the raw body with `META_APP_SECRET` and reject on
   mismatch. (`META_APP_SECRET` is already in env; currently unused.)
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
12. **RLS + anon key.** If RLS is enabled and policies aren't in place for the anon role,
    every webhook insert and every staff reply silently fails. (§2.3.)
13. **One private reply per comment, ever.** Send the DM **first** so a webhook redelivery
    fails at the DM step and doesn't double-post the public reply. (§8.1.)

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
case-insensitive), and branch matching (full name vs first word, ambiguous → null).
**Port these tests** — they are the single source of truth for webhook-shape edge cases.

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

*End of spec. Build IG only; leave the Facebook/WhatsApp code paths out unless and until
those channels are also scoped in.*
