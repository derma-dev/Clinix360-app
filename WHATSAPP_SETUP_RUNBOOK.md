# WhatsApp Setup — Runbook (test first, client number last)

**Goal:** get WhatsApp receive + send working end-to-end on **our own Meta app + Meta's free
test number**. Prove the code. Then replay this doc on the client's account when he hands
over access.

**Provider:** Meta Cloud API **direct** — no AiSensy, no BSP. See
[WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md) for why (₹0 for our scope).

Companion doc: [WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md) = design & decisions.
This doc = the clicking.

Last updated: 2026-07-17

---

## This is a dry run — read this first

**The client owns the real product.** This Meta app, this Netlify site, these creds are
ours. Nothing here is his. **Every step in Parts B–D gets done a second time on his
account** once he gives access (Part E).

Two consequences:
- **No branch, no deploy preview, no staging ceremony.** Work on `main`, deploy to the
  existing site. There are no real users to protect, and the "safety" would be protecting a
  throwaway from itself.
- **This doc is the actual deliverable.** The code gets written once; *this* is the thing we
  replay on his account. So it's written to be re-run by someone who hasn't read it before —
  which round 2 will feel like, months later.

Round 2 is cheap **by design**: the swap is env vars + one callback URL, **zero code
changes**. That's the whole reason we test on a throwaway number first.

---

## Order (dependencies are real — don't reorder)

```
1. DB column                                  ─┐
2. Code changes                                ├─ me
3. Push to main → auto-deploys                ─┘
4. Meta: add WhatsApp product + test number   ─┐
5. Env vars in Netlify                         ├─ you (clicking)
6. Webhook config → site URL                  ─┘
7. Test INBOUND   (your phone → dashboard)    ─┐
8. Test OUTBOUND  (dashboard → your phone)     ├─ you
9. Sanity-check FB/IG still work              ─┘
10. Ask client for access → replay 4–9 on his account
```

Steps 1–3 are code — **that's me, not you.** Your work starts at step 4. But 1–3 must land
first, or there's nothing for the webhook to hit.

---

## PART A — Code & DB (me)

