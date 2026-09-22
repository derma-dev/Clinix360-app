// Chatbot Step 16 — corpus replay harness (final plan §8, D21).
// Feeds ig_export_history.jsonl threads through the REAL decision pipeline
// (classifyInbound + caps + offer ladder + callAssistant) in shadow semantics:
// nothing is sent, nothing touches Supabase except the READ of chatbot_config.
// Output = local JSONL shaped like bot_shadow_log rows plus review extras
// (staff's actual reply, strat bucket, synthetic turn state). Local file, not
// the live table: replay rows would pollute Step 19's shadow metrics and
// re-running the tuning loop would duplicate them.
//
// Usage:
//   node scripts/replay-shadow.js                # ~300 stratified-thread sample → replay-sample.jsonl
//   node scripts/replay-shadow.js --all          # full corpus → replay-full.jsonl (§8.3 numbers)
//   node scripts/replay-shadow.js --dry          # plan only: buckets, turn counts, call estimate — no API
//   node scripts/replay-shadow.js --limit 5      # smoke: first N threads of the selection
//   node scripts/replay-shadow.js --bucket price --out replay-price.jsonl   # one strat bucket only
//   node scripts/replay-shadow.js --rpm 15       # throttle (default 15 calls/min, free-tier friendly)
// Re-running the same command RESUMES: threads already in the output file are skipped.
// 429/5xx → exponential backoff; a daily-quota 429 stops the run gracefully (just re-run later).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { classifyInbound, callAssistant, parseOfferCaption } = require('../netlify/functions/utils/meta-service');

const CORPUS = path.join(ROOT, 'artifacts', 'data', 'ig_export_history.jsonl');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const DRY = flag('dry'), ALL = flag('all');
const OUT = path.join(ROOT, 'artifacts', 'data', opt('out', ALL ? 'replay-full.jsonl' : 'replay-sample.jsonl'));
const RPM = Number(opt('rpm', 15)), LIMIT = Number(opt('limit', 0));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── config: the live chatbot_config (KB, model, caps) — same read getSettingJson does ──
async function loadConfig() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
  const res = await fetch(`${url}/rest/v1/settings?key=eq.chatbot_config&select=value&limit=1`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`chatbot_config read failed: ${res.status}`);
  const rows = await res.json();
  return JSON.parse(rows[0].value);
}

// ── stratified sample (deterministic — the tuning loop must see the same threads) ──
// Priority: safety > offers > collab > price > long > rest. Safety is a tiny bucket
// (53 threads) so it goes in whole; the rest fill ~300 evenly, newest-biased spread.
const PRICE_KW = ['price', 'cost', 'rate', 'charge', 'fees', 'kitna', 'kitne', 'kitni', 'how much', 'paisa', '₹'];
const COLLAB_KW = ['collab', 'collaborat', 'hiring', 'influencer', 'partnership', 'promotion', 'sponsor', 'follow me'];

function bucketOf(thread) {
  const ins = thread.messages.filter(m => m.dir === 'in' && !m.canned);
  if (ins.some(m => classifyInbound(m.text))) return 'safety';
  if (ins.some(m => m.text.startsWith('[shared post:'))) return 'offers';
  const low = ins.map(m => m.text.toLowerCase()).join(' ');
  if (COLLAB_KW.some(k => low.includes(k))) return 'collab';
  if (PRICE_KW.some(k => low.includes(k))) return 'price';
  if (ins.length > 20) return 'long';
  return 'rest';
}

// Evenly spaced across the bucket sorted newest-first — spread, not just the top.
function spread(threads, n) {
  if (threads.length <= n) return threads;
  const out = [];
  for (let i = 0; i < n; i++) out.push(threads[Math.floor(i * threads.length / n)]);
  return out;
}

const QUOTA = { safety: 53, offers: 55, collab: 55, price: 60, long: 3, rest: 74 };   // ≈300 threads

function selectSample(threads) {
  // Threads with no replayable inbound (all-canned / outbound-only) waste quota slots.
  const usable = threads.filter(t => t.messages.some(m => m.dir === 'in' && !m.canned && m.text));
  const byBucket = {};
  for (const t of usable) (byBucket[bucketOf(t)] ||= []).push(t);
  for (const k in byBucket) byBucket[k].sort((a, b) => b.updated_time.localeCompare(a.updated_time));
  const picked = [];
  for (const [b, list] of Object.entries(byBucket)) picked.push(...spread(list, ALL ? list.length : QUOTA[b] ?? 0));
  return { picked: picked.sort((a, b) => a.updated_time.localeCompare(b.updated_time)), byBucket };
}

