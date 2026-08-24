# Chatbot Implementation — Step Tracker (resume file)

> **NEW SESSION? START HERE.** This file is the durable record of the chatbot build.
> 1. Read the **Status** block + **Log** below — that's where the last session left off.
> 2. Design and all locked decisions: [artifacts/CHATBOT_FINAL_PLAN_2026-08-24.md](artifacts/CHATBOT_FINAL_PLAN_2026-08-24.md)
>    (ledger **D1–D24**, turn pipeline §3, schema §4, tests §8). Don't re-litigate — build.
> 3. Next work = **first unchecked step**. Before starting it, confirm the previous step's
>    Verify still holds (unit suite: `node netlify/functions/utils/meta-service.test.js`).
> 4. After each step: tick it, append one line to the **Log**, update **Status** — then **propose**
>    the commit (one-line message + what's in it) and **wait for the user's go-ahead. Never
>    auto-commit.** [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md) updates belong in the
>    **same commit** (§15/§21/§22).
> 5. When reporting a finished step: if any part of its **Verify needs a human** (deploy first,
>    DM the test IG, click the dashboard), list **exactly what the user should do** as a short
>    checklist. If the unit/live checks already covered everything, say "no manual test needed" —
>    don't invent work.
> 6. **Publish budget: Netlify free account = 300 build credits — ≈15 publishes for us.**
>    Pushing ≠ publishing — deploys are manual and each costs credits. So: implement +
>    unit-verify several steps, commit, publish **once**, then run all their live checks
>    together. Docs-only commits never publish. No unnecessary commits either — one commit
>    per coherent chunk, not per file. Track the count in the Status block below.
>
> Steps are vertical slices: implement → verify → only then move on. Each step's Verify is
> the exit test; don't start step N+1 with step N failing.
>
> Deployment context (D23): steps run against **our test Meta app + test IG** (live mode is
> safe there — Standard Access = only app-role users can DM it). Client rollout = Step 19+.

---

## Status

- **Now:** Step 3 — `chatbot_config` settings row + admin card (Step 2 done + live-verified)
- **Done:** Steps 1–2
- **Remaining:** Steps 3–20
- **Blockers:** Gemini API key needed by Step 6's live check (unit part runs mocked without it)
- **Publish budget:** 2/15 used (Step 2 ×2: initial publish + ig_post fix publish) · **13 left** — batch live checks, docs-only commits never publish

## Log (append one line per completed step — date · step · what/why/learned)

- 2026-08-24 · Step 1 · §4 schema applied via SQL editor + verified over REST (all cols/tables live, old rows carry defaults, existing reads fine). Deviation: plan's `bigint lead_id` → **uuid** (`leads.id` is UUID). Found + fixed pre-existing drift: live `leads` has `email`/`assigned_to`, lacks `service`/`notes`/`updated_at` the schema file claimed — nothing in this repo's code touches the dead columns (grep-verified), so no breakage.
- 2026-08-24 · Step 2 · attachments labeled instead of dropped, unit + live verified (share → `🔗 shared post: <caption>`, photo → `📷 image` on test IG). **Live finding:** shared posts arrive as `ig_post` (legacy `share` type removed ~Feb 2026 — brainstorm doc was stale); payload carries `ig_post_media_id` directly, so plan §3.4's permalink→media-id map is unnecessary for shares. Real-image display in inbox deliberately NOT built (CDN url is short-lived; durable fetch+store arrives with Step 15 vision, which needs the bytes anyway).

---

## Foundation (plan Phase 2/3 · Step 0 of build order)

### Step 1 — Schema migration
- **Implement:** [SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql) — `leads.category`, `leads.location`, `leads.bot_active` (default false), `leads.bot_state`, `lead_messages.is_bot`, tables `kb_candidates`, `bot_shadow_log` (final plan §4 block, copy as-is).
- **Verify:** apply to Supabase; `\d leads` / table list shows everything; existing app + inbox unaffected (defaults cover old rows).
- **Status:** ✅ done 2026-08-24 (applied + REST-verified; `lead_id` FKs uuid, not plan's bigint — `leads.id` is UUID)

### Step 2 — Attachment capture in `extractEvents`
- **Implement:** shares (permalink, share_type) → `🔗 shared post: <share_text>`; images → `📷 image`; non-text no longer dropped. Bot-independent — fixes inbox display today.
- **Verify:** unit test with fixture webhook payloads (text / share / image); live: DM a post share to test IG → label appears in inbox timeline.
- **Status:** ✅ done 2026-08-24 (unit fixtures + live on test IG; ig_post type discovered live — `🔗 shared post: <caption>` + `ev.attachment {type, mediaId, title, url}`)

### Step 3 — `chatbot_config` + Settings card
- **Implement:** settings row + admin card (mirrors `comment_rules` card): **mode section off/shadow/live (D24)**, model, KB, locality map, canned replies (incl. kb_miss/llm_error hold copy, disclosure, refusal-ok), `offer_stale_days`, turn caps.
- **Verify:** card saves/loads round-trip; mode renders; default `mode:'off'` (bot inert until Step 7 wires it anyway).
- **Status:** ☐ not started

### Step 4 — KB seed from corpus (D22)
- **Implement:** KB entries from the distill (staff voice, Hinglish) into `chatbot_config.kb`; **prices mined latest-quote-wins per service** (resolves distill ₹-conflict tables by message timestamp); services with no corpus price stay unpriced (HITL later, Step 13); `prices_verified_at` set.
- **Verify:** script output review — spot-check 10 services against distill files; every priced service shows its latest quote, not an older one.
- **Status:** ☐ not started

## Turn pipeline (live on test app)

### Step 5 — `classifyInbound` keyword net
- **Implement:** pure function, English + Hinglish net mined from real corpus phrasings (khujli, dawai, daag, ilaj, garbhvati…), emergency/medical/requested tiers (final plan §3.2, D7 layer 1).
- **Verify:** unit assertions (final plan §8.1): medical/emergency/requested → handoff; FAQ ("price of laser") passes; emergency outranks medical.
- **Status:** ☐ not started

### Step 6 — Gemini client `callAssistant`
- **Implement:** raw fetch `generateContent`, `x-goog-api-key` (`GEMINI_API_KEY`), full responseSchema — `{category, is_medical, reply, kb_covers, handoff, reason, qualification}` (final plan §3.5). Whole KB injected (D20).
- **Verify:** unit test with mocked fetch (schema mapping, error throw); one **live** call with real key returns parseable structured JSON (this validates the model choice D1 early).
- **Status:** ☐ not started

### Step 7 — `botReply` wiring + guards
- **Implement:** hook into `handleWebhook` loop after `routeLeadFromReply`; no-op when `bot_active=false` / `mode:'off'`; everything try/catch (bot never drops/delays an inbound, D13); **dedup check before `botReply`** (redelivered event → no second reply).
- **Verify:** unit no-op tests; **webhook-redelivery replay test** (open #10): same payload twice → zero bot replies in off mode / exactly one once live (Step 8).
- **Status:** ☐ not started

### Step 8 — Live turn: reply + persist
- **Implement:** send via `sendByPlatform`, store outgoing `is_bot=true`; persist category (every turn, D14) + qualification into `leads`/`bot_state`; disclosure prepend on first bot turn (D15); phone 10-digit code-normalized (D16); `bot_active=true` on new-lead creation when bot on (D6). Flip test deployment `mode:'live'`.
- **Verify:** live DM "price of laser" to test IG → KB-range reply + next qualification question lands in thread; DB rows correct (`is_bot`, category, bot_state).
- **Status:** ☐ not started

### Step 9 — Handoff paths + summary card
- **Implement:** `handoffToStaff` — medical/emergency/requested/qualified/llm_error/turn_cap; `bot_state.handoff_summary`; `bot_active=false`, `status='qualified'`; **summary card UI replaces thread, raw collapsible, raw expanded for medical (D11)**; `llm_error` catch → canned handoff (D13).
- **Verify:** live "khujli ho rahi hai" → NO answer, handoff, summary card in dashboard; simulate LLM failure (bad key) → canned "let me connect you" + handoff, inbound still stored.
- **Status:** ☐ not started

### Step 10 — Auto-takeover + Take-over button
- **Implement:** any staff outgoing message flips `bot_active=false`, sticky (D12) — guard in existing staff send path; Take-over button as shortcut.
- **Verify:** live: staff replies from dashboard → subsequent customer DMs get no bot reply; button does the same instantly.
- **Status:** ☐ not started

### Step 11 — Non-lead handling + category chips
- **Implement:** collab/sales/misc → 1 canned reply (config copy) → `bot_active=false`, filed under `leads.category` (D2/D14); category filter chips in leads list.
- **Verify:** live collab-style DM ("we'd love to collaborate") → one canned reply, filed, bot silent after; chips filter correctly.
- **Status:** ☐ not started

### Step 12 — Shadow mode wiring
- **Implement:** mode branch after Gemini decision; `logShadowTurn` → one `bot_shadow_log` row/turn; invariants: never send, never mutate leads, one row even on error, dedup first (D19).
- **Verify:** unit invariant tests; live: flip `mode:'shadow'`, DM → log row exists, **no reply sent, no lead mutation**; flip back to live.
- **Status:** ☐ not started

### Step 13 — Teach-the-bot loop (D17 + D22 price HITL)
- **Implement:** `kb_covers:false` → `kb_miss` handoff (canned hold reply, summary "Bot didn't know: \<q\>"); first staff reply on that thread → `kb_candidates` row; dashboard **Teach-the-bot** list (Approve / Edit+Approve / Discard) → approved joins `chatbot_config.kb` tagged `learned:<YYYY-MM>`; `kb_miss`/emergency badge (D18).
- **Verify:** live: ask an unpriced/unknown question → hold reply → staff reply from dashboard → candidate appears → Approve → **re-ask the same question → bot answers from the learned entry**.
- **Status:** ☐ not started

### Step 14 — Share→offer price (D9/D10)
- **Implement:** permalink → media id map (one-time `GET /{IG_ID}/media`, refresh on miss) → caption → Gemini parse → cache `{service, offer_price, last_seen, source_caption}`; offer ladder at quote time: fresh offer → quote it; stale (`offer_stale_days`) → KB range; no offer → KB range; no match → "after consultation".
- **Verify:** live: share an offer post + "price?" → offer price quoted ("as in the post"); set `offer_stale_days=0` → same share now returns KB range.
- **Status:** ☐ not started

### Step 15 — Raw-image vision fallback
- **Implement:** image DM → Gemini vision (`inline_data`) + KB service list → "which service is this?" → answer normally (fallback model `gemini-3.7-flash` if Lite flaky, D1).
- **Verify:** live: send a screenshot of a service post → correct service identified, KB price answered.
- **Status:** ☐ not started

### Step 16 — Corpus replay harness
- **Implement:** `scripts/replay-shadow.js` (feed `ig_export_history.jsonl` threads through the real pipeline → `bot_shadow_log`) + `scripts/review-shadow.js` (sample + stats: category/reason/malformed/is_medical rates, latency p50/p95).
- **Verify:** run over the 1,970-thread corpus end-to-end; review output readable; **tune KB/prompt until drafts are acceptable vs actual staff replies** (this is the cheap iteration loop before relying on live traffic).
- **Status:** ☐ not started

### Step 17 — Soft booking (D3)
- **Implement:** prompt-side — collect preferred day/time once lead is engaged; `qualification.preferred_time` → carried on handoff summary; staff lock in Clinicea. No calendar.
- **Verify:** live: run a qualify→agree flow → handoff summary contains service + branch + preferred day/time.
- **Status:** ☐ not started

### Step 18 — Alerts + caps + metrics
- **Implement:** email alert on `emergency` + `kb_miss` (one mechanism, two triggers, D18 — badge exists from Step 13); turn cap 10 + 7-day conversation-age cap (#17 — confirm finals); success-metric weekly SQL (#18: ≥60% handoffs phone+service+location, zero missed medical).
- **Verify:** trigger kb_miss → email arrives; cap: send 11 DMs → turn_cap handoff on #11; metrics query returns real numbers.
- **Status:** ☐ not started

## Client rollout (plan Phase 5/6)

### Step 19 — Client shadow-first rollout
- **Implement:** deliver same code + [final plan](artifacts/CHATBOT_FINAL_PLAN_2026-08-24.md) to client; client KB gets Phase 1 sign-offs (clinician risk/guardrail wording, offers.md, canned #2); flip client `mode:'shadow'` on real traffic; seeded scenarios re-run on their app.
- **Verify:** **exit criteria** (final plan §8.3): ≥30 leads/≥100 turns · ≥10 seeded Hinglish medical = 0 drafted answers · malformed <2% · offer extraction ≥90% · 20-draft sign-off. Not met → fix, extend shadow.
- **Status:** ☐ not started

### Step 20 — Client live
- **Implement:** flip `mode:'live'` via Settings toggle (D24).
- **Verify:** week-1 review (daily 48h via review script on `is_bot=true`, then weekly); 30-day metrics vs #18 targets. Toggle stays as permanent throttle (off / shadow / live).
- **Status:** ☐ not started

---

## Client-side items pending (gate Step 19, not the test build)

- [ ] Price sheet (sanity check only — D22, corpus latest-wins is the source)
- [ ] offers.md confirmation; 2nd canned template approved copy
- [ ] Clinician sign-off on risk-FAQ + guardrail wording
- [ ] Gemini API key (needed at Step 6 live check)
