# Chatbot Implementation — Step Tracker (resume file)

> **NEW SESSION? START HERE.** This file is the durable record of the chatbot build.
> 1. Read the **Status** block + **Log** below — that's where the last session left off.
> 2. Design and all locked decisions: [artifacts/CHATBOT_FINAL_PLAN_2026-08-24.md](artifacts/CHATBOT_FINAL_PLAN_2026-08-24.md)
>    (ledger **D1–D24**, turn pipeline §3, schema §4, tests §8). Don't re-litigate — build.
> 3. Next work = **first unchecked step in the Status block's agreed order** — execution
>    order ≠ step number (currently 17 → 18 → 16 → 19–20, see Status). Before starting it,
>    confirm the previous step's Verify still holds (unit suite: `node netlify/functions/utils/meta-service.test.js`).
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
> **Deployment context (D23) — everything here is OUR TEST SETUP, not the client's.** The
> Meta app, the Instagram account, the Facebook Page, the Netlify site
> (`eloquent-pothos-dc09dc`) and the Supabase DB (`plxhbtsncfkuvnywstgn` — all rows are
> mock data) were all created by us to build and prove the bot before it
> goes onto the client's real accounts. "Live", "published", `mode:'live'` in this file =
> live on those test accounts (safe — Standard Access, only app-role users can DM). The
> only real client data is the IG DM export (`inbox/` → corpus, gitignored PII) used for
> the KB + replay. Client rollout = **Step 19+**, which starts by re-creating this setup
> on the client's accounts.

---

## Status

- **⚠️ Direction change 2026-09-28:** the bot becomes **our hosted service**: leads POST to the client's Make webhook → their website, and stuck/unknown-price cases go to the owner on Telegram. **Step 19 as written below is superseded.** Read [artifacts/CHATBOT_SERVICE_PIVOT_2026-09-28.md](artifacts/CHATBOT_SERVICE_PIVOT_2026-09-28.md) + open decisions in [Questions.md](Questions.md) before building. Steps 1–18 + Step 16 tuning still stand. **The build is now tracked in [CHATBOT_SERVICE_TRACKER.md](CHATBOT_SERVICE_TRACKER.md)** (steps S0–S17; Step 16 = S11, Steps 19–20 = S15–S17).
- **Now:** Steps 17–18 committed (ccbdf69) + published — **their live batch is still pending (user, see below)**. Step 16 harness built + smoke-verified; the ~300-thread sample run started 2026-08-25 (background, ~85 min, resumable).
- **Done:** Steps 1–15 (code + live — user confirmed the 8–12 and 13–15 batches on published deploys 2026-08-25) · Steps 17–18 (code + unit-verified + published) · Step 16 scripts (replay-shadow + review-shadow)
- **Remaining:** run the **17–18 live batch** (below) · finish the Step 16 sample run → `review-shadow` → **tune KB/prompt** (drafts vs actual staff replies; known nudge: model labels `reason:'kb_miss'` while answering from the KB with `handoff:false` — cosmetic today, fix in this loop) · full corpus once (`--all`) for the §8.3 numbers · prompt tweaks fold into the pre-19 publish → ~~metrics-email build~~ ✅ 2026-09-23 (unpublished — rides the next publish) → Steps 19–20
- **Why 17→18 before 16 (done as decided):** replay measures the FINAL prompt — booking collection (17) and turn cap (18) changed what drafts look like.
- **Blockers:** none
- **Publish budget:** 5/15 used · **10 left** — batch live checks, docs-only commits never publish.
  **Live batch checklist for 17–18 (user, against the published deploy):** run a qualify→agree flow ("price of laser" … "book kar do Saturday evening") → handoff summary must contain service + branch + preferred day/time · DM an emergency phrasing → alert EMAIL arrives (bot sends the customer nothing) · trigger a kb_miss → alert email arrives (an unknown-question DM covers the 13 teach-loop too) · send 11 quick DMs on a throwaway thread → bot replies to #1–10 then hands off `turn_cap` on #11 with the "connect you" copy · paste [scripts/bot-metrics.sql](scripts/bot-metrics.sql) in the Supabase SQL editor → real numbers return (missed_medical=0).

## Log (append one line per completed step — date · step · what/why/learned)