// ── Gemini call with throttle + 429/5xx backoff ──
let lastCall = 0;
async function throttled(fn) {
  const wait = lastCall + 60000 / RPM - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fn();
}
class QuotaExceeded extends Error {}
// Free tier = 500 requests/day (live-measured 2026-08-26). A quota 429 carries
// "retry in Xs" — X short = a window we can simply wait out; X long (>2 min,
// e.g. hours until the daily reset) = stop the run, resume later.
async function withBackoff(fn) {
  for (let a = 0; ; ) {
    try { return await throttled(fn); }
    catch (e) {
      const msg = String(e.message);
      const q = msg.match(/429[\s\S]*?retry in ([\d.]+)s/i);
      if (q) {
        const wait = parseFloat(q[1]) * 1000 + 2000;
        if (wait > 120000) throw new QuotaExceeded(msg.split('\n')[0]);
        console.warn(`  [replay] quota window — waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;   // a quota wait doesn't consume a retry attempt
      }
      if (!/\b(429|5\d\d)\b/.test(msg) || a >= 4) throw e;
      console.warn(`  [replay] ${msg.split('\n')[0]} — backoff ${2 ** a * 2000}ms`);
      await sleep(2 ** a * 2000);
      a++;
    }
  }
}

// Freshness on the THREAD's clock (isOfferFresh uses Date.now() — the corpus is
// years old, so replay computes freshness against the message timestamp instead).
const isFreshOn = (clock, lastSeen, staleDays) =>
  clock - Date.parse(lastSeen || '') < Number(staleDays == null ? 30 : staleDays) * 86400000;

// In-memory offer cache keyed by normalized caption (the corpus export carries no
// media ids) — one parse per distinct caption, the D9 invariant.
const normCap = (s) => s.toLowerCase().replace(/[^a-z0-9₹]+/g, ' ').trim().slice(0, 120);
const offerCache = new Map();   // normKey → {service, offer_price, last_seen, source_caption}

// The staff reply that ACTUALLY followed an inbound (≤2 outgoing, canned skipped)
// — distill-corpus.js's pairing rule; this is what drafts get compared against.
function staffReplyAfter(messages, i) {
  const out = [];
  for (let j = i + 1; j < messages.length && messages[j].dir === 'out' && out.length < 2; j++)
    if (!messages[j].canned) out.push(messages[j].text.replace(/\s+/g, ' ').trim());
  return out.join(' ⏎ ').slice(0, 500);
}

// ── replay one thread ──
async function replayThread(thread, cfg, append) {
  const cap = Number(cfg.turn_cap ?? 10);
  const ageCapMs = Number(cfg.conversation_age_cap_days ?? 7) * 86400000;
  let turns = 0, firstAt = null, ageResetAt = null, lastOffer = null;

  const msgs = thread.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.dir !== 'in' || m.canned || !m.text) continue;
    const clock = Date.parse(m.at);
    firstAt ??= clock; ageResetAt ??= clock;

    const row = { run: RUN, thread_id: thread.thread_id, username: thread.username,
                  bucket: bucketOf(thread), turn_index: i, at: m.at, synthetic_turn_count: turns,
                  inbound: m.text.slice(0, 300) };

    // D7 layer 1 — safety net first, Gemini never runs (same order as botReply).
    const tier = classifyInbound(m.text);
    // Open #17 caps with the synthetic counter (shadow replay can't tick the live
    // one). After logging a cap we reset the window and keep drafting — a faithful
    // stop would end the thread (bot off), and one row per cap is all review needs.
    const overCap = turns >= cap || (ageCapMs > 0 && clock - Math.max(firstAt, ageResetAt) > ageCapMs);

    try {
      if (tier) {
        row.decision = { safety_net: tier, reason: tier, reply: '', handoff: true };
      } else if (overCap) {
        row.decision = { reason: 'turn_cap', reply: '', kb_covers: false, handoff: true, category: 'lead' };
        turns = 0; ageResetAt = clock;
      } else {
        // Offer ladder (D9/D10): a shared post parses once per caption (in-memory
        // cache); otherwise the thread's last offer rides along, stale or fresh.
        let offer = null;
        if (m.text.startsWith('[shared post:')) {
          const caption = m.text.slice('[shared post: '.length, m.text.replace(/\s+$/, '').length - 1);
          const k = normCap(caption);
          offer = offerCache.get(k) || await withBackoff(() => parseOfferCaption(
            { model: cfg.model, caption, serviceKeys: cfg.kb.entries.filter(e => e.type === 'service').map(e => e.key) }
          ).then(p => p && { ...p, last_seen: m.at, source_caption: caption.slice(0, 200),
                              // A just-parsed offer is fresh by definition (live resolveOffer
                              // sets fresh:true; without this the ladder renders STALE on the
                              // very turn the post was shared).
                              fresh: isFreshOn(clock, m.at, cfg.offer_stale_days) }));
          if (offer) { offerCache.set(k, offer); lastOffer = offer; }
        } else if (lastOffer) {
          offer = { ...lastOffer, fresh: isFreshOn(clock, lastOffer.last_seen, cfg.offer_stale_days) };
        }
        // Live shape: the share turn's prompt text is the attachmentLabel form.
        const inboundText = m.text.startsWith('[shared post:')
          ? `🔗 shared post: ${m.text.slice('[shared post: '.length).replace(/\s+$/, '').slice(0, -1).slice(0, 100)}`
          : m.text;
        const history = msgs.slice(Math.max(0, i - 10), i)
          .map(h => ({ role: h.dir === 'in' ? 'user' : 'model', text: h.text }));
        const t0 = Date.now();
        try {
          let decision = await withBackoff(() =>
            callAssistant({ model: cfg.model, kb: cfg.kb, history, inboundText, offer }));
          row.latency_ms = Date.now() - t0;
          // Layer 2 — is_medical overrides the model's own reply (same as botReply).
          if (decision.is_medical) decision = { safety_net: 'medical', reason: 'medical', reply: '', handoff: true };
          row.decision = offer ? { ...decision, offer } : decision;
          // Counter ticks only on a drafted normal lead reply (live ticks on sends;
          // handoff/non-lead turns are terminal there and don't tick).
          if (!decision.handoff && decision.category === 'lead' && String(decision.reply || '').trim()) turns++;
        } catch (err) {
          if (err instanceof QuotaExceeded) throw err;   // stop the run, don't burn threads as error rows
          row.latency_ms = Date.now() - t0;
          row.error = err.message;   // llm_error equivalent — review's malformed rate
        }
      }
    } catch (err) {
      if (err instanceof QuotaExceeded) throw err;
      row.error = err.message;
    }
    row.staff_reply = staffReplyAfter(msgs, i);
    append(JSON.stringify(row) + '\n');
  }
}

const RUN = new Date().toISOString();

(async () => {
  const threads = fs.readFileSync(CORPUS, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const { picked, byBucket } = selectSample(threads);
  const BUCKET = opt('bucket', '');   // e.g. --bucket price: tune on lead-heavy threads only
  const pool = BUCKET ? picked.filter(t => bucketOf(t) === BUCKET) : picked;
  const selected = LIMIT > 0 ? pool.slice(0, LIMIT) : pool;

  const turnsEst = selected.reduce((n, t) => n + t.messages.filter(m => m.dir === 'in' && !m.canned && m.text).length, 0);
  console.log(`[replay] corpus ${threads.length} threads → selected ${selected.length} (${Object.entries(byBucket).map(([b, l]) => `${b}:${Math.min(l.length, ALL ? l.length : QUOTA[b] ?? 0)}`).join(' ')})`);
  console.log(`[replay] inbound turns to draft: ${turnsEst} · throttle ${RPM}/min · est ${Math.ceil(turnsEst / RPM)} min`);

  if (DRY) {
    const caps = selected.filter(t => t.messages.filter(m => m.dir === 'in' && !m.canned).length > 8).length;
    console.log(`[replay] dry run — no API calls, no output. Distinct share captions to parse: ${new Set(selected.flatMap(t => t.messages.filter(m => m.dir === 'in' && m.text?.startsWith('[shared post:')).map(m => normCap(m.text.slice(13, -1))))).size}`);
    return;
  }
  if (!process.env.GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY (set in .env)');

  const cfg = await loadConfig();
  console.log(`[replay] config: model=${cfg.model} mode=${cfg.mode} turn_cap=${cfg.turn_cap} age_cap=${cfg.conversation_age_cap_days}d kb=${cfg.kb?.entries?.length} entries`);

  // Resume: skip threads whose last row is marked done.
  const done = new Set();
  if (fs.existsSync(OUT)) {
    for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (r.done) done.add(r.thread_id); } catch {}
    }
  }
  const todo = selected.filter(t => !done.has(t.thread_id));
  console.log(`[replay] output ${path.relative(ROOT, OUT)} · resumable (${done.size} threads already done, ${todo.length} to go)`);

  const out = fs.createWriteStream(OUT, { flags: 'a' });
  const append = (s) => out.write(s);
  let n = 0;
  try {
    for (const t of todo) {
      await replayThread(t, cfg, append);
      append(JSON.stringify({ run: RUN, thread_id: t.thread_id, done: true }) + '\n');
      if (++n % 10 === 0 || n === todo.length) console.log(`[replay] ${n}/${todo.length} threads (${new Date().toLocaleTimeString()})`);
    }
    console.log(`[replay] done — review with: node scripts/review-shadow.js${OUT.endsWith('replay-full.jsonl') ? ' --file artifacts/data/replay-full.jsonl' : ''}`);
  } catch (e) {
    if (e instanceof QuotaExceeded) {
      console.warn(`[replay] DAILY QUOTA hit after ${n} threads — re-run the same command later to resume. (${e.message.slice(0, 120)})`);
    } else throw e;
  } finally { out.end(); }
})().catch(e => { console.error('[replay] FAIL:', e.message); process.exit(1); });
