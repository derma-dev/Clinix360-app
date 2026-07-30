# Facebook Comment Automation — Implementation Spec

> **Status: PLANNED — not started, and deliberately gated.** *(2026-07-30)*
>
> This is a **plan only**. No code is written. It must **not** be built until the
> Instagram comment automation it mirrors is **live and its two open assumptions are
> settled** — see [§12 Phase 0](#phase-0--prerequisite-instagram-must-be-live-first).
> Facebook inherits Instagram's answers for free; building it first would just re-run
> the same unknowns against a second App Review track.
>
> Companion to [INSTAGRAM_COMMENT_AUTOMATION.md](INSTAGRAM_COMMENT_AUTOMATION.md)
> and [PROJECT_DOCUMENTATION.md §15](PROJECT_DOCUMENTATION.md#15-messaging-integrations-instagram--facebook--whatsapp).
> Written: **2026-07-30** · Planned against current `main` (HEAD `6286d71`).
>
> **One-line summary:** the Instagram comment→DM→branch-routing feature, extended to
> Facebook Page comments. The shared plumbing (`matchCommentRule`, `matchBranch`,
> `routeLeadFromReply`, `processIncomingMessage`, the inbox) is already built and
> platform-agnostic — only the **comment extractor** and the **two Graph senders**
> are Instagram-specific, and this spec replaces those with Facebook equivalents.
> Because the client chose **shared rules**, the admin UI change is essentially a
> label edit.

---

## Table of contents

1. [The ask](#1-the-ask)
2. [Build vs buy](#2-build-vs-buy)
3. [How Meta actually allows this (Facebook specifics)](#3-how-meta-actually-allows-this-facebook-specifics)
4. [Design](#4-design)
5. [The code (planned)](#5-the-code-planned)
6. [Meta dashboard setup](#6-meta-dashboard-setup)
7. [Test plan](#7-test-plan)
8. [Gotchas](#8-gotchas)
9. [Cost](#9-cost)
10. [Deliberately out of scope](#10-deliberately-out-of-scope)
11. [Open questions for the client](#11-open-questions-for-the-client)
12. [Implementation order — gated, start at Phase 0](#12-implementation-order--gated-start-at-phase-0)

---

## 1. The ask

Identical in shape to the Instagram feature
([IG §1](INSTAGRAM_COMMENT_AUTOMATION.md#1-the-ask)), on the clinic's **Facebook Page**:

1. Someone comments on a Clinix360 Facebook post ("what's the price of laser?").
2. We post a **public reply** under their comment — *"Check your DM 💬"*.
3. We send **one DM** (Messenger) that answers briefly and ends in the **branch
   question**, with a tappable button per branch.
4. Their tap (or typed answer) **routes the lead to the right branch** and **opens the
   24-hour messaging window** (the conversation is now customer-initiated).
5. The thread lands in that branch's **Leads inbox**, and staff reply with no send limits.

> **Decision (client, 2026-07-30): shared rules.** Facebook uses the **same**
> `comment_rules` set as Instagram — one rule list in `settings`, one admin card. The
> copy is generic ("Which branch works for you…") and applies to comments on either
> platform. There is **no** `fb_comment_rules` and **no** second settings card. This is
> what makes the UI layer of this feature nearly a no-op
> ([§4.4](#44-files-touched), [§5.6](#56-indexhtml--appjs--label-only)).

---

## 2. Build vs buy

The **same verdict as Instagram — build** — for the same four reasons, harder not softer
here: one callback URL per app, data split across dashboards, ₹0 vs ₹12k–₹1.2L/yr, and we
already have 90% of the code. The full provider table and reasoning live in
[IG §2](INSTAGRAM_COMMENT_AUTOMATION.md#2-build-vs-buy--the-provider-landscape) and are
not repeated. The delta for Facebook is even smaller than for Instagram, because the
Facebook Messenger send path (`sendFacebookMessage`, `META_PAGE_ACCESS_TOKEN`,
`facebook_user_id`) is already shipped for DMs.

---

## 3. How Meta actually allows this (Facebook specifics)

The Instagram spec is the deep dive on the comment-to-DM mechanic
([IG §3](INSTAGRAM_COMMENT_AUTOMATION.md#3-how-meta-actually-allows-this)). This section
covers only **what is different on Facebook**, verified against Meta's docs (July 2026).
Everything else — one private reply per comment, top-level only, buttons-not-quick-replies,
`postback`-not-`web_url`, the postback-opens-the-window logic, 7-day-ish send window — is
**the same** and is not restated.

### 3.1 The webhook field is `feed`, not `comments`

This is the single biggest difference and the #1 silent-failure trap.

Instagram delivers comments under `entry[].changes[].field === 'comments'`.
**Facebook Pages deliver them under `field === 'feed'`**, and the `feed` field carries
*every* Page activity — posts, photos, shares, likes **and** comments — so we must also
filter on `value.item === 'comment'` and `value.verb === 'add'`:

```jsonc
{
  "object": "page",
  "entry": [{
    "id": "1029384756",                       // OUR page id  (self-comment guard uses this)
    "time": 1753660800,
    "changes": [{
      "field": "feed",
      "value": {
        "item":       "comment",              // also "post" | "photo" | "share" | "like" …
        "verb":       "add",                  // also "edited" | "remove"  → skip both
        "comment_id": "1029384756_999",       // ← the comment id, the thing we need
        "message":    "what is the price of laser?",
        "from":       { "id": "1010101010", "name": "Priya Sharma" },
        "post_id":    "1029384756_888",
        "parent_id":  "1029384756_777",       // present ONLY if it's a reply in a thread
        "created_time": 1753660800
      }
    }]
  }]
}
```

Note the field-name differences from the Instagram payload — they matter for the extractor:

| Meaning | Instagram (`field:'comments'`) | Facebook (`field:'feed'`, `item:'comment'`) |
|---|---|---|
| Comment id | `value.id` | `value.comment_id` |
| Comment text | `value.text` | `value.message` |
| Author display name | *(not provided — fetch via Profile API)* | `value.from.name` (**inline, free**) |
| Author username | `value.from.username` | *(not provided)* |
| Thread parent | `value.parent_id` | `value.parent_id` *(same)* |
| Post/media id | `value.media.id` | `value.post_id` |
| Our account id | `value.recipient_id \|\| entry.id` | `entry.id` *(page id)* |
| Event-type filter | *(none — field is comment-specific)* | `value.item === 'comment'` |
| Add/edit filter | *(none)* | `value.verb === 'add'` |

### 3.2 Public reply — post a comment under their comment

```http
POST https://graph.facebook.com/v21.0/{FB_COMMENT_ID}/comments?access_token={META_PAGE_ACCESS_TOKEN}
Content-Type: application/json

{ "message": "Check your DM 💬" }
```

Permission: **`pages_manage_engagement`** (+ `pages_read_engagement`). Returns
`{ "id": "<new comment id>" }`.

Two differences from Instagram's public reply: the endpoint edge is **`/comments`**, not
`/replies` ([Graph Comment node](https://developers.facebook.com/docs/graph-api/reference/comment/)),
and it uses the **Page** access token as a query parameter, exactly like the existing
`sendFacebookMessage()`.

### 3.3 Private reply — DM the commenter

Facebook offers **two** private-reply mechanisms. **We use the Messenger Platform one**
because it mirrors Instagram exactly and keeps the lead id-space consistent:

```http
POST https://graph.facebook.com/v21.0/{META_PAGE_ID|me}/messages?access_token={META_PAGE_ACCESS_TOKEN}
Content-Type: application/json

{
  "recipient": { "comment_id": "1029384756_999" },
  "message":   { "text": "Hi! Our laser packages start at ₹…" }
}
```

Permission: **`pages_messaging`**. Returns `{ "recipient_id": "<PSID>", "message_id": "…" }`.

> **Why this and not the `/{comment-id}/private_replies` edge.** Meta documents a
> separate [Graph `/private_replies` edge](https://developers.facebook.com/docs/graph-api/reference/object/private_replies/)
> (`POST /{comment-id}/private_replies?message=…`). We deliberately do **not** use it:
> (a) it returns `user_id` (an **app-scoped** user id), not the Messenger **PSID** — using
> it would store a different id in `facebook_user_id` than normal Messenger DMs do, forking
> one person into two leads (the exact bug class `idColumnFor()` exists to prevent); (b) it
> documents only a plain `message` string, with no buttons/templates; (c) it is the older,
> less-unified path. The `/messages` + `recipient:{comment_id}` send is the same feature
> Instagram uses ([IG §3.3](INSTAGRAM_COMMENT_AUTOMATION.md#33-private-reply--dm-the-commenter)),
> supports the button template, and returns the PSID — so a commenter who later DMs us
> dedupes to **one** lead. ([Messenger Platform — Private Replies](https://developers.facebook.com/docs/messenger-platform/discovery/private-replies))

**`recipient: { comment_id }` is the whole trick** — it is what makes DMing a stranger
legal, exactly as on Instagram, and it carries the same **exactly one private reply per
comment** limit ([Graph `/private_replies` reference](https://developers.facebook.com/docs/graph-api/reference/object/private_replies/):
*"a comment or post may only be replied to once"*) and **top-level comments only** rule
(Meta rejects a private reply to a reply-in-a-thread).

**Do not set `messaging_type: 'RESPONSE'`** on this send. `RESPONSE` asserts the recipient
messaged us within 24h — a commenter has **not**. The private reply is its own sanctioned
out-of-window context via `comment_id`; adding `RESPONSE` would be a false assertion. (The
normal `sendFacebookMessage()` does set `RESPONSE`, because that path only runs inside the
24h window. They are different sends.)

### 3.4 What happens after — the window reopens

**Identical to Instagram** ([IG §3.4](INSTAGRAM_COMMENT_AUTOMATION.md#34-what-happens-after--the-window-reopens)).
The private reply spends the one allowed message; the customer's reply (typed or a button
tap) is customer-initiated, so it opens the standard **24-hour** window and staff can then
reply free-form from the inbox. This is why the DM must end in a question.

### 3.5 Buttons — same rules, same unproven assumption

Same as Instagram ([IG §3.5](INSTAGRAM_COMMENT_AUTOMATION.md#35-the-three-tappable-options--use-buttons-not-quick-replies)):
**button template**, max **3** `postback` buttons (one per branch — we have exactly 3),
**never `web_url`** (a link tap sends us nothing: no event, no window, no routing), and the
branch names stay in the text so typed answers and desktop-web users still route.

> ⚠️ **Same two open assumptions as Instagram**, inherited and not re-litigated:
> 1. Meta accepts a **button template** on a `recipient:{comment_id}` send.
> 2. A **postback tap opens the 24h window**.
>
> These are exactly the things [IG §7 step 0](INSTAGRAM_COMMENT_AUTOMATION.md#manual-smoke-test)
> exists to prove. **Facebook is gated on that proof** ([§12 Phase 0](#phase-0--prerequisite-instagram-must-be-live-first)).
> If they fail on Instagram, they fail here too — and the fix is identical: pass `[]` for
> `branches` and ship plain text. The typed-answer path (`matchBranch`) already covers
> routing and is unit tested.

---

## 4. Design

### 4.1 Flow

The flow is the Instagram flow ([IG §4.1](INSTAGRAM_COMMENT_AUTOMATION.md#41-flow)) with
`facebook` substituted. Only the extraction source and the two Graph calls differ:

```
── A. the comment ────────────────────────────────────────────────────────────
customer comments on a Facebook Page post
  → Meta → POST <site>/webhook/meta   (object='page', changes[].field='feed', value.item='comment')
  → extractComments(payload)          — now ALSO reads the FB 'feed' stream; returns a
                                        normalized event tagged platform:'facebook'
  → processComment(c)
      ├ skip: item !== 'comment' or verb !== 'add'   (handled in the extractor)
      ├ skip: our own comment      (from.id === entry.id)   ← infinite-loop guard
      ├ skip: threaded reply       (value.parent_id present)
      ├ matchCommentRule(text, settings.comment_rules)  → no match? leave it alone
      │      (SHARED rules — same list Instagram uses)
      ├ 1. PRIVATE REPLY  POST graph.facebook.com/v21.0/{PAGE}/messages
      │      { recipient:{comment_id}, message:{ attachment: button template } }
      │      ← the ONE allowed message. Ends in the branch question. NO messaging_type.
      ├ 2. PUBLIC REPLY   POST graph.facebook.com/v21.0/{comment_id}/comments  { message }
      └ 3. lead parked on META_BRANCH_ID + timeline:
            "[comment] <text>" incoming, the question outgoing

── B. their answer ───────────────────────────────────────────────────────────
customer taps [Dwarka]  (or types "dwarka")
  → entry[].messaging[] — .postback for a tap, .message for typed text
  → processIncomingMessage(...)  → lead + message stored, as always
  → routeLeadFromReply(lead, text, payload)        ← UNCHANGED, platform-agnostic
      ├ payload "BRANCH:<uuid>"?  → exact branch id (tap)
      ├ else matchBranch() on active branch names (typed)
      └ exactly 1 → UPDATE leads SET branch_id = <that branch>
  → thread in the right branch's inbox, 24h window OPEN
```

Half B is **completely unchanged** — `extractEvents()` already handles `messaging[].postback`
for the `page` object (the FB Messenger shape), and `routeLeadFromReply`/`matchBranch` are
platform-agnostic. This is the payoff of the Instagram build: routing works for Facebook
today, for free.

### 4.2 Decisions worth arguing about

**a) Same dedupe strategy — private reply sent FIRST.** Meta permits exactly one private
reply per comment, so a redelivered webhook throws on the second attempt and we never
double-post the public reply. Ordering *is* the dedupe; no processed-comments table.
Identical to Instagram ([IG §4.2 a](INSTAGRAM_COMMENT_AUTOMATION.md#42-decisions-worth-arguing-about)).

**b) `recipient_id` (PSID) from the send response is the lead's `facebook_user_id` — never
the comment's `from.id`.** Facebook's comment `from.id` is an **app-scoped** user id,
distinct from the Messenger **PSID** the send returns. Using `from.id` would fork one person
into two leads and silently break DM dedupe — the exact bug class `idColumnFor()` guards.
The private-reply response hands us the correct PSID for free.
([IG §4.2 b](INSTAGRAM_COMMENT_AUTOMATION.md#42-decisions-worth-arguing-about))

**c) Self-comment guard is mandatory and works the same way.** Our public reply is posted by
the Page, so the feed webhook for it carries `from.id === entry.id` (the page id). The
existing `c.fromId === c.accountId` guard catches it. Using `entry.id` (not a `META_PAGE_ID`
env var) means the guard works even if that var is unset. Same as Instagram.

**d) Filter `item === 'comment'` AND `verb === 'add'` in the extractor, not in `processComment`.**
The `feed` field fires for posts, photos, likes, edits and removals too. Pushing both filters
into `extractComments` keeps `processComment` simple and means a `verb:'edited'` event never
even reaches the rule matcher (an edit would otherwise re-fire the automation and error on
the one-private-reply-per-comment limit — naturally deduped, but noisy in the logs).

**e) Shared `comment_rules` — no new settings key, no new card.** Client decision. The
Instagram loader/editor (`loadCommentRules`, `renderCommentRules`, `addCommentRule`,
`removeCommentRule` in [app.js](app.js)) already reads/writes `settings.comment_rules`; it is
reused verbatim. The card label changes to mention both platforms. Nothing else in the UI
moves.

**f) No `messaging_type` on the private reply.** See [§3.3](#33-private-reply--dm-the-commenter).
The normal `sendFacebookMessage()` keeps `RESPONSE`; the comment private reply omits it. They
are different code paths.

**g) Generalize, don't duplicate.** Rather than a parallel `extractFacebookComments` +
`processFacebookComment`, we widen the **existing** `extractComments` to dispatch by
`payload.object` and tag each event with `platform`, then make the **existing**
`processComment` pick its sender by `c.platform`. This keeps `handleWebhook`'s loop untouched
and means there is exactly one comment-automation code path to maintain. Matches the
codebase's explicit, "throw on the unknown" ethos.

**h) Routing, rules and branch matching are shared and already built.** `matchCommentRule`,
`matchBranch`, `routeLeadFromReply` need **zero** changes. The only new logic is extraction
+ two senders.

**i) A shared button builder.** Both IG and FB private replies build the same button-template
message. Extract `buildBranchButtonMessage(text, branches)` and have both senders use it — a
small DRY win that also refactors the shipped IG sender onto the shared helper (identical
output, low risk).

### 4.3 Rule format

**Unchanged from Instagram** ([IG §4.3](INSTAGRAM_COMMENT_AUTOMATION.md#43-rule-format)) —
shared rules, so the same JSON in `settings.comment_rules`:

```json
[
  { "keyword": "price", "public": "Check your DM 💬",
    "dm": "Hi! Laser packages start from ₹X per session and depend on the area treated. Which branch works for you — Janakpuri, Kirti Nagar or Dwarka? I'll send the full price list and open slots." },
  { "keyword": "*", "public": "Check your DM",
    "dm": "Thanks for reaching out! Which branch are you closest to — Janakpuri, Kirti Nagar or Dwarka?" }
]
```

The three branch buttons are appended automatically from the active `branches` rows; the admin
never types them. Copy rules carry over: always end on a question, name the branches in the
text, spell them as in the `branches` table.

> ⚠️ **Catch-all `*` is riskier on Facebook than Instagram.** Pages draw more spam and
> drive-by comments than an Instagram business profile. A `*` rule replies to *every* comment,
> burning the one-private-reply-per-comment allowance on noise. **Recommend keyword-only on
> Facebook** unless the client specifically wants blanket coverage. See [§11](#11-open-questions-for-the-client).

### 4.4 Files touched

| File | Change |
|---|---|
| [netlify/functions/utils/meta-service.js](netlify/functions/utils/meta-service.js) | Generalize `extractComments()` to also read FB `feed`/`item:'comment'` events and tag each with `platform`; make `processComment()` platform-aware; add `sendFacebookPrivateReply()`, `replyToFacebookComment()`, and a shared `buildBranchButtonMessage()`; refactor `sendCommentPrivateReply()` onto the shared builder. **`handleWebhook`'s comment loop is unchanged** — it already iterates whatever `extractComments` returns. |
| [netlify/functions/utils/meta-service.test.js](netlify/functions/utils/meta-service.test.js) | Facebook extraction assertions (item/verb filters, field-name mapping, self-comment + threaded markers) + IG regression. `matchCommentRule`/`matchBranch` already covered. |
| [index.html](index.html) | Comment Automation card: label/description updated to "Instagram & Facebook". **No new card.** |
| [app.js](app.js) | **No logic change.** (`commentRules` state + CRUD already wired for the shared `comment_rules`.) Optional: tweak the card's help text to note rules apply to both platforms. |
| [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) | §15 (new Facebook subsection under comment automation), §21 (change log), §22 (roadmap: add FB item, note it shares rules + is gated on IG). Per the file's maintenance rule — same commit. |

**No** schema migration, **no** new settings key, **no** new dependency, **no** new Netlify
function. `META_PAGE_ID` is referenced but optional (defaults to `me`, exactly like
`META_IG_ID`); the Page token `META_PAGE_ACCESS_TOKEN` already exists for FB DMs.

Meta dashboard: subscribe the **`feed`** field, confirm **`messaging_postbacks`**, add the
Page permissions + App Review, subscribe the Page to the app — [§6](#6-meta-dashboard-setup).

---

## 5. The code (planned)

Not yet written. Listed here so the build is mechanical and the design is reviewable. Pure
parts (`extractComments`) are testable offline exactly like the Instagram ones were.

### 5.1 `meta-service.js` — generalized `extractComments`

Replaces the current Instagram-only extractor with one that dispatches by `payload.object`
and tags each event with `platform`. The Instagram branch preserves today's field mapping
verbatim; the Facebook branch maps the `feed`/`item:'comment'` shape to the same internal
contract:

```js
// Post/media comment events. Instagram delivers these under entry[].changes[]
// field 'comments'; Facebook Pages deliver them under field 'feed' with
// value.item 'comment'. Both are normalized to one shape tagged with `platform`,
// so processComment can pick the right sender. A comment is not a message, so it
// never mixes with extractEvents()' messaging stream.
function extractComments(payload) {
  const comments = [];

  for (const entry of (payload.entry || [])) {
    for (const change of (entry.changes || [])) {
      const v = change.value || {};

      // Instagram — field 'comments'
      if (payload.object === 'instagram' && change.field === 'comments') {
        comments.push({
          platform:  'instagram',
          commentId: v.id,
          text:      v.text,
          fromId:    v.from?.id,
          username:  v.from?.username,
          name:      null,                       // IG gives a username, not a display name
          parentId:  v.parent_id,                // set = reply in a thread
          accountId: v.recipient_id || entry.id, // OUR ig account id
        });
        continue;
      }

      // Facebook Page — field 'feed', new comments only.
      // 'feed' also carries posts/photos/likes (item !== 'comment') and edits/
      // removals (verb !== 'add'); drop all of those at the source.
      if (payload.object === 'page' && change.field === 'feed'
          && v.item === 'comment' && v.verb === 'add') {
        comments.push({
          platform:  'facebook',
          commentId: v.comment_id,
          text:      v.message,
          fromId:    v.from?.id,                 // app-scoped — NOT the Messenger PSID
          username:  null,
          name:      v.from?.name,               // FB hands the display name over inline
          parentId:  v.parent_id,                // set = reply in a thread
          accountId: entry.id,                   // OUR page id
        });
        continue;
      }
    }
  }
  return comments;
}
```

Two new fields on the normalized event — `platform` (drives sender selection) and `name`
(FB populates it inline; IG leaves it null and the username path is unchanged).

### 5.2 `meta-service.js` — shared button builder

Extracted from the shipped IG sender so both platforms share it. Identical output to today's
inline construction, so the IG regression is a no-op:

```js
// The button-template message body used by both IG and FB private replies.
// One POSTBACK button per branch, max 3 (Meta's limit). postback (never web_url):
// a link tap sends us nothing — no event, no 24h window, no routing. Titles
// truncate past 20 chars. With no branches, falls back to plain text.
function buildBranchButtonMessage(text, branches = []) {
  const buttons = branches.slice(0, 3).map((b) => ({
    type:    'postback',
    title:   String(b.name || '').slice(0, 20),
    payload: `BRANCH:${b.id}`,
  }));
  return buttons.length
    ? { message: { attachment: { type: 'template',
                                 payload: { template_type: 'button', text, buttons } } } }
    : { message: { text } };
}
```

### 5.3 `meta-service.js` — Facebook private reply + public reply

```js
// Facebook private reply — DMs the commenter via the Messenger Platform. Passing
// `comment_id` as the recipient is what makes a DM to a stranger legal, exactly as
// on Instagram. Same one-private-reply-per-comment limit; same button template.
// Uses the PAGE token (query param, like sendFacebookMessage). Deliberately does
// NOT set messaging_type — a commenter hasn't messaged us, so 'RESPONSE' would be a
// false assertion; the comment_id recipient is its own sanctioned out-of-window send.
// Returns { recipient_id, message_id }; recipient_id is the commenter's PSID — the
// id space Messenger and leads.facebook_user_id use.
async function sendFacebookPrivateReply(commentId, text, branches = []) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error('Missing META_PAGE_ACCESS_TOKEN env var');

  const { message } = buildBranchButtonMessage(text, branches);
  const pageId = process.env.META_PAGE_ID || 'me';

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${pageId}/messages?access_token=${encodeURIComponent(token)}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ recipient: { comment_id: commentId }, message }),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`FB private reply failed: ${res.status} ${msg}`);
  }
  console.log(`[meta-service] FB private reply sent for comment ${commentId} → PSID ${data.recipient_id} (${branches.slice(0,3).length} buttons)`);
  return data;
}

// Public reply posted under a Facebook comment. Endpoint edge is /comments
// (Instagram uses /replies). Needs pages_manage_engagement (+ pages_read_engagement).
async function replyToFacebookComment(commentId, text) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error('Missing META_PAGE_ACCESS_TOKEN env var');

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${encodeURIComponent(commentId)}/comments?access_token=${encodeURIComponent(token)}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message: text }),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`FB comment reply failed: ${res.status} ${msg}`);
  }
  console.log(`[meta-service] FB public reply posted under comment ${commentId} (id=${data.id || 'n/a'})`);
  return data;
}
```

### 5.4 `meta-service.js` — platform-aware `processComment`

The existing function, with the sender chosen by `c.platform` and the name resolved from
whichever field the platform provides. Rules are shared; routing/branch-matching unchanged:

```js
async function processComment(c) {
  if (!c.commentId || !c.text || !c.fromId) {
    console.log('[meta-service] Skipping comment event — missing id, text or from.id');
    return;
  }
  if (c.fromId === c.accountId) {                         // our own reply → infinite-loop guard
    console.log('[meta-service] Skipping our own comment');
    return;
  }
  if (c.parentId) {                                        // reply inside a thread
    console.log('[meta-service] Skipping threaded reply (has parent_id)');
    return;
  }

  const rules = await getSettingJson('comment_rules');    // SHARED with Instagram
  const rule  = matchCommentRule(c.text, Array.isArray(rules) ? rules : []);
  if (!rule) {
    console.log(`[meta-service] Comment ${c.commentId}: no rule matched "${c.text}"`);
    return;
  }

  const db       = createSupabaseClient();
  const branches = await db.listBranches();

  // DM first, on purpose — one private reply per comment makes a redelivered
  // webhook throw here, so we never double-post the public reply.
  const isFb = c.platform === 'facebook';
  const sent = rule.dm
    ? (isFb ? await sendFacebookPrivateReply(c.commentId, rule.dm, branches)
            : await sendCommentPrivateReply(c.commentId, rule.dm, branches))
    : null;
  if (rule.public) {
    isFb ? await replyToFacebookComment(c.commentId, rule.public)
         : await replyToComment(c.commentId, rule.public);
  }
  if (!sent) return;

  // recipient_id from the send is the authoritative platform id (IGSID / PSID).
  // The comment's from.id is a different id space — using it forks one person into
  // two leads and breaks DM dedupe.
  const lead = await processIncomingMessage(
    sent.recipient_id,
    `[comment] ${c.text}`,
    c.platform,                                            // 'instagram' | 'facebook'
    c.name || (c.username ? `@${c.username}` : null)       // FB has name inline; IG has username
  );
  await db.insertMessage({
    lead_id:   lead.id,
    direction: 'outgoing',
    message:   rule.dm,
    is_seen:   true,
  });
}
```

### 5.5 `handleWebhook` — no change

The loop that already exists needs nothing:

```js
  // Instagram AND Facebook post comments — one stream, dispatched inside extractComments.
  for (const c of extractComments(payload)) {
    try {
      await processComment(c);
    } catch (err) {
      console.error(`[meta-service] Comment ${c.commentId} automation failed:`, err.message);
    }
  }
```

The `isPlatformEnabled(platform)` gate above it still works for a `feed` payload:
`extractEvents` returns `platform:'facebook'` for `object:'page'`, the feed change has
`field:'feed'` (not `'messages'`) so it produces zero message events, and the enabled-check
correctly gates Facebook comment automation on the admin's Connected-Accounts toggle.

### 5.6 `index.html` / `app.js` — label only

The Comment Automation card's title/help text is updated to state it covers **Instagram &
Facebook**. No new card, no new `state` field, no new CRUD — `commentRules` already drives
the shared `comment_rules`. Optionally add one line of help text: *"Rules apply to comments on
both Instagram and Facebook."*

---

## 6. Meta dashboard setup

No new env vars. All of this fails **silently** if missed, same as the Instagram checklist
([IG §6](INSTAGRAM_COMMENT_AUTOMATION.md#6-meta-dashboard-setup)).

1. **Subscribe the `feed` webhook field** on the **Page** object (same callback
   `/webhook/meta`, same verify token). This is the field that delivers comment events.
   **Do not subscribe `comments`** — that field exists for *Instagram*, not Facebook Pages;
   ticking it on a Page does nothing, and its absence is the most common silent failure.
2. **Confirm `messaging_postbacks` is subscribed for the Page.** Button taps arrive as
   postbacks; without this the customer taps a branch, we hear nothing, and no inbound event
   means the **24h window never opens**. If Facebook DM buttons are already in use this may
   already be on — verify, don't assume.
3. **Add the Page permissions and get Advanced Access via App Review.** This is a *separate*
   App Review track from the Instagram permissions, with its own lead time:
   - `pages_messaging` — sending the private reply (`/messages`).
   - `pages_read_engagement` — receiving the `feed` webhook and reading comments.
   - `pages_manage_engagement` — posting the public reply (`/comments`).
   - (`pages_show_list` — listing/subscribing the Page; usually required to grant the above.)
4. **Subscribe the Page to the app:** `POST /{page-id}/subscribed_apps` with the Page token
   (the Facebook equivalent of Instagram's `graph.instagram.com/.../subscribed_apps`). The
   Page must grant the app and the subscribed fields.
5. **App Live, Page published.** Same gate as Instagram — an app in Development mode sends
   zero real notifications.

**Rollback:** untick the `feed` field. The extractor's `field === 'feed'` check means the code
goes inert with no deploy — same one-line-off property as Instagram.

---

## 7. Test plan

Extend the existing framework-free test
([meta-service.test.js](netlify/functions/utils/meta-service.test.js), run with
`node netlify/functions/utils/meta-service.test.js`). The extractor is pure, so it tests with
no env vars or network. `matchCommentRule` and `matchBranch` are already covered and are
platform-agnostic, so only **extraction** needs new assertions:

```js
// ── Facebook Page feed comments: the comment-to-DM stream ──
{
  const payload = {
    object: 'page',
    entry: [{ id: 'PAGE_ID', time: 1753660800, changes: [{ field: 'feed', value: {
      item: 'comment', verb: 'add',
      comment_id: 'FB_COMMENT_1',
      message: 'what is the PRICE of laser?',
      from: { id: 'FB_USER_1', name: 'Priya Sharma' },
      post_id: 'FB_POST_1',
    } }] }],
  };

  const [c] = extractComments(payload);
  assert.equal(c.platform,  'facebook');
  assert.equal(c.commentId, 'FB_COMMENT_1');
  assert.equal(c.text,      'what is the PRICE of laser?');
  assert.equal(c.fromId,    'FB_USER_1');
  assert.equal(c.name,      'Priya Sharma');        // FB gives the display name inline
  assert.equal(c.accountId, 'PAGE_ID');             // entry.id = our page, for the self-guard

  // 'feed' must not leak non-comment items, edits or removals
  assert.equal(extractComments({ object:'page', entry:[{ id:'P', changes:[{ field:'feed', value:{ item:'post',  verb:'add'    } }] }] }).length, 0);
  assert.equal(extractComments({ object:'page', entry:[{ id:'P', changes:[{ field:'feed', value:{ item:'like',  verb:'add'    } }] }] }).length, 0);
  assert.equal(extractComments({ object:'page', entry:[{ id:'P', changes:[{ field:'feed', value:{ item:'comment', verb:'edited', comment_id:'x' } }] }] }).length, 0);
  assert.equal(extractComments({ object:'page', entry:[{ id:'P', changes:[{ field:'feed', value:{ item:'comment', verb:'remove', comment_id:'x' } }] }] }).length, 0);

  // A feed-comment payload must not leak into the DM stream (and vice versa)
  assert.equal(extractEvents(payload).events.length, 0, 'feed comment must not become a message event');

  // Threaded-reply marker survives extraction
  const [c2] = extractComments({ object:'page', entry:[{ id:'PAGE_ID', changes:[{ field:'feed', value:{
    item:'comment', verb:'add', comment_id:'FB_C2', message:'ok',
    from:{ id:'U', name:'X' }, parent_id:'FB_COMMENT_1',
  } }] }] });
  assert.equal(c2.parentId, 'FB_COMMENT_1');

  // Self-comment guard: a Page-authored comment has from.id === entry.id
  const [c3] = extractComments({ object:'page', entry:[{ id:'PAGE_ID', changes:[{ field:'feed', value:{
    item:'comment', verb:'add', comment_id:'FB_C3', message:'Check your DM',
    from:{ id:'PAGE_ID', name:'Clinix360' },
  } }] }] });
  assert.equal(c3.fromId, c3.accountId, 'our own reply must be detectable → no infinite loop');
}

// Regression: the IG branch of the generalized extractor still works
{
  const [ig] = extractComments({ object:'instagram', entry:[{ id:'IG_ID', changes:[{ field:'comments', value: {
    from: { id: 'IG_USER', username: 'priya.sharma' }, id: 'IG_C1', text: 'hi', parent_id: 'IG_PARENT',
  } }] }] });
  assert.equal(ig.platform, 'instagram');
  assert.equal(ig.commentId, 'IG_C1');
  assert.equal(ig.username, 'priya.sharma');
  assert.equal(ig.parentId, 'IG_PARENT');

  // IG still rejects non-instagram payloads
  assert.equal(extractComments({ object:'whatsapp_business_account', entry:[{ changes:[{ field:'feed', value:{} }] }] }).length, 0);
  assert.equal(extractComments({}).length, 0);
}
```

### Manual smoke test

Needs a second Facebook account with a tester/admin role on the Page. **It is largely a
re-run of the Instagram smoke test** ([IG §7](INSTAGRAM_COMMENT_AUTOMATION.md#manual-smoke-test))
— Facebook inherits the two open assumptions from there. Key Facebook-specific checks:

1. Comment on a Page post from the tester account → within seconds: a public reply under the
   comment, the DM (three buttons) in Messenger, a new lead on the fallback branch, timeline
   `[comment] <text>` then the question.
2. **Tap `Dwarka`.** Lead moves to **Dwarka Sec 12**; "Dwarka" appears in the thread as an
   incoming message.
3. **Reply from staff in the dashboard.** The one that proves the premise — it must send
   (the tap opened the 24h window). Before the tap it would fail `502 / Failed — not sent`.
4. New comment, then **type** `dwarka` instead of tapping → same result via `matchBranch`.
5. **Edit** the comment → no second DM (the `verb:'edited'` filter; and the one-private-reply
   limit would reject a second anyway).
6. **Like** the post or add a **photo** → no reaction at all (`item !== 'comment'`).
7. Confirm a commenter who **later DMs the Page** merges into the **same** lead (PSID dedupe),
   not a second one — this validates using the send response's `recipient_id`, not `from.id`.

---

## 8. Gotchas

The Facebook-specific ones; the shared ones (one private reply per comment, `postback` not
`web_url`, buttons not quick replies, name-the-branches-in-text, 7-day→24h window logic,
rate limits, etc.) are in [IG §8](INSTAGRAM_COMMENT_AUTOMATION.md#8-gotchas) and apply
unchanged.

| # | Thing |
|---|---|
| 1 | **The webhook field is `feed`, not `comments`.** `comments` is the *Instagram* field; subscribing it on a Page delivers nothing. The #1 silent trap. |
| 2 | **`feed` carries everything — filter `item === 'comment'`.** Posts, photos, shares and likes arrive on the same field. Without the filter, every Page activity hits the rule matcher. |
| 3 | **Filter `verb === 'add'`.** Edits fire `verb:'edited'`; without the filter, editing a comment re-runs the automation and errors on the one-private-reply limit. |
| 4 | **`from.id` is app-scoped, not the PSID.** Always take `recipient_id` from the private-reply response for `facebook_user_id`. Using `from.id` forks one person into two leads — the `idColumnFor()` bug class. |
| 5 | **Do not set `messaging_type: 'RESPONSE'` on the private reply.** A commenter hasn't messaged us; `RESPONSE` is a false assertion. The `comment_id` recipient is the sanctioned out-of-window context. (`sendFacebookMessage` keeps `RESPONSE` — different path, inside the window.) |
| 6 | **Use `/messages` with `recipient:{comment_id}`, not the `/private_replies` edge.** The edge returns an app-scoped `user_id` (breaks PSID dedupe) and supports no buttons. |
| 7 | **Public reply endpoint is `/comments`, not `/replies`.** And it takes the Page token as a query param. |
| 8 | **The Page token must be long-lived / a System User token.** A 24h user token dies overnight — the same "worked yesterday, 401 today" lesson as WhatsApp. `META_PAGE_ACCESS_TOKEN` is already used for FB DMs, so confirm it's the permanent one. |
| 9 | **Separate App Review track.** `pages_messaging` / `pages_read_engagement` / `pages_manage_engagement` Advanced Access is its own review, independent of the Instagram permissions. Start early. |
| 10 | **Subscribe the Page to the app** (`/{page-id}/subscribed_apps`) and grant the subscribed fields — easy to miss vs the app-level webhook subscription. |
| 11 | **Catch-all `*` is riskier on Facebook.** Pages get more spam/drive-by comments; a `*` rule replies to all of them. Prefer keyword-only. |
| 12 | **API-posted comments occasionally lag public visibility** (reported on Stack Overflow). The reply is posted; if it's slow to show publicly, that's Meta, not us. |
| 13 | **FB comment `from.name` is available inline** — better than Instagram, which needs a profile fetch for a display name. Leads start with a real name immediately. |
| 14 | **Max 3 buttons, 20-char titles** — same as Instagram. A 4th branch or a long branch name forces plain-text/typed answers. |

---

## 9. Cost

**₹0.** Facebook messaging and comment endpoints are free; the Page permissions cost nothing.
Same calculus as Instagram ([IG §9](INSTAGRAM_COMMENT_AUTOMATION.md#9-cost)). The only spend
would be a provider subscription we are not buying.

---

## 10. Deliberately out of scope

Everything in [IG §10](INSTAGRAM_COMMENT_AUTOMATION.md#10-deliberately-out-of-scope) carries
over. Facebook-specific additions:

| Skipped | Add when |
|---|---|
| **Per-platform rule sets** (we chose shared `comment_rules`) | The clinic wants different keywords/copy/tone on FB vs IG. Would mean `fb_comment_rules` + a second card. |
| **Per-Page / per-post scoping** (`post_id` is already extracted, just unused) | Different campaigns need different answers on different Page posts. |
| **Spam/comment-moderation** (hide/delete via `POST`/`DELETE /{comment-id}`) | Volume or abuse justifies auto-hiding. The endpoints are free if it ever comes up. |
| **Visitor-Post private replies** (the `/private_replies` edge also covers visitor posts) | The clinic takes DMs from Page visitor posts, not just comments. |

---

## 11. Open questions for the client

1. **Is the clinic's Facebook Page an active comment channel?** If FB comment volume is
   near-zero, this is lower ROI than it looks — Instagram is the proven growth mechanic. Worth
   confirming real traffic before spending the App Review lead time.
2. **Catch-all or keyword-only on Facebook?** Recommend **keyword-only** — Pages draw more
   spam than Instagram, and `*` replies to every comment including "🔥". See [§4.3](#43-rule-format).
3. **Shared copy acceptable for Facebook?** The client chose shared rules; confirm the
   Instagram `comment_rules` copy reads fine in a Messenger context (it does — it's generic).
4. **Medical-claim review.** Same as Instagram — auto-sent DMs about skin treatments should be
   signed off by the clinic before going live.

### What this closes

Facebook comment-originated leads get the same branch routing Instagram comment leads get —
but, like Instagram, only for leads that actually engage with the branch question. Routing of
*plain Messenger DMs* (a customer who messages the Page directly, no comment) still needs
manual assignment: `routeLeadFromReply` will move such a lead only if they happen to name a
branch in an early message. This does **not** close [roadmap item 1](PROJECT_DOCUMENTATION.md#22-roadmap--open-items)
for Messenger any more than Instagram closed it for IG — it extends the *comment* path to a
second platform.

---

## 12. Implementation order — gated, start at Phase 0

This is the build order. **Do not start until Phase 0 is satisfied** — Facebook inherits
Instagram's two open assumptions, and re-running them blind against a second App Review track
is wasted effort.

### Phase 0 — PREREQUISITE: Instagram must be live first

- [ ] **0.** The Instagram comment automation is **switched on** ([IG §12](INSTAGRAM_COMMENT_AUTOMATION.md#12-implementation-order--start-here)
      Phases 1, 4 and 6 done): `comments` + `messaging_postbacks` subscribed,
      `instagram_business_manage_comments` added, the App Live, and the two live checks passed —
      (a) button template accepted on a `recipient:{comment_id}` send, (b) a postback tap opens
      the 24h window. **Facebook takes whichever answer Instagram got.** If IG shipped plain text
      (buttons failed), FB ships plain text too and the button-builder work below is skipped.

### Phase 1 — Meta dashboard (long lead time; start early)

- [ ] **1.** Subscribe the **`feed`** field and confirm **`messaging_postbacks`** on the Page
      webhook. Add `pages_messaging` + `pages_read_engagement` + `pages_manage_engagement` and
      get **Advanced Access** via App Review. Subscribe the Page to the app
      (`/{page-id}/subscribed_apps`). Full detail + silent-failure modes: [§6](#6-meta-dashboard-setup).
      *Verify:* comment on a Page post from a tester account and watch the Netlify function log
      for a `field: 'feed'`, `item: 'comment'` payload. **No payload = stop here.**

### Phase 2 — pure logic, no network

- [ ] **2.** Generalize `extractComments()` ([§5.1](#51-meta-servicejs--generalized-extractcomments))
      and add the shared `buildBranchButtonMessage()` ([§5.2](#52-meta-servicejs--shared-button-builder)).
- [ ] **3.** Add `sendFacebookPrivateReply()` and `replyToFacebookComment()` ([§5.3](#53-meta-servicejs--facebook-private-reply--public-reply)),
      and make `processComment()` platform-aware ([§5.4](#54-meta-servicejs--platform-aware-processcomment)).
      Refactor the IG sender onto the shared builder.
- [ ] **4.** Paste the [§7](#7-test-plan) assertions into `meta-service.test.js`.
      *Verify:* `node netlify/functions/utils/meta-service.test.js` prints
      `meta-service: all checks passed`, including the IG regression.

### Phase 3 — UI (label only)

- [ ] **5.** Update the Comment Automation card in [index.html](index.html) to read
      "Instagram & Facebook", and optionally note that rules apply to both. No app.js logic
      change.

### Phase 4 — end to end + docs

- [ ] **6.** Work through the [manual smoke test](#manual-smoke-test). Step 3 (a staff reply
      sends after the tap) is the one that matters.
- [ ] **7.** Update [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) **in the same commit** —
      §15 (Facebook subsection under comment automation), §21 (change log), §22 (roadmap: add
      the FB item, note shared rules + IG gating). Per the file's maintenance rule.

### Things not to rediscover the hard way

The four that break silently, in the order they'll bite:

1. Subscribing `comments` instead of `feed` → no comment ever reaches us (and no error).
2. No `item === 'comment'` / `verb === 'add'` filter → every Page activity, and every edit,
   fires the automation.
3. Using `from.id` (app-scoped) instead of the send response `recipient_id` (PSID) → a
   commenter who later DMs becomes two leads, permanently.
4. Setting `messaging_type: 'RESPONSE'` on the private reply → a false 24h-window assertion.
