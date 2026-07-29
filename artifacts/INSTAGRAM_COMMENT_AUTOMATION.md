# Instagram Comment Automation — Implementation Spec

> **Status: CODE SHIPPED — not yet switched on.** *(2026-07-29)*
>
> All the code in [§5](#5-the-code) is implemented and unit tested
> (`node netlify/functions/utils/meta-service.test.js`). It is **inert** until the Meta
> dashboard work in [§6](#6-meta-dashboard-setup) is done — `extractComments()` returns `[]`
> for every payload shape we currently receive, so nothing changes until `comments` and
> `messaging_postbacks` are subscribed.
>
> **What's left: [§12](#12-implementation-order--start-here) Phases 1, 4 and 6** — the Meta
> dashboard, the two live button checks, and the end-to-end smoke test. Everything offline
> is done.
>
> Companion to [PROJECT_DOCUMENTATION.md §15](PROJECT_DOCUMENTATION.md#instagram-comment-automation-comment--dm--branch-routing).
> Written: **2026-07-28** · Built against commit `0c6e45f`
>
> **Rev 2** — the DM asks a question instead of delivering the answer. That single change
> turns a one-shot broadcast into a real conversation *and* closes multi-branch routing.
> Rationale and verification: [§1](#1-the-ask), [§3.4](#34-what-happens-after--the-window-reopens).
>
> **Rev 3** — the question carries **three tappable branch buttons**. They must be
> `postback` buttons, not quick replies and not links, for reasons that are not obvious and
> that break the feature silently if got wrong:
> [§3.5](#35-the-three-tappable-options--use-buttons-not-quick-replies).

---

## Table of contents

1. [The ask](#1-the-ask)
2. [Build vs buy — the provider landscape](#2-build-vs-buy--the-provider-landscape)
3. [How Meta actually allows this](#3-how-meta-actually-allows-this)
4. [Design](#4-design)
5. [The code](#5-the-code)
6. [Meta dashboard setup](#6-meta-dashboard-setup)
7. [Test plan](#7-test-plan)
8. [Gotchas](#8-gotchas)
9. [Cost](#9-cost)
10. [Deliberately out of scope](#10-deliberately-out-of-scope)
11. [Open questions for the client](#11-open-questions-for-the-client)
12. [Implementation order — start here](#12-implementation-order--start-here)

---

## 1. The ask

Someone comments on a Clinix360 Instagram post ("what's the price of laser?"). We want:

1. A **public reply** posted under their comment — *"Check your DM 💬"*
2. A **DM** that answers their question briefly and then **asks one back** — *"which branch
   works for you?"* — with **three tappable branch buttons** under it
3. Their tap (or typed answer) **routes the lead to the right branch** and **opens the
   24-hour messaging window**, because the conversation is now customer-initiated
4. The thread lands in that branch's **Leads inbox** so staff take over with no send limits

This is the single most common Instagram growth mechanic — "comment PRICE and I'll DM you"
— and it is a **first-class, officially supported Meta feature**, not a scraping hack.

> **The question is the point, not a detail.** The obvious version of this feature — DM
> the answer and stop — spends our one and only private reply on a dead end: no branch, no
> messaging window, no way to follow up. Ending on a question converts a one-shot broadcast
> into a real conversation, and simultaneously solves
> [multi-branch routing](PROJECT_DOCUMENTATION.md#22-roadmap--open-items), which has been
> the open blocker on the whole messaging stack. Mechanics verified in [§3.4](#34-what-happens-after--the-window-reopens).

---

## 2. Build vs buy — the provider landscape

An entire SaaS category exists for exactly this. Every one of them is a wrapper around the
same two Meta API calls documented in [§3](#3-how-meta-actually-allows-this).

### The market

| Provider | Focus | Price (2026) | Notes |
|---|---|---|---|
| **ManyChat** | The category leader — IG + FB + WhatsApp + SMS | $14–$139/mo, **per contact** | March 2026 repricing gutted the free plan from 1,000 contacts to **25**. AI add-on is +$29/mo. |
| **Chatfuel** | IG + FB + WhatsApp | from ~$14.99/mo | ManyChat's oldest competitor |
| **Spur** | India-based, D2C-focused, IG + WhatsApp + FB + live chat | INR pricing | Closest to our market; WhatsApp-first like our stack |
| **Inro** | AI-led IG DM automation | from €12.99/mo | Feature-based pricing, not per-contact |
| **LinkDM** | IG-only, flat rate | $19/mo flat | Deliberately narrow |
| **InstantDM** | *Only* comment-to-DM | from $29/mo | Sells "spam-filter safety" as the differentiator |
| **CreatorFlow** | IG-only, flat rate | flat | Creator market |
| **ReplyKaro** | India, IG automation | ~$3/mo flat | Cheapest; free tier with no DM cap |
| **PostEngage.ai** | India-native, INR + GST invoicing | from ₹749/mo | Only one issuing proper Indian invoices |
| **Wati / Interakt / Zoko** | WhatsApp BSPs, popular with Indian SMBs | ₹2k–5k/mo | **Do NOT do Instagram comment automation** — WhatsApp only. Not relevant here. |

### Why we build it

The same reasoning that killed AiSensy for WhatsApp
([WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md)) applies here, and harder:

1. **One callback URL per product per app.** ManyChat/Spur/Inro must *own* the Instagram
   webhook subscription to function. Pointing IG at their servers **takes DMs away from
   `/webhook/meta`** — our Leads inbox goes dark. We would be trading a working inbox for
   a comment auto-reply. That alone is disqualifying.
2. **Data split.** Comment-originated leads would live in their dashboard, DM leads in
   ours. The whole point of Lead Hub is one inbox.
3. **Cost.** ₹0 vs ₹12k–₹1.2L/yr, for two HTTP calls we already have the token for.
4. **We already have 90% of it.** The webhook endpoint, the Supabase lead/message tables,
   the IG access token, the inbox UI, the settings-JSON pattern — all shipped and working.
   The delta is one payload extractor, a postback branch on the existing one, two `fetch`
   calls and a branch matcher.

**Verdict: build.** ~200 lines in `meta-service.js`, ~65 in `app.js`, one settings card,
no new table, no new dependency, no new Netlify function.

> The only scenario that flips this: if the client wants a visual flow-builder (branching
> quizzes, buttons, drip sequences, A/B tests) rather than keyword → reply. That is a
> product, not a feature, and buying **Spur** would be the right call — but only if we
> accept losing the unified inbox.

---

## 3. How Meta actually allows this

Verified against Meta's docs, July 2026. This is the **Instagram API with Instagram Login**
flavour (`graph.instagram.com`, our `META_ACCESS_TOKEN` / `IGAA…` token) — the same one
`sendInstagramMessage()` already uses. **Not** the Facebook-Login/Page-token flavour that
most blog posts show.

### 3.1 The webhook field: `comments`

Comments arrive on the **same** `/webhook/meta` callback as DMs, under `object:'instagram'`,
but in `entry[].changes[]` with `field: 'comments'` — a shape our `extractEvents()`
currently discards, because it only accepts `field === 'messages'`.

```jsonc
{
  "object": "instagram",
  "entry": [{
    "id": "17841400000000000",          // OUR ig account id
    "time": 1753660800,
    "changes": [{
      "field": "comments",
      "value": {
        "from":  { "id": "1000000000", "username": "priya.sharma" },
        "media": { "id": "179332585…", "media_product_type": "REELS" },
        "id":    "17900000000000000",   // ← the comment id, the thing we need
        "text":  "what is the price of laser?",
        "parent_id": "…"                // present ONLY if it's a reply in a thread
      }
    }]
  }]
}
```

Requirements: **Advanced Access** on the comments permission, and the Instagram
professional account must be **public** — Meta sends no comment notifications for private
accounts.

### 3.2 Public reply — post a comment under their comment

```http
POST https://graph.instagram.com/v21.0/{IG_COMMENT_ID}/replies
Authorization: Bearer {META_ACCESS_TOKEN}
Content-Type: application/json

{ "message": "Check your DM 💬" }
```

Permission: **`instagram_business_manage_comments`**.
Returns `{ "id": "<new comment id>" }`.

Same endpoint family also does hide/unhide (`POST /{comment-id}`) and delete
(`DELETE /{comment-id}`) — not needed here, but free if spam moderation ever comes up.

### 3.3 Private reply — DM the commenter

```http
POST https://graph.instagram.com/v21.0/{IG_ID|me}/messages
Authorization: Bearer {META_ACCESS_TOKEN}
Content-Type: application/json

{
  "recipient": { "comment_id": "17900000000000000" },
  "message":   { "text": "Hi! Our laser packages start at ₹…" }
}
```

Permission: **`instagram_business_manage_messages`**.
Returns `{ "recipient_id": "<IGSID>", "message_id": "…" }`.

**`recipient: { comment_id }` instead of `recipient: { id }` is the whole trick.** It is
what makes DMing a stranger legal, and it changes the rules in our favour:

| | Normal DM reply | Private reply to a comment |
|---|---|---|
| Window | **24 hours** from their last message | **7 days** from the comment |
| Needs prior contact? | Yes — they must DM first | **No** |
| How many | Unlimited within the window | **Exactly ONE per comment, ever** |

Instagram **Live** comments are the exception: the private reply must be sent *during* the
broadcast. (Live also gets a much higher rate limit — 100 calls/sec vs the normal 2/sec per
account.)

### 3.4 What happens after — the window reopens

The one-reply-per-comment limit sounds like a hard ceiling. It isn't:

> *"If the user replies to your private reply, that opens a normal conversation: their
> inbound message starts a fresh 24-hour messaging window, and you can continue free-form
> over the Direct Messages API — text, media, reactions."*

So the sequence is:

| Step | Who | State after |
|---|---|---|
| Comments on a post | Customer | We may send **1** private reply, within 7 days |
| Private reply (a **question**) | Us | Allowance spent. Nothing more can be sent. |
| **Answers the question** | Customer | **24h window open.** Unlimited free-form both ways. |
| Every staff reply from the inbox | Us | Window refreshes on each new customer message |

The customer's answer is doing two jobs at once: it tells us their branch, and it is the
customer-initiated message that lifts the send limit. This is why the private reply must
end in a question — a statement gives them nothing to reply to, and the conversation dies
with the allowance already spent.

### 3.5 The three tappable options — use BUTTONS, not quick replies

Instagram offers two kinds of tappable option, and for this specific message they are
**not** interchangeable.

| | Quick replies | Template buttons |
|---|---|---|
| Max | 13, titles truncated at 20 chars | **3 per element** |
| Combines with attachments | No | Yes |
| Types | text only | **`postback`** or **`web_url`** |
| **Visible in the message-requests folder** | ❌ **No** | ✅ **Yes** |
| Visible on instagram.com (desktop web) | ❌ No | ❌ No |

That fourth row decides it. Our private reply goes to someone who has **never messaged us**,
so it lands in their **message requests** folder — and ManyChat's own guidance, from running
this at scale, is explicit:

> *"Always use solid buttons in first message instead of quick replies, because sometimes
> these messages land in the request folder and these quick replies will not be visible to
> users until they accept the request."*

Quick replies in the first message would be invisible to exactly the audience this feature
exists for. **Use buttons.**

The same source also settles the open question from rev 2 — ManyChat attaches buttons to the
first private reply node in production, so **buttons on a `recipient: { comment_id }` send
do work**:

> *"The first private reply node can contain only a single content block (text or an image,
> with buttons or Quick Replies)."*

**Three branches, three buttons — exactly at Meta's limit.** A fourth branch breaks the
button layout and forces a fallback to typed answers. Worth knowing before Clinix360 opens
one.

#### `postback`, never `web_url`

This is the distinction the whole feature rests on:

- **`postback`** — the tap **sends us an event**. That is a customer-initiated interaction,
  so it opens the 24h window *and* hands us the branch id. ✅
- **`web_url`** — the tap **opens a link**. Nothing is sent to us. **No window, no routing,
  no lead.** ❌

A "clickable option that links to the branch" is intuitively the web_url one, and it is the
one that silently breaks everything. The buttons must be `postback`.

```jsonc
{
  "recipient": { "comment_id": "17900000000000000" },
  "message": {
    "attachment": {
      "type": "template",
      "payload": {
        "template_type": "button",
        "text": "Laser starts from ₹X and depends on the area treated. Which branch works for you — Janakpuri, Kirti Nagar or Dwarka?",
        "buttons": [
          { "type": "postback", "title": "Janakpuri",   "payload": "BRANCH:8db5a0fb-…" },
          { "type": "postback", "title": "Kirti Nagar", "payload": "BRANCH:e1d26aab-…" },
          { "type": "postback", "title": "Dwarka",      "payload": "BRANCH:9a3aff6c-…" }
        ]
      }
    }
  }
}
```

A tap arrives on the webhook as a **postback**, not a message — a shape
`extractEvents()` does not currently look at, and on a field that must be **separately
subscribed** (`messaging_postbacks`):

```jsonc
{ "entry": [{ "messaging": [{
  "sender": { "id": "<IGSID>" }, "recipient": { "id": "<IG_ID>" },
  "postback": { "mid": "…", "title": "Dwarka", "payload": "BRANCH:9a3aff6c-…" }
}] }] }
```

`payload` is an exact branch id: **zero parsing, zero ambiguity, one tap.**

> ⚠️ **Two things still to prove in [§7 step 0](#manual-smoke-test)**, because the whole
> design hangs off them and no documentation states either outright:
> 1. Meta accepts a **button template** on a `recipient: { comment_id }` send. (ManyChat
>    ships it, so this is very likely — but "a vendor does it" is not the same as reading
>    it in the docs.)
> 2. A **postback tap opens the 24h window**. Expected — it is a customer-initiated event,
>    the same logic that makes a typed reply work — but it is the single assumption that,
>    if wrong, costs the feature its whole point.
>
> **Neither is a blocker**, because of the fallback below.

#### The fallback is free

**Always spell the branch names in the message text, buttons or no buttons.** Then:

| Situation | What happens |
|---|---|
| Buttons render, they tap | `postback.payload` → exact branch id |
| Buttons unsupported, or they're on desktop web, or they'd rather type | They type "Dwarka" → the name matcher catches it |
| Buttons rejected by Meta entirely | Send plain text; nothing else changes |

The router accepts **postback payload, quick-reply payload, and free text** — all three
paths, one function, already in [§5.4](#54-meta-servicejs--branch-routing-from-the-reply).
So the button question changes the *quality* of the UX, never whether it works.

---

## 4. Design

### 4.1 Flow

Two halves. The first fires on the comment; the second fires on their answer and is what
makes the whole thing worth building.

```
── A. the comment ────────────────────────────────────────────────────────────
customer comments on a post
  → Meta → POST <site>/webhook/meta   (object='instagram', changes[].field='comments')
  → extractComments(payload)          — its own stream; never mixes with DM events
  → processComment(c)
      ├ skip: our own comment      (from.id === entry.id)   ← infinite-loop guard
      ├ skip: threaded reply       (value.parent_id present)
      ├ matchCommentRule(text, settings.comment_rules)  → no match? leave it alone
      ├ 1. PRIVATE REPLY  POST /{IG}/messages  { recipient:{comment_id}, message:{text} }
      │                   ← the ONE allowed message. Ends in the branch question.
      ├ 2. PUBLIC REPLY   POST /{comment_id}/replies  { message }
      └ 3. lead parked on META_BRANCH_ID + timeline:
            "[comment] <text>" incoming, the question outgoing

── B. their answer ───────────────────────────────────────────────────────────
customer taps [Dwarka]  (or just types "dwarka")
  → webhook entry[].messaging[] — .postback for a tap, .message for typed text
  → processIncomingMessage(...)  → lead + message stored, as always
  → routeLeadFromReply(lead, text, payload)
      ├ skip unless lead.branch_id is still the META_BRANCH_ID fallback
      ├ payload "BRANCH:<uuid>"?  → exact branch id, use it (tap or quick reply)
      ├ else match the text against active branch names (full name or first word)
      ├ 0 matches or 2+ matches → leave unrouted, staff assign in the inbox
      └ exactly 1 → UPDATE leads SET branch_id = <that branch>
  → thread now sits in the right branch's inbox, 24h window OPEN, no send limits
```

### 4.2 Decisions worth arguing about

**a) The private reply is sent FIRST — this is the dedupe.**
Meta permits exactly one private reply per comment, so a redelivered webhook *throws* on
the second attempt and we never double-post the public reply. Ordering replaces a
processed-comments table entirely. It also means we never publicly promise a DM that
failed to send (blocked DMs, >7 days, restricted account).

**b) `recipient_id` from the send response is the lead's `instagram_user_id` — never the
comment's `from.id`.**
The comment's `from.id` and the messaging IGSID are **different id spaces**. Using
`from.id` would fork one person into two leads and silently break DM dedupe forever. This
is the exact bug class `idColumnFor()` already exists to prevent
([meta-service.js:36](netlify/functions/utils/meta-service.js#L36)) — the private-reply
response hands us the correct IGSID for free, with no extra API call.

**c) Self-comment guard is mandatory.**
Our own public reply is itself a comment on our own media and can re-trigger the webhook.
Without `from.id === entry.id → skip`, the account replies to itself in a loop. `entry.id`
is used rather than `META_IG_ID` so the guard works even if that env var is unset.

**d) Rules live in `settings.comment_rules` (JSON), not a new table.**
`settings` is already the key/value store for `payment_modes` and `integrations`, and the
admin UI already has the exact list-editor pattern to copy (`renderPaymentModesList` /
`addPaymentMode` / `removePaymentMode`). A new table means a hand-run migration in the
Supabase SQL editor for a list that will hold maybe five rows. Not worth it — revisit only
if rules need per-post or per-branch scoping.

**e) No new Netlify function.**
Comments arrive on the callback we already own. `handleWebhook()` gains a second loop.

**f) Routing keys off "still on the fallback branch", not a conversation state machine.**
The naive design flags a lead as `awaiting_branch` after the question is sent and clears it
on reply — a new column, a new state, and a lead permanently stuck if the customer answers
in their third message instead of their first. Instead: **if a lead is still parked on
`META_BRANCH_ID` and their message names exactly one branch, move it.** No column, no
state, no expiry. It self-disables the moment the lead is assigned — by the customer, or
by staff — so it can never move a lead someone already placed.

**g) Routing applies to every platform, not just Instagram.**
It's the same `if` either way, and a WhatsApp customer who opens with "I want to visit
Dwarka" gets routed for free. "hi" matches nothing and is harmlessly ignored.

**h) Ambiguous or unrecognised answers are left alone, deliberately.**
Two branch names in one message ("Janakpuri or Dwarka?"), or none, → no move, logged, lead
stays in the fallback inbox for staff. A wrong auto-assignment is worse than none: it sends
the lead to a branch that never expected them and hides it from the one that did.

**i) The fallback `META_BRANCH_ID` should be a dedicated "Unassigned" branch.**
Today it points at a real branch. Every unrouted lead — from every platform — lands in that
branch's inbox as if it were theirs, and (with routing on) a passing mention of another
branch can move it out. Pointing `META_BRANCH_ID` at an inactive `Unassigned` branch row
makes "not yet routed" an explicit state instead of a lie. One row, one env var change,
no code. **Recommended, not required** — flagged in [§11](#11-open-questions-for-the-client).

### 4.3 Rule format

The `dm` field is the **single message we are allowed to send**. It should answer enough to
be useful and end on the branch question, so the customer has something to reply to:

```json
[
  {
    "keyword": "price",
    "public":  "Check your DM 💬",
    "dm":      "Hi! Laser packages start from ₹X per session and depend on the area treated. Which branch works for you — Janakpuri, Kirti Nagar or Dwarka? I'll send the full price list and open slots."
  },
  {
    "keyword": "book",
    "public":  "Sent you a DM ✨",
    "dm":      "Happy to get you booked in! Which branch is easiest for you — Janakpuri, Kirti Nagar or Dwarka?"
  },
  {
    "keyword": "*",
    "public":  "Check your DM",
    "dm":      "Thanks for reaching out! Which branch are you closest to — Janakpuri, Kirti Nagar or Dwarka? I'll connect you with that team."
  }
]
```

Case-insensitive substring, **first hit wins**, `*` is the catch-all and is tried only
after every keyword rule misses. No rules configured (or no match and no `*`) → the comment
is left completely alone. Either field may be blank: `public` only = public reply, no DM;
`dm` only = silent DM with no public reply.

The **three branch buttons are appended automatically** from the active `branches` rows —
they are not part of the rule and the admin never types them
([§5.3](#53-meta-servicejs--the-automation)). The `dm` text is what sits above them.

**Copy rules that come straight out of the mechanics:**

- **Always end on a question.** A statement ends the conversation with the allowance spent.
- **Name the branches in the text too, even though the buttons exist.** Buttons don't
  render on instagram.com in a browser, and typed answers are matched against those exact
  strings. The buttons are the fast path, the text is the one that always works.
- **Spell them as they are in the `branches` table** — that string is what the router
  matches. "Which branch?" alone gets "the nearest one", which routes nowhere.
- **Answer something.** Pure deflection ("DM us your branch!") reads as evasive and, if
  they don't reply, delivers nothing for our one allowed message. Give a real partial
  answer, then ask.
- **No prices or medical claims in the `public` field** — that's what the DM is for.

### 4.4 Files touched

| File | Change |
|---|---|
| [netlify/functions/utils/meta-service.js](netlify/functions/utils/meta-service.js) | `extractComments`, `getSettingJson`, `matchCommentRule`, `sendCommentPrivateReply` (button template), `replyToComment`, `processComment`, `matchBranch`, `routeLeadFromReply`, `listBranches` on the Supabase client; **`extractEvents` handles `messaging[].postback`** (button taps, currently dropped) and captures its payload; `findLeadByPlatformId` also selects `branch_id`; `processIncomingMessage` returns the lead; two lines added to `handleWebhook` |
| [netlify/functions/utils/meta-service.test.js](netlify/functions/utils/meta-service.test.js) | extraction, postback, rule-matching and branch-matching assertions |
| [app.js](app.js) | comment-rules CRUD section, `state.commentRules`, one line in `switchAdminTab`, one binding in `bindGlobalEvents` |
| [index.html](index.html) | "Comment Automation" settings card |
| [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) | §11 (5 cards), §15 (new subsection), §17 (`comment_rules` key), §21 change log, §22 (routing item 1 partly closed) |

**No** schema migration, **no** new env var, **no** new dependency, **no** new function.
(An `Unassigned` branch row — [decision (i)](#42-decisions-worth-arguing-about) — is
recommended but optional, and is data, not schema.)

Meta dashboard: two extra webhook field subscriptions (`comments`, `messaging_postbacks`)
and one extra permission — [§6](#6-meta-dashboard-setup).

---

## 5. The code

Written and syntax-checked against the real files; the pure parts (`extractComments`,
`matchCommentRule`, `matchBranch`) were run against the assertions in [§7](#7-test-plan) and
pass, including with the live branch names. Reverted from the working tree so this doc stays
the only artefact. The network paths — the two Graph calls — are unrun and are what the
manual smoke test exists to prove.

### 5.1 `meta-service.js` — payload extraction

Add after `extractEvents()`:

```js
// Instagram comment events — entry[].changes[].field='comments'. A comment is not
// a message, so it gets its own stream instead of being squeezed into extractEvents.
function extractComments(payload) {
  if (payload.object !== 'instagram') return [];

  const comments = [];
  for (const entry of (payload.entry || [])) {
    for (const change of (entry.changes || [])) {
      if (change.field !== 'comments') continue;
      const v = change.value || {};
      comments.push({
        commentId: v.id,
        text:      v.text,
        fromId:    v.from?.id,
        username:  v.from?.username,
        mediaId:   v.media?.id,
        parentId:  v.parent_id,                  // set = it's a reply in a thread
        accountId: v.recipient_id || entry.id,   // OUR ig account id
      });
    }
  }
  return comments;
}
```

### 5.2 `meta-service.js` — settings reader

`isPlatformEnabled()` already inlines a settings fetch. Extract it so the rules loader
reuses it — this is a net deletion:

```js
// Returns the parsed JSON value of one settings row, or null on any failure —
// each caller picks its own fallback.
async function getSettingJson(key) {
  const url  = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  try {
    const res = await fetch(
      `${url}/rest/v1/settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`,
      { headers: { apikey: anon, Authorization: `Bearer ${anon}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows.length) return null;
    return JSON.parse(rows[0].value || 'null');
  } catch (err) {
    console.warn(`[meta-service] settings.${key} read failed:`, err.message);
    return null;
  }
}

// FAIL-OPEN preserved: a missing key, unset DB creds, or any error → enabled.
async function isPlatformEnabled(platform) {
  const flags = await getSettingJson('integrations');
  return !flags || flags[platform] !== false;   // only an explicit false disables
}
```

### 5.3 `meta-service.js` — the automation

```js
// ── Instagram comment automation ──────────────────────────────
// Someone comments on a post → we reply publicly under the comment ("Check your
// DM") and send the real answer as a DM. Rules live in settings.comment_rules:
//   [{ keyword: 'price', public: 'Check your DM', dm: 'Hi! Our price list is…' }]
// First keyword hit wins; keyword '*' is the catch-all, tried only if nothing
// else matched. Matching is case-insensitive substring.

function matchCommentRule(text, rules) {
  const t = (text || '').toLowerCase();
  return rules.find(r => r?.keyword && r.keyword !== '*' && t.includes(r.keyword.toLowerCase()))
      || rules.find(r => r?.keyword === '*')
      || null;
}

// Private reply — DMs the commenter. Passing `comment_id` as the recipient is what
// makes it legal: it opens a 7-day window instead of the usual 24h one. Meta allows
// exactly ONE private reply per comment, ever — a second call errors.
//
// `branches` (optional) turns the message into a button template: one POSTBACK button
// per branch, max 3 (Meta's limit). Buttons — not quick replies — because this lands in
// the recipient's message-requests folder, where quick replies don't render. The branch
// names stay in the text regardless, so a typed answer still routes.
// Returns { recipient_id, message_id }; recipient_id is the commenter's IGSID.
async function sendCommentPrivateReply(commentId, text, branches = []) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('Missing META_ACCESS_TOKEN env var');

  const buttons = branches.slice(0, 3).map((b) => ({
    type:    'postback',                 // NOT web_url — a link sends us nothing
    title:   b.name.slice(0, 20),        // titles truncate past 20 chars
    payload: `BRANCH:${b.id}`,
  }));

  const message = buttons.length
    ? { attachment: { type: 'template', payload: { template_type: 'button', text, buttons } } }
    : { text };

  const igId = process.env.META_IG_ID || 'me';
  const res  = await fetch(`https://graph.instagram.com/v21.0/${igId}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ recipient: { comment_id: commentId }, message }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`IG private reply failed: ${res.status} ${data?.error?.message || JSON.stringify(data)}`);
  }
  console.log(`[meta-service] Private reply sent for comment ${commentId} → IGSID ${data.recipient_id}`);
  return data;
}

// Public reply posted underneath the comment. Needs instagram_business_manage_comments.
async function replyToComment(commentId, text) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('Missing META_ACCESS_TOKEN env var');

  const res = await fetch(
    `https://graph.instagram.com/v21.0/${encodeURIComponent(commentId)}/replies`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message: text }),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`IG comment reply failed: ${res.status} ${data?.error?.message || JSON.stringify(data)}`);
  }
  console.log(`[meta-service] Public reply posted under comment ${commentId} (id=${data.id || 'n/a'})`);
  return data;
}

async function processComment(c) {
  if (!c.commentId || !c.text || !c.fromId) {
    console.log('[meta-service] Skipping comment event — missing id, text or from.id');
    return;
  }
  // Our own comment — including the public reply we just posted. Without this
  // guard that reply re-triggers the webhook and the account answers itself forever.
  if (c.fromId === c.accountId) {
    console.log('[meta-service] Skipping our own comment');
    return;
  }
  // Only top-level comments. A reply inside a thread has a parent_id.
  if (c.parentId) {
    console.log('[meta-service] Skipping threaded reply (has parent_id)');
    return;
  }

  const rules = await getSettingJson('comment_rules');
  const rule  = matchCommentRule(c.text, Array.isArray(rules) ? rules : []);
  if (!rule) {
    console.log(`[meta-service] Comment ${c.commentId}: no rule matched "${c.text}"`);
    return;
  }

  // DM first, on purpose. Meta rejects a second private reply to the same comment,
  // so a redelivered webhook throws here and we never double-post the public reply.
  // It also means we never publicly promise a DM that failed to send.
  const db     = createSupabaseClient();
  const sent   = rule.dm
    ? await sendCommentPrivateReply(c.commentId, rule.dm, await db.listBranches())
    : null;
  if (rule.public) await replyToComment(c.commentId, rule.public);
  if (!sent) return;

  // recipient_id from the send is the authoritative IGSID. The comment's own
  // from.id is a different id space — using it here would break DM dedupe.
  const lead = await processIncomingMessage(
    sent.recipient_id,
    `[comment] ${c.text}`,
    'instagram',
    c.username ? `@${c.username}` : null
  );
  await db.insertMessage({
    lead_id:   lead.id,
    direction: 'outgoing',
    message:   rule.dm,
    is_seen:   true,
  });
}
```

One supporting change — `processIncomingMessage()` returns the lead so both
`processComment` and the router can use it:

```js
  console.log(`[meta-service] Message inserted for lead_id=${lead.id}`);
  return lead;                                    // ← added
}
```

### 5.4 `meta-service.js` — branch routing from the reply

This is the half that pays for the feature. Add `branch_id` to the lead select and a
`listBranches` method on the Supabase client:

```js
// createSupabaseClient() — findLeadByPlatformId now needs the branch to know if
// the lead is still unrouted.
`…&select=id,customer_name,branch_id&limit=1`     // ← branch_id added

async listBranches() {
  const res = await fetch(`${url}/rest/v1/branches?active=eq.true&select=id,name`, { headers });
  if (!res.ok) throw new Error(`branches fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
},
```

Then the matcher and the router:

```js
// ── Branch routing from the customer's reply ──────────────────
// The comment DM ends with "which branch?" — their answer both routes the lead
// AND opens the 24h window. Matching is pure; see meta-service.test.js.
//
// Matches the full branch name or its first word, so "Dwarka Sec 12" is found by
// someone who just types "dwarka". Returns the single match, or null when the
// answer is unrecognised OR names more than one branch — guessing wrong sends the
// lead to a branch that never expected them and hides it from the one that did.
function matchBranch(text, branches) {
  const t = (text || '').toLowerCase();
  if (!t) return null;
  const hits = branches.filter((b) => {
    const name = (b.name || '').toLowerCase();
    return name && (t.includes(name) || t.includes(name.split(' ')[0]));
  });
  return hits.length === 1 ? hits[0] : null;
}

// Only ever moves a lead that is still parked on the META_BRANCH_ID fallback, so
// it self-disables the moment anyone — customer or staff — assigns the lead.
// No conversation-state column, no expiry, and a late answer still works.
//
// `payload` is set when they TAPPED something (postback button, or a quick reply if
// we ever use one); `text` is what they typed. Both paths land here so the feature
// works identically whether or not buttons render on their device.
async function routeLeadFromReply(lead, text, payload) {
  const fallback = process.env.META_BRANCH_ID;
  if (!lead || !fallback || lead.branch_id !== fallback) return;

  const db = createSupabaseClient();

  // A button tap carries the branch id verbatim — no guessing needed.
  if (payload && payload.startsWith('BRANCH:')) {
    const branchId = payload.slice('BRANCH:'.length);
    await db.updateLead(lead.id, { branch_id: branchId });
    console.log(`[meta-service] Lead ${lead.id} routed to branch ${branchId} (button tap)`);
    return;
  }

  const branch = matchBranch(text, await db.listBranches());
  if (!branch) {
    console.log(`[meta-service] Lead ${lead.id}: no single branch match in "${text}" — left unrouted`);
    return;
  }
  await db.updateLead(lead.id, { branch_id: branch.id });
  console.log(`[meta-service] Lead ${lead.id} routed to ${branch.name}`);
}
```

Then teach `extractEvents()` about taps. A **postback is not a message** — it arrives as
`messaging[].postback`, so today's extractor produces `messageText === undefined` and
`handleWebhook` drops it before anything happens. Two lines in the `messaging[]` branch
cover both a tap and a typed reply:

```js
    for (const msg of (entry.messaging || [])) {
      events.push({
        senderId:    msg.sender?.id,
        // A button tap has no message.text — its label lives on the postback.
        messageText: msg.message?.text ?? msg.postback?.title,
        profileName: null,
        isEcho:      msg.message?.is_echo === true,
        // Set only when they TAPPED: postback button, or a quick reply.
        payload:     msg.postback?.payload ?? msg.message?.quick_reply?.payload,
        shape:       'messaging',
      });
    }
```

Using `postback.title` as the message text means the tap also shows up in the inbox
timeline as "Dwarka", exactly as if they had typed it — staff see a normal conversation,
not a blank turn.

> **This needs the `messaging_postbacks` webhook field subscribed** ([§6](#6-meta-dashboard-setup)).
> Without it Meta never sends the tap, the customer sees nothing happen, and — worse — no
> inbound event means **no 24h window**. Missing this checkbox breaks the feature silently.

### 5.5 `meta-service.js` — wiring both halves into `handleWebhook`

```js
// The skip guard must let a tap through. A postback carrying a payload is routable
// even if it somehow arrives with no title — the payload IS the answer.
    if (!ev.senderId || (!ev.messageText && !ev.payload)) {
      console.log(`[meta-service] Skipping ${platform}/${ev.shape} event — missing sender.id or content`);
      continue;
    }

// In the existing message loop — capture the lead, then try to route it.
    try {
      const lead = await processIncomingMessage(ev.senderId, ev.messageText, platform, ev.profileName);
      await routeLeadFromReply(lead, ev.messageText, ev.payload);
    } catch (err) {
      console.error(`[meta-service] Error processing ${platform} message from sender=${ev.senderId}:`, err.message);
    }

// After that loop, before `return { received: true }` —
  // Instagram post comments — a separate event stream from DMs.
  for (const c of extractComments(payload)) {
    try {
      await processComment(c);
    } catch (err) {
      console.error(`[meta-service] Comment ${c.commentId} automation failed:`, err.message);
    }
  }
```

…and add `extractComments, matchCommentRule, matchBranch` to `module.exports`.

The existing `isPlatformEnabled(platform)` check sits above both loops, so the admin
Connected Accounts toggle disables comment automation and routing too — for free.

### 5.6 `index.html` — settings card

Insert immediately before the `<!-- Payment Modes -->` card:

```html
<!-- Instagram Comment Automation -->
<div class="section-card settings-card collapsed">
  <div class="section-header settings-head">
    <span class="section-icon"><svg class="icon"><use href="#i-chat"/></svg></span>
    <span class="section-title">Comment Automation</span>
    <span class="settings-chevron">▾</span>
  </div>
  <div class="settings-body" style="padding:8px 18px 18px">
    <p style="font-size:13px;color:#6b7280;margin:0 0 12px">When someone comments on an Instagram post, reply publicly under their comment and send them one DM. <b>End the DM with the branch question</b> — a tappable button per branch is added automatically, and their answer routes the lead and lifts Instagram's send limit so staff can reply freely. Name the branches in the text too: buttons don't show on desktop. First matching keyword wins; use <b>*</b> to catch every comment.</p>
    <div id="comment-rules-list"></div>
    <div style="display:grid;gap:8px;margin-top:12px">
      <input type="text" id="new-rule-keyword" class="text-input" placeholder="Keyword in the comment (e.g. price) — or * for any" style="margin:0">
      <input type="text" id="new-rule-public" class="text-input" placeholder="Public reply under the comment (e.g. Check your DM)" style="margin:0">
      <textarea id="new-rule-dm" class="text-input" rows="3" placeholder="DM to send — answer briefly, then ask: which branch — Janakpuri, Kirti Nagar or Dwarka?" style="margin:0;resize:vertical"></textarea>
      <button class="primary-btn" id="btn-add-comment-rule" style="justify-self:start">+ Add rule</button>
    </div>
  </div>
</div>
```

### 5.7 `app.js` — rules CRUD

Add `commentRules: []` to `state`, then a new section after `removePaymentMode()`:

```js
// ============================================================
// INSTAGRAM COMMENT AUTOMATION (settings.comment_rules)
// Rules are edited here and matched server-side by meta-service.js when the
// `comments` webhook fires. This screen never talks to Meta.
// ============================================================
async function loadCommentRules() {
  try {
    const { data } = await db.from('settings').select('value').eq('key', 'comment_rules').single();
    const arr = data && data.value ? JSON.parse(data.value) : [];
    state.commentRules = Array.isArray(arr) ? arr : [];
  } catch (e) { state.commentRules = []; }
  renderCommentRules();
}

function renderCommentRules() {
  const el = document.getElementById('comment-rules-list');
  if (!el) return;
  const rules = state.commentRules || [];
  if (!rules.length) {
    el.innerHTML = '<p style="font-size:13px;color:#9ca3af;margin:0">No rules yet — comments are left alone.</p>';
    return;
  }
  el.innerHTML = rules.map((r, i) => `
    <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:6px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <span style="font-weight:600">${r.keyword === '*' ? 'Any comment' : esc(r.keyword)}</span>
        <button class="del-row-btn" onclick="removeCommentRule(${i})" title="Remove">×</button>
      </div>
      <div style="font-size:12px;color:#6b7280;margin-top:6px">Reply: ${esc(r.public || '—')}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:2px">DM: ${esc(r.dm || '—')}</div>
    </div>`).join('');
}

async function saveCommentRulesToDB() {
  await db.from('settings').upsert(
    { key: 'comment_rules', value: JSON.stringify(state.commentRules) },
    { onConflict: 'key' }
  );
}

async function addCommentRule() {
  const kw  = (document.getElementById('new-rule-keyword')?.value || '').trim();
  const pub = (document.getElementById('new-rule-public')?.value || '').trim();
  const dm  = (document.getElementById('new-rule-dm')?.value || '').trim();
  if (!kw)          { showToast('Enter a keyword, or * for any comment', 'error'); return; }
  if (!pub && !dm)  { showToast('Add a public reply or a DM', 'error'); return; }
  if ((state.commentRules || []).some(r => r.keyword.toLowerCase() === kw.toLowerCase())) {
    showToast('That keyword already has a rule', 'error'); return;
  }
  state.commentRules.push({ keyword: kw, public: pub, dm });
  await saveCommentRulesToDB();
  ['new-rule-keyword', 'new-rule-public', 'new-rule-dm']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  renderCommentRules();
  showToast('Rule added ✓', 'success');
}

async function removeCommentRule(i) {
  state.commentRules.splice(i, 1);
  await saveCommentRulesToDB();
  renderCommentRules();
  showToast('Rule removed ✓', 'success');
}
```

Wire it up — two one-line edits:

```js
// switchAdminTab()
if (tab === 'settings') { loadAutomations(); renderPaymentModesList(); loadIntegrations(); loadCommentRules(); }

// bindGlobalEvents()
document.getElementById('btn-add-comment-rule')?.addEventListener('click', addCommentRule);
```

Rule text is rendered through the existing `esc()` helper — XSS-safe, same as the inbox.

---

## 6. Meta dashboard setup

No new env vars. Three things to change in the Meta App Dashboard, all easy to miss and all
failing **silently**:

1. **Subscribe the `comments` webhook field.** Same callback URL (`/webhook/meta`), same
   verify token — just tick one more box next to `messages`. **Verifying the callback URL
   is not the same as subscribing the field**; this is the exact trap that cost a full
   session during IG go-live
   ([PROJECT_DOCUMENTATION.md §15](PROJECT_DOCUMENTATION.md#meta-app-requirements-learned-the-hard-way)).
   Without it: no comment ever reaches us.
2. **Subscribe the `messaging_postbacks` webhook field.** This is what delivers a button
   tap. Without it the customer taps a branch, we hear nothing, they get no reply — and no
   inbound event means **the 24h window never opens**. The one checkbox that turns the
   feature into a dead end.
3. **Add the `instagram_business_manage_comments` permission** to the app and re-authorise
   so the token carries the new scope. `instagram_business_manage_messages` we already have.

Also confirm:

- The app is **Live**, not in Development — otherwise Meta sends zero real notifications.
- The Instagram professional account is **public** — no comment webhooks for private accounts.
- **Advanced Access** for comments from the general public (App Review). Standard Access
  covers app roles/testers only — same gate as DMs, [roadmap item 3](PROJECT_DOCUMENTATION.md#22-roadmap--open-items).

**Rollback:** untick the `comments` field. `extractComments()` returns `[]` for every other
payload shape, so the code goes inert with no deploy.

---

## 7. Test plan

Extend the existing framework-free test
([meta-service.test.js](netlify/functions/utils/meta-service.test.js), run with
`node netlify/functions/utils/meta-service.test.js`) — the extractor and the matcher are
pure, so they test without env vars or network:

```js
// ── Instagram comments: the comment-to-DM automation stream ──
{
  const payload = {
    object: 'instagram',
    entry: [{
      id: 'IG_ACCOUNT_ID',
      time: 1753660800,
      changes: [{
        field: 'comments',
        value: {
          from:  { id: 'COMMENTER_ID', username: 'priya.sharma' },
          media: { id: 'MEDIA_1', media_product_type: 'REELS' },
          id:    'COMMENT_1',
          text:  'what is the PRICE of laser?',
        },
      }],
    }],
  };

  const [c] = extractComments(payload);
  assert.equal(c.commentId, 'COMMENT_1');
  assert.equal(c.text, 'what is the PRICE of laser?');
  assert.equal(c.fromId, 'COMMENTER_ID');
  assert.equal(c.username, 'priya.sharma');
  assert.equal(c.accountId, 'IG_ACCOUNT_ID');   // entry.id = our account, for the self-guard

  // A comments payload must not leak into the DM stream (and vice versa).
  assert.equal(extractEvents(payload).events.length, 0, 'comments must not become message events');
  assert.equal(extractComments({
    object: 'instagram',
    entry: [{ messaging: [{ sender: { id: 'IGSID_1' }, message: { text: 'hi' } }] }],
  }).length, 0, 'DMs must not become comment events');
}

// Only Instagram has comment automation
assert.equal(extractComments({ object: 'page', entry: [{ changes: [{ field: 'comments', value: {} }] }] }).length, 0);
assert.equal(extractComments({}).length, 0);

// Self-comment + threaded-reply markers survive extraction so processComment can skip them
{
  const [c] = extractComments({
    object: 'instagram',
    entry: [{ id: 'IG_ACCOUNT_ID', changes: [{ field: 'comments', value: {
      from: { id: 'IG_ACCOUNT_ID' }, id: 'COMMENT_2', text: 'Check your DM', parent_id: 'COMMENT_1',
    } }] }],
  });
  assert.equal(c.fromId, c.accountId, 'our own reply must be detectable → no infinite loop');
  assert.equal(c.parentId, 'COMMENT_1');
}

// A postback (button tap) must survive extraction — today it is dropped entirely
{
  const { events } = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{
      sender:   { id: 'IGSID_1' },
      postback: { mid: 'm1', title: 'Dwarka', payload: 'BRANCH:9a3aff6c-…' },
    }] }],
  });
  assert.equal(events.length, 1, 'a button tap must not be dropped');
  assert.equal(events[0].payload, 'BRANCH:9a3aff6c-…');
  // The title becomes the message text so the tap reads as "Dwarka" in the inbox.
  assert.equal(events[0].messageText, 'Dwarka');
}
// A quick-reply tap lands on the same field
{
  const { events } = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{
      sender:  { id: 'IGSID_1' },
      message: { mid: 'm1', text: 'Dwarka', quick_reply: { payload: 'BRANCH:9a3aff6c-…' } },
    }] }],
  });
  assert.equal(events[0].payload, 'BRANCH:9a3aff6c-…');
  assert.equal(events[0].messageText, 'Dwarka');
}
// A typed reply has no payload — the router falls back to name matching
{
  const { events } = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{ sender: { id: 'IGSID_1' }, message: { text: 'dwarka' } }] }],
  });
  assert.equal(events[0].payload, undefined);
  assert.equal(events[0].messageText, 'dwarka');
}
// Regression: adding postback handling must not resurrect echoes or break plain DMs
{
  const { events } = extractEvents({
    object: 'page',
    entry: [{ messaging: [{ sender: { id: 'PAGE_ID' }, message: { text: 'our reply', is_echo: true } }] }],
  });
  assert.equal(events[0].isEcho, true);
  assert.equal(events[0].payload, undefined);
}

// ── Rule matching ────────────────────────────────────────────
{
  const rules = [
    { keyword: '*',      public: 'Thanks!',      dm: 'Hi there!' },
    { keyword: 'price',  public: 'Check your DM', dm: 'Our price list…' },
    { keyword: 'timing', public: 'Sent!',        dm: '10am–8pm' },
  ];

  // Keyword beats the catch-all even when '*' is listed first, and is case-insensitive.
  assert.equal(matchCommentRule('What is the PRICE?', rules).keyword, 'price');
  assert.equal(matchCommentRule('timing please', rules).keyword, 'timing');
  // Nothing specific matched → catch-all.
  assert.equal(matchCommentRule('nice post 😍', rules).keyword, '*');
  // No catch-all configured → no reply at all.
  assert.equal(matchCommentRule('nice post', [{ keyword: 'price', dm: 'x' }]), null);
  assert.equal(matchCommentRule('anything', []), null);
  assert.equal(matchCommentRule(undefined, rules).keyword, '*');
}

// ── Branch routing from the reply (real branch names) ────────
{
  const BRANCHES = [
    { id: '8db5a0fb-a7d4-435b-951e-6f1cb5d85fc9', name: 'Janakpuri' },
    { id: 'e1d26aab-025d-4136-8a91-867a16c5a9ef', name: 'Kirti Nagar' },
    { id: '9a3aff6c-84b5-4c7f-95e8-6af3c9ec0556', name: 'Dwarka Sec 12' },
  ];

  assert.equal(matchBranch('Janakpuri', BRANCHES).name, 'Janakpuri');
  assert.equal(matchBranch('janakpuri', BRANCHES).name, 'Janakpuri');
  // First-word match — nobody types "Dwarka Sec 12"
  assert.equal(matchBranch('dwarka', BRANCHES).name, 'Dwarka Sec 12');
  assert.equal(matchBranch('kirti', BRANCHES).name, 'Kirti Nagar');
  // Inside a sentence
  assert.equal(matchBranch("i'm closest to Dwarka sec 12 branch", BRANCHES).name, 'Dwarka Sec 12');
  assert.equal(matchBranch('Janakpuri please', BRANCHES).name, 'Janakpuri');
  // Ambiguous → null, never a guess
  assert.equal(matchBranch('janakpuri or dwarka?', BRANCHES), null);
  // Unrecognised → null, lead stays for staff
  assert.equal(matchBranch('the nearest one', BRANCHES), null);
  assert.equal(matchBranch('hi', BRANCHES), null);
  assert.equal(matchBranch('', BRANCHES), null);
  assert.equal(matchBranch(undefined, BRANCHES), null);
  assert.equal(matchBranch('janakpuri', []), null);
  // A blank/missing branch name must not match everything
  assert.equal(matchBranch('janakpuri', [{ id: 'x', name: '' }, { id: 'y' }]), null);
}
```

All of the above have been **run and pass** (`node netlify/functions/utils/meta-service.test.js`).

### Manual smoke test

Needs a **second** Instagram account with a tester role on the app.

**Step 0 — settle the two button assumptions before writing anything**
([§3.5](#35-the-three-tappable-options--use-buttons-not-quick-replies)). By hand, with curl:

- **0a.** Comment on a post from the tester account, grab the comment id from the webhook
  log, and send **one** private reply with the `button` template and three `postback`
  buttons. Does Meta accept it (`200` + `recipient_id`)? Do the buttons **render**, and do
  they render while the DM is still sitting in **Requests** (i.e. before the tester taps
  Accept)? That last part is the whole reason for choosing buttons over quick replies.
- **0b.** Tap a button. Does a `postback` arrive on `/webhook/meta`? Then — the assumption
  everything hangs on — **does a staff reply now send successfully**, proving the tap
  opened the 24h window?

If 0a fails → plain text, branch names typed. If 0b fails → the customer must type rather
than tap, so drop the buttons and keep the text question. Either way the rest of the build
is unchanged; this just tells us which UX we're shipping.

Then, with the feature built:

1. Add a rule: keyword `price`, public `Check your DM`, DM
   `Laser starts from ₹X. Which branch works for you — Janakpuri, Kirti Nagar or Dwarka?`
2. Comment "what's the price?" on a post from the tester account.
3. Expect within seconds: a public reply under the comment, the DM (with three buttons) in
   that account's requests folder, a new lead in **Leads** on the fallback branch, timeline
   = `[comment] what's the price?` then the question.
4. **Tap `Dwarka`.** Expect: the lead moves to **Dwarka Sec 12** (log:
   `routed to branch 9a3aff6c-… (button tap)`) and "Dwarka" appears in the thread as an
   incoming message.
5. **Reply from staff, in the dashboard.** This is the one that proves the whole premise —
   before step 4 it would have failed with `502 / Failed — not sent`; now it sends, because
   their tap opened the 24h window.
6. Repeat 2–3 with a new comment, then **type** `dwarka` instead of tapping. Same result via
   the name matcher (log: `routed to Dwarka Sec 12`) — this is the fallback path, and it
   must work independently of buttons.
7. Repeat with `the nearest one`. Expect: **no** move, log
   `no single branch match … left unrouted`, lead sits in the fallback inbox.
8. Comment again on the *same* post with a *new* comment → fires again (new comment id).
9. Reply inside the existing comment thread → **nothing** (has `parent_id`). Log:
   `Skipping threaded reply`.
10. Comment "nice photo" with no `*` rule configured → **nothing**. Log: `no rule matched`.
11. Confirm `Skipping our own comment` appears after our public reply lands — that line is
    the infinite-loop guard doing its job.
12. Manually reassign a lead in the dashboard, then have that account send another message
    naming a different branch → it must **not** move. Routing only ever touches leads still
    on the fallback branch.
13. Open the same thread on **instagram.com in a browser**: buttons will not render. Confirm
    the branch names are still readable in the message text — that is the desktop fallback.

---

## 8. Gotchas

| # | Thing |
|---|---|
| 1 | **One private reply per comment, ever.** Meta enforces it. Testing repeatedly on the same comment will fail on the second run — post a *new* comment each time. |
| 2 | **Subscribing `messages` does not deliver `comments`.** Separate checkbox. Silent failure if missed. |
| 3 | **Private IG account → zero comment webhooks.** Meta does not send them at all. |
| 4 | **The public reply can re-trigger the webhook** → infinite loop without the `from.id === entry.id` guard. |
| 5 | **`from.id` ≠ IGSID.** Always take `recipient_id` from the private-reply response for the lead. |
| 6 | **7-day window on the private reply, then back to 24h.** Follow-ups need the customer to reply first — the inbox already surfaces this as "Failed — not sent". |
| 7 | **Rate limit 2 calls/sec per IG account** on messaging. A viral post firing hundreds of comments will throttle; failures are logged per comment and the rest continue. |
| 8 | **Rules are global** — not per-post, not per-branch. Every lead starts on `META_BRANCH_ID` and only moves once the customer names a branch. |
| 9 | **Emoji-only / non-text comments** carry no `text` and are skipped, same as non-text DMs. |
| 10 | Keep the public reply generic. Never put prices or medical claims in the *public* comment — that is what the DM is for. |
| 11 | **If the customer never replies, we got nothing** — no branch, no window, and the one private reply is spent. This is why the DM must answer *something* real, not just ask. Watch the reply rate; a low one means the copy is asking too much. |
| 12 | **A DM sent before their reply will fail** with `502 / Failed — not sent`. That is correct behaviour, not a bug: the private reply is the only pre-window message allowed. Staff seeing this in the inbox are seeing the limit, not an outage. |
| 13 | **Branch names in the rule copy must match the `branches` table.** The router matches the customer's answer against those exact strings. Rename a branch and the old wording in the DM stops routing — silently. |
| 14 | **`META_BRANCH_ID` currently points at a real branch**, so unrouted leads look like that branch's own leads, and a passing mention of another branch can move them out. Point it at an inactive `Unassigned` branch — [decision (i)](#42-decisions-worth-arguing-about). |
| 15 | **Buttons and quick replies are invisible on instagram.com in a browser** — desktop users see only the message text. Keep the branch names in the text always. |
| 16 | **`web_url` buttons would silently kill the feature.** A link tap sends us nothing: no window, no routing, no lead. Buttons must be `postback`. |
| 17 | **Quick replies don't render in the message-requests folder** — which is exactly where a private reply to a stranger lands. This is why the first message uses buttons, not quick replies. |
| 18 | **`messaging_postbacks` is a separate webhook subscription.** Miss it and taps vanish: the customer sees nothing happen and the 24h window never opens. |
| 19 | **A postback is not a message.** `messaging[].postback` has no `message.text`, so the current extractor drops it before any handler runs. |
| 20 | **Max 3 template buttons.** Clinix360 has exactly 3 branches — a 4th breaks the button layout and forces typed answers only. |
| 21 | Button titles **truncate at 20 characters**. "Dwarka Sec 12" is fine; longer branch names will need short labels. |

---

## 9. Cost

**₹0.** Instagram messaging and comment endpoints are free; the only spend would be a
provider subscription we are not buying. Netlify function invocations are inside the free
tier at this volume. Compare: ManyChat ~₹15k–₹1.2L/yr, Spur/PostEngage ₹9k–₹30k/yr.

---

## 10. Deliberately out of scope

Each of these is a real feature, none is needed for the ask. Listed so nobody has to
re-derive why they're missing:

| Skipped | Add when |
|---|---|
| **An auto-reply to their branch answer** ("Thanks, the Dwarka team will message you shortly") | Staff response time is slow enough that the silence hurts. One extra send, trivial to add — but once the window is open a human should take it, and a bot answering a bot's question is the point where this stops feeling like a clinic. |
| Per-post / per-media rules (`mediaId` is already extracted, just unused) | Different campaigns need different answers on different posts |
| Regex or multi-keyword matching | Substring matching visibly misfires |
| Fuzzy / typo-tolerant branch matching ("janakpurii") | The logs show real answers being missed. Unmatched leads are visible in the fallback inbox, so this fails safe. |
| Story-reply and `mentions` automation | Client asks for it — different webhook fields, same pattern |
| Delay before replying ("look human") | Instagram flags the account as spammy |
| Per-user rate limiting / repeat-commenter suppression | Someone abuses it; Meta's one-reply-per-comment already covers the common case |
| Admin-editable button labels (they're generated from `branches.name`) | Branch names get too long for the 20-char limit, or need friendlier labels |
| Analytics on comment→DM conversion, and on **reply rate** | The Leads KPIs stop being enough. Reply rate is the number that says whether the question-first copy is working. |
| An `is_active` toggle per rule | There isn't one — delete the rule instead |

---

## 11. Open questions for the client

1. **Which keywords, and the exact DM copy for each?** This is the only real blocker.
   Suggested starting set: `price` / `cost`, `timing` / `open`, `book` / `appointment`,
   `address` / `location`, plus a `*` catch-all. Each `dm` must answer something real and
   end on the branch question — see the copy rules in [§4.3](#43-rule-format).
2. **Catch-all or not?** Replying to *every* comment (including "😍") is higher reach but
   reads as botty and burns the one-private-reply-per-comment allowance on people who
   weren't asking anything.
3. **Create an `Unassigned` branch and point `META_BRANCH_ID` at it?** Recommended —
   [decision (i)](#42-decisions-worth-arguing-about). One inactive row makes "not yet
   routed" an honest state instead of silently dumping every unrouted lead, on every
   platform, into a real branch's inbox. Needs the client's OK because it changes what that
   branch's staff see.
4. **Medical-claim review.** Auto-sent DMs about skin treatments should be signed off by
   the clinic before going live.

### What this closes

[Roadmap item 1 — multi-branch routing](PROJECT_DOCUMENTATION.md#22-roadmap--open-items) has
been the open blocker on the whole messaging stack, and it is **option C** from
[WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md) ("an interactive branch-picker
auto-reply"), now with a concrete reason to exist rather than being an extra step bolted on
for its own sake: the customer has to reply *anyway* to lift the send limit, so asking the
routing question costs nothing.

It closes routing for **Instagram comments** outright. `routeLeadFromReply` is
platform-agnostic, so a WhatsApp or Messenger customer who names a branch in an early
message is routed for free — but neither channel gets *asked*, so their unrouted leads
still need manual assignment. Deciding how WhatsApp customers first make contact (per-branch
`wa.me` links vs one number) remains open and unchanged.

---

## 12. Implementation order — start here

Everything above is reference. This is the build order. Each step is independently
verifiable, and the pure-logic steps (2, 3) need no Meta credentials at all — done first so
a failing curl in step 6 can't be confused with a bug in our code.

> **Steps 2–5 and 7–8 are DONE** (2026-07-29). What remains needs the Meta dashboard and a
> live tester account: **step 1**, **step 6**, **step 9**. Step 10's doc updates are done.

### Phase 1 — Meta dashboard (do first; it has a lead time)

- [ ] **1.** Subscribe the **`comments`** and **`messaging_postbacks`** webhook fields on
      the existing `/webhook/meta` callback. Add the
      **`instagram_business_manage_comments`** permission and re-authorise so the token
      carries the new scope. Full detail + the silent-failure modes: [§6](#6-meta-dashboard-setup).
      *Verify:* comment on a post from the tester account and watch the Netlify function log
      for a `field: 'comments'` payload. **No payload = stop here**, nothing downstream can
      work.

### Phase 2 — pure logic, no network (fully testable offline)

- [x] **2.** `meta-service.js`: add `extractComments()` ([§5.1](#51-meta-servicejs--payload-extraction)),
      `matchCommentRule()` and `matchBranch()` ([§5.3](#53-meta-servicejs--the-automation),
      [§5.4](#54-meta-servicejs--branch-routing-from-the-reply)), and teach `extractEvents()`
      about `messaging[].postback` ([§5.4](#54-meta-servicejs--branch-routing-from-the-reply)).
      Export all three new functions.
- [x] **3.** Paste the assertions from [§7](#7-test-plan) into `meta-service.test.js`.
      *Verify:* `node netlify/functions/utils/meta-service.test.js` prints
      `meta-service: all checks passed`. These assertions have already been run and pass —
      a failure here is a typo in the port, not a design problem.

### Phase 3 — plumbing

- [x] **4.** `meta-service.js`: `getSettingJson()` + rewrite `isPlatformEnabled()` on top of
      it ([§5.2](#52-meta-servicejs--settings-reader)) — net deletion, keep the FAIL-OPEN
      behaviour. Add `listBranches()` to the Supabase client and `branch_id` to
      `findLeadByPlatformId`'s select ([§5.4](#54-meta-servicejs--branch-routing-from-the-reply)).
      Make `processIncomingMessage()` return the lead ([§5.3](#53-meta-servicejs--the-automation)).
      *Verify:* re-run the test file — existing DM behaviour must not regress.
- [x] **5.** `meta-service.js`: `sendCommentPrivateReply()`, `replyToComment()`,
      `processComment()`, `routeLeadFromReply()`, and both `handleWebhook` hooks including
      the widened skip guard ([§5.5](#55-meta-servicejs--wiring-both-halves-into-handlewebhook)).

### Phase 4 — prove the two assumptions before trusting the UX

- [ ] **6.** Run **step 0a / 0b** from the [manual smoke test](#manual-smoke-test) by hand
      with curl: does Meta accept a **button template** on a `recipient: { comment_id }`
      send, do the buttons render **while the DM is still in the Requests folder**, and does
      a tap open the 24h window?
      *If 0a fails* → pass `[]` as `branches` to `sendCommentPrivateReply` and ship plain
      text. *If 0b fails* → same. **Neither blocks the build** — the typed-answer path is
      the fallback and is already covered by step 3's assertions.

### Phase 5 — admin UI

- [x] **7.** `index.html`: the Comment Automation settings card, immediately before
      `<!-- Payment Modes -->` ([§5.6](#56-indexhtml--settings-card)).
- [x] **8.** `app.js`: `commentRules: []` in `state`, the CRUD section after
      `removePaymentMode()`, `loadCommentRules()` in `switchAdminTab`'s settings branch, and
      the `btn-add-comment-rule` binding in `bindGlobalEvents`
      ([§5.7](#57-appjs--rules-crud)).
      *Verify:* `node --check app.js`, then add and delete a rule in Admin → Settings and
      confirm it round-trips through `settings.comment_rules`.

### Phase 6 — end to end

- [ ] **9.** Work through steps 1–13 of the [manual smoke test](#manual-smoke-test).
      Step 5 is the one that matters: a staff reply that would have failed before the
      customer's tap now sends.
- [x] **10.** Update [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) **in the same
      commit** — §11 (five settings cards), §15 (replace the "comments are NOT ingested"
      note with the real subsection), §17 (`comment_rules` settings key), §20 (drop quirk 13,
      it's fixed), §21 (change log), §22 (roadmap item 4 → done, item 1 → closed for IG).
      Flip this file's status header to BUILT. That is the repo's maintenance rule, not
      optional.

### Decisions still owed by the client

Not blockers for the code — the feature can be built and tested with placeholder copy — but
it cannot go **live** without them: the keyword list and DM copy, the catch-all question,
and the `Unassigned` branch call. See [§11](#11-open-questions-for-the-client).

### Things not to rediscover the hard way

The four that break silently, in the order they'll bite:

1. `messaging_postbacks` unsubscribed → taps vanish, window never opens.
2. `web_url` instead of `postback` → the tap sends us nothing at all.
3. No self-comment guard → our own public reply re-triggers the webhook, forever.
4. Using the comment's `from.id` as `instagram_user_id` instead of the send response's
   `recipient_id` → one person becomes two leads, permanently.
