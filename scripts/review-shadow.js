// Chatbot Step 16 — replay review (final plan §8.2/§8.3).
// Reads a replay-shadow.js output file and prints the tuning numbers:
// reason/category/is_medical rates, malformed rate (<2% target), offer ladder
// fresh/stale + the extraction table (≥90% correct needs an eyeball here),
// latency p50/p95, the missed-medical invariant (must be 0), and a side-by-side
// sample of bot drafts vs what staff actually replied — the "would you send
// this?" loop (D21: humans edit text, not gradients).
//
// Usage:
//   node scripts/review-shadow.js                     # newest artifacts/data/replay-*.jsonl
//   node scripts/review-shadow.js --file artifacts/data/replay-full.jsonl
//   node scripts/review-shadow.js --sample 30 --bucket safety

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const DATA = path.join(ROOT, 'artifacts', 'data');
const fileArg = opt('file', '');
const file = fileArg
  ? (path.isAbsolute(fileArg) ? fileArg : path.join(ROOT, fileArg))
  : path.join(DATA, fs.readdirSync(DATA).filter(f => /^replay-.*\.jsonl$/.test(f))
      .sort((a, b) => fs.statSync(path.join(DATA, b)).mtimeMs - fs.statSync(path.join(DATA, a)).mtimeMs)[0] || '');
if (!file || !fs.existsSync(file)) { console.error('[review] no replay-*.jsonl found — run scripts/replay-shadow.js first'); process.exit(1); }

const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(r => r && !r.done);   // done-markers aren't turns
const bucketFilter = opt('bucket', '');
const view = bucketFilter ? rows.filter(r => r.bucket === bucketFilter) : rows;

