# Realtime Inbox — Research & Implementation Spec

> **Status: IMPLEMENTED in code — pending the DB publication step + a deploy.** *(2026-08-03)*
>
> The client (`app.js`) + server (`meta-service.js`, `meta-send.js`) code is
> written, syntax-checked, and the existing test suite passes. What remains is the
> one-time DB step (enable the `supabase_realtime` publication on `lead_messages` +
> backfill `branch_id`) and a deploy — see [§13](#13-implementation-order). Until
> the publication is on, the app **silently degrades** to the old load-on-open
> behaviour (no error). This file is both the research record and the impl spec.
>
> Companion to [PROJECT_DOCUMENTATION.md §14 & §20 quirk 8](PROJECT_DOCUMENTATION.md#14-lead-hub--unified-inbox)
> and [§22 roadmap item 7](PROJECT_DOCUMENTATION.md#22-roadmap--open-items). Written:
> **2026-08-03** · Planned against current `main` (HEAD `5d85d00`).
>
> **One-line summary:** subscribe the browser to `lead_messages` (and `leads`)
> via **Supabase Realtime Postgres Changes** — a WebSocket channel that ships
> inside the `supabase-js@2` we already load and pushes every DB write to every
> open dashboard. No new dependency, no new infrastructure, no new Netlify
> function. The whole feature is one SQL line + one subscription layer in
> `app.js` + a three-site backfill of the currently-unused `branch_id` column.

---

## Table of contents

1. [The ask](#1-the-ask)
2. [Research: what "real-time bidirectional" means here](#2-research-what-real-time-bidirectional-means-here)
3. [Build vs buy (and vs raw WebSocket)](#3-build-vs-buy-and-vs-raw-websocket)
4. [How Supabase Realtime actually works](#4-how-supabase-realtime-actually-works)
5. [Design](#5-design)
6. [The code (planned)](#6-the-code-planned)
7. [Setup](#7-setup)
8. [Test plan](#8-test-plan)
9. [Gotchas](#9-gotchas)
10. [Cost](#10-cost)
11. [Deliberately out of scope](#11-deliberately-out-of-scope)
12. [Open questions](#12-open-questions)
13. [Implementation order](#13-implementation-order)

---

## 1. The ask

Today every view in the Leads inbox is **load-on-open** — there is no push of any
kind (confirmed: the only `setInterval` in the repo is the IST clock at
[app.js:17](app.js#L17)). So:

- A customer sends an Instagram/Facebook/WhatsApp message → Meta → `/webhook/meta`
  → the row is written to `lead_messages` (`direction:'incoming'`) within a second
  ([meta-service.js:227](netlify/functions/utils/meta-service.js#L227)) — but the
  staff member's open inbox has no idea. They must **manually refresh** to see it.
- The conversation list builds its previews once at tab load
  ([app.js:204](app.js#L204)) and the code already apologises for it: *"The left
  card's preview is not realtime"* ([app.js:366](app.js#L366)). `syncCardPreview`
  is the current band-aid — it re-queries and patches a stale card only when a
  thread is *opened* ([app.js:382](app.js#L382)).
- Two staff (or admin + branch) looking at the same thread do not see each other's
  sends.

The ask: **real-time, bidirectional message sync with no manual refresh**, for both
the branch inbox and the admin chat modal.

---

## 2. Research: what "real-time bidirectional" means here

The phrase "bidirectional WebSocket between staff and user" deserves a correction,
because it changes the whole design:

**There is no — and should be no — direct socket between a staff member and a
customer.** The customer lives on Meta's transport (Instagram / Messenger /
WhatsApp); we cannot and would not bypass it. Every message in either direction is
already written to one shared table, `lead_messages`:

```
Customer ──Meta──▶ /webhook/meta ──▶ INSERT lead_messages  ◀──meta-send──◀ Staff UI
                                          │
                                   Supabase Realtime (WebSocket)
                                          ▼
                                   every open dashboard updates live
```

So "real-time bidirectional" in this architecture = **any write to the shared DB
appears instantly on every dashboard watching it.** That delivers two wins, not one:

1. **Inbound push** — a customer's message pops into the open thread and bumps the
   inbox card with zero refresh (the actual complaint).
2. **Multi-staff collaboration** — if admin replies from the chat modal and a branch
   staff member has the same thread open, both see each other's sends live. Today
   they silently miss each other.

The WebSocket therefore sits between **dashboard(s) and Postgres**, not between
staff and customer. This is why the right tool is a *DB-change* subscription, not a
messaging bus.

---

## 3. Build vs buy (and vs raw WebSocket)

Three credible options. The verdict is decisive.

### 3.1 Supabase Realtime Postgres Changes — **USE THIS**

A managed WebSocket gateway bundled with the Supabase project we already run.
`db.channel(...).on('postgres_changes', ...).subscribe()` is exposed by the
**exact** `supabase-js@2` we already load from CDN
([index.html:13](index.html#L13)), hanging off the `db` handle created at
[app.js:805](app.js#L805). It watches `lead_messages` — already the source of truth
both inbound and outbound write to — and pushes every change.

Why it wins on the project's own terms ("deliberately dependency-light"):

- **Already-installed dependency.** No new script, no npm package, no build step.
- **Already the source of truth.** We listen to writes we already do; no second
  messaging bus to keep in sync.
- **No new infrastructure / ₹0.** Part of Supabase; realtime limits on the free tier
  are far beyond a 3-clinic DM volume.
- **Already on the roadmap** — [§22 item 7](PROJECT_DOCUMENTATION.md#22-roadmap--open-items).

### 3.2 Raw WebSocket / Socket.io server — **do not**

Netlify Functions are **serverless and cannot hold a persistent connection** —
confirmed by Netlify's own docs and support: functions are short-lived
request/response cycles, and Socket.io servers that work locally fail silently when
deployed. To run a raw `ws`/Socket.io server you must stand up a separate
always-on host (Railway/Fly/Render/VPS): a new deploy target, new secrets, new
monitoring, a second process to keep alive. Massive overkill to replicate what
Supabase already gives us for free, watching the DB we already have.

### 3.3 Third-party realtime service (Ably / Pusher / PubNub) — **do not**

Netlify's own blog recommends this pattern for serverless realtime, but only when
you don't already have a realtime-capable database. We do. Paying Ably to do what
Supabase Realtime already does — against the same Postgres rows — is pure cost and a
second vendor.

**Sources:** [Supabase Postgres Changes docs](https://supabase.com/docs/guides/realtime/postgres-changes),
[Netlify: WebSockets in a serverless world](https://www.netlify.com/blog/web-sockets-in-a-serverless-world/),
[Netlify support: no native WebSockets](https://answers.netlify.com/t/does-netlify-support-websocket-programming/4213).

---

## 4. How Supabase Realtime actually works

### 4.1 The publication gate (the #1 silent-failure trap)

A channel connects even if the table is not enabled for realtime — it just never
fires. Postgres Changes only broadcasts tables added to the `supabase_realtime`
publication. One SQL line, or a dashboard toggle (Database → Publications →
`supabase_realtime` → tick the table):

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.lead_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.leads;
```

([Supabase docs](https://supabase.com/docs/guides/realtime/postgres-changes),
[discussion #13680](https://github.com/orgs/supabase/discussions/13680).)

### 4.2 The single-filter rule

A Postgres Changes channel accepts **one `eq` filter on one column**
([SO 74594066](https://stackoverflow.com/questions/74594066/),
[realtime-js#97](https://github.com/supabase/realtime-js/issues/97)). You cannot
`IN (list_of_leads)`. This is the single biggest design constraint and it dictates
the channel shape in [§5](#5-design).

Implication: to scope the inbox channel server-side by branch, the message row must
carry a filterable `branch_id`. Which leads to the next finding.

### 4.3 The `lead_messages.branch_id` column exists but is unused

The schema *has* `branch_id` on `lead_messages`
([SUPABASE_SCHEMA.sql:181](SUPABASE_SCHEMA.sql#L181)) — but **every insert leaves it
NULL**: `processIncomingMessage` ([meta-service.js:227](netlify/functions/utils/meta-service.js#L227)),
`meta-send` ([meta-send.js:73](netlify/functions/meta-send.js#L73)), and
`processComment` ([meta-service.js:789](netlify/functions/utils/meta-service.js#L789))
never set it. The branch relationship is resolved today through `leads.branch_id`.

This is the one schema-debt fix the feature wants: populate `branch_id` on each
insert (one line per site: `branch_id: lead.branch_id`), and the inbox channel
becomes a clean server-side `.eq('branch_id', <id>)` filter — no client-side
filtering, scales to any number of leads.

### 4.4 RLS posture

RLS is disabled on every table and the anon key already has full read/write
([§20](PROJECT_DOCUMENTATION.md#20-security-model-quirks--known-issues)). Realtime
inherits this: the anon key can subscribe and receive changes today, consistent
with the existing security model. (If [roadmap item 8](PROJECT_DOCUMENTATION.md#22-roadmap--open-items)
— RLS hardening — is ever done, the realtime role must retain `SELECT` policies on
these rows or subscriptions go dark.)

### 4.5 Reconnection

`supabase-js` manages the WebSocket lifecycle and reconnects automatically. We do
not write reconnect/backoff logic.

---

## 5. Design

### 5.1 Channels — one per scope, filtered server-side

**As built — one message channel per scope.** The `leads`-table channels from the
original plan were dropped: new/routed leads are detected via the "unknown
`lead_id` → `loadLeadsTab()`" check inside the message handler, which avoids
subscribing to `leads` UPDATEs (those fire on every name-backfill and would flash
the list on every inbound message).

| Scope | Channel | Filter | Fires on | Handler does |
|---|---|---|---|---|
| Branch inbox | `inbox-msg:{branchId}` | `lead_messages.branch_id = eq.{branchId}` | any message INSERT for this branch | open convo → append bubble + `markConversationSeen`; closed convo + incoming → unread dot; always → `syncCardPreview`; unknown lead → `loadLeadsTab()` |
| Admin chat modal | `admin-msg` | *(unfiltered)* | any message INSERT, any branch | if `_adminChatLeadId === payload.lead_id` → append to modal; else ignore |

The branch channel depends on [§4.3](#43-the-lead_messagesbranch_id-column-exists-but-is-unused)
— the `branch_id` backfill. **Without it** the channel matches nothing and the
inbox silently stays load-on-open (no error). The backfill is done in code
([§6.2](#62-server-backfill-three-one-line-fixes)); the one-shot existing-rows
backfill is [§6.1](#61-sql--publication--backfill).

### 5.2 Lifecycle — subscribe on entry, unsubscribe on exit

- **Branch Leads tab** — subscribe on `loadLeadsTab()`, unsubscribe on
  `closeLeadDetail()` / leaving the tab (so a staff member sitting on the cashup
  screen isn't holding a socket).
- **Active conversation** — handled *inside* the inbox channel (it already fires for
  the active lead's messages), not a separate per-lead channel. This avoids
  per-conversation subscribe/unsubscribe churn and sidesteps the single-filter limit.
- **Admin chat modal** — subscribe on `openAdminChat()`, unsubscribe on
  `closeAdminChat()`.
- One module-level helper, `subscribeInbox(branchId)` / `unsubscribeInbox()`, holds
  the channel refs and guards against double-subscribe.

### 5.3 The optimistic-echo dedupe problem (the main code subtlety)

Today, sending is **optimistic** ([app.js:402](app.js#L402)): the outgoing bubble
appears the instant staff hit send, marked "Sending…", then reconciled when the
`meta-send` fetch settles (`markBubbleSent` / `markBubbleFailed`). Once realtime is
on, the server's `INSERT` of that same outgoing row is pushed back to **every**
client — including the sender. A naive handler doubles the bubble.

Two cases to serve, and they pull in opposite directions:

- **Same client sent it** → suppress; the optimistic bubble already represents it.
- **Another staff/admin sent it** → append a confirmed outgoing bubble (this is the
  collaboration win).

**As built — DOM-marker dedupe (no schema change, no time window).** On send, the
optimistic bubble is stamped `data-sent-key="leadId|text"`. When an outgoing INSERT
echoes back over realtime, the handler looks that marker up in the DOM:
- if a bubble with that `data-sent-key` exists → it's our own send; consume the
  marker and **drop the echo** (the optimistic bubble already represents it);
- else → it's a send from another staff/admin → render it (the collaboration win).

DOM presence is the dedupe, not a time window. The echo only fires after the
Graph-API send + DB insert, routinely **>5 s**, so an earlier fixed-window `Set`
(`_recentlySent`, 5 s) expired before the echo arrived and **doubled the bubble** —
that was the first bug report and why it was replaced. Incoming INSERTs always
append (active thread) / bump unread (card) and call `markConversationSeen`.

### 5.4 Decisions worth arguing about

**a) Postgres Changes, not Broadcast/Presence.** Supabase Realtime also offers
Broadcast (custom pub/sub) and Presence (who's online). Neither fits: the source of
truth is the DB, and messages already arrive via webhook→INSERT. Listening to the DB
is the one moving part. Typing indicators (Presence) are explicitly out of scope
([§11](#11-deliberately-out-of-scope)).

**b) Filter by `branch_id`, not by a list of leads.** The single-filter rule
([§4.2](#42-the-single-filter-rule)) makes per-lead or lead-list filtering awkward.
`branch_id` is one column, one value, server-side — clean. This is why the backfill
is worth its three lines.

**c) Reuse the existing render primitives.** `renderThreadHtml`, `appendOutgoingBubble`,
`markBubbleSent`, `markConversationSeen`, `syncCardPreview`, `formatConvoTime` all
stay. Realtime just calls them with the new row; it does not introduce a second
render path.

**d) Keep the optimistic send exactly as-is.** Realtime is additive — it never
replaces the optimistic send, because the bubble must appear *before* the network
round-trip. Realtime only helps the *other* viewers and the inbound direction.

**e) `leads` channel catches routing for free.** `routeLeadFromReply` does
`UPDATE leads SET branch_id = …` ([meta-service.js:841](netlify/functions/utils/meta-service.js#L841)).
A `leads` channel filtered by `branch_id` fires on that UPDATE, so a lead routed by
the comment automation pops into the right branch's inbox with no extra plumbing.

### 5.5 Files touched

| File | Change |
|---|---|
| `lead_messages` (live DB) | none structural — `branch_id` column already exists; just gets populated. Realtime publication enabled. **Run the SQL in [§6.1](#61-sql--publication--backfill) in the Supabase SQL editor.** |
| [netlify/functions/utils/meta-service.js](netlify/functions/utils/meta-service.js) | add `branch_id: branchId` to the `insertMessage` in `processIncomingMessage` ([L227](netlify/functions/utils/meta-service.js#L227)) and `processComment` ([L789](netlify/functions/utils/meta-service.js#L789)). |
| [netlify/functions/meta-send.js](netlify/functions/meta-send.js) | add `branch_id: lead.branch_id` to the `insertMessage` ([L73](netlify/functions/meta-send.js#L73)). (Lead row already carries `branch_id`; `getLeadById` may need to select it.) |
| [app.js](app.js) | new realtime module (~80 lines): `subscribeInbox`/`unsubscribeInbox` + admin equivalents + the dedupe `Set` + the INSERT handlers calling existing render fns. Wired into `loadLeadsTab`/`closeLeadDetail`/`openAdminChat`/`closeAdminChat`. |
| [SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql) | fix the `lead_messages` drift while here: real columns are `direction ('incoming'/'outgoing')`, `message`, `is_seen`, `seen_at` (not `body`/`'in'`/`'out'` per [§17](PROJECT_DOCUMENTATION.md#17-database-schema)); document `branch_id` populated. |
| [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) | §14 (inbox now realtime), §20 quirk 8 (resolved), §21 changelog, §22 item 7 (closed). Same commit, per the file's maintenance rule. |

**No** new dependency, **no** new Netlify function, **no** new env var, **no** new
tables.

---

## 6. The code (planned)

Not yet written. Listed so the build is mechanical and the design is reviewable.

### 6.1 SQL — publication + backfill

Run in the Supabase SQL editor (idempotent — safe to re-run):

```sql
-- 0. Belt-and-braces: the column exists per SUPABASE_SCHEMA.sql, but make this
--    safe even if the schema file is wrong about it.
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS branch_id
  UUID REFERENCES branches(id) ON DELETE CASCADE;

-- 1. Enable realtime on lead_messages (the only table we subscribe to).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'lead_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lead_messages;
  END IF;
END $$;

-- 2. Backfill branch_id on existing rows (was NULL on every historical row).
--    One-shot; new inserts set it (meta-service inbound + meta-send outbound).
UPDATE lead_messages m
SET branch_id = l.branch_id
FROM leads l
WHERE m.lead_id = l.id AND m.branch_id IS NULL;

-- 3. Sanity check — expect 0.
SELECT count(*) AS still_null FROM lead_messages WHERE branch_id IS NULL;
```

### 6.2 Server backfill — three one-line fixes

```js
// meta-service.js — processIncomingMessage (L227)
await db.insertMessage({
  lead_id:   lead.id,
  branch_id: lead.branch_id,        // ← ADD  (lead already carries it)
  direction: 'incoming',
  message:   messageText,
  is_seen:   false,
});

// meta-service.js — processComment (L789)
await db.insertMessage({
  lead_id:   lead.id,
  branch_id: lead.branch_id,        // ← ADD
  direction: 'outgoing',
  message:   rule.dm,
  is_seen:   true,
});

// meta-send.js (L73) — and ensure getLeadById selects branch_id
const rows = await db.insertMessage({
  lead_id:   leadId,
  branch_id: lead.branch_id,        // ← ADD
  direction: 'outgoing',
  message,
  is_seen:   true,
});
```

`getLeadById` ([meta-service.js:101](netlify/functions/utils/meta-service.js#L101))
selects `id, instagram_user_id, facebook_user_id, whatsapp_user_id, source` — add
`branch_id` to that `select`.

### 6.3 `app.js` — realtime module (sketch)

A self-contained block in the Lead Hub section. Uses the global `db`
([app.js:805](app.js#L805)) and the existing render primitives — no new render path.

```js
// ============================================================
// REALTIME — live inbox via Supabase Postgres Changes
// ============================================================
let _inboxChannels = [];          // active channel handles
const _recentlySent = new Set();  // dedupe: 'leadId|text' keys, cleared after 5s

function _trackSent(leadId, text) {
  const key = `${leadId}|${text}`;
  _recentlySent.add(key);
  setTimeout(() => _recentlySent.delete(key), 5000);
}

// Append one message row to whichever log is active (branch inbox or admin modal).
function _appendMessageRow(row, lead) {
  if (row.lead_id === _activeLeadId) {
    const log = document.getElementById('leads-convo-log');
    if (log) {
      log.insertAdjacentHTML('beforeend', renderThreadHtml([row], lead));
      log.scrollTop = log.scrollHeight;
    }
  }
}

// Branch inbox — call on loadLeadsTab(); unsubscribe on leaving the tab.
function subscribeInbox(branchId) {
  unsubscribeInbox();

  const msgChan = db.channel(`inbox-msg:${branchId}`)
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'lead_messages',
          filter: `branch_id=eq.${branchId}` },
        payload => onInboxMessage(payload.new))
    .subscribe();

  const leadsChan = db.channel(`inbox-leads:${branchId}`)
    .on('postgres_changes',
        { event: '*', schema: 'public', table: 'leads',
          filter: `branch_id=eq.${branchId}` },
        payload => onInboxLead(payload))
    .subscribe();

  _inboxChannels = [msgChan, leadsChan];
}

function unsubscribeInbox() {
  _inboxChannels.forEach(c => db.removeChannel(c));
  _inboxChannels = [];
  _activeLeadId = null;
}

function onInboxMessage(row) {
  const lead = _leads.find(l => l.id === row.lead_id);
  const isOutgoing = ['out', 'outgoing'].includes(row.direction);

  if (isOutgoing) {
    if (_recentlySent.has(`${row.lead_id}|${row.message}`)) return;  // this client sent it
    _appendMessageRow(row, lead);                                     // another staff member did
  } else {
    _appendMessageRow(row, lead);
    if (row.lead_id === _activeLeadId) markConversationSeen(row.lead_id);
  }
  syncCardPreview(row.lead_id, row);   // refresh preview/time/unread on the card
}

function onInboxLead(payload) {
  // New lead, or a lead routed to this branch → refresh the list.
  // (Simplest correct behaviour: re-run the lightweight list query. At this
  // volume that's fine; a surgical DOM patch can come later.)
  loadLeadsTab();
}
```

Wiring points (one line each):
- `loadLeadsTab()` — after the initial render succeeds, call `subscribeInbox(state.currentBranch.id)`.
- `closeLeadDetail()` / leaving the branch Leads tab — `unsubscribeInbox()`.
- `sendLeadMessage()` — after `appendOutgoingBubble(body)`, call `_trackSent(leadId, body)`.

The admin modal mirrors this with an **unfiltered** channel and `_adminChatLeadId`
in place of `_activeLeadId`; subscribe in `openAdminChat()`, unsubscribe in
`closeAdminChat()`.

### 6.4 Schema-file fix (while we're here)

Align [SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql) `lead_messages` with the live DB
(per [§17 drift](PROJECT_DOCUMENTATION.md#17-database-schema)): real columns are
`direction` values `'incoming'`/`'outgoing'`, column `message` (not `body`), plus
`is_seen`/`seen_at`; note `branch_id` is now populated. Pure doc fix, no migration.

---

## 7. Setup

No new env vars, no new function. Two one-time steps:

1. **Enable realtime** on `lead_messages` and `leads` — Supabase Dashboard →
   Database → Publications → `supabase_realtime` → tick both, **or** the SQL in
   [§6.1](#61-sql--publication--backfill). Without this, channels connect but never
   fire — the #1 trap.
2. **Backfill `branch_id`** — the SQL `UPDATE` in [§6.1](#61-sql--publication--backfill),
   then the three one-line insert fixes ([§6.2](#62-server-backfill-three-one-line-fixes))
   so new rows carry it.

That's it. The browser code needs nothing deployed server-side beyond the insert
fixes — the realtime gateway is part of Supabase.

**Rollback:** `unsubscribeInbox()` everywhere + `ALTER PUBLICATION supabase_realtime
DROP TABLE ...`. The app reverts to load-on-open with no errors (the current
behaviour).

---

## 8. Test plan

No automated test for the socket layer (it needs a live Supabase project); verify
manually with two browser sessions. The render functions it calls are already
battle-tested.

### Manual smoke test

Prep: enable realtime + backfill done; two browsers (or a normal + incognito
window), one as branch staff, one as admin.

1. **Inbound, thread closed** — from a tester Meta account, DM the clinic. The
   branch inbox card updates its preview, time, and unread dot **without refresh**.
   Admin table row shows a new-message affordance.
2. **Inbound, thread open** — open the conversation, send another DM from Meta. The
   bubble appears live; unread is cleared (`markConversationSeen` fired); card stays
   in sync.
3. **Outbound, sender** — staff replies. One bubble (optimistic), marked sent on
   resolve. **Crucially: no second bubble** from the realtime echo (the dedupe
   `Set`).
4. **Outbound, other viewer** — with the same thread open in the **admin** modal,
   staff sends from the branch inbox. Admin sees the outgoing bubble appear live
   (the collaboration win).
5. **Routing** — trigger the comment automation (or manually flip a lead's
   `branch_id` in SQL). The card appears in the destination branch's inbox live,
   without re-opening the tab.
6. **New lead** — first-ever DM from a brand-new sender. A new card appears in the
   list live.
7. **Tab lifecycle** — leave the Leads tab (go to cashup). Confirm the channel is
   removed (`db.getChannels().length` for the branch scope is 0); no socket is held
   idle. Return — it re-subscribes.
8. **Reconnect** — with a thread open, toggle the network off/on. supabase-js
   reconnects; send a DM while offline, reconnect, it arrives without a manual
   refresh.

---

## 9. Gotchas

| # | Thing |
|---|---|
| 1 | **Enable the publication or nothing fires.** The channel connects and reports `SUBSCRIBED` even with the table absent from `supabase_realtime` — it just never emits. The #1 silent failure. |
| 2 | **One `eq` filter per channel.** No `IN (list)`. This is why we filter by `branch_id`, not by the set of loaded leads. |
| 3 | **`branch_id` must be populated.** The column exists but every insert leaves it NULL today. Without the backfill the inbox channel can't filter server-side. |
| 4 | **Optimistic-echo double-bubble.** The sender's own outgoing INSERT is pushed back; a naive handler renders it a second time. Dedupe by **DOM marker** (`data-sent-key` on the optimistic bubble), **not a time window** — the echo only fires after the Graph-API send + DB insert (routinely >5 s), so a fixed window expires first and doubles the bubble (the first bug we hit). Don't blanket-ignore outgoing either — that kills the multi-staff collaboration win. |
| 5 | **The schema file is stale on `lead_messages`.** [§17 drift](PROJECT_DOCUMENTATION.md#17-database-schema): real columns are `message`/`is_seen`/`seen_at`, direction `'incoming'`/`'outgoing'`. Don't trust the SQL file; trust the code. |
| 6 | **Unsubscribe on exit.** Holding a channel while on the cashup screen wastes a socket and re-renders cards no one is looking at. `unsubscribeInbox()` on tab/modal close. |
| 7 | **`is_seen` races on rapid inbound.** If two messages arrive in the same tick while the thread is open, `markConversationSeen` fires per message — harmless (idempotent bulk update) but worth knowing. |
| 8 | **RLS is off, so the anon key sees all rows over realtime too.** Consistent with today's posture, but a devtools-savvy user can subscribe and read every branch's messages. Does not get worse than today; matters again if [item 8](PROJECT_DOCUMENTATION.md#22-roadmap--open-items) (RLS) is done. |
| 9 | **Admin channel is unfiltered** — by design (admin sees all branches), so it carries every message insert. Fine at 3 clinics; revisit if volume spikes. |
| 10 | **Realtime does not replace the optimistic send.** The bubble must paint before the network round-trip; realtime only feeds the *other* viewers and the inbound direction. |

---

## 10. Cost

**₹0.** Supabase Realtime is included in the plan we already pay for; the free
realtime limits are far beyond a 3-clinic DM volume. No new dependency, no new
service.

---

## 11. Deliberately out of scope

| Skipped | Add when |
|---|---|
| **Typing indicators / presence** (Supabase Presence channel) | Staff ask for "X is typing…" or online dots. One more channel, low effort, but unrequested. |
| **`client_message_id` robust dedupe** ([§5.3](#53-the-optimistic-echo-dedupe-problem-the-main-code-subtlety)) | The 5 s / same-text window ever causes a missed or doubled bubble in practice (concurrent identical sends). |
| **Audible / desktop notification on inbound** | Staff want a chime or a Web Notification when a new DM lands while they're on another tab. |
| **Surgical DOM patch on `onInboxLead`** | Lead volume makes a full `loadLeadsTab()` re-query on every routing event feel slow. |
| **Mobile push (PWA / FCM)** | Staff want inbox pings when the dashboard isn't open — a different, larger track. |
| **RLS hardening for realtime** | Tightly coupled to [roadmap item 8](PROJECT_DOCUMENTATION.md#22-roadmap--open-items); do them together. |

---

## 12. Open questions

1. **Audible/desktop notification wanted?** The cheapest engagement win once realtime
   lands — a chime + Web Notification when an inbound message arrives and the inbox
   isn't focused. Say so and it goes in scope.
2. **Admin scope: one global channel or per-open-modal?** Plan subscribes the admin
   message channel only while a chat modal is open. If admin wants a live unread
   badge on the *table* while no modal is open, subscribe globally on entering the
   admin Leads tab instead (slightly more events, still trivial at this volume).
3. **Backfill tolerance** — the one-shot `UPDATE` rewrites `branch_id` on every
   historical `lead_messages` row. It's a pure null→value fill (no row changes
   shape), but confirm you're comfortable running it against production, or scope it
   to recent rows only.

---

## 13. Implementation order

Small build. SQL + ~80 lines of `app.js` + three one-line server fixes + docs.
**Code + docs are done; only the DB step + deploy remain.**

### Phase 1 — DB (enables everything; do first) — ☐ YOU RUN THIS

- [x] **1.** Run the SQL in [§6.1](#61-sql--publication--backfill) in the Supabase SQL
      editor: ensure the `branch_id` column, enable the `supabase_realtime` publication
      on `lead_messages`, backfill existing rows.
      *Verify:* the final `SELECT count(*) … WHERE branch_id IS NULL` → **0**, and
      Database → Publications → `supabase_realtime` shows `lead_messages` ticked.

### Phase 2 — server backfill (three one-line fixes) — ✅ done

- [x] **3.** `branch_id: lead.branch_id` added to the three `insertMessage` call sites
      (`processIncomingMessage`, `processComment`, `meta-send`); `branch_id` added to
      `getLeadById`'s `select`.
      *Verify:* `node netlify/functions/utils/meta-service.test.js` → `all checks passed`.

### Phase 3 — client realtime module — ✅ done

- [x] **4.** Realtime block added after `sendAdminChatMessage`: `subscribeInbox` /
      `unsubscribeInbox` (branch, filtered by `branch_id`), `subscribeAdminChat` /
      `unsubscribeAdminChat` (admin, unfiltered), the DOM-marker echo dedupe
      (`_findOwnSentBubble` + `data-sent-key`), `_messageBubbleHtml` (shared with
      `renderThreadHtml`), `_appendBranchMessage`, `_bumpCardUnread`, and the two
      INSERT handlers. `renderThreadHtml` refactored to use `_messageBubbleHtml`
      (identical output).
- [x] **5.** Lifecycle wired: `loadLeadsTab` → `subscribeInbox` (idempotent);
      `showHome` + `openAdminPanel` → `unsubscribeInbox`; `sendLeadMessage` +
      `sendAdminChatMessage` stamp `data-sent-key` on the optimistic bubble;
      `openAdminChat` → `subscribeAdminChat`; `closeAdminChat` → `unsubscribeAdminChat`.
      *Verify:* `node --check app.js` → OK. Live verify after deploy via the
      [manual smoke test](#manual-smoke-test).

### Phase 4 — docs — ✅ done

- [x] **6.** `lead_messages` drift fixed in [SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql).
- [x] **7.** [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) updated — §14, §17
      drift, §20 quirk 8, §21 changelog, §22 item 7, §23 companion docs.

### Things not to rediscover the hard way

The three that break silently, in the order they'll bite:

1. Table not in `supabase_realtime` → channel is "subscribed" but never fires (no error).
2. `branch_id` still NULL → the inbox `filter: branch_id=eq.…` matches nothing.
3. No `_recentlySent` guard → every send paints two bubbles.
