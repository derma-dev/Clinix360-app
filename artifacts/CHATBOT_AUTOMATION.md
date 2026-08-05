# Chatbot Automation — Research & Implementation Spec

> **Status: RESEARCH — not started, and deliberately gated.** *(2026-08-03)*
>
> This is a **plan only**. No code is written. It must **not** be built until the two
> prerequisites in [§12 Phase 0](#phase-0--prerequisite-inbox-and-routing-must-be-stable) are
> met: the **unified inbox is stable** (it just went realtime — see
> [roadmap item 7](PROJECT_DOCUMENTATION.md#22-roadmap--open-items)) and **lead routing is
> settled enough** that the bot has somewhere deterministic to hand off to. A bot bolted onto
> an unstable inbox just makes a mess faster.
>
> It is also **gated on a client decision** ([§11](#11-open-questions-for-the-client)): which
> platform first, how conservative on medical questions, and where the knowledge base comes
> from. Those answers shape the build, so do not start before they are made.
>
> Companion to [PROJECT_DOCUMENTATION.md §15](PROJECT_DOCUMENTATION.md#15-messaging-integrations-instagram--facebook--whatsapp)
> and [§22](PROJECT_DOCUMENTATION.md#22-roadmap--open-items). Written: **2026-08-03** · Planned
> against current `main` (HEAD `bcc572d`).
>
> **One-line summary:** an LLM-backed assistant that answers repetitive FAQs and pre-qualifies
> leads on Instagram / Facebook / WhatsApp, so staff reply only to engaged, qualified
> conversations. It plugs into the **one choke point every inbound message already flows
> through** (`processIncomingMessage` → `routeLeadFromReply`), reuses the existing per-platform
> send functions, and stores nothing new but two columns on `leads`. It is the `comment_rules`
> pattern with a brain instead of a keyword matcher.

---

## Table of contents

1. [The ask](#1-the-ask)
2. [Build vs buy](#2-build-vs-buy)
3. [The bot model — three options, one safe answer](#3-the-bot-model--three-options-one-safe-answer)
4. [Design](#4-design)
5. [The code (planned)](#5-the-code-planned)
6. [Provider & dashboard setup](#6-provider--dashboard-setup)
7. [Test plan](#7-test-plan)
8. [Gotchas](#8-gotchas)
9. [Cost](#9-cost)
10. [Deliberately out of scope](#10-deliberately-out-of-scope)
11. [Open questions for the client](#11-open-questions-for-the-client)
12. [Implementation order — gated, start at Phase 0](#12-implementation-order--gated-start-at-phase-0)

---

## 1. The ask

Today, every inbound DM / Messenger message / WhatsApp text lands in the branch inbox and
waits for a human. The comment-automation features ([IG](INSTAGRAM_COMMENT_AUTOMATION.md),
[FB](FACEBOOK_COMMENT_AUTOMATION.md)) auto-reply to *comments*; **plain DMs have no auto-reply
at all.** So staff answer every *"hi"*, *"price?"*, *"where r u located"*, *"kya timing hai"*
by hand — the repetitive 80%, over and over. We want:

1. **FAQ deflection.** The bot answers the repetitive questions (price **ranges**, location,
   hours, parking, what treatments we offer, pre-care notes) in seconds. Staff never see them.
2. **Lead qualification.** Before handing off, the bot gathers what staff need to act —
   treatment interest, branch (we already route on this), timeline/urgency, booking intent —
   and posts a **summary** into the timeline. Staff receive *"Laser hair reduction · Dwarka ·
   wants consultation within 2 weeks"* instead of *"hi"*.
3. **Safe handoff.** Anything medical, urgent, out-of-knowledge, or explicitly "talk to a
   human" is escalated to staff with context. **The bot never diagnoses, prescribes, or
   guarantees results.**
4. **Staff stay in control.** A staff member can "take over" a conversation at any time; once
   they do, the bot stays silent.

The win is **not** fewer messages — it is **pre-qualified leads** and staff freed to focus on
treatment and on the conversations that actually need a human.

> **Why this fits the existing architecture for free.** The webhook handler already calls
> `processIncomingMessage()` then `routeLeadFromReply()` for every inbound message. The bot is
> one additional call between "message stored" and "wait for staff". It sends through the
> **existing** `sendInstagramMessage` / `sendFacebookMessage` / `sendWhatsAppMessage`. No new
> webhook, no new send path, no new table — the same shape as `comment_rules`, with an LLM
> replacing the keyword match.

---

## 2. Build vs buy

**Build — same verdict as the Instagram and Facebook specs**, for the same reasons (harder,
not softer, here):

| | Build (this spec) | Buy a chatbot SaaS (e.g. a BSP / "AI inbox") |
|---|---|---|
| **Data ownership** | Leads, messages and qualifications stay in our Supabase — one source of truth | Conversations split across a second dashboard; leads live in two places |
| **Cost** | LLM API only — paise per conversation | ₹12k–₹1.2L/yr platform fee on top of the LLM cost |
| **Plumbing** | Already shipped: webhook, `processIncomingMessage`, per-platform senders, inbox | Re-integrate the same Meta webhook into a third party |
| **Customisation** | Knowledge base + guardrails are ours, in `settings`, editable from admin | Vendor's flow builder, vendor's lock-in |
| **Medical safety** | We control the guardrails exactly | Vendor's "AI" with unknown medical guardrails |

The only genuinely new spend is the LLM API ([§9](#9-cost)) — and that is pennies per
qualified lead on a small/fast model. Full provider reasoning lives in
[IG §2](INSTAGRAM_COMMENT_AUTOMATION.md#2-build-vs-buy--the-provider-landscape) and is not
repeated.

---

## 3. The bot model — three options, one safe answer

This is the central design decision, and for a **clinic** only one option is acceptable.

| | Example | Pro | Con |
|---|---|---|---|
| **A. Decision tree** | "Reply 1 for laser, 2 for skin…" | Deterministic, cheap, zero hallucination | Cannot answer *"is laser safe with PCOS?"* — real questions are free-form. This is `comment_rules` with more steps. |
| **B. Pure LLM** | "Ask anything" | Handles anything | Hallucinates prices, may give bad medical advice, drifts. **Unacceptable for a clinic.** |
| **C. Hybrid: LLM + knowledge base + hard guardrails (recommended)** | LLM that answers using **only** our KB, and **must** hand off anything outside it | Handles free-form; cannot invent facts; medically safe | Needs a curated KB and rules |

**We build C.** The LLM is *constrained*:

- It receives the clinic's **knowledge base** (services, price **ranges**, hours, branches,
  FAQs, pre/post-care) as context, and is instructed to answer **only from it**.
- It receives the **qualification state** — what it still needs to find out for this lead.
- For anything **outside the KB** — symptoms, diagnosis, exact pricing, guarantees, medication
  — it replies *"let me connect you with our team"* and **hands off**.
- It returns **structured output**: `{ reply, handoff, qualification }`, so the send, the
  state update and the escalation are driven by the model's own structured decision, not by us
  parsing prose.

This is the standard **RAG + structured-output** pattern. Facts that exist in the KB cannot be
hallucinated; facts that don't exist route to a human.

> **The bot is never the doctor.** This is a hard product rule, not a preference. See
> [§4.5 Guardrails](#45-guardrails--safety-non-negotiable-for-a-clinic).

---

## 4. Design

### 4.1 Where it plugs in (the key insight)

The current event loop in `handleWebhook` ([meta-service.js:447](netlify/functions/utils/meta-service.js#L447)):

```
for (const ev of events) {
  if (ev.isEcho) continue;
  const lead = await processIncomingMessage(ev.senderId, ev.messageText, platform, ev.profileName);
  await routeLeadFromReply(lead, ev.messageText, ev.payload);
}
```

The bot is one call inserted after routing:

```
  const lead = await processIncomingMessage(...);   // exists — stores lead + incoming message
  await routeLeadFromReply(lead, ev.messageText, ev.payload);   // exists — routes branch if named
  await botReply(lead, ev, platform);               // NEW — decide + generate + send (or hand off)
```

`botReply` sends through the **existing** per-platform sender — the same one staff replies use.
So the bot is, architecturally, an automated staff member that types into the same thread.

### 4.2 Flow

```
── inbound message ────────────────────────────────────────────────────────────
customer DMs / WA-texts the clinic
  → Meta → POST <site>/webhook/meta
  → extractEvents(payload)                          — UNCHANGED
  → processIncomingMessage(...)                     — UNCHANGED (stores lead + incoming msg)
  → routeLeadFromReply(...)                         — UNCHANGED (routes branch if they named one)
  → botReply(lead, ev, platform)                    — NEW
      ├ bot disabled for this lead (bot_active=false)? → stop, leave for staff
      ├ outside 24h window?                         → stop (can't send free-form)
      ├ CLASSIFY the inbound first (cheap, fast):
      │      medical / symptom / emergency?         → handoff immediately, NO LLM answer
      ├ LLM call: system prompt (KB + guardrails + qualification state)
      │            + last N messages of the thread
      │   → returns { reply, handoff, qualification }
      ├ handoff=true?  set bot_active=false, post summary to timeline, status='qualified'
      └ reply?  send via the per-platform sender, store as outgoing, is_seen=true
```

### 4.3 Two jobs, one turn

Each `botReply` turn does both jobs at once:

- **Deflect:** if the message is an FAQ the KB answers, answer it.
- **Qualify:** whatever the message, nudge toward the next missing qualification field — but
  *naturally*, in the same reply, not as a rigid form. The LLM is told *"you are qualifying
  this lead; you still need: treatment interest, branch, timeline"* and weaves the next
  question into its answer.

Qualification is **complete enough** when the core fields are gathered (see
[§11.2](#11-open-questions-for-the-client) for what "core" means — a client decision). Then
the bot hands off with a one-line summary.

### 4.4 Handoff (design it deliberately)

The most important decision is *when the bot stops*. Hand off on **any** of:

| Trigger | Why |
|---|---|
| **Medical / symptom / diagnosis question** | Safety — non-negotiable. The classifier catches this *before* the LLM answers. |
| **Emergency keywords** (bleeding, severe reaction, swelling, "urgent") | Safety — hand off **and** alert staff |
| **Explicit "talk to human" / "doctor se baat"** | Customer intent |
| **Qualification complete** | The bot's job is done — hand off with summary |
| **Low confidence / out-of-KB** | "Let me check with the team and get back" — never guess |
| **Buying signal** ("book it", "when can I come") | Hand off to close — staff convert |

On handoff: set `bot_active = false`, append a **summary line** to the timeline
(*"🤖 Qualified: Laser · Dwarka · consultation within 2 weeks · budget-conscious"*), and move
the lead `status` to `qualified`. Staff now own the thread.

Staff can also **take over manually** mid-conversation (a button in the inbox sets
`bot_active = false`), which is the human-initiated handoff path.

### 4.5 Guardrails — safety, non-negotiable for a clinic

- **Hard system-prompt rules:** never diagnose, never prescribe, never recommend medication,
  never guarantee results, never quote a price not in the KB, never give medical advice.
- **First bot message discloses it is an assistant:** *"Hi! I'm Clinix360's virtual assistant
  — for anything medical I'll connect you with our team."* (Meta policy + trust + many
  jurisdictions require bot disclosure.)
- **Prices are ranges, from the KB only.** Exact price is always *"after consultation"*.
- **Classifier-first.** A cheap, fast classification pass on the inbound message; if it smells
  medical/emergency, the reasoning LLM **never runs** — straight to handoff. The LLM never gets
  the chance to play doctor.
- **No medical advice, ever** — even if the customer insists. The KB deliberately contains
  *no* diagnostic or treatment-advice content; only service descriptions, prices, logistics,
  and pre/post-care **instructions** (which a doctor has signed off).
- **Disclaimer on price/medical deflection:** every deflected answer ends with a soft handoff
  cue, never a dead end.

> ⚠️ **Medical-claim review.** As with the comment-automation DMs
> ([FB §11.4](FACEBOOK_COMMENT_AUTOMATION.md#11-open-questions-for-the-client)), everything the
> bot can say about treatments must be **signed off by the clinic** before going live. The KB
> is editable from admin, but the *initial* content and the guardrail wording need a clinician's
> eye.

### 4.6 State — keep it lazy

You do **not** need a state machine or a per-step cursor. **The conversation is the state.**
Each turn, replay the last ~10 `lead_messages` to the LLM along with the KB and "here's what
you still need". The model reasons over the visible thread.

Schema additions are deliberately minimal — two columns on `leads`:

| Column | Type | Purpose |
|---|---|---|
| `bot_active` | bool, default `false` | Is the bot still handling this lead? Flipped to `false` on any handoff or staff takeover. |
| `bot_state` | jsonb, nullable | Optional scratchpad — qualification fields gathered so far, last-handoff reason. The LLM can populate this via structured output; nullable so old leads are unaffected. |

`lead_messages` already holds the timeline (incoming + outgoing, including the bot's replies
as `direction:'outgoing'`). **No new table.** The KB lives in the `settings` table — a
`chatbot_config` row, exactly like `comment_rules` and `integrations`, editable from admin.

### 4.7 Files touched (planned)

| File | Change |
|---|---|
| [netlify/functions/utils/meta-service.js](netlify/functions/utils/meta-service.js) | Add `botReply(lead, ev, platform)` called from `handleWebhook`'s loop after `routeLeadFromReply`. Add `classifyInbound(text)` (cheap classifier) and `callAssistant(thread, kb, state)` (LLM call). Send via the existing per-platform sender. **`processIncomingMessage`, `routeLeadFromReply`, the extractors and the senders are unchanged.** |
| [netlify/functions/utils/meta-service.test.js](netlify/functions/utils/meta-service.test.js) | Assert `botReply` is a no-op when `bot_active=false` / outside window; assert classifier-first routing for medical keywords. (The LLM call itself is mocked — see [§7](#7-test-plan).) |
| [supabase/schema.sql](supabase/schema.sql) | Add `leads.bot_active bool default false`, `leads.bot_state jsonb`. Backfill is trivial (defaults cover existing rows). |
| [index.html](index.html) | New "Chatbot" settings card: enable toggle, KB editor (services + price ranges + FAQs + hours), guardrail copy, qualification-field checklist. A "Take over" button on each lead in the inbox. |
| [app.js](app.js) | `chatbotConfig` state + CRUD against `settings.chatbot_config` (mirrors `commentRules`); `takeOverLead(id)` sets `bot_active=false`. |
| [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) | New §15 subsection (chatbot), §21 (change log), §22 (roadmap: add item, note gating). Per the file's maintenance rule — **same commit**. |

**No** new Netlify function (the bot runs inside the existing webhook handler), **no** new
dependency beyond an LLM SDK or raw `fetch` (Node 18 `fetch` is already used), **no** new
messaging integration.

---

## 5. The code (planned)

Not yet written. Listed so the build is mechanical and the design is reviewable. The pure
parts (`classifyInbound`, the guardrail wiring, the no-op guards) are testable offline.

### 5.1 `meta-service.js` — the bot reply hook

```js
// One bot turn. Called from handleWebhook's event loop AFTER processIncomingMessage +
// routeLeadFromReply, so the inbound message is already stored and the lead already routed
// (if the customer named a branch). Sends through the SAME per-platform sender staff use, so
// the bot's replies land in the same thread. Returns early (no-op) when the bot is off for
// this lead or the send window has closed — both must never throw, or a bot glitch drops a
// real inbound message.
async function botReply(lead, ev, platform) {
  if (!lead?.bot_active) return;                       // staff owns it, or never opted in

  const db = createSupabaseClient();

  // 1. Cheap classifier FIRST. Medical/symptom/emergency → hand off, never answer.
  const cls = classifyInbound(ev.messageText);
  if (cls.handoff) {
    await handoffToStaff(lead, cls.reason, db, platform);
    return;
  }

  // 2. Build the prompt: KB + guardrails + qualification state + recent thread.
  const config = await getSettingJson('chatbot_config') || {};
  const thread = await db.recentMessages(lead.id, 10);   // last ~10 lead_messages
  const decision = await callAssistant({
    kb:        config.kb,
    guardrails: GUARDRAILS,
    state:     lead.bot_state || {},
    thread,
    inbound:   ev.messageText,
  });
  // decision = { reply?: string, handoff: bool, reason?: string, qualification?: {...} }

  // 3. Persist any qualification fields the model extracted.
  if (decision.qualification) {
    await db.updateLead(lead.id, { bot_state: { ...(lead.bot_state || {}), ...decision.qualification } });
  }

  // 4. Hand off or reply.
  if (decision.handoff) {
    await handoffToStaff(lead, decision.reason || 'qualified', db, platform, decision.reply);
    return;
  }
  if (decision.reply) {
    await sendByPlatform(platform, ev.senderId, decision.reply);   // existing sender
    await db.insertMessage({ lead_id: lead.id, direction: 'outgoing', message: decision.reply, is_seen: true });
  }
}
```

### 5.2 `meta-service.js` — the classifier (pure, testable)

```js
// Cheap, deterministic first pass. Catches the safety-critical case (medical/emergency)
// BEFORE any LLM cost or LLM answer. Keyword + light pattern matching — good enough as a
// safety net because a false "handoff" is cheap (staff answer) and a missed one is expensive
// (the bot answers a medical question). Returns { handoff: bool, reason: string }.
//
// ponytail: keyword net, not an LLM — a classifier model here adds latency + cost for a job a
// ~40-word net does better; upgrade to a model only if false negatives show up in review.
const EMERGENCY = ['emergency', 'bleeding', 'severe', 'swelling', 'reaction', 'urgent', 'suicid'];
const MEDICAL   = ['diagnos', 'symptom', 'medicine', 'medication', 'prescription', 'side effect',
                   'pregnant', 'pcos', 'thyroid', 'diabetes', 'infection', 'rash', 'allerg'];

function classifyInbound(text) {
  const t = (text || '').toLowerCase();
  if (EMERGENCY.some(k => t.includes(k))) return { handoff: true, reason: 'emergency' };
  if (MEDICAL.some(k => t.includes(k)))   return { handoff: true, reason: 'medical' };
  if (/(talk|speak) to (a )?(human|doctor|person|staff)/.test(t)) return { handoff: true, reason: 'requested' };
  return { handoff: false };
}
```

### 5.3 `meta-service.js` — the LLM call (structured output)

```js
// The constrained assistant. Gets the KB + hard guardrails + qualification state + the recent
// thread, returns a STRUCTURED decision — never prose for us to parse. The model is a
// small/fast one (Haiku/Flash-class); this is FAQ + light qualification, not hard reasoning.
// Raw fetch (Node 18) — no SDK dependency, matches the rest of meta-service.
const GUARDRAILS = [
  'Answer ONLY using the provided knowledge base.',
  'Never diagnose, prescribe, or give medical advice. If asked, hand off.',
  'Never quote a price not in the KB. Exact price is always "after consultation".',
  'Never guarantee results.',
  'End deflected answers with a soft cue to speak to the team — never a dead end.',
];

async function callAssistant({ kb, guardrails, state, thread, inbound }) {
  const res = await fetch(process.env.CHATBOT_LLM_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CHATBOT_LLM_KEY}` },
    body: JSON.stringify({
      // system: guardrails + KB + "you are qualifying this lead; still need: <missing fields>"
      // messages: the thread, then the inbound
      // response_format: { type: 'json_schema', … { reply, handoff, reason, qualification } }
    }),
  });
  if (!res.ok) throw new Error(`LLM call failed: ${res.status}`);
  return (await res.json()).decision;   // validated by the provider's structured-output mode
}
```

### 5.4 `meta-service.js` — handoff + per-platform send dispatch

```js
// Hand a lead off to staff: flip bot_active off, post a one-line summary to the timeline so
// staff see context instantly, and bump status to 'qualified'. The optional `reply` is a
// courtesy "let me connect you" message sent before the summary.
async function handoffToStaff(lead, reason, db, platform, reply) {
  if (reply) {
    await sendByPlatform(platform, lead.__senderId, reply);
    await db.insertMessage({ lead_id: lead.id, direction: 'outgoing', message: reply, is_seen: true });
  }
  const summary = `🤖 Handed off (${reason}) — ${summarizeState(lead.bot_state)}`;
  await db.insertMessage({ lead_id: lead.id, direction: 'outgoing', message: summary, is_seen: false });
  await db.updateLead(lead.id, { bot_active: false, status: 'qualified' });
}

// Send via whichever platform the lead came in on. The three senders already exist; this just
// picks one so botReply stays platform-agnostic.
function sendByPlatform(platform, recipientId, text) {
  return platform === 'whatsapp' ? sendWhatsAppMessage(recipientId, text)
       : platform === 'facebook' ? sendFacebookMessage(recipientId, text)
       :                           sendInstagramMessage(recipientId, text);
}
```

(`lead.__senderId` is threaded from the event — `leads` stores platform ids, but the column
differs per platform, so the caller passes the sender id explicitly rather than re-deriving it.)

---

## 6. Provider & dashboard setup

The bot needs **one** external thing the codebase does not already have: an LLM endpoint.

1. **Pick a provider + model** ([§11.1](#11-open-questions-for-the-client)). A small/fast model
   is sufficient — this is FAQ + light qualification, not frontier reasoning. Add two env vars:
   `CHATBOT_LLM_ENDPOINT` and `CHATBOT_LLM_KEY`.
2. **No new Meta permissions.** The bot replies through the existing senders within the
   existing 24h window, using tokens already configured. WhatsApp template messages
   (outside-24h) are deliberately out of scope ([§10](#10-deliberately-out-of-scope)).
3. **Meta bot policy compliance:**
   - Disclose the assistant on first contact ([§4.5](#45-guardrails--safety-non-negotiable-for-a-clinic)).
   - Honour the 24h window — the bot only ever replies to a recent inbound, so this is
     automatic, same as staff.
   - Provide a path to a human (the "talk to human" handoff) — required by Meta and by good
     sense.
4. **Knowledge base content review.** The initial KB (services, price ranges, FAQs, hours) and
   the guardrail wording need clinician sign-off before go-live. This is the long-lead item.

**Rollback:** set `chatbot_config.enabled = false` in settings (the same one-line-off property
as comment automation) — `botReply` returns early, no deploy. Per-lead, staff "take over" flips
`bot_active=false` instantly.

---

## 7. Test plan

Extend the existing framework-free test
([meta-service.test.js](netlify/functions/utils/meta-service.test.js), run with
`node netlify/functions/utils/meta-service.test.js`). The LLM call is **mocked** — `callAssistant`
is stubbed to return canned `{ reply, handoff, qualification }` decisions, so the surrounding
logic tests with no network and no API spend.

```js
// ── botReply is a no-op when it must be ──
assert.equal(await botReply({ bot_active: false }, { messageText: 'hi' }, 'instagram'), undefined,
  'bot must stay silent when bot_active=false (staff owns the lead)');

// ── classifier-first: medical/emergency never reaches the LLM ──
// (mock callAssistant to throw if called; if the test passes, it was never called)
const medical = classifyInbound('I have a rash and swelling, is this an allergic reaction?');
assert.equal(medical.handoff, true);
assert.equal(medical.reason, 'emergency');   // 'swelling' + 'reaction' → emergency

const diag = classifyInbound('do I have melasma?');
assert.equal(diag.handoff, true);
assert.equal(diag.reason, 'medical');

const fine = classifyInbound('what is the price of laser for upper lip?');
assert.equal(fine.handoff, false);

const human = classifyInbound('let me talk to a doctor please');
assert.equal(human.handoff, true);
assert.equal(human.reason, 'requested');

// ── handoff flips bot_active off and writes a summary ──
// (mock db + sender; assert updateLead called with { bot_active:false, status:'qualified' }
//  and that a summary message was inserted)
```

### Manual smoke test

Needs the KB populated and `chatbot_config.enabled = true`, on one platform. Key checks:

1. New lead DMs *"price of laser"* → bot replies with the KB range **and** asks the next
   qualification question. Timeline shows incoming + outgoing, `bot_active=true`.
2. Lead asks *"I have PCOS, is laser safe?"* → **no medical answer**; bot replies with a
   handoff cue, `bot_active` flips false, a summary line appears, `status='qualified'`.
3. Lead answers the qualification questions over a few turns → once "complete enough", bot
   hands off with a one-line summary; staff inbox shows the qualified lead.
4. Staff clicks **Take over** mid-conversation → bot goes silent, even if the lead keeps
   messaging; staff replies send normally (24h window is open).
5. Lead says *"talk to a human"* → immediate handoff, reason `requested`.
6. Outside the 24h window (simulate by not replying for 24h, then inbound) → bot still works,
   because it replies to a *fresh* inbound. (Bot-initiated messages outside the window are out
   of scope.)
7. WhatsApp-specific: confirm free-form bot replies deliver inside the 24h service window.

---

## 8. Gotchas

The ones that break silently or hurt a clinic specifically:

| # | Thing |
|---|---|
| 1 | **The bot is never the doctor.** The classifier is the safety net, but the KB must contain *zero* diagnostic content. If a price/FAQ reads like advice, a clinician must catch it in review. |
| 2 | **A bot glitch must never drop a real inbound.** `botReply` wraps every step in try/catch and returns early on any error — the message is already stored by `processIncomingMessage` before the bot runs. The bot is additive, not in the critical path. |
| 3 | **24h window is automatic but not magic.** The bot only replies to a recent inbound; it cannot *initiate* outside the window (WhatsApp would need a paid template — out of scope). |
| 4 | **Structured output, not prose parsing.** The model returns `{ reply, handoff, reason, qualification }` via the provider's JSON-schema mode. Parsing free text is the fragile path that breaks at 2am. |
| 5 | **Replay the thread, don't trust a state column.** The conversation is the state. If `bot_state` drifts, the LLM still reads the actual messages. `bot_state` is a convenience for the summary, not the source of truth. |
| 6 | **Price ranges only.** Stale or wrong exact prices are a trust and legal problem. Exact price is always "after consultation". The KB holds ranges, and they need a maintenance owner. |
| 7 | **Disclosure on the first bot message.** Meta policy and trust both require it. Don't let the LLM improvise it — bake it into the first-turn prompt. |
| 8 | **Take-over must be instant and sticky.** Once `bot_active=false`, the bot must stay silent even across new inbounds — re-enabling accidentally mid-crisis is the worst case. |
| 9 | **Latency.** A classifier + LLM round-trip adds 1–3s before the reply. Acceptable for async DMs, not for an emergency — which is why emergencies hand off *before* the LLM runs (and staff get an alert). |
| 10 | **LLM cost is per-turn, not per-lead.** A chatty lead that never qualifies can rack up calls. Cap the conversation length (e.g. hand off after N turns unqualified) — see [§10](#10-deliberately-out-of-scope). |
| 11 | **Echo guard already exists** — the webhook skips `is_echo` messages, so the bot never reads its own replies as inbound. Inherit it; do not re-solve. |
| 12 | **Per-lead `bot_active`, not per-message.** A single flag per lead; flipping it on handoff/takeover is the whole control surface. Don't build per-message enablement. |

---

## 9. Cost

- **LLM API:** paise to low-rupees per conversation on a small/fast model. The classifier pass
  is free (local keywords). Only the turns that reach the LLM cost anything. Negligible vs.
  staff time saved.
- **Meta:** ₹0 — the bot uses the existing free messaging endpoints inside the 24h window.
- **No platform/SaaS fee** — we build ([§2](#2-build-vs-buy)).
- **Schema:** two nullable/defaulted columns on `leads` — no migration cost.

Exact model pricing is a provider decision ([§11.1](#11-open-questions-for-the-client)) and is
not quoted here, to avoid stating stale numbers.

---

## 10. Deliberately out of scope

| Skipped | Add when |
|---|---|
| **Out-of-24h bot-initiated messages** (WhatsApp templates) | The clinic wants the bot to re-engage cold leads. Needs paid WA templates + an IG/FB "message tag". |
| **Booking / appointment scheduling inside the bot** | The bot should hand buying signals to staff to *close*; adding a calendar integration is a separate feature. |
| **Per-platform bot personalities / KBs** | One shared KB + guardrails covers it; split only if tone or offerings genuinely differ by platform. |
| **Bot-to-bot self-conversation guard** | Already inherited: `is_echo` skip + the `bot_active`/takeover flag. |
| **Conversation-length cap / "hand off after N turns"** | Add if chatty unqualified leads measurably run up cost. |
| **Multilingual KB** (Hindi/Hinglish) | The model handles Hinglish input decently; a translated KB is worth it only if quality on regional-language answers matters. |
| **Analytics on bot deflection / qualification rate** | Worth adding once there's traffic to measure — tells us the ROI this spec claims. |

---

## 11. Open questions for the client

1. **Which provider + model?** A small/fast model is enough (Claude Haiku-class, Gemini
   Flash-class, or an OpenAI mini). The architecture doesn't care; the choice is about price,
   latency, and structured-output reliability. Recommend starting with one and keeping the call
   behind a single function so it's swappable.
2. **What are the "core" qualification fields** that mark a lead "complete enough" to hand off?
   Branch we already capture. Likely: **treatment interest**, **timeline/urgency**, **booking
   intent** (consultation vs. walk-in). Possibly prior-treatment history, budget range. This
   defines the bot's mission.
3. **Which platform first?** WhatsApp is often the highest clinical volume in India, but it has
   the paid-template constraint outside 24h. IG/FB are free within the window. Recommend
   starting on the platform with the most *repetitive* inbound.
4. **How conservative on medical?** Recommend **very** — the bot touches nothing
   symptom-shaped. Confirm the classifier keyword net and the guardrail wording with the clinic.
5. **Knowledge base source.** Is there an existing services / price / FAQ list, or do we draft
   it from scratch in admin? **Who maintains it** (especially prices) going forward?
6. **Disclosure tone.** Transparent ("I'm a virtual assistant") vs. a softer "conversational
   assistant" framing? Recommend transparent — it's required and it sets expectations.
7. **Handoff SLA.** When the bot says "connecting you with our team", staff need to respond
   reasonably fast or trust erodes. What's the expected response time, and is there a fallback
   alert (e.g. the emergency path pings a staff channel)?

### What this closes

Repetitive FAQ inbound stops consuming staff time, and leads arrive **pre-qualified** instead
of as *"hi"*. It does **not** close [roadmap item 1](PROJECT_DOCUMENTATION.md#22-roadmap--open-items)
(multi-branch routing for WhatsApp) — the bot *asks* the branch question naturally (reusing
`routeLeadFromReply`), which helps, but a customer who never answers still needs manual
assignment. The bot is a layer on top of the inbox, not a replacement for it.

---

## 12. Implementation order — gated, start at Phase 0

This is the build order. **Do not start until Phase 0 is satisfied** — the bot amplifies
whatever state the inbox is in, good or bad.

### Phase 0 — PREREQUISITE: inbox and routing must be stable

- [ ] **0a.** The **unified realtime inbox** is stable in production (it shipped 2026-08-03;
      verify before building on it). A bot into a flaky inbox is worse than no bot.
- [ ] **0b.** **Lead routing is settled enough** that the bot has a deterministic place to hand
      off to. If `META_BRANCH_ID` still masquerades unrouted leads as a real branch's own
      ([roadmap item 1 / §22](PROJECT_DOCUMENTATION.md#22-roadmap--open-items)), fix that
      first — the bot's summaries and handoffs assume routed leads mean something.
- [ ] **0c.** **Client decisions** ([§11](#11-open-questions-for-the-client)) are made:
      platform, model, qualification fields, KB source, guardrail conservatism.

### Phase 1 — knowledge base + guardrails (long lead; start early)

- [ ] **1.** Draft the KB (services, price **ranges**, FAQs, hours, branches) and the guardrail
      wording. **Get clinician sign-off.** This is the slowest, most safety-critical step.
- [ ] **2.** Add the `chatbot_config` settings row and the admin card to edit it (mirrors the
      `comment_rules` card).

### Phase 2 — schema + pure logic, no network

- [ ] **3.** Add `leads.bot_active` (bool, default false) and `leads.bot_state` (jsonb). Backfill
      is free (defaults cover existing rows).
- [ ] **4.** Add `classifyInbound()` and the no-op guards in `botReply()`. Paste the [§7](#7-test-plan)
      assertions. *Verify:* `node netlify/functions/utils/meta-service.test.js` passes — the
      classifier routes medical/emergency to handoff and leaves FAQs alone, and `botReply` is a
      no-op when `bot_active=false`.

### Phase 3 — the LLM call (mocked-first)

- [ ] **5.** Add `callAssistant()` behind the provider's structured-output mode, with the LLM
      call **mocked** in tests. Wire `botReply` end-to-end against canned decisions. *Verify:*
      tests still green with no network.

### Phase 4 — live on one platform

- [ ] **6.** Pick the platform from [§11.3](#11-open-questions-for-the-client), set the env vars,
      enable `chatbot_config`. Work through the [manual smoke test](#manual-smoke-test). Step 2
      (a medical question gets NO medical answer and hands off) is the one that matters.
- [ ] **7.** Add the staff **Take over** button in the inbox; confirm it silences the bot
      stickily.

### Phase 5 — the other platforms + docs

- [ ] **8.** Roll to the remaining platforms — the brain is platform-agnostic (`sendByPlatform`
      already dispatches). Only re-test the platform-specific window behaviour.
- [ ] **9.** Update [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) **in the same commit** —
      §15 (chatbot subsection), §21 (change log), §22 (roadmap: add the item, note gating on
      Phase 0 + client decisions). Per the file's maintenance rule.

### Things not to rediscover the hard way

The four that break silently or hurt a clinic, in the order they'll bite:

1. The bot answers a medical question because the classifier missed it → **under-classify, never
   over-classify**; a false handoff is cheap, a false medical answer is a liability.
2. A bot error drops a real inbound → the bot runs **after** the message is stored and every step
   is try/catch; it is additive, never in the critical path.
3. The bot keeps replying after staff took over → `bot_active=false` is sticky; take-over is
   instant and never auto-reverts.
4. Parsing model prose instead of structured output → use the provider's JSON-schema mode;
   free-text parsing is the 2am bug.