const pct = (a, b) => b ? Math.round(1000 * a / b) / 10 + '%' : '—';
const hist = (map) => [...Object.entries(map)].sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${k}:${n}`).join(' · ') || '(none)';

// ── tallies ──
const reason = {}, category = {}, tiers = {};
let llm = 0, errors = 0, malformed = 0, infraErr = 0, handoffs = 0, isMed = 0, medForced = 0, offerTurns = 0, fresh = 0;
// #18 completeness, measured like bot-metrics.sql: live handoff is terminal, so one
// per thread (the FIRST), judged on qualification accumulated up to it (mergeBotState).
let hoPhone = 0, hoSvc = 0, hoLoc = 0, hoFull = 0, hoThreads = 0, turnsBeforeHo = 0;
const qual = new Map(), handedOff = new Set(), seen = new Map();
// Replay can't answer the bot's WhatsApp ask (customer turns are fixed), so the
// prompt-controlled signal is: did the bot ASK before a model-driven handoff?
const ASK_RE = /whatsapp|number|contact/i, asked = new Set();
let leadDrafts = 0, draftAsks = 0, modelHo = 0, modelHoUnasked = 0;
const latencies = [], offers = new Map();
let missedMedical = 0;

for (const r of view) {
  const d = r.decision;
  if (!d) {
    errors++;
    // 429/quota/network blips are infrastructure, not model output quality —
    // the <2% target (§8.3) counts only genuinely malformed responses.
    if (/429|quota|fetch failed/i.test(r.error || '')) infraErr++; else malformed++;
    reason['(no decision)'] = (reason['(no decision)'] || 0) + 1; continue;
  }
  reason[d.reason || '?'] = (reason[d.reason || '?'] || 0) + 1;
  if (d.safety_net) tiers[d.safety_net] = (tiers[d.safety_net] || 0) + 1;
  else if (!r.error && d.reason !== 'turn_cap') { llm++; category[d.category || '?'] = (category[d.category || '?'] || 0) + 1; }
  const q = qual.get(r.thread_id) || {};
  for (const [k, v] of Object.entries(d.qualification || {})) if (v) q[k] = v;
  qual.set(r.thread_id, q);
  const drafted = !d.safety_net && d.category === 'lead' && String(d.reply || '').trim();
  if (drafted) { leadDrafts++; if (ASK_RE.test(d.reply)) { draftAsks++; asked.add(r.thread_id); } }
  if (d.handoff) handoffs++;
  // Live botReply files a non-lead BEFORE the handoff check (no handoff_at) — it
  // ends the thread but isn't a lead handoff, so it's out of the #18 denominator.
  if (!d.safety_net && d.category && d.category !== 'lead') handedOff.add(r.thread_id);
  if (d.handoff && !handedOff.has(r.thread_id)) {
    handedOff.add(r.thread_id); hoThreads++;
    turnsBeforeHo += seen.get(r.thread_id) || 0;
    if (q.phone) hoPhone++;
    if (q.service) hoSvc++;
    if (q.location || q.branch) hoLoc++;
    if (q.phone && q.service && (q.location || q.branch)) hoFull++;
    if (['qualified', 'wants_booking', 'declined_booking'].includes(d.reason)) {
      modelHo++;
      if (!q.phone && !asked.has(r.thread_id)) modelHoUnasked++;
    }
  }
  seen.set(r.thread_id, (seen.get(r.thread_id) || 0) + 1);
  if (d.is_medical) isMed++;
  if (d.safety_net === 'medical') medForced++;
  // Invariant: an is_medical or safety-net turn must never carry a drafted reply.
  if ((d.is_medical || d.safety_net) && String(d.reply || '').trim()) missedMedical++;
  if (typeof r.latency_ms === 'number') latencies.push(r.latency_ms);
  if (d.offer) {
    offerTurns++; if (d.offer.fresh) fresh++;
    const k = `${d.offer.service} ₹${d.offer.offer_price}`;
    const o = offers.get(k) || { n: 0, fresh: 0, caption: d.offer.source_caption || '' };
    o.n++; if (d.offer.fresh) o.fresh++; offers.set(k, o);
  }
}
latencies.sort((a, b) => a - b);
const p = (q) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : 0;

console.log(`# Replay review — ${file}${bucketFilter ? ` (bucket: ${bucketFilter})` : ''}`);
console.log(`threads(turns) ${view.length} · Gemini turns ${llm} · errors ${errors} (infra ${infraErr} · malformed ${malformed} = ${pct(malformed, llm + malformed)} — target <2%)`);
console.log(`reason   ${hist(reason)}`);
console.log(`tier     ${hist(tiers)} → forced medical handoffs ${medForced}, is_medical flags ${isMed}`);
console.log(`category ${hist(category)}`);
console.log(`handoffs ${handoffs} (${pct(handoffs, view.length)} of turns) · first per thread ${hoThreads}, after avg ${hoThreads ? (turnsBeforeHo / hoThreads).toFixed(1) : '—'} turns`);
console.log(`complete ${pct(hoFull, hoThreads)} phone+service+location (target ≥60%) · WhatsApp # ${pct(hoPhone, hoThreads)} · service ${pct(hoSvc, hoThreads)} · location/branch ${pct(hoLoc, hoThreads)}`);
console.log(`asks     ${pct(draftAsks, leadDrafts)} of ${leadDrafts} lead drafts ask for WhatsApp · model handoffs ${modelHo}, phone never asked ${modelHoUnasked} (want 0)`);
console.log(`offers   ${offerTurns} offer turns · ${fresh} fresh / ${offerTurns - fresh} stale`);
console.log(`latency  p50 ${p(0.5)}ms · p95 ${p(0.95)}ms (n=${latencies.length})`);
console.log(`MISSED MEDICAL: ${missedMedical} (must be 0)\n`);

if (offers.size) {
  console.log('## Offer extraction table (eyeball ≥90% correct — service/price vs caption)');
  for (const [k, o] of [...offers.entries()].sort((a, b) => b[1].n - a[1].n))
    console.log(`  ${String(o.n).padStart(3)}× (${o.fresh} fresh) ${k}  ←  ${JSON.stringify(String(o.caption).slice(0, 90))}`);
  console.log('');
}

// ── draft vs staff sample — evenly spaced, deterministic ──
const drafted = view.filter(r => r.decision && !r.error && String(r.decision.reply || '').trim());
const N = Math.min(Number(opt('sample', 15)), drafted.length);
console.log(`## Draft sample — ${N} of ${drafted.length} drafted turns (bot draft vs what staff actually replied)\n`);
for (let i = 0; i < N; i++) {
  const r = drafted[Math.floor(i * drafted.length / N)];
  console.log(`─ [${r.bucket}/${r.decision.reason}] @${r.username} (${r.at.slice(0, 10)}) turn_count=${r.synthetic_turn_count}`);
  console.log(`  customer : ${JSON.stringify(String(r.inbound || '').slice(0, 200))}`);
  console.log(`  BOT draft: ${JSON.stringify(String(r.decision.reply).slice(0, 300))}`);
  console.log(`  staff did: ${JSON.stringify(String(r.staff_reply || '(no reply)').slice(0, 300))}\n`);
}