- 2026-09-23 · Pre-19 metrics email · `netlify/functions/send-bot-report.js` — one scheduled function (09:00 IST daily) reads `chatbot_config.report_frequency` at runtime: daily → last 24 h every run, weekly → Mondays / last 7 days, off (default) → nothing. Numbers = `bot-metrics.sql` over REST (`bot_state->>handoff_at=gt.<iso>` works as a jsonb text filter; ISO strings compare lexicographically), emailed via Resend to `alert_email`; ⚠️ in the subject when missed medical ≠ 0. Chatbot card gains an **Alerts & report** row (alert email was config-only until now). Unit: metrics incl. missed-medical boundary + frequency gate; queries run read-only against the test Supabase (60-day window: 1 handoff, 18 bot messages). Needs a publish for the live email check.
- 2026-09-23 · Live-test fixes · (1) **Language:** reply follows the customer's LATEST message (rule in the system prompt + a reminder next to the new message). With the rule in the system prompt only, a Hinglish line after an English thread still got English back about half the time. Live check with the real KB: 8/8 correct for English and Hinglish; Devanagari replies come back in Roman Hinglish (15/6,500 corpus inbounds, left as is). (2) **Soft handoff keeps the bot on:** `qualified`/`wants_booking`/`declined_booking` write the summary + `status:'qualified'` but leave `bot_active=true` until a staff reply takes over (user decision). Found live: after a `qualified` handoff, "Kya aap ki or koi brach bhi hai?" + "Hello?" got silence. Unit suite green. Needs a publish to test live.

