# Website Booking → WhatsApp Redirect — Research & Spec

> **Status: RESEARCH — not started, and gated.** *(written 2026-08-03)*
>
> This is a **plan only**. No code is written. It is gated on **one hard dependency** (the
> WhatsApp number migration, [§6](#6-the-make-or-break-dependency--the-number-migration)) and
> **three open client decisions** ([§7](#7-decisions-still-open)). Do not build until those are
> settled — building the website button without the number migration produces a button that opens
> a WhatsApp which the dashboard never sees.
>
> **Important framing:** the website change itself is **a different project** from this repo —
> `dermaskinandhairsolutions.com/contact` is a hand-built static page, not this dashboard. **This
> repo's role is the *receiving* side:** the WhatsApp number the button points at, the webhook that
> ingests the message, and the routing that puts the lead in the right branch inbox. That receiving
> side **already exists and already works** for routing; the only real work here is the number
> migration + a one-line "Unassigned" branch. The website build is small and lives elsewhere.
>
> Companion to [PROJECT_DOCUMENTATION.md §15](PROJECT_DOCUMENTATION.md#15-messaging-integrations-instagram--facebook--whatsapp)
> and [§22 roadmap item 1](PROJECT_DOCUMENTATION.md#22-roadmap--open-items) (WhatsApp multi-branch
> routing). Written: **2026-08-03** · Planned against current `main` (HEAD `bcc572d`). Code claims
> verified against source by an exploration pass on the same date.
>
> **One-line summary:** change the website's booking widget so the final "Continue" opens WhatsApp
> with a pre-filled message naming the service + branch, instead of showing a thank-you. Because the
> message contains the **branch name**, the dashboard's existing `matchBranch` router auto-files the
> lead in the correct branch inbox — which is **exactly roadmap item #1, Option A** ("per-branch
> `wa.me` deep links with a hidden branch tag"). One feature, two wins.

---

## Table of contents

1. [The ask](#1-the-ask)
2. [Current state — website](#2-current-state--website)
3. [Current state — dashboard (the receiving side)](#3-current-state--dashboard-the-receiving-side)
4. [The key insight — this is roadmap item #1, Option A](#4-the-key-insight--this-is-roadmap-item-1-option-a)
5. [The end-to-end flow (once the number is migrated)](#5-the-end-to-end-flow-once-the-number-is-migrated)
6. [The make-or-break dependency — the number migration](#6-the-make-or-break-dependency--the-number-migration)
7. [Decisions still open](#7-decisions-still-open)
8. [The message format — the contract between site and dashboard](#8-the-message-format--the-contract-between-site-and-dashboard)
9. [What changes, and where](#9-what-changes-and-where)
10. [Gotchas & edge cases](#10-gotchas--edge-cases)
11. [Deliberately out of scope](#11-deliberately-out-of-scope)
12. [What I think (recommendation)](#12-what-i-think-recommendation)
13. [Next steps — gated order](#13-next-steps--gated-order)

---

## 1. The ask

On the clinic's website, [https://dermaskinandhairsolutions.com/contact#book](https://dermaskinandhairsolutions.com/contact#book),
a visitor books a consultation in a short wizard. Today the wizard ends on a "Thank you" message
and the lead data **goes nowhere** (the page is static — no persistence, see [§2](#2-current-state--website)).

The client wants:

1. A **branch dropdown** alongside the name + phone fields.
2. The **"Continue" button to redirect to WhatsApp**, opening the clinic's WhatsApp account with a
   **pre-written message** for the selected **service + branch**, so the visitor just hits **Send**.

The client also noted: *"this is not this project, but our WhatsApp may play a role after the user
sends a message."* That is correct and is the crux of this spec — see [§4](#4-the-key-insight--this-is-roadmap-item-1-option-a).

---

## 2. Current state — website

The contact page is **not** WordPress/Elementor (the homepage is). It is a **hand-built static page**
— separate stylesheet `styles.css`, Cormorant Garamond + Inter fonts, no WP markers. This matters:
editing the widget is a code edit on the **website host**, not a content change in WordPress and not
anything in this repo.

The booking widget currently has **3 steps**, not 2:

| Step | Fields | Button |
|---|---|---|
| 1. What can we help you with? | Service: Laser Hair Reduction · Hair Loss · Acne · Skin Brightening · Anti-Ageing · HIFU · Weight Management · Other | (tap a chip) |
| 2. Your details | Full name + Phone | **Continue** |
| 3. Choose your clinic | Preferred clinic: Janakpuri · Kirti Nagar · Dwarka | **Request my consultation** |

…then a **"Thank you! We've received your request…"** message.

> Note: a **clinic dropdown already exists** (step 3). What the client is asking for effectively
> **merges it into the details step** and changes the final action from "show thank-you" to "open
> WhatsApp with a pre-filled message." This collapses the wizard to **2 steps**: service →
> (name + phone + branch) → Continue → WhatsApp. Confirm in [§7.3](#73-ux--two-steps-or-three).

The site advertises two numbers — **+91 731 731 09 09** and **+91 700 98 700 56** — and three clinics:
**Janakpuri, Kirti Nagar, Dwarka**. Hours: 10:30 AM–8:00 PM daily.

**The current form saves nothing.** It is a static page whose submit handler only reveals the
thank-you. So today, every web booking lead **vanishes**. The redirect to WhatsApp would be a strict
improvement in lead capture *if* the destination number is the dashboard-connected one.

---

## 3. Current state — dashboard (the receiving side)

Verified against source on 2026-08-03. The relevant pipeline lives almost entirely in one file,
[netlify/functions/utils/meta-service.js](netlify/functions/utils/meta-service.js).

| Fact | Where | Detail |
|---|---|---|
| **Provider** | env `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN` | **Meta Cloud API, direct. No BSP, no AiSensy, no Twilio.** Service conversations free since 2024-11-01 → ₹0 for our entire scope. Decision log: [WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md). |
| **One webhook for IG/FB/WA** | [meta-service.js `platformFor`](netlify/functions/utils/meta-service.js) (~L276) | `payload.object === 'whatsapp_business_account'` → `'whatsapp'`. |
| **Inbound extraction** | [meta-service.js `extractEvents`](netlify/functions/utils/meta-service.js) (~L285, WA branch ~L315) | Reads `entry[].changes[].field='messages'` → `value.messages[].text.body` + `value.contacts[].profile.name`. Non-text (image/audio) → skipped. WA has **no profile API** — name rides inline in `contacts[].profile.name`. |
| **Every inbound lead → `META_BRANCH_ID`** | [meta-service.js `processIncomingMessage`](netlify/functions/utils/meta-service.js) (~L194) | `const branchId = process.env.META_BRANCH_ID;` then `createLead({ branch_id: branchId, source: 'whatsapp', ... })`. **One hardcoded fallback branch for all platforms.** |
| **Branch routing from message text** | [meta-service.js `routeLeadFromReply` + `matchBranch`](netlify/functions/utils/meta-service.js) (~L830 / ~L597) | Runs on **every** inbound including WA. Full branch name or **first-word substring** → single unambiguous hit routes the lead. **This is the hook the website feature uses.** |
| **Outbound (staff reply)** | [meta-service.js `sendWhatsAppMessage`](netlify/functions/utils/meta-service.js) (~L560) via [meta-send.js](netlify/functions/meta-send.js) | `POST graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages`, recipient = `wa_id`. 1000-byte max. 24h service window only — no templates. |
| **Storage** | `leads` + `lead_messages` ([SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql) ~L141–193) | `leads` has `whatsapp_user_id` (the `wa_id`, indexed for dedupe); `lead_messages` has `direction`, `message`, `is_seen`, `branch_id` (populated on every insert for realtime filtering). |
| **No booking flow exists** | grep `booking\|appointment\|consultancy` | **Zero implementation hits.** The web booking widget would be the *first* booking-intent capture in the system. |

**Critical:** the connected WhatsApp number is currently **Meta's free test number**, not the clinic's
`+91 731 731 0909`. See [§6](#6-the-make-or-break-dependency--the-number-migration).

> ⚠️ **Dev/prod divergence.** The local `.env` points at a *different* Supabase project
> (`etwsehplgamvqdwpnmex`, dev) than the schema doc's prod project (`plxhbtsncfkuvnywstgn`), and the
> dev `META_BRANCH_ID` differs from the prod branch UUIDs. **Trust prod values from
> [PROJECT_DOCUMENTATION.md §2](PROJECT_DOCUMENTATION.md) for anything that ships:**
> Janakpuri `8db5a0fb-a7d4-435b-951e-6f1cb5d85fc9` · Kirti Nagar `e1d26aab-025d-4136-8a91-867a16c5a9ef` ·
> Dwarka Sec 12 `9a3aff6c-84b5-4c7f-95e8-6af3c9ec0556`.

---

## 4. The key insight — this is roadmap item #1, Option A

The dashboard's biggest open blocker is **WhatsApp multi-branch routing** ([§22 roadmap item 1](
PROJECT_DOCUMENTATION.md#22-roadmap--open-items)). Every inbound WA lead lands on the single
hardcoded `META_BRANCH_ID`, because a WA webhook carries **no location field** — `metadata.phone_number_id`
is *our* number (same for all branches), and a phone prefix says nothing reliable about which branch a
patient uses.

The roadmap ranked the options. **Option A** was:

> **A — per-branch `wa.me` deep links / QR codes with a hidden branch tag** (parse the branch from
> the first message).

**The website "Continue → WhatsApp" button *is* Option A.** The pre-filled message is the branch tag.
The dashboard is **already wired to consume it**: `routeLeadFromReply` + `matchBranch` already run on
every WA inbound and already route on a branch name in the text — the same path Instagram comment
leads use today. So this single website change:

- **Solves roadmap item #1 for website-origin leads** — for free, no dashboard code.
- **Does not** solve it for walk-in / saved-number WhatsApp leads (those still hit `META_BRANCH_ID`).
  That remainder stays open and is handled by the planned "Unassigned" inbox ([§9.2](#92-dashboard-side-this-repo---minimal)).

This is why the feature is worth more than "a website dropdown": it is the first concrete instance of
the dashboard's hardest unsolved routing problem being closed, and it doubles as a genuine lead-capture
channel (replacing the vanishing thank-you).

---

## 5. The end-to-end flow (once the number is migrated)

```
── website ────────────────────────────────────────────────────────────────────
visitor picks Service + types Name + Phone + picks Branch
  → "Continue" builds  https://wa.me/<DASHBOARD_WA_NUMBER>?text=<encoded message>
       (message names Service + Branch, e.g. "...Laser Hair Reduction... Janakpuri...")
  → visitor's WhatsApp opens with the message pre-filled → they hit Send

── dashboard receiving side (already exists, no new code) ─────────────────────
customer's WA message
  → Meta → POST <site>/webhook/meta
  → extractEvents()                            — platform='whatsapp', text + profile.name
  → processIncomingMessage(wa_id, text, ...)   — createLead on META_BRANCH_ID, store incoming msg
  → routeLeadFromReply(lead, text)             — matchBranch(text) hits "Janakpuri" → lead MOVED
                                                  to Janakpuri branch; 24h window now OPEN
  → Janakpuri inbox shows a new WA lead, realtime (green badge), with the full message
  → staff reply from the inbox → meta-send → sendWhatsAppMessage → delivered
```

**No new dashboard function, no schema change, no new dependency** is required for this flow to work.
The branch name in the message does the routing that `META_BRANCH_ID` could not.

---

## 6. The make-or-break dependency — the number migration

**Today the website's WhatsApp number and the dashboard's are different.** The dashboard is connected
to Meta's **free test number**; the website advertises `+91 731 731 0909`.

- If the website button points at `+91 731 731 0909` **as-is**, the message lands on a phone and
  **never reaches the dashboard** — no lead, no routing, no inbox. The website feature and the
  dashboard stay fully disconnected. The client's own note ("our WhatsApp may play a role after the
  user sends a message") is only true *if* the numbers match.
- The fix is the **planned number migration** already documented as the client handover:
  [WHATSAPP_SETUP_RUNBOOK.md](WHATSAPP_SETUP_RUNBOOK.md) Part E — set `WHATSAPP_PHONE_NUMBER_ID` +
  a **permanent System User token** (the dashboard token expires in 24h) to the clinic's real number.
  **Config only — zero code.** Long pole: Meta Business Verification (2–10 business days), and the
  number must first be migrated off any BSP.

**Until this migration is done, building the website button delivers no dashboard value** — it just
opens a WhatsApp. So the migration is the gate, not the website code.

---

## 7. Decisions still open

These were posed to the client on 2026-08-03 and are **not yet answered**. They shape the build.

### 7.1 The number (gate)

Will the dashboard be migrated onto the clinic's real `+91 731 731 0909` number (so the full loop
works), or will the website button point at a WhatsApp that stays disconnected from the dashboard?
→ see [§6](#6-the-make-or-break-dependency--the-number-migration).

### 7.2 Capture abandoners, or pure WhatsApp?

A visitor may open WhatsApp from the button and **never hit Send**. Two designs:

| | Pure `wa.me` | Save-then-redirect |
|---|---|---|
| **Lead exists if** | they actually send the WA message | always — saved the moment they click Continue |
| **Abandoners** | lost | captured as a `website`-source lead |
| **Cost** | none — pure client-side link | one small Netlify function on the **site** (the static page cannot write to Supabase without exposing keys) |
| **Duplication risk** | none | a saved lead + the WA inbound could create two rows for one person — needs dedupe on `whatsapp_user_id` |

**Recommendation:** start **pure `wa.me`**. It is one client-side link, needs no backend, and the
message itself is the lead. Add save-then-redirect only if abandoners prove to be a real, measured
loss — YAGNI until then. (See [§12](#12-what-i-think-recommendation).)

### 7.3 UX — two steps or three?

Client described merging the branch into the details step. Confirm: **service → (name + phone +
branch) → Continue → WhatsApp** (collapses today's step 3), vs. keeping 3 steps and only changing the
final action. **Recommendation:** collapse to 2 — fewer steps, higher completion.

### 7.4 Which website number?

The site lists two (`+91 731 731 09 09` and `+91 700 98 700 56`). The button must use **whichever is
(or will be) the dashboard-connected number**. Confirm which.

---

## 8. The message format — the contract between site and dashboard

The pre-filled message **is the integration contract**: it carries the branch name that drives
routing, plus the service and name the human (and later the chatbot) reads. It must read naturally
enough that a visitor is comfortable hitting **Send** as-is.

**Hard requirements:**
- **Contains the exact branch token `matchBranch` will hit.** The website labels are Janakpuri /
  Kirti Nagar / Dwarka; the dashboard branches are Janakpuri / Kirti Nagar / **Dwarka Sec 12**.
  `matchBranch` uses **first-word substring**, so "Dwarka" matches "Dwarka Sec 12", "Kirti" matches
  "Kirti Nagar", "Janakpuri" is a full match. **All three route cleanly.** Use the website label
  verbatim.
- **Contains the service** (human-readable; no parsing needed today).
- **Contains the name** (human-readable; the lead's stored `customer_name` will actually come from
  WhatsApp's `profile.name`, but the typed name is a useful cross-check and matters if the WA profile
  name is blank/a nickname).

**Draft variants** (the `[...]` are filled from the form):

- **A — natural (recommended):**
  `Hi! I'd like to book a consultation for [Service] at your [Branch] clinic. — [Name]`
- **B — with phone (if alt-callback matters):**
  `Hi! I'd like to book a consultation for [Service] at your [Branch] clinic. My name is [Name], you can also reach me at [Phone].`
- **C — compact:**
  `Consultation request: [Service] · [Branch] · [Name]`

> **Note on phone:** in WhatsApp the sender is identified by their `wa_id` (the number they send
> from), not the typed phone — so the typed phone is **secondary**. It only matters if the visitor
> wants a callback on a *different* number. Variant A omits it; the dashboard still gets the real
> number from the webhook. Include it (variant B) only if the clinic wants it.

**The link itself** (built client-side on the website — *not* this repo):

```
https://wa.me/<DASHBOARD_WA_NUMBER>?text=<encodeURIComponent(message)>
```

- `<DASHBOARD_WA_NUMBER>`: international format, digits only, no `+`/spaces — e.g. `917317310909`
  (use the value resolved for [§7.4](#74-which-website-number)).
- `wa.me` is the universal link — opens the app on mobile, WhatsApp Web on desktop. Encode the whole
  message body with `encodeURIComponent` (handles spaces, emojis, newlines as `%0A`).

---

## 9. What changes, and where

### 9.1 Website side (a different project — NOT this repo)

- Edit the static contact page's wizard JS: add the branch `<select>` to the details step, and on
  "Continue" build the `wa.me` URL from service + branch + name and `window.location =` it (or open
  in a new tab). Validate name + phone + branch + service are all set before enabling Continue.
- Replace the "thank-you" terminal step with a brief "Opening WhatsApp…" state (and keep it as the
  fallback if the redirect is blocked). This is a handful of lines of vanilla JS — the page is already
  custom, no new dependency.

### 9.2 Dashboard side (this repo — minimal)

The receiving pipeline needs **no code change**. Two small things, both already recommended by
existing roadmap items:

1. **[Gate] Number migration** — [§6](#6-the-make-or-break-dependency--the-number-migration). Config only.
2. **[Prerequisite for clean routing] Point `META_BRANCH_ID` at a dedicated inactive "Unassigned"
   branch** ([§22 item 1](PROJECT_DOCUMENTATION.md#22-roadmap--open-items)). Today unrouted leads
   masquerade as one real branch. A visitor who edits the branch name out of the message before
   sending (or picks "Other" service with no branch) would otherwise be misfiled. Create an inactive
   `Unassigned` branch row and set `META_BRANCH_ID` to it — a 2-minute DB change. Then `matchBranch`
   moves the *routed* ones off it, and the rest sit visibly in "Unassigned" for manual assignment.

> **What this repo does NOT need:** no new webhook, no new function, no schema column, no new
> dependency. Routing, ingestion, storage, and the realtime inbox already handle WA leads. The website
> message just arrives like any other WA inbound.

---

## 10. Gotchas & edge cases

| # | Thing |
|---|---|
| 1 | **The number must match.** Everything in [§5](#5-the-end-to-end-flow-once-the-number-is-migrated) is void if the website button and the dashboard are on different numbers ([§6](#6-the-make-or-break-dependency--the-number-migration)). This is the single highest-risk item. |
| 2 | **Visitor edits the message before sending.** If they delete the branch name, `matchBranch` finds no hit → the lead stays on `META_BRANCH_ID` ("Unassigned" once [§9.2](#92-dashboard-side-this-repo---minimal) is done). Acceptable — staff assign manually. Cannot be prevented; wa.me text is user-editable by design. |
| 3 | **`Dwarka` vs `Dwarka Sec 12`.** The website label is "Dwarka"; the branch is "Dwarka Sec 12". `matchBranch` first-word match covers it, but if the website ever changes the label to something whose first word collides with another branch, routing breaks silently. Keep website branch labels aligned with branch first-words. |
| 4 | **Lead name source.** The stored `customer_name` comes from WhatsApp `profile.name` (the sender's WA profile), **not** the typed name — they may differ. The typed name rides in the message text for the human. Do not expect the typed name in `leads.customer_name`. |
| 5 | **Service is not parsed into `leads.service` today.** It lives only in the message text. Staff read it; the planned chatbot ([CHATBOT_AUTOMATION.md](artifacts/CHATBOT_AUTOMATION.md)) could later parse it. Fine for now. |
| 6 | **24h window opens on send — that's the win.** Because the customer initiates the message, staff (and the future bot) can reply freely within 24h. No template needed. |
| 7 | **Desktop vs mobile.** `wa.me` on desktop opens WhatsApp Web (may prompt the user); on mobile it opens the app directly. Some desktop users without WhatsApp Web will drop here — the save-then-redirect option ([§7.2](#72-capture-abandoners-or-pure-whatsapp)) is the mitigation if that loss is measurable. |
| 8 | **Dedupe.** A returning visitor who books twice from the same `wa_id` reuses the existing lead (matched on `whatsapp_user_id`); a new message is appended to the timeline. No duplicate leads. |
| 9 | **Bot interaction (future).** If the chatbot ships later, it will see this message as the first inbound and may try to *re-qualify* — including re-asking the branch. Worth a note then: a message that already names service + branch is effectively pre-qualified, so the bot should treat it as a strong buying signal and hand off fast. Out of scope for now. |

---

## 11. Deliberately out of scope

| Skipped | Add when |
|---|---|
| **One WhatsApp number per branch** | Ruled out by the client's single-number requirement; the branch-name-in-message approach replaces it cleanly. |
| **Save-then-redirect (capture abandoners)** | Add only if measured abandonment at the WhatsApp screen justifies a backend function + dedupe ([§7.2](#72-capture-abandoners-or-pure-whatsapp)). |
| **Parsing service into `leads.service`** | The message text suffices for staff today; revisit when the chatbot qualifies automatically. |
| **Calendar / slot-picking / auto-confirmation** | Booking intent is a lead for staff to close, same as every other channel. A calendar integration is a separate feature (also out of scope for the chatbot). |
| **WhatsApp templates / outside-24h outreach** | Not needed — the customer initiates. Templates stay off the table, consistent with the rest of the WA integration. |
| **QR codes per branch (physical)** | Same Option-A mechanism; a natural later extension (a per-branch QR in-clinic that opens the same pre-filled message). Not needed for the website. |

---

## 12. What I think (recommendation)

This is a **small, high-leverage feature** and the design is already decided by existing code. My read:

- **Do it, and do it after the number migration.** The website change is ~20 lines of vanilla JS on a
  static page. The dashboard needs no new code — routing already works. The only real prerequisite is
  the number migration, which is already planned and config-only.
- **Go pure `wa.me` first.** No backend, no save-then-redirect, no dedupe complexity. The message is
  the lead. Measure abandonment later; add the safety net only if the data demands it.
- **Collapse to 2 steps.** service → (name + phone + branch) → Continue → WhatsApp. Less friction.
- **Use the natural message (variant A).** Comfortable to send, carries everything routing + the human
  need.
- **Create the "Unassigned" branch and repoint `META_BRANCH_ID` first.** It is the prerequisite for
  *clean* routing and it is already a recommended roadmap item — do it now so misfiled leads become
  visible instead of invisible.
- **Frame it correctly to the client:** this is not "a website tweak that maybe touches WhatsApp." It
  is the first real booking-intent capture in the system **and** the first concrete win on the
  dashboard's #1 open problem. That framing justifies prioritising the number migration, which is the
  actual long pole.

The risk to call out plainly: **if the number migration stalls (Meta Business Verification can take
2–10 business days), the website button ships into a void.** Sequence the work so the website change
goes live *after* a test message from the button is confirmed to land in the dashboard inbox.

---

## 13. Next steps — gated order

Do not start at the top until the gate ([step 1](#step-1--gate--whatsapp-number-migration)) is cleared.

### Step 1 — GATE: WhatsApp number migration
- [ ] Migrate the dashboard's WA number to the clinic's real number
      ([WHATSAPP_SETUP_RUNBOOK.md](WHATSAPP_SETUP_RUNBOOK.md) Part E): `WHATSAPP_PHONE_NUMBER_ID` +
      a **permanent System User token**, Business Verification, number off any BSP first.
- [ ] **Verify:** send a real WA message to the number → it appears as a lead in the dashboard inbox.

### Step 2 — dashboard prerequisite (clean routing)
- [ ] Create an inactive `Unassigned` branch; repoint `META_BRANCH_ID` to it
      ([§22 item 1](PROJECT_DOCUMENTATION.md#22-roadmap--open-items)).
- [ ] **Verify:** a WA inbound that names no branch lands in "Unassigned"; one that names "Dwarka"
      routes to Dwarka Sec 12.

### Step 3 — open decisions
- [ ] Confirm [§7.1](#71-the-number-gate) number (resolved by step 1),
      [§7.2](#72-capture-abandoners-or-pure-whatsapp) pure-vs-save,
      [§7.3](#73-ux--two-steps-or-three) UX,
      [§7.4](#74-which-website-number) which site number.

### Step 4 — website build (separate project)
- [ ] Add branch `<select>` to the details step; collapse the wizard to 2 steps.
- [ ] On "Continue", build `wa.me/<number>?text=<encoded>` from service + branch + name (variant A)
      and redirect. Validate all fields first.
- [ ] **Verify end-to-end:** complete the wizard on a phone → WhatsApp opens with the right message →
      Send → lead appears in the **correct branch** inbox in this dashboard, realtime.

### Step 5 — docs
- [ ] Per the [maintenance rule](PROJECT_DOCUMENTATION.md), update `PROJECT_DOCUMENTATION.md` in the
      same commit as any dashboard change: §15 (note the website→WA booking path),
      §21 (change log), §22 (roadmap item 1 — mark website-origin routing **done**; walk-in/saved-number
      routing still open), §23 (companion doc → this file). **Note:** this research doc itself does not
      change behaviour, so it does not yet require a `PROJECT_DOCUMENTATION.md` edit — but the moment
      any of steps 1–2 ship, it does.

---

*Research session 2026-08-03. Nothing built. Revisit when the number migration (step 1) is scheduled.*