### A1. DB: add the WhatsApp id column
Run in Supabase SQL editor (matches the existing FB/IG pattern at
[SUPABASE_SCHEMA.sql:158-162](SUPABASE_SCHEMA.sql#L158)):

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS whatsapp_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_whatsapp_user ON leads(whatsapp_user_id);
```
Safe on a live DB — additive only, no rewrite, no lock of consequence.

### A2. Code — 4 spots, all in existing files
| # | File | Change |
|---|---|---|
| 1 | [meta-service.js:34](netlify/functions/utils/meta-service.js#L34) | `idColumnFor()` ternary → 3-way map. **Shared with FB/IG** — the only change that can break something already working |
| 2 | [meta-service.js:237](netlify/functions/utils/meta-service.js#L237) | `handleWebhook()`: add `whatsapp_business_account → whatsapp` + WA payload extractor |
| 3 | [meta-service.js:84](netlify/functions/utils/meta-service.js#L84) | `getLeadById()` select: add `whatsapp_user_id` |
| 4 | [meta-send.js:53](netlify/functions/meta-send.js#L53) | `sendWhatsAppMessage()` + `source === 'whatsapp'` branch |

No frontend work — the Inbox already renders WhatsApp (`WA` label + green styling).

### A3. Push to `main` → Netlify auto-deploys
No branch. Throwaway site, no real users.

The WhatsApp code is **inert until step C2 anyway** — the new branch only fires on
`object === 'whatsapp_business_account'`, and nothing sends that until you point the webhook.
So merged-but-unconfigured is a no-op.

`netlify.toml`'s `/webhook/meta` redirect ([netlify.toml:5-9](netlify.toml#L5)) already
exposes the endpoint — same URL FB/IG use today.

**→ Note your site URL (`https://<your-site>.netlify.app`). You need it in C2.**

---

## PART B — Meta dashboard (you)

Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps** → open the
**same app that already runs the Facebook Page + Instagram**. Do NOT create a new app —
reusing it is what lets us share `META_VERIFY_TOKEN` / `META_APP_SECRET`.

> Round 2 note: this is *our* app today. On the client's account it'll be *his* app — the one
> running *his* FB Page. Same rule, same reason: add WhatsApp to the app that already has
> FB/IG, don't make a new one.

### B1. Add the WhatsApp product
- Left sidebar → **Add Product** → find **WhatsApp** → **Set up**.
- It'll ask you to attach a **Business Portfolio** — pick the existing one (the one the FB
  Page lives in).
- It auto-creates a **test WhatsApp Business Account (WABA)** + a **test phone number**.
  Free, instant, no verification, no client involvement.

### B2. Grab the values — **WhatsApp → API Setup**
This screen hands you everything:

| On screen | Copy it as | Notes |
|---|---|---|
| **Phone number ID** (under "From") | `WHATSAPP_PHONE_NUMBER_ID` | numeric. NOT the phone number itself |
| **Temporary access token** | `WHATSAPP_ACCESS_TOKEN` | **expires in 24h** — fine for testing |
| Test number `+1 555…` | (just note it) | this is what you'll message from your phone |

> ⚠️ **The temporary token dies after 24 hours.** If it works today and breaks tomorrow,
> that's *expected* — not a bug. Just regenerate it on this same screen. We only need a
> permanent System User token at client-handover time (step E2).

### B3. Register YOUR phone as a test recipient
Still on **API Setup** → under "To" → **Manage phone number list** → **Add phone number**
→ enter your own WhatsApp number → Meta sends an OTP → enter it.

> ⚠️ **Test number limits (this is why we can't skip the real number later):**
> - Max **5** recipient numbers, and each must be OTP-verified by you.
> - It **cannot message real customers** — only that allowlist.
> - Fine for proving the integration. Useless for production. Expected.

---

## PART C — Wire it up (you)

### C1. Env vars — Netlify → Site settings → Environment variables
Add:
```
WHATSAPP_PHONE_NUMBER_ID = <from B2>
WHATSAPP_ACCESS_TOKEN    = <from B2>
```
Already set from the FB/IG work — **don't touch, we reuse them**:
`META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_BRANCH_ID`.

> After adding env vars, **redeploy** (Netlify → Deploys → Trigger deploy).
> Env vars are baked at build time — a deploy from before you added them won't see them.

### C2. Webhook — **WhatsApp → Configuration**
> This is the WhatsApp product's *own* webhook panel, with its own callback URL — **not** the
> Messenger/Instagram one. Editing it can't disturb the existing FB/IG wiring.

- **Callback URL:** `https://<your-site>.netlify.app/webhook/meta`
- **Verify token:** the exact value of `META_VERIFY_TOKEN` (same string FB/IG already use)
- Click **Verify and save** → should go green immediately.

  *If it fails:* the GET handshake is `verifyWebhook()`
  ([meta-service.js:206](netlify/functions/utils/meta-service.js#L206)). It logs
  `VERIFY_TOKEN_ENV= (set)` or `(MISSING)` — check Netlify → Functions → `meta-webhook`
  logs. `(MISSING)` = env var didn't reach the deploy → redeploy (see the note in C1).

- Then **Webhook fields** → find `messages` → **Subscribe**.

> ⚠️ **Subscribing to `messages` is the step everyone forgets.** Verify-and-save going green
> only means the handshake passed. Without the `messages` subscription **no message ever
> arrives** and the webhook looks silently broken.

---

## PART D — Test (you)

### D1. Inbound: phone → dashboard
1. From the phone you registered in B3, send a WhatsApp message to the **test number** from B2.
2. Watch Netlify → Functions → `meta-webhook` logs. You want:
   `[meta-webhook] Webhook received — object: whatsapp_business_account`
3. Open the dashboard Inbox → a new lead with the **green WA** badge.

**Where it lands:** the lead attaches to `META_BRANCH_ID` — the same single branch FB/IG use.
That's expected for now; multi-branch routing is decision #6 in the design doc, still open.

*Nothing showed up?* The logs answer it — `handleWebhook()` logs the full payload plus a
specific skip reason for every event it drops.

### D2. Outbound: dashboard → phone
1. Open that lead in the Inbox → type a reply → send.
2. It should arrive on your phone within seconds.

Free — you're inside the 24h service window that D1 opened.

> If you wait **>24h** after D1 and then reply, it will **fail with a 502**. That's correct
> behavior, not a bug — same as Facebook/Instagram do today
> ([meta-send.js:52](netlify/functions/meta-send.js#L52)). Just send a fresh message from
> your phone to reopen the window.

### D3. Sanity-check FB/IG still work
No real users here, so this isn't a ship gate — but the `idColumnFor()` change (A2 #1) is
shared code on the FB/IG path, and it's the one thing in this job that can break something
that already works. Catch it now, not in round 2 on the client's live account.

- Send a test **Instagram** DM → confirm it lands in the Inbox.
- Send a test **Facebook** Messenger message → confirm it lands.
- Reply to each from the dashboard → confirm delivery.

If a WA message ever writes into `instagram_user_id`, this is the bug that did it.

---

## PART E — Round 2: the client's account

Once D1–D3 pass, the code is proven. **Everything below is a replay of B→C→D on his Meta
app, with his number. No code changes** — that's what the dry run bought us.

### E1. What to ask him for
- **Do NOT take the AiSensy account.** If his number is live on AiSensy, it must be
  **disconnected/migrated off that WABA first** — a number can only be on one provider at a
  time, and while it's on AiSensy we cannot bind it.
- **Admin access to his Meta Business Portfolio** — the one with his FB Page/Instagram. That
  is the actual "access" we're waiting on; the phone number alone isn't enough.
- A phone number that is **not currently on the WhatsApp consumer app or WhatsApp Business
  app**. If it is, it must be deleted from there first (this **wipes its chat history** —
  warn him *before* he does it, not after). A fresh/unused number is the cleanest path.
- **Meta Business Verification** on his portfolio (tax/incorporation docs). **2–10 business
  days.** ← **the long pole. Ask him to start this the day he agrees, not the day we're ready.**

### E2. Replay on his account
1. **B1–B2** on *his* app — add WhatsApp product to the app running his FB Page.
2. **Skip the test number.** Go straight to **API Setup → Add phone number** → his real
   number → OTP verify. (The test-number detour was for proving the code; it's done.)
3. **Permanent token — do NOT use the temporary one here.** Business Settings → **System
   Users** → add a system user → **Generate token** → select the app → permissions
   `whatsapp_business_messaging` + `whatsapp_business_management` → **expiry: Never**.
   > A temp token here = the client's WhatsApp silently dies 24h after handover. This is the
   > single most important difference between round 1 and round 2.
4. **C1** — update `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ACCESS_TOKEN` on the real site → redeploy.
5. **C2** — callback URL → the real production URL, subscribe `messages` again
   (it's per-app; his app has never been subscribed).
6. **D1–D2** — message his number from your phone, reply from the dashboard. Same test.

### E3. What's *not* solved by any of this
**Multi-branch routing** (decision #6 in [WHATSAPP_INTEGRATION.md](WHATSAPP_INTEGRATION.md)).
Every WhatsApp lead lands in `META_BRANCH_ID` — one branch, hardcoded. Fine for testing,
**wrong for his 3 branches on one number.** Still needs his answer on how patients first make
contact. Don't let a green end-to-end test read as "done" — it isn't, and this is the gap.

---

## Gotchas — ranked by how likely they are to eat your afternoon

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | Webhook verified green, **no messages arrive** | `messages` field not subscribed | C2, last step |
| 2 | Worked yesterday, **401 today** | temp token expired (24h) | regenerate on API Setup |
| 3 | Verify fails, log says `VERIFY_TOKEN_ENV= (MISSING)` | env var added after last build | trigger redeploy |
| 4 | Can't message a friend to test | test number = 5 OTP'd recipients only | add them in B3, or accept it |
| 5 | Reply fails 502 after a day | 24h service window closed | message from phone again |
| 6 | FB/IG broke | `idColumnFor()` refactor | D3 catches it — that's why D3 exists |
| 7 | Client's number rejected | still on WhatsApp Business app / on AiSensy | E1 |
| 8 | **Client's WhatsApp dies 24h after handover** | shipped the **temp** token to prod | E2 step 3 — permanent System User token, expiry Never |

---

## Rollback

Nothing here is sticky:
- **Webhook:** WhatsApp → Configuration → clear the callback URL. Kills all WA traffic
  instantly; FB/IG have their own callback and never notice.
- **Code:** inert with the webhook cleared — the WA branch only fires on payloads that stop
  arriving. `git revert` only if the `idColumnFor()` change actually broke FB/IG (D3).
- **DB:** `whatsapp_user_id` is additive + nullable — leave it, it costs nothing.
- **Meta:** the test WABA can sit there unused, free.

## Cost of everything in this doc

**₹0.** Test number free, test WABA free, inbound free, replies inside the 24h window free.
No card required at any point.