- 2026-08-25 · Step 16 (scripts half) · `scripts/replay-shadow.js` + `scripts/review-shadow.js` built and live-smoke-verified (2 threads / 8 turns through real Gemini; drafts vs staff readable; **age cap fired correctly across a 9-day thread gap** then reset and kept drafting; counter ticks only on drafted normal turns). Design: replay drives the REAL decision pipeline (`classifyInbound` → caps → offer ladder → `callAssistant`) with a simulated lead state — synthetic `turn_count` (ticks per drafted normal turn, cap → one turn_cap row then window reset, so long threads stay covered without flooding), thread-clock freshness for offers (corpus is years old; `isOfferFresh`'s `Date.now()` would stale everything), in-memory caption-keyed offer cache (export carries no media ids), staff replies replayed as model-role history. Deterministic stratified ~300-thread sample (safety 53 all + offers 55 + collab 55 + price 60 + long 3 + rest 74 ≈ 1,273 turns + 83 caption parses); threads with zero replayable inbounds filtered out (they were eating quota slots). Output = local `artifacts/data/replay-*.jsonl` (gitignored PII dir), NOT the live `bot_shadow_log` — replay rows would pollute Step 19 shadow metrics and duplicate on re-runs; rows carry the staff's actual reply for the draft-vs-staff eyeball. Resume by re-running the same command; `--rpm` throttle (default 15) + 429/5xx backoff; daily-quota 429 stops gracefully. `review-shadow.js`: malformed rate (<2%), reason/category/tier histograms, offer fresh/stale + extraction table (≥90% eyeball), latency p50/p95, missed-medical invariant (0), `--sample N --bucket b` draft-vs-staff dump. **Learned:** the first smoke "passed" with 0 turns — the two oldest picked threads had no replayable inbounds, so the estimate line is now the cheap guard (0 turns = selection bug, not success).

- 2026-08-25 · Steps 17–18 · **17 (soft booking, D3):** prompt-side only by design — the system prompt now drives toward a preferred day/time once a lead is engaged and hands off `wants_booking` on a booking intent ("NEVER confirm a slot yourself"); `preferred_time` plumbing (schema → mergeBotState → summary "preferred \<time\>") already existed from Steps 8–9, so no new runtime code. **18 (caps + alerts + metrics):** caps checked after the safety net / before Gemini — `bot_state.turn_count` (ticks only on delivered normal live turns) ≥ `turn_cap` (10) → `turn_cap` handoff with the hold copy (`canned.turn_cap` else llm_error copy — never silence after 10 turns); lead age > `conversation_age_cap_days` (7) → same; safety outranks the cap; turn-capped threads skip the disclosure re-prepend, age-cap-only first turns keep it. `sendBotAlert`: one Resend email on emergency/kb_miss handoffs (D18's two triggers; badge was Step 13), best-effort, `cfg.alert_email` override, customer text HTML-escaped. `scripts/bot-metrics.sql`: weekly #18 query (≥60% complete-handoff target, missed-medical=0 invariant computed as "no is_bot message newer than the last inbound on a safety-handoff thread"). **Learned:** (a) shadow mode never ticks `turn_count` (no mutation) — the Step 16 replay harness must inject a synthetic count per replayed turn or the cap is invisible in replay; (b) the alert body had to HTML-escape the verbatim question — asserting on the raw string caught it immediately. Unit suite green (soft-booking summary/prompt, cap boundary both sides, age cap, safety-outranks-cap, shadow cap row, all D18 trigger/negative/failure cases).

- 2026-08-25 · Steps 13–15 · **13 (teach-the-bot, D17/D22):** kb_miss summary now names the question + `bot_state.kb_miss_question` stashed; meta-send captures the FIRST staff reply on a kb_miss thread → one `kb_candidates` row (exactly-once flag on bot_state, best-effort, never 502s a send); admin Settings → **Teach the Bot** card (Approve/Edit+Approve/Discard) — approval does a freshest-config read-modify-write, then folds the Q/A into the KB: a price answer on a word-matched service updates that entry (newest quote = source of truth, D22), else a learned FAQ entry tagged `learned:<YYYY-MM>`; ❓/🔴 badges on branch lead cards (D18 dashboard half — email is Step 18). **14 (share→offer, D9/D10):** share caption (payload carries `ig_post_media_id` + title — the plan's permalink map stayed unnecessary) → one structured `parseOfferCaption` call matched to KB service keys → cached in `settings.offer_cache` keyed by media id (capped 50, one parse per post, cross-lead); ladder enforced in CODE at quote time (`isOfferFresh` ms-compare vs `offer_stale_days`, 0 = instantly stale) → prompt gets a LIVE OFFER (quotable, overrides KB) or STALE OFFER (never quote) block; the thread's latest offer rides in `bot_state.last_offer` so follow-up "price?" turns see it; shadow logs the offer in the decision row but writes nothing. **15 (vision):** IG image DM with CDN url → bytes fetched → `inline_data` on the turn's user content + KB-service-match addendum; fetch/parse failures degrade to a plain text turn (WA images carry no url — IG-first, D5). **Learned:** asserting on prompt-marker strings broke because the system prompt itself now names the LIVE/STALE blocks — tests key on the ladder block's distinctive phrases instead. Unit suite green (offer ladder a–h, capture, vision, freshness).

- 2026-08-25 · Steps 8–12 live · user ran the whole live batch against the published deploy and confirmed all checks (live turn/disclosure, medical handoff card, takeover stickiness, non-lead filing + chips, shadow row). Steps 1–12 now fully live-verified.

- 2026-08-25 · Publish 3/15 + Step 6 live · Steps 8–12 committed (ff69688) and **published**; `GEMINI_API_KEY` set in Netlify + validated by the one live Gemini call (`scripts/live-gemini-check.js`): 1.4 s, parseable structured JSON, Hinglish reply, KB service key extracted. Now the live verify batch (Status block) before Step 13.
- 2026-08-25 · Steps 8–12 · Turn pipeline completed. **8:** live turn — context = last-10 messages minus the just-inserted inbound (`processIncomingMessage` now returns its row), one Gemini call, send via existing per-platform senders, outgoing persisted `is_bot=true`, category+qualification persisted every turn (D14), disclosure code-prepended on the first bot *send* (D15), phone digit-normalized in code (D16), `bot_active=true` on new-lead creation when mode live/shadow (D6 — comment-automation leads get it too, deliberately: the bot continuing qualification after "which branch?" is the intended flow). **9:** `handoffToStaff` — safety tiers send NOTHING; kb_miss/llm_error → canned hold copy; model handoffs → model's closing reply; `handoff_summary` built in code (no 2nd LLM call), medical/emergency carry verbatim customer words; `bot_active=false`+`status:'qualified'`; failed courtesy send never aborts the handoff. is_medical (layer 2) overrides the model's reply. Dashboard: summary card replaces thread, raw collapsible, raw expanded for medical, 🤖 marker on bot bubbles. **10:** meta-send flips `bot_active=false` on every successful staff send (best-effort, never 502s a delivered message); 🤖⏯ Take-over button in branch + admin chat headers (visible only while bot on); comment automation DM does NOT flip (it's not staff). **11:** non-lead → one canned reply → `category` filed + bot off, no status change; category toggle (All/Leads/Collab/Sales/Misc — "Leads" includes pre-bot null-category rows) + colored tags on lead cards. **12:** shadow branch after the decision — exactly ONE `bot_shadow_log` row per turn (success / Gemini error / safety tier), zero sends, zero lead mutations; dedup already gates it via the fresh-insert check. **Learned:** test-mock ordering bug caught by the suite — the API returns history newest-first and `listRecentMessages` reverses in place; a mock that fed oldest-first silently swapped prompt roles. Unit suite green (full §8.1 set). Live checks all deferred to the single publish batch (needs `GEMINI_API_KEY` in Netlify env).

- 2026-08-24 · Step 1 · §4 schema applied via SQL editor + verified over REST (all cols/tables live, old rows carry defaults, existing reads fine). Deviation: plan's `bigint lead_id` → **uuid** (`leads.id` is UUID). Found + fixed pre-existing drift: live `leads` has `email`/`assigned_to`, lacks `service`/`notes`/`updated_at` the schema file claimed — nothing in this repo's code touches the dead columns (grep-verified), so no breakage.
- 2026-08-24 · Step 2 · attachments labeled instead of dropped, unit + live verified (share → `🔗 shared post: <caption>`, photo → `📷 image` on test IG). **Live finding:** shared posts arrive as `ig_post` (legacy `share` type removed ~Feb 2026 — brainstorm doc was stale); payload carries `ig_post_media_id` directly, so plan §3.4's permalink→media-id map is unnecessary for shares. Real-image display in inbox deliberately NOT built (CDN url is short-lived; durable fetch+store arrives with Step 15 vision, which needs the bytes anyway).
- 2026-08-24 · Step 3 · `chatbot_config` settings row + Settings card (mode off/shadow/live applies on click, model, 7 canned replies, caps, KB status line). Unit-verified incl. REST round-trip vs live Supabase (default row now exists, `mode:'off'`); browser eyeball deferred to the Step 3–7 publish batch. No SQL-editor step needed — defaults merge in code, row materialized on first save. Canned copy is placeholder pending client/clinician sign-off (Phase 1).
- 2026-08-24 · Step 4 · KB seeded via `scripts/seed-kb.js` (dev-only): 28 service entries with corpus-mined prices (latest-quote-wins D22; attribution = service most recently asked about in thread context, skip staff shared-posts/canned/phones/round-number filter) + 10 FAQ entries in staff voice from the distill. **Learned:** the distill ₹-conflict tables mislead — they tag amounts by thread topic, so "microblading 12k last 2026-08" was actually 2025 offer prices; direct ask→answer threads show 25000@2026-03 is the latest real quote. Per-session vs package ambiguity remains (e.g. PRP "10k for 5 sessions") — KB keeps `price_last_quoted` + `quotes_seen` visible for the client sanity check.
- 2026-08-24 · Steps 5–7 · Turn-pipeline core: `classifyInbound` (36 emergency / 30 medical / 12 requested patterns, EN+Hinglish corpus phrasings; risk-FAQ words safe/pain/PCOS deliberately excluded — those pass to layer 2 per D8), `callAssistant` (raw fetch, responseSchema structured decision, whole-KB injection D20, throws → llm_error D13), `botReply` wired after `routeLeadFromReply` (no-ops on bot_active=false / mode:'off'; safety tier → minimal handoff; never throws). **Learned (live-probed):** PostgREST `resolution=ignore-duplicates` CANNOT target the PARTIAL unique index on `external_message_id` — redeliveries surface as 23505, not a silent no-op; pre-existing code therefore logged an error and skipped routing on every redelivery. Now caught in `insertMessage` → returns `[]` → `processIncomingMessage` returns `inserted:false` → redelivery gets no bot turn (open #10 signal). Step 6's one live Gemini call still pending key; redelivery replay + Settings browser eyeball join the Step 3–7 publish batch.

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
- **Status:** ✅ done 2026-08-24 (unit: syntax + suite + REST round-trip vs live Supabase — upsert/read-back/flips, default row left in place `mode:'off'`; browser round-trip joins the Step 3–7 publish batch)

### Step 4 — KB seed from corpus (D22)
- **Implement:** KB entries from the distill (staff voice, Hinglish) into `chatbot_config.kb`; **prices mined latest-quote-wins per service** (resolves distill ₹-conflict tables by message timestamp); services with no corpus price stay unpriced (HITL later, Step 13); `prices_verified_at` set.
- **Verify:** script output review — spot-check 10 services against distill files; every priced service shows its latest quote, not an older one.
- **Status:** ✅ done 2026-08-24 (`scripts/seed-kb.js` — 28 service + 10 FAQ entries written, `prices_verified_at` set, mode untouched; spot-check: 6 exact vs distill, 3 "misses" turned out to be distill-table noise — miner's ask-context attribution is more precise than the distill's topic-tagged ₹ tables; PEEL COSMELAN unpriced → HITL; soft entries CHEMICAL PEEL/Q SWITCH 35000 single-quote, flagged for client sanity check)

## Turn pipeline (live on test app)

### Step 5 — `classifyInbound` keyword net
- **Implement:** pure function, English + Hinglish net mined from real corpus phrasings (khujli, dawai, daag, ilaj, garbhvati…), emergency/medical/requested tiers (final plan §3.2, D7 layer 1).
- **Verify:** unit assertions (final plan §8.1): medical/emergency/requested → handoff; FAQ ("price of laser") passes; emergency outranks medical.
- **Status:** ✅ done 2026-08-24 (36 emergency / 30 medical / 12 requested substring patterns; evaluation order = priority; §8.1 assertions green incl. "PCOS hai to laser safe?" passes and emergency-outranks-medical; risk-FAQ words deliberately excluded — layer 2 handles nuance, Step 16 replay tunes the net)

### Step 6 — Gemini client `callAssistant`
- **Implement:** raw fetch `generateContent`, `x-goog-api-key` (`GEMINI_API_KEY`), full responseSchema — `{category, is_medical, reply, kb_covers, handoff, reason, qualification}` (final plan §3.5). Whole KB injected (D20).
- **Verify:** unit test with mocked fetch (schema mapping, error throw); one **live** call with real key returns parseable structured JSON (this validates the model choice D1 early).
- **Status:** ✅ done 2026-08-24 unit-mocked; **live call ✅ 2026-08-25** (`scripts/live-gemini-check.js` — 1.4 s, valid structured JSON, Hinglish reply, correct KB service key. Note: model returned `reason:'kb_miss'` with `kb_covers:true/handoff:false` — inconsistent combo, harmless while live path keys off handoff/category; prompt nudge queued for Step 16 tuning)

### Step 7 — `botReply` wiring + guards
- **Implement:** hook into `handleWebhook` loop after `routeLeadFromReply`; no-op when `bot_active=false` / `mode:'off'`; everything try/catch (bot never drops/delays an inbound, D13); **dedup check before `botReply`** (redelivered event → no second reply).
- **Verify:** unit no-op tests; **webhook-redelivery replay test** (open #10): same payload twice → zero bot replies in off mode / exactly one once live (Step 8).
- **Status:** ✅ done 2026-08-24 (unit: no-ops, safety-before-Gemini, crash-swallow; live: `insertMessage` redelivery → `[]` → `inserted:false` verified against live Supabase — **learned:** PostgREST ignore-duplicates can't target the partial unique index, redelivery = 23505, now caught; the webhook replay itself joins the Step 3–7 publish batch)

### Step 8 — Live turn: reply + persist
- **Implement:** send via `sendByPlatform`, store outgoing `is_bot=true`; persist category (every turn, D14) + qualification into `leads`/`bot_state`; disclosure prepend on first bot turn (D15); phone 10-digit code-normalized (D16); `bot_active=true` on new-lead creation when bot on (D6). Flip test deployment `mode:'live'`.
- **Verify:** live DM "price of laser" to test IG → KB-range reply + next qualification question lands in thread; DB rows correct (`is_bot`, category, bot_state).
- **Status:** ✅ done 2026-08-25 unit-verified (send→persist, disclosure, phone, D6, is_bot, category/bot_state every turn; live DM turn joins the publish batch — needs `GEMINI_API_KEY` in Netlify env + `mode:'live'` flip)

### Step 9 — Handoff paths + summary card
- **Implement:** `handoffToStaff` — medical/emergency/requested/qualified/llm_error/turn_cap; `bot_state.handoff_summary`; `bot_active=false`, `status='qualified'`; **summary card UI replaces thread, raw collapsible, raw expanded for medical (D11)**; `llm_error` catch → canned handoff (D13).
- **Verify:** live "khujli ho rahi hai" → NO answer, handoff, summary card in dashboard; simulate LLM failure (bad key) → canned "let me connect you" + handoff, inbound still stored.
- **Status:** ✅ done 2026-08-25 unit-verified (safety tiers send nothing; kb_miss/llm_error canned; summary in code w/ verbatim medical words; qualified flip; send-failure doesn't abort handoff; summary card + 🤖 marker shipped. turn_cap reason exists — the cap itself is Step 18/#17. Live card eyeball joins the publish batch)

### Step 10 — Auto-takeover + Take-over button
- **Implement:** any staff outgoing message flips `bot_active=false`, sticky (D12) — guard in existing staff send path; Take-over button as shortcut.
- **Verify:** live: staff replies from dashboard → subsequent customer DMs get no bot reply; button does the same instantly.
- **Status:** ✅ done 2026-08-25 (meta-send guard: best-effort flip after persist, never 502s a delivered message; 🤖⏯ button in branch + admin headers, visible only while bot on; comment-automation DM deliberately does NOT flip. Live stickiness check joins the publish batch)

### Step 11 — Non-lead handling + category chips
- **Implement:** collab/sales/misc → 1 canned reply (config copy) → `bot_active=false`, filed under `leads.category` (D2/D14); category filter chips in leads list.
- **Verify:** live collab-style DM ("we'd love to collaborate") → one canned reply, filed, bot silent after; chips filter correctly.
- **Status:** ✅ done 2026-08-25 unit-verified (one canned reply w/ disclosure on first turn → category filed, bot off, NO status change; branch Leads category toggle + colored card tags; "Leads" chip includes pre-bot null-category rows. Live filing + chips check joins the publish batch)

### Step 12 — Shadow mode wiring
- **Implement:** mode branch after Gemini decision; `logShadowTurn` → one `bot_shadow_log` row/turn; invariants: never send, never mutate leads, one row even on error, dedup first (D19).
- **Verify:** unit invariant tests; live: flip `mode:'shadow'`, DM → log row exists, **no reply sent, no lead mutation**; flip back to live.
- **Status:** ✅ done 2026-08-25 unit-verified (shadow = one row on success/Gemini-error/safety-tier, zero sends, zero lead mutations, no Gemini on safety tier, latency_ms recorded; dedup = the fresh-insert gate already before botReply. Live shadow row check joins the publish batch)

### Step 13 — Teach-the-bot loop (D17 + D22 price HITL)
- **Implement:** `kb_covers:false` → `kb_miss` handoff (canned hold reply, summary "Bot didn't know: \<q\>"); first staff reply on that thread → `kb_candidates` row; dashboard **Teach-the-bot** list (Approve / Edit+Approve / Discard) → approved joins `chatbot_config.kb` tagged `learned:<YYYY-MM>`; `kb_miss`/emergency badge (D18).
- **Verify:** live: ask an unpriced/unknown question → hold reply → staff reply from dashboard → candidate appears → Approve → **re-ask the same question → bot answers from the learned entry**.
- **Status:** ✅ done 2026-08-25 unit-verified (summary line + `bot_state.kb_miss_question`; meta-send captures first staff reply → `kb_candidates`, exactly-once, best-effort; Teach the Bot card — approval folds price answers into the word-matched service entry (D22 newest-quote-wins) else a `learned:` FAQ; ❓ kb_miss / 🔴 emergency badges on branch lead cards. Live teach-loop check joins the next publish batch)

### Step 14 — Share→offer price (D9/D10)
- **Implement:** permalink → media id map (one-time `GET /{IG_ID}/media`, refresh on miss) → caption → Gemini parse → cache `{service, offer_price, last_seen, source_caption}`; offer ladder at quote time: fresh offer → quote it; stale (`offer_stale_days`) → KB range; no offer → KB range; no match → "after consultation".
- **Verify:** live: share an offer post + "price?" → offer price quoted ("as in the post"); set `offer_stale_days=0` → same share now returns KB range.
- **Status:** ✅ done 2026-08-25 unit-verified (**deviation:** permalink map unnecessary — payload carries `ig_post_media_id` + caption directly, Step 2 live finding). Cache = `settings.offer_cache` keyed by media id (cap 50, cross-lead, one parse per post); freshness computed in code (ms compare — `offer_stale_days:0` = instantly stale) → LIVE/STALE prompt block; follow-up turns read `bot_state.last_offer`; no-match/parse-fail/share-sans-caption → plain KB ladder. Live ladder check joins the next publish batch)

### Step 15 — Raw-image vision fallback
- **Implement:** image DM → Gemini vision (`inline_data`) + KB service list → "which service is this?" → answer normally (fallback model `gemini-3.7-flash` if Lite flaky, D1).
- **Verify:** live: send a screenshot of a service post → correct service identified, KB price answered.
- **Status:** ✅ done 2026-08-25 unit-verified (IG image with CDN url → bytes → `inline_data` + KB-match addendum on the user turn; fetch failure degrades to a plain text turn; WA images carry no url in the webhook → no vision there yet, IG-first D5. Model fallback = config `model` field, nothing to build. Live screenshot check joins the next publish batch)

### Step 16 — Corpus replay harness
- **Order note (2026-08-25):** runs AFTER 17–18 (user decision) so replay measures the final prompt — see Status. Tuning loop on a fixed ~300-stratified-thread sample (price / offers / collab / safety / long threads); full corpus once at the end for §8.3. Local scripts — zero publishes. Script needs throttle + 429 backoff (free-tier viable on the sample; full pass ≈ $4 paid or a throttled week free).
- **Implement:** `scripts/replay-shadow.js` (feed `ig_export_history.jsonl` threads through the real pipeline → shadow-log-shaped local rows) + `scripts/review-shadow.js` (sample + stats: category/reason/malformed/is_medical rates, latency p50/p95).
- **Verify:** run over the 1,970-thread corpus end-to-end; review output readable; **tune KB/prompt until drafts are acceptable vs actual staff replies** (this is the cheap iteration loop before relying on live traffic).
- **Status:** 🔄 scripts done 2026-08-25 (built + 2-thread live smoke through real Gemini: age cap fired across a 9-day gap, counter ticks only on drafted turns, drafts-vs-staff readable in review). Sample run (300 threads ≈ 1,273 turns + 83 offer parses, ~85 min @15 RPM) started same day. Remaining: sample run → review → tune → `--all` full pass for §8.3. **Deviation:** output is a local `artifacts/data/replay-*.jsonl`, not live `bot_shadow_log` rows — replay would pollute Step 19's shadow metrics and duplicate on tuning re-runs; rows carry the staff's actual reply for the comparison.

### Step 17 — Soft booking (D3)
- **Implement:** prompt-side — collect preferred day/time once lead is engaged; `qualification.preferred_time` → carried on handoff summary; staff lock in Clinicea. No calendar.
- **Verify:** live: run a qualify→agree flow → handoff summary contains service + branch + preferred day/time.
- **Status:** ✅ done 2026-08-25 unit-verified (prompt now names the soft-booking drive explicitly — work toward preferred day/time once engaged, confirm + hand off `wants_booking` on a booking intent, NEVER confirm a slot yourself; `preferred_time` already flowed schema → `bot_state` → summary ("preferred \<time\>") from Steps 8–9, so the only new plumbing is the wording. Unit: summary carries `branch` + `preferred`, prompt contains the Soft-booking rule. Live qualify→agree check joins the publish batch)

### Step 18 — Alerts + caps + metrics
- **Implement:** email alert on `emergency` + `kb_miss` (one mechanism, two triggers, D18 — badge exists from Step 13); turn cap 10 + 7-day conversation-age cap (#17 — confirm finals); success-metric weekly SQL (#18: ≥60% handoffs phone+service+location, zero missed medical).
- **Verify:** trigger kb_miss → email arrives; cap: send 11 DMs → turn_cap handoff on #11; metrics query returns real numbers.
- **Status:** ✅ done 2026-08-25 unit-verified (**caps (#17 finals = 10 turns / 7 days, both already Settings-card fields):** checked in `botReply` after the safety net, before Gemini — `bot_state.turn_count` (ticked on each delivered normal live turn) ≥ `turn_cap` → the 11th inbound hands off; lead older than `conversation_age_cap_days` → same; `turn_cap` handoff sends the hold copy (`canned.turn_cap` if set, else llm_error copy); safety outranks the cap; no disclosure re-prepend on a turn-capped thread; shadow logs the cap row but never ticks the counter (replay must inject a synthetic count — noted in Status). `findLeadByPlatformId` now selects `created_at`. **Alerts (D18):** `sendBotAlert` — Resend email on emergency/kb_miss handoffs only, best-effort (missing key/failure logs + moves on), `cfg.alert_email` override, verbatim text HTML-escaped; medical/qualified/normal → no email; no alerts in shadow. **Metrics (#18):** `scripts/bot-metrics.sql` — weekly SQL-editor run: % complete handoffs (≥60% target), safety/kb_miss/turn_cap counts, missed-medical invariant (0), volume. Live email/cap/SQL checks join the publish batch)

## Client rollout (plan Phase 5/6)

### Step 19 — Client shadow-first rollout
- **Move off our test accounts first (nothing so far touches the client's).** Repeat on the client's side what we set up for testing — [PROJECT_DOCUMENTATION.md §15 Meta app requirements](PROJECT_DOCUMENTATION.md#meta-app-requirements-learned-the-hard-way) has the gotchas:
  - [ ] **Meta app** owned by the client (their Business Manager): app icon, privacy policy URL, category, set to **Live**; Business Verification if Meta asks.
  - [ ] **Client IG professional account + FB Page** linked and connected to that app; tokens generated (`META_ACCESS_TOKEN`, `META_PAGE_ACCESS_TOKEN`).
  - [ ] **App Review → Advanced Access** on `instagram_business_manage_messages` (+ Messenger equivalent) — without it the public can't reach the bot, only app-role users (open #3 in doc §22). Long pole — start early.
  - [ ] **Site** on the client's side (their Netlify account / domain) deploying this repo; every env var in doc §18 set to the client's values (`META_*`, `GEMINI_API_KEY`, `RESEND_API_KEY`, `INTERNAL_FUNCTION_SECRET`, `META_BRANCH_ID`) → redeploy.
  - [ ] **Webhook** callback = `<client site>/webhook/meta`, verify token matches, fields subscribed (`messages`, `messaging_postbacks`, `comments` if comment automation goes on); IG `subscribed_apps` confirmed.
  - [ ] **Client-owned Supabase project** (ours is mock): apply [SUPABASE_SCHEMA.sql](SUPABASE_SCHEMA.sql) — trust the code over the file where they drift (doc §17) — insert the real branches (new UUIDs → `META_BRANCH_ID`), set `SUPABASE_URL`/`SUPABASE_ANON_KEY` to it (the browser gets them from the same env vars), re-run `scripts/seed-kb.js --write` against it, then configure `chatbot_config` in Settings (the Settings card creates the row on first save).
  - [ ] Start the client install at `mode:'off'`, re-run the Steps 2–18 live checks with a staff account DMing the client IG, then flip to shadow.
- **Implement:** deliver same code + [final plan](artifacts/CHATBOT_FINAL_PLAN_2026-08-24.md) to client; client KB gets Phase 1 sign-offs (clinician risk/guardrail wording, offers.md, canned #2); flip client `mode:'shadow'` on real traffic; seeded scenarios re-run on their app.
- **Pre-19 build — scheduled metrics email (client wants DAILY analytics; approach locked 2026-08-25):** NO new settings card/section — `chatbot_config.report_frequency: 'off' | 'daily' | 'weekly'` dropdown in the **existing Chatbot card** (recipient = `alert_email`). ONE daily scheduled function decides at runtime (daily → send every run · weekly → Mondays only · off → skip) — the `check-automations` pattern, not a second cron. Content = the same numbers as [scripts/bot-metrics.sql](scripts/bot-metrics.sql) computed over Supabase REST, emailed via Resend; the SQL file stays for ad-hoc runs. Deliberately NOT the `cashup_automations` per-report config model — one fixed digest, one config field.
- **Metrics email: ✅ built 2026-09-23** (`send-bot-report.js`; live check = set Report: daily + an email, wait for 09:00 IST, or trigger the function from the Netlify UI).
- **Verify:** **exit criteria** (final plan §8.3): ≥30 leads/≥100 turns · ≥10 seeded Hinglish medical = 0 drafted answers · malformed <2% · offer extraction ≥90% · 20-draft sign-off. Not met → fix, extend shadow.
- **Status:** ☐ not started

### Step 20 — Client live
- **Implement:** flip `mode:'live'` via Settings toggle (D24).
- **Verify:** week-1 review (daily 48h via review script on `is_bot=true`, then weekly); 30-day metrics vs #18 targets. Toggle stays as permanent throttle (off / shadow / live).
- **Status:** ☐ not started

---

## Client-side items pending (gate Step 19, not the test build)

- [x] ~~Price sheet~~ — **resolved 2026-08-25, client declined to provide one:** "Learn the pricing from previous conversations as they must be provided there; if any isn't provided should push to human in the loop to fetch the pricing" — i.e. D22 confirmed verbatim (corpus latest-wins + kb_miss HITL, Steps 4 + 13 already shipped). No sheet will arrive; sanity-check banner (open #5) stays corpus-based.
- [ ] offers.md confirmation; 2nd canned template approved copy
- [ ] Clinician sign-off on risk-FAQ + guardrail wording
- [ ] Gemini API key **on the client's account** (ours powers the test build; Step 6 live check was done with it)
- [ ] Admin access to the client's Meta Business Manager, IG professional account and FB Page (for the Step 19 account setup)
- [ ] Where the production site lives (client Netlify account / domain) + Resend sender domain for alert/report emails
