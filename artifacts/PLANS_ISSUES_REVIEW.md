# Plans Review — Issues in Chatbot & Website→WhatsApp Specs

> **Status: REVIEW — issues found, nothing built.** *(2026-08-04)*
>
> A critical read of the two research plans — [CHATBOT_AUTOMATION.md](CHATBOT_AUTOMATION.md)
> and [WEBSITE_BOOKING_WHATSAPP.md](WEBSITE_BOOKING_WHATSAPP.md) — surfacing problems they
> miss, get wrong, or inherit from current code. Every claim below was checked against source
> on 2026-08-04 (HEAD `bcc572d`).
>
> **Severity legend:** 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low/Good · **gap** = plan is silent
> or wrong · **verified** = checked against code · **known** = the doc already flags it.
>
> Companion to [CHATBOT_AUTOMATION.md](CHATBOT_AUTOMATION.md), [WEBSITE_BOOKING_WHATSAPP.md](WEBSITE_BOOKING_WHATSAPP.md),
> and [PROJECT_DOCUMENTATION.md §22](PROJECT_DOCUMENTATION.md#22-roadmap--open-items).

---

## TL;DR — fix these two first

1. **A1** — the chatbot literally cannot start as designed (`bot_active` is never set true).
2. **B1** — a *live* misrouting bug today: every unrouted IG/FB/WA lead is silently filed into one real branch's inbox, independent of either plan.

Everything else is build-time hardening.

---

## A. `CHATBOT_AUTOMATION.md`

### A1 — 🔴 CRITICAL (gap, verified): no on-ramp to `bot_active=true`
The whole feature starts with `if (!lead?.bot_active) return;` (planned §5.1). But
`processIncomingMessage` ([meta-service.js:194](../netlify/functions/utils/meta-service.js#L194))
creates every lead with the column default, and §4.6 specifies that default as `false`. **Nothing
in either doc ever sets it `true`.** As designed, the bot is dead code for 100% of leads. Needs a
creation-time rule (`bot_active = chatbot_config.enabled && new lead`) or a tri-state check.

### A2 — 🔴 CRITICAL (gap, verified): the plan claims a safety property its own code omits
§8 gotcha #2 says *"botReply wraps every step in try/catch."* The §5.1 code has **zero** try/catch.
Protection actually lives one level up — the webhook loop already wraps `processIncomingMessage` +
`routeLeadFromReply` at [meta-service.js:470-479](../netlify/functions/utils/meta-service.js#L470-L479).
Safe **only if** the implementer drops the `botReply()` call *inside that existing try block*. The
plan doesn't say to; its sample reads as a bare call. Easy fix — the doc actively misleads.

### A3 — 🟠 HIGH (gap, verified): synchronous LLM in the webhook → timeout → Meta retry → duplicate messages
`botReply` runs in `handleWebhook`'s per-event loop ([meta-service.js:454](../netlify/functions/utils/meta-service.js#L454)),
1–3s per event. [netlify.toml](../netlify.toml) sets **no** function timeout (platform default). A
multi-event batch or slow LLM can blow the timeout; Meta retries; `insertMessage` has **no idempotency
key** → duplicate timeline rows. The repo *just* fixed a duplicate-message bug (`dddb8ce`) — the bot
reopens that wound. §8 #9 calls latency "acceptable" without connecting it to retry-driven duplication.

### A4 — 🟠 HIGH (gap, safety): the safety classifier is English-only in a Hindi/Hinglish clinic
`classifyInbound`'s keyword net (planned §5.2) is English: `symptom, infection, rash, pregnant, allerg…`.
Real inbound is heavily Hinglish — *"khujli ho rahi hai"*, *"dawai leni chahiye?"*, *"periods late
hain"*, *"ilaaj"*. Those score `handoff:false`, reach the LLM, may get a medical answer. The doc
defers a multilingual **KB** to later (§10) but never notices the **classifier itself** — the
non-negotiable safety net — is the English-only hole. A false negative here is a liability. §12's
own rule ("under-classify, never over-classify") is violated by a language the net can't see.

### A5 — 🟡 MEDIUM (gap): `callAssistant` is a placeholder dressed as code
§5.3's fetch body is `// system: …` comments — the prompt assembly and the JSON schema for
`{reply,handoff,reason,qualification}` are unwritten. If a provider returns a missing/empty `reply`,
the code does `if (decision.reply)` and **silently sends nothing** — lead gets neither answer nor
handoff, no error surfaced. Needs an explicit validate-or-handoff-on-malformed step.

### A6 — 🟡 MEDIUM (gap): bot vs staff race before any takeover
Realtime inbox means staff see inbound instantly; the bot fires 1–3s later. Both can reply into the
same thread. `bot_active` only flips on *explicit* "Take over" (§4.4) — no "staff replied →
auto-silence bot." Given the fresh duplicate-message work, this is live territory. The doc handles
"bot keeps talking *after* takeover," not "both reply *before*."

### A7 — 🟢 LOW (gap, verified): the 24h-window guard doesn't exist
§4.2 lists *"outside 24h window? → stop"*, but no window check is implemented (24h appears only in
code *comments*: [meta-service.js:496](../netlify/functions/utils/meta-service.js#L496), 525, 557) and
§5.1 omits it. Practically harmless (bot replies to fresh inbound → window open), but the plan lists a
guard that isn't there.

### A8 — 🟢 LOW (gap): `lead.__senderId` is a fragile dunder-field shim
§5.4 admits platform-id columns differ per platform and smuggles the sender id through
`lead.__senderId`. A lead-object refactor silently breaks sends. The webhook loop already has
`ev.senderId` in scope — pass it as an explicit `botReply` arg.

---

## B. `WEBSITE_BOOKING_WHATSAPP.md`

### B1 — 🟠 HIGH (current defect, verified): `META_BRANCH_ID` misfiling is a bug *today*, not just a website prereq
[processIncomingMessage L195-196](../netlify/functions/utils/meta-service.js#L195-L196): **every**
unrouted lead is stamped with `META_BRANCH_ID` (a real branch). Right now, every IG/FB/WA lead that
doesn't name a branch is silently filed into one real branch's inbox — invisible misrouting across
all three platforms. The doc wants an "Unassigned" branch + repoint (§9.2) but frames it as a
*website-feature* prerequisite. It's an existing production defect — fix it regardless.

### B2 — 🟠 HIGH (known, sharpen): the number-migration gate has no timeout
Meta Business Verification = 2–10 biz days, and the number must first leave any BSP (§6). If it
stalls, the button ships into a void. Acknowledged in §12 — but the plan has no "if migration drags
past N weeks, revisit" decision point. A hard blocker with no backstop.

### B3 — 🟡 MEDIUM (verified): `matchBranch` matches substring-anywhere, not intent
[matchBranch L816-820](../netlify/functions/utils/meta-service.js#L816-L820): `t.includes(name.split(' ')[0])`.
Fine for the website's controlled pre-filled message; riskier for the free-text walk-in/saved-number
leads it also governs — *"do you have a Dwarka branch?"* routes to Dwarka. Multi-hit safely returns
`null`, but any future branch whose first word collides (e.g. a second "Kirti …") silently returns
`null` → Unassigned. Routing correctness depends on website labels never drifting from branch
first-words; no validation/mapping table.

### B4 — 🟡 MEDIUM (gap): the message-format "contract" is untestable from this repo
The website is a separate project (§2). If that team tweaks the wording and drops the branch token,
routing breaks silently — leads pile into "Unassigned" and nobody notices until staff complain. §8 is
a *doc*, not an enforced interface. No alerting on an Unassigned spike is planned. Add a cheap monitor
(Unassigned count threshold) the day this ships.

### B5 — 🟢 GOOD (verified correct): dedupe + name-source claims are true
For accuracy: [findLeadByPlatformId L203](../netlify/functions/utils/meta-service.js#L203) dedupes on
`whatsapp_user_id`, and `customer_name` comes from WA `profile.name`
([L212/L220](../netlify/functions/utils/meta-service.js#L212)), not the typed name. Gotchas #4 and #8
are accurate — not problems.

---

## C. Cross-cutting (both plans)

### C1 — 🟠 HIGH (gap): the two features collide and neither plans for it
When the chatbot ships after the website button, the bot receives the website's pre-filled message
(*"…consultation for Laser at Janakpuri…"*) as inbound #1. But its `bot_state` starts **empty** —
nothing tells it the lead is already pre-qualified. Website §10 #9 hand-waves *"treat as a strong
buying signal, hand off fast"*; the chatbot doc has **no mechanism** to detect it. The bot will
re-ask branch + service + timeline to a lead who just typed them — annoying, and it burns LLM turns
(§8 #10). Needs a shared marker the bot reads, or a `matchBranch`-style pre-parse inside `botReply`.

### C2 — 🟡 MEDIUM (known): both rest on a one-day-old inbox
Realtime inbox shipped 2026-08-03 — one day before the plans. Both correctly gate on "inbox stable" /
routing settled (chatbot Phase 0; website §6). The risk is treating that gate as a formality. The
duplicate-message commit (`dddb8ce`) is evidence the inbox layer is still settling; the bot "amplifies
whatever state the inbox is in" (chatbot §12). Don't waive the Phase-0 check.

### C3 — 🟢 LOW (gap): no measurement ships with either feature
Website §11 defers parsing `service` into `leads.service`; chatbot §10 defers deflection/qualification
analytics. Once both ship, the core ROI claims — staff time saved, pre-qualified leads, bookings
captured — are **unmeasurable**. Build the counter in with the feature, not after.

---

## Summary table

| ID | Sev | Doc | One line |
|---|---|---|---|
| A1 | 🔴 | Chatbot | `bot_active` is never set true → bot can't start |
| A2 | 🔴 | Chatbot | Plan claims try/catch safety the sample code omits |
| A3 | 🟠 | Chatbot | Sync LLM in webhook → timeout → retry → dup messages |
| A4 | 🟠 | Chatbot | English-only safety classifier in a Hinglish clinic |
| A5 | 🟡 | Chatbot | `callAssistant` body/schema unwritten; silent no-op on bad output |
| A6 | 🟡 | Chatbot | Bot vs staff reply race before takeover |
| A7 | 🟢 | Chatbot | 24h-window guard listed but not implemented |
| A8 | 🟢 | Chatbot | `lead.__senderId` dunder-field shim is fragile |
| B1 | 🟠 | Website | `META_BRANCH_ID` misfiles unrouted leads today (all platforms) |
| B2 | 🟠 | Website | Number-migration gate has no timeout/backstop |
| B3 | 🟡 | Website | `matchBranch` substring match → false routing / collision |
| B4 | 🟡 | Website | Message-format contract untestable; no Unassigned-spike alert |
| B5 | 🟢 | Website | Dedupe + name-source claims verified correct |
| C1 | 🟠 | Both | Bot re-qualifies website pre-filled leads — no handoff marker |
| C2 | 🟡 | Both | Both rest on a one-day-old, still-settling inbox |
| C3 | 🟢 | Both | No analytics ship with either feature |

---

*Review session 2026-08-04. Nothing built. Findings verified against `main` HEAD `bcc572d`.*
