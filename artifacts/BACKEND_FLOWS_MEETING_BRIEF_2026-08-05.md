# Clinix360 — Backend & Flows (Client Meeting Brief)

*Prepared 2026-08-04 for the 2026-08-05 meeting. "How the backend works and its flows."*

---

## 1. The big picture (one paragraph)

Clinix360 is a single web app (live at **clinix360.ai**) that does two jobs for the 3 branches:
**(A) daily cash-up / end-of-day reconciliation**, and **(B) a unified lead inbox** that pulls in
every Instagram, Facebook and WhatsApp message into one place, auto-routes leads to the right
branch, and lets staff reply without leaving the dashboard. There is no separate "marketing
tool" or "chat tool" — it is one system, one database, one login per branch.

## 2. The backend, in plain terms

| Piece | What it is | Role |
|---|---|---|
| **Supabase** (Postgres) | The database | The real "backend" — stores everything (cashup, leads, messages, settings). The app reads/writes it directly. |
| **Netlify Functions** | Small serverless scripts | Run only the things a browser *can't* do safely: send emails (Resend), the Meta webhook receiver, and scheduled automations. |
| **One webhook** (`/webhook/meta`) | A single endpoint | **All three** platforms (Instagram, Facebook, WhatsApp) send their events to the *same* URL. The code looks at the event and routes it. Adding WhatsApp was adding a third branch to one tree, not a new system. |
| **Supabase Realtime** | A live channel | Pushes new messages to open dashboards instantly — no manual refresh. |
| **Netlify** (hosting) | Static site + functions | Serves the app + auto HTTPS. |

**Security:** login is PIN-based (one PIN per branch + one admin PIN). Access control is enforced
at the app layer. (RLS is a planned hardening — see "what's next".)

---

## 3. The flows

### Flow A — Daily Cash-up (live since day one)

```
Branch staff
  → log in with branch PIN
  → fill the cash-up sheet (sales entries, expenses, extra cash, handover)
  → Submit Final   → rows saved to Supabase
  → Admin panel sees: live KPIs across all 3 branches, reports, variance alerts
  → Closing math auto:  opening + cash sales − handover + extras − expenses
```
*Extra:* automated reports and variance alerts email the admin; "Forgot PIN" is a controlled
recovery path to the admin only. Payment modes are admin-managed and update everywhere live.

### Flow B — Unified Lead Inbox (Instagram, Facebook, WhatsApp)

This is the heart of the messaging side. One inbound path, one reply path, three platforms.

```
Customer DMs/Messages on IG · FB · WhatsApp
  → Meta sends it to  /webhook/meta
  → code identifies the platform + finds-or-creates a LEAD
  → stores the incoming message on the lead's timeline
  → REALTIME pushes it to the open dashboard instantly (no refresh)
  → lead shows in the branch's inbox
  → staff types a reply  → sent back via Meta's API  → stored as outgoing
```

**What's live:** Instagram DMs (in + out), Facebook Messenger (in + out), the realtime live
inbox, multi-staff collaboration (two people see each other's replies live).
**WhatsApp:** code is done and proven on a test number. To go live on the clinic's real number it
needs a one-time migration (see §5).

### Flow C — Comment Automation (Instagram + Facebook)

The "comment PRICE and I'll DM you" growth mechanic — built, not bought.

```
Customer comments on an IG/FB post (e.g. "price of laser?")
  → public reply appears under the comment ("Check your DM 💬")
  → ONE DM sent: answers briefly + asks "which branch?" with tappable branch buttons
  → customer taps a branch (or types it)
  → lead auto-routes to THAT branch's inbox
  → the 24-hour reply window opens → staff take over, no send limits
```

The keyword rules are **admin-editable** in Settings (one shared rule list for IG + Facebook).
*Why the DM ends on a question:* Meta allows only one DM per comment — ending on a question turns
a one-shot broadcast into a real conversation AND simultaneously solves branch routing.

### Flow D — Branch routing (the cross-cutting piece)

Every inbound lead currently parks on one default branch, then moves to the correct branch the
moment the customer names one (via a button tap or typed text). This works across all three
platforms. The recommended next step is a dedicated "Unassigned" inbox so unrouted leads stop
masquerading as a real branch's own.

---

## 4. Where each thing actually stands

*Reflects the code on `main`, not the spec-doc headers (which lag behind).*

| Feature | Status |
|---|---|
| Daily cash-up + admin KPIs/reports/alerts | ✅ **Live** |
| Instagram DM inbox (receive + reply) | ✅ **Live** |
| Facebook Messenger inbox (receive + reply) | ✅ **Live** |
| Realtime inbox (no-refresh push) | ✅ **Live** (shipped, then bug-fixed in production) |
| Instagram comment → DM → branch routing | ✅ **Built**; needs Meta dashboard fields switched on + a live test |
| Facebook comment automation | ✅ **Built** (shares rules with IG); same switch-on step |
| WhatsApp receive + reply | ✅ **Built & proven on test number**; ⏳ pending the real-number migration |

## 5. What we need from you (the client) — meeting action items

These are the things only the client can provide/decide. Prioritised by leverage:

1. **🟠 WhatsApp real-number migration (the long pole).** WhatsApp is fully built but runs on a
   test number. To take it live we need: (a) the number moved **off AiSensy / off the WhatsApp
   Business app** (a number can only sit with one provider), (b) **Meta Business Verification**
   — **2–10 working days**, so worth starting the *day you agree*, not the day we're ready, and
   (c) a permanent token. **Config only — zero new code.** Until this is done, WhatsApp can't
   receive real customer messages.
2. **🟠 Comment-automation sign-off.** To switch IG/FB comment automation on for the *general
   public* (not just testers), Meta requires **App Review (Advanced Access)**. We also need: the
   **keyword list + DM copy** for each rule, a decision on catch-all vs keyword-only, and a quick
   **medical-claim review** of the auto-sent DMs.
3. **🟡 "Unassigned" branch.** Recommended one-off: create an inactive "Unassigned" branch so
   unrouted leads are visible instead of silently landing in a real branch's inbox. Needs your OK
   because it changes what branch staff see.
4. **🟡 Which website/WhatsApp number.** The site lists two numbers; confirm which is (or will be)
   the dashboard-connected one.

## 6. What's deliberately next (after the gates clear)

- **Complete WhatsApp multi-branch routing** for walk-in / saved-number leads (customers who
  don't name a branch). The comment path already routes; plain DMs need the "Unassigned" inbox +
  a decision on how patients first make contact.
- **Security hardening (RLS + proper auth)** — the planned upgrade from PIN-only access control.
- **Optional later:** an AI assistant that auto-answers repetitive FAQs and pre-qualifies leads,
  and a website "book → WhatsApp" button. Both are *research/spec only* today, deliberately gated
  on the items above being stable first.

---

## 7. One-line summary for the client

> *Cash-up is live and proven. The unified inbox already handles Instagram + Facebook in real
> time, with auto comment-to-DM and branch routing built on top. WhatsApp is fully built and
> tested — it goes live the moment the number migration completes (the one thing that takes
> 2–10 days, so we should start it now).*
