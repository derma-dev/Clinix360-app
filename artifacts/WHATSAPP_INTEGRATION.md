# WhatsApp Integration — Tracking Doc

**Goal:** Receive incoming WhatsApp messages into the dashboard Inbox, same as the
existing Facebook Page + Instagram DM integration.

**Session type:** Reporting / QA. No code changes yet — this doc tracks decisions and status.

Last updated: 2026-07-17

---

## TL;DR — where we are

The dashboard already has a **shared Meta webhook + service** that handles Facebook
Messenger and Instagram DMs. WhatsApp (Cloud API) is a Meta product too and rides the
**same webhook shape**, so this is a "third branch," not a new system.

**The frontend is already WhatsApp-ready** — nothing to build there:
- `whatsapp → WA` label already mapped ([app.js:291](app.js#L291), [app.js:361](app.js#L361))
- `.whatsapp` green (#25d366) styles already exist ([styles.css:1852](styles.css#L1852), [styles.css:1996](styles.css#L1996), [styles.css:2066](styles.css#L2066))
- `leads.source` enum already lists `WhatsApp` ([SUPABASE_SCHEMA.sql:146](SUPABASE_SCHEMA.sql#L146))

So the work is **backend routing + Meta-side setup**, not UI.

---

## How the existing integration works (reference)

| Concern | Where | Notes |
|---|---|---|
| Webhook URL | `netlify.toml:4-9` → `/webhook/meta` | One endpoint for FB **and** IG |
| Handler | [netlify/functions/meta-webhook.js](netlify/functions/meta-webhook.js) | GET = verify, POST = events |
| Verify handshake | `verifyWebhook()` [meta-service.js:206-229](netlify/functions/utils/meta-service.js#L206) | Uses `META_VERIFY_TOKEN`, returns `hub.challenge` |
| Event routing | `handleWebhook()` [meta-service.js:237-304](netlify/functions/utils/meta-service.js#L237) | Maps `payload.object` → platform |
| Store message | `processIncomingMessage()` [meta-service.js:160-202](netlify/functions/utils/meta-service.js#L160) | Find-or-create lead, insert into `lead_messages` |
| Outbound reply | [meta-send.js](netlify/functions/meta-send.js) + `sendXMessage()` | Switch on `lead.source` |
| Inbox UI | `index.html:208-254`, `app.js:183-439` | Already renders WA leads |

**Data model:** `leads` (one row per contact, `source` = platform, platform id column
like `facebook_user_id`/`instagram_user_id`) + `lead_messages` (timeline;
`direction` = `incoming`/`outgoing`, `message`, `is_seen`, `seen_at`).

> ⚠️ **Known discrepancy:** the committed `SUPABASE_SCHEMA.sql` for `lead_messages` is
> STALE — it lists `direction ('in'/'out')` + `body`, but the live DB and code use
> `message` / `is_seen` / `seen_at` and `incoming`/`outgoing`. Trust the code.

---

## Roadmap

- [ ] **Step 1 — Meta-side prerequisites & credentials** ← *we are here*
- [ ] Step 2 — DB: add `whatsapp_user_id` column + index on `leads`
- [ ] Step 3 — Inbound routing: add `whatsapp_business_account` branch + WA payload extractor
- [ ] Step 4 — Webhook config: subscribe the `messages` field, point callback at `/webhook/meta`
- [ ] Step 5 — End-to-end test: send a real WhatsApp msg → verify it lands in the Inbox
- [ ] **Step 6 — Outbound replies: `sendWhatsAppMessage()` + `source==='whatsapp'` branch** ← *now IN SCOPE (client 2026-07-17)*
- [ ] Step 7 (optional, cross-cutting) — Add `X-Hub-Signature-256` verification (missing for ALL platforms today)

**Scope (client, 2026-07-17): receive + send. Nothing else.** No templates, no campaigns, no
broadcasts. Both directions are **₹0** on direct Cloud API (service window — see below).

---

## Provider decision — Meta Cloud API DIRECT (no BSP) ✅

**Client asked:** which WhatsApp API provider is cheapest/best — he has an AiSensy account.
**Answer: use no provider.** Go direct to Meta's Cloud API. Costs ₹0 for our scope and is a
*smaller* diff than AiSensy.

### Cost (researched 2026-07-17)
Meta made **service conversations free & unlimited** on 2024-11-01, and moved to
**per-template pricing** on 2025-07-01. A service conversation = customer messages us, we
reply free-form within 24h. **That is exactly our scope** (Steps 1–5 inbound, and Step 6
in-window replies). Templates are the only billable thing, and we send none.

| Route | Platform fee | Our traffic | Integration |
|---|---|---|---|
| **Cloud API direct** ⭐ | ₹0 | ₹0 (service free) | reuses `/webhook/meta` |
| AiSensy Basic | ₹1,500/mo (₹18k/yr) | ₹0 (service free) | new proprietary webhook |

Meta India template rates (2026-01-01): marketing **₹0.8631**, utility/auth **₹0.115** (+18% GST).
AiSensy charges **₹1.09** / **₹0.145** for the same → **~26% markup**, despite third-party
blogs claiming "no markup". Irrelevant today (no templates), decisive if broadcasts ever land.

### Why AiSensy is technically worse here, not just pricier
A WABA binds to **one BSP at a time**. On AiSensy, **AiSensy owns the Meta webhook
subscription** — we cannot point Meta at `/webhook/meta`. Consequences:
- The planned `whatsapp_business_account → whatsapp` branch in `handleWebhook()` dies; WA
  needs a *separate* endpoint + AiSensy's payload shape → a 2nd integration to maintain,
  not a 3rd branch of one.
- `META_VERIFY_TOKEN` / `META_APP_SECRET` / `META_BRANCH_ID` reuse (Step 1 decision) is lost.
- Step 7 signature verification diverges from FB/IG.
- We'd pay ₹18k/yr for an agent inbox + campaign UI — **we already built the inbox.**

### Sending is also ₹0 — and the 24h window is NOT a new problem
Client confirmed scope = receive **+ send** (2026-07-17). Replying **inside the 24h service
window** is free-form and **free**. Outside it, WhatsApp requires a paid template (₹0.115
utility) — but we don't send templates, so a late reply simply **fails**, exactly like
FB/IG do today ([meta-send.js:52](netlify/functions/meta-send.js#L52) already comments this,
and the 502 surfaces it). **Same constraint, same handling, no new work** — WhatsApp is not
special here. Revisit only if "staff replied next day and it bounced" becomes a real
complaint; the fix then is a utility template, ~₹0.115/msg.

### What would flip this
Only if non-technical staff need to send appointment-reminder templates or marketing
broadcasts themselves → then a BSP's template/campaign UI is worth ₹1,500/mo. Explicitly
**out of scope** per client. **Not a one-way door**: the number can migrate to a BSP later
without touching the receive path.

### Action for client
- **Do NOT hand over the AiSensy account.** If his number is already live on AiSensy, it must
  be **migrated off** (disconnect from their WABA) before direct Cloud API can bind it.
- Instead: add the **WhatsApp product** to the *existing* FB/IG Meta app, then hand over
  `WHATSAPP_PHONE_NUMBER_ID` + a **System User permanent** `WHATSAPP_ACCESS_TOKEN`.
- Dev is unblocked meanwhile — we start on Meta's free test number.

---

## STEP 1 — Meta-side prerequisites & credentials

**Why first:** WhatsApp Cloud API needs a WhatsApp Business Account (WABA) + a phone
number + tokens before any code can receive a message. This step is mostly done in the
Meta dashboard, not in code, and it produces the credentials the code will need.

### 1a. Accounts / assets to have in place (in Meta)
- A **Meta Business** account (likely already exists — used for FB Page + IG).
- A **WhatsApp Business Account (WABA)** — created under the same Meta app used for FB/IG,
  or a new app. Ideally the **same app** so it reuses `META_VERIFY_TOKEN` / `META_APP_SECRET`.
- A **phone number** registered to the WABA (test number provided by Meta, or a real
  number). Note: a number already on the WhatsApp consumer/Business app must be migrated.
- Add the **WhatsApp** product to the Meta app.

### 1b. Credentials to collect (these become env vars)
| Meta value | Env var (planned) | Reuse existing? |
|---|---|---|
| Phone Number ID | `WHATSAPP_PHONE_NUMBER_ID` | new |
| WABA ID | `WHATSAPP_BUSINESS_ACCOUNT_ID` | new (only needed for some API calls) |
| Access token (System User, long-lived) | `WHATSAPP_ACCESS_TOKEN` | new |
| Webhook verify token | — | **reuse `META_VERIFY_TOKEN`** |
| App secret (for signature check) | — | **reuse `META_APP_SECRET`** |
| Branch UUID new WA leads attach to | — | **reuse `META_BRANCH_ID`** |

> Use a **System User permanent token** (not the 24h temporary token from the dashboard),
> or the integration breaks after a day.

### 1c. Info we need from YOU to proceed — ANSWERED
1. Same Meta app as FB/IG? → ✅ **Same app** (reuse `META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_BRANCH_ID`).
2. WABA + phone number already exist? → 🟡 **Pending client** — asking client whether they provide it or we create it.
3. Test number or real number? → ✅ **Test number first**, swap to real number after receive is proven (no code change to swap).
4. Receive-only or also send? → ✅ **Receive-only now.** Sending replies (Step 6) is a later phase.

### Step 1 status: 🟢 Mostly resolved. Two things outstanding:
- **Client confirmation** on who owns/creates the WABA + real number (#2). Does NOT block dev — we start on the test number.
- Once the WhatsApp product is added to the app, collect `WHATSAPP_PHONE_NUMBER_ID` + a
  **permanent** `WHATSAPP_ACCESS_TOKEN` (System User token) from the test setup.

---

## Multi-branch routing (single number) — DESIGN OPEN

**Constraint:** client wants ONE WhatsApp number for all branches (3 today, more later).
Current FB/IG code hardcodes a single branch (`META_BRANCH_ID`) — it does NOT solve
multi-branch. This is a new concern WhatsApp forces us to design.

**Hard limit — client's "detect location → nearest branch" is NOT feasible as described:**
WhatsApp inbound webhook has **no location field**. It gives `metadata.phone_number_id`
(OUR number — same for every branch, so it can't disambiguate branch), the customer's
phone number (`wa_id`/`from`), name, and text. Phone number ≠ location (portability,
same-metro numbers, travelers). Live location only arrives if the customer *actively*
taps "share location" — won't happen on first contact.

**Options (ranked):**
| Opt | Approach | Works receive-only? | Accuracy |
|---|---|---|---|
| A ⭐ | Per-branch entry points — distinct `wa.me` deep link / QR per branch with a hidden branch tag; parse first message to route | ✅ yes | high (if started from branch touchpoint) |
| B | Manual assignment — shared "Unassigned" inbox, staff pick branch, sticks after | ✅ yes | 100% |
| C | Interactive branch-picker auto-reply ("1=X, 2=Y…") | ❌ needs outbound (Step 6) | 100% |
| D | Ask customer to share location/pincode, geocode nearest (client's idea, feasible-ified) | ❌ needs outbound + opt-in | medium |
| E | One number per branch → webhook `phone_number_id` → branch | ✅ yes | 100% (cleanest, but breaks single-number rule) |
| — | Phone-prefix guessing | ✅ | ⚠️ unreliable, useless same-metro |

**Recommendation:** short term (receive-only) **A + B** (auto-route via entry point,
manual fallback for cold messages); long term add **C** once outbound lands. Put **E**
to the client as the cleanest option if single-number is negotiable. "Nearest" is likely
the wrong key for a clinic anyway — patients want *their* branch, not the closest.

**Branch geography — ANSWERED:** all 3 branches are in the **same city** (more may come).
Implication: "nearest branch" is meaningless — no geographic signal in the phone number,
branches minutes apart, and patients want *their* branch (records/doctor), not the closest.
So routing must be **intent-based** (A/B/C), never location-based.

**Still need from client:** how do customers usually first make contact — per-branch
Google Maps listing / QR at reception / website (→ A auto-routes) vs cold-dialing a saved
number (→ falls to B manual)? This sets the auto-vs-manual split, not the design itself.

## Open questions / decisions log

| # | Question | Decision | Date |
|---|---|---|---|
| 1 | Same Meta app as FB/IG, or separate? | **Same app** — reuse verify token, app secret, branch id | 2026-07-10 |
| 2 | WABA + number already exist? | **Pending client** — client to confirm provide-vs-create. Dev not blocked (test number first) | 2026-07-10 |
| 3 | Test number or real number? | **Test number first**, swap to real after receive proven | 2026-07-10 |
| 4 | Receive-only or also send replies? | ~~Receive-only now~~ → **SUPERSEDED**: receive **+ send**, both in scope. Nothing beyond those two | 2026-07-17 |
| 5 | Add signature verification now or later? | _TBD_ | |
| 6 | Multi-branch routing on a single number | Auto-location NOT feasible (WhatsApp sends no location). Branches confirmed **same-city** → "nearest" is meaningless, must be intent-based. Proposed: A (per-branch entry points) + B (manual fallback) now, C (menu) later. Still awaiting client answer on how customers initiate contact | 2026-07-10 |
| 7 | Which API provider — AiSensy vs alternatives? | **None — Meta Cloud API direct.** Service convos free since 2024-11-01 → our receive-only scope costs **₹0**. AiSensy = ₹18k/yr + ~26% template markup + a *second* webhook integration (BSP owns the Meta webhook, killing our `/webhook/meta` reuse). Revisit only if staff need a self-serve campaign/template UI | 2026-07-17 |

---

## Notes for later steps (not needed to start)

- **Reuse the same endpoint.** `/webhook/meta` already dispatches by `payload.object`, so
  WhatsApp can POST to the same URL — `handleWebhook()` just needs a
  `whatsapp_business_account → whatsapp` case. Smaller diff than a new function.
- **WA payload shape differs.** WhatsApp uses `entry[].changes[].field='messages'` (like
  Meta's Test button) but the `value` is `{ messages:[{from, text:{body}, ...}], contacts:[{profile:{name}}] }` —
  NOT `value.sender`/`value.message`. Needs a WhatsApp-specific extractor in the
  `changes[]` loop ([meta-service.js:266-275](netlify/functions/utils/meta-service.js#L266)).
- **Signature verification is absent for all platforms today.** `META_APP_SECRET` is
  loaded but never used to HMAC-check the POST body. Worth adding for WhatsApp (and
  retrofitting FB/IG) as a hardening step.

### Step 6 (send) — the exact 3 spots, all in existing files
1. **`idColumnFor()` is a 2-way ternary** ([meta-service.js:34-35](netlify/functions/utils/meta-service.js#L34)) —
   `platform === 'facebook' ? 'facebook_user_id' : 'instagram_user_id'`. A `whatsapp` lead
   would **silently write to `instagram_user_id`**. Make it a map/3-way — this is the root
   cause spot, it feeds BOTH `findLeadByPlatformId()` and `processIncomingMessage()`, so
   fixing it here fixes inbound *and* outbound at once.
2. **`getLeadById()` select list** ([meta-service.js:84](netlify/functions/utils/meta-service.js#L84)) —
   add `whatsapp_user_id`, else `meta-send` can't resolve the recipient.
3. **`sendWhatsAppMessage()` + a `source === 'whatsapp'` branch** ([meta-send.js:53-65](netlify/functions/meta-send.js#L53)) —
   POST `graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages` with
   `{messaging_product:'whatsapp', to, type:'text', text:{body}}`. Mirrors the existing
   two senders. Note WA takes the **phone number id in the path** (not `me`) and the
   recipient is a `wa_id`, not a PSID/IGSID.

`meta-send.js`'s error path, persistence, and validation all already work — the WA branch
inherits them. No frontend change (WA already renders).
