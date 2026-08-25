// Chatbot KB seed (checklist Step 4, D22) — dev-only, not deployed.
// 1. FAQ entries hand-authored from the distill (staff voice, Hinglish) — the
//    answers mirror what staff actually wrote in the corpus.
// 2. Service prices mined from ig_export_history.jsonl: staff-quoted amounts
//    are attributed to the service under discussion (alias match on the
//    customer's recent messages in the thread); LATEST quote per service wins
//    (D22). Services with no corpus quote stay unpriced → kb_miss HITL (Step 13).
//
// Usage:
//   node scripts/seed-kb.js           → review table only (dry-run)
//   node scripts/seed-kb.js --write   → also merge kb into settings.chatbot_config
//
// Spot-check the review table against artifacts/data/distill/*.md before --write.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) throw new Error('No .env found');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ── FAQ entries (distill: staff voice) ──────────────────────────────────────
// Answers mirror real staff replies in the corpus (dates checked, newest
// evidence preferred). Risk/safety wording needs clinician sign-off (D8, Phase 1).
const FAQ_ENTRIES = [
  { id: 'consultation', tags: ['consultation', 'consult', 'fee', 'charges kya', 'appointment fee'],
    a: 'Clinic consultation is free 🙏 You can walk in any day, or share your contact details and our team will book you. (Phone/WhatsApp consult without a visit has a charge.)' },
  { id: 'branches', tags: ['branch', 'location', 'address', 'kahan', 'where', 'clinic'],
    a: 'We have 3 branches — Janakpuri (A1/291, Pankha Road — main branch), Kirti Nagar and Dwarka Sec 12. Which one is nearest to you?' },
  { id: 'timings', tags: ['timing', 'open', 'close', 'kbse kb tk', 'sunday', 'weekend'],
    a: 'Clinic is open 11:00 am – 8:30 pm, all days. Doctor is available till about 6 pm.' },
  { id: 'laser_machine', tags: ['machine', 'soprano', 'which laser', 'technology'],
    a: 'For laser hair removal we use the Soprano Titanium — it is comfortable and suitable for most skin types.' },
  { id: 'laser_sessions', tags: ['sessions', 'sitting', 'kitni sitting', 'how many', 'permanent', 'gap', 'results laser'],
    a: 'Laser hair removal usually takes 6–8 sessions for the face and up to 12 for full body. Sessions are monthly at first, then the gap increases to 2–3 months. Reduction is 98–99% with maintenance sessions if needed.' },
  { id: 'hair_results', tags: ['prp result', 'gfc result', 'hair growth', 'new growth', 'baal', 'hair fall'],
    a: 'PRP/GFC help regrow and strengthen hair — new growth starts coming with the sessions. Sessions are usually monthly, and packages are available. Results are best assessed by the doctor after checking your scalp.' },
  { id: 'safety', tags: ['side effect', 'safe', 'pain', 'painful', 'dard', 'reaction'],
    a: 'The treatments are safe when done by our qualified team. For scalp PRP we apply anesthesia spray first, so it is comfortable. Mild redness for a short time can happen with some treatments. If you have any skin condition or active problem, our doctor will guide you first.' },
  { id: 'emi', tags: ['emi', 'installment', 'emi options', 'payment'],
    a: 'Yes — zero-cost EMI is available (3/6/9 months) on packages.' },
  { id: 'offers', tags: ['offer', 'discount', 'package', 'running offer', 'koi offer'],
    a: 'Offers change from time to time 🤩 If you have shared an offer post, the price in that post applies. For current offers and packages our team shares full details on WhatsApp — share your contact number and we will not spam, promise.' },
  { id: 'contact', tags: ['contact', 'number', 'phone', 'call', 'whatsapp'],
    a: 'You can reach us on WhatsApp at 731-731-09-09. We only call/text with your permission — no spam.' },
];

// ── Service map: Clinicea canonical key (D4) → alias regex from real phrasings ──
// ORDER MATTERS: patterns are tested in array order within one message, and a
// message matching two different keys makes attribution ambiguous (skipped).
const SERVICE_MAP = [
  { key: 'LHR FULL BODY P/S',        re: /full\s*body|head\s*to\s*toe|whole\s*body/i },
  { key: 'LHR FULL FACE P/S',        re: /full\s*face|facial\s*hair|face\s*(laser|lhr)|lhr\s*face|face\s*hair\s*remov|face\s*par\s*hair/i },
  { key: 'LHR LIP CHIN P/S',         re: /(lip|chin)\s*(hair|laser|lhr)|lips?\s+pr\s*(laser|kar)/i },
  { key: 'LHR UNDER ARMS P/S',       re: /under\s*arm|armpit|arm\s*pits?/i },
  { key: 'LHR BIKINI P/S',           re: /bikini|brazil?ian|private\s*area/i },
  { key: 'GFC 360 P/S',              re: /\bgfc\b/i },
  { key: 'QR 678 P/S',               re: /qr\s*678/i },
  { key: 'EXOSOME HAIR/FACE P/S',    re: /exosome/i },
  { key: 'HAIR PRP P/S',             re: /\bprp\b/i },   // bare prp = hair (dominant corpus usage)
  { key: 'HYDRA FACIAL P/S',         re: /hydra?\s*facial|hydrafacial/i },
  { key: 'CARBON FACIAL P/S',        re: /carbon/i },
  { key: 'CO2 LASER P/S',            re: /co\s?2/i },
  { key: 'MNRF P/S',                 re: /\bmnrf\b/i },
  { key: 'MICROBLADING (D) - EYEBROW P/S', re: /microblad/i },
  { key: 'BB Glow P/S',              re: /bb\s*glow/i },
  { key: 'HIFU P/S',                 re: /\bhifu\b/i },
  { key: 'COOL SCULPT P/S',          re: /cool\s*sculpt/i },
  { key: 'IV DRIP (AQUA GOLD) P/S',  re: /iv\s*drip|ivdrip|drip/i },
  { key: 'WHITENING DRIP P/S (BLUEBOX)', re: /gluta|whitening.*(drip|iv)/i },
  { key: 'NANO PLASTIA',             re: /nano\s*plast/i },
  { key: 'PEEL COSMELAN',            re: /cosmelan/i },
  { key: 'ADD ON - CHEMICAL PEEL P/S', re: /chemical\s*peel|peel\s*(ka|ki|price|cost|charge)/i },
  { key: 'PHOTO FACIAL P/S',         re: /photo\s*fac/i },
  { key: 'Q SWITCH LASER P/S',       re: /q[\s-]*switch/i },
  { key: 'DOUBLE CHIN P/S',          re: /double\s*chin/i },
  { key: 'E.P.T.Q (FILLER) 1ML',     re: /filler|e\.?p\.?t\.?q|juvederm|restylane|monolisa/i },
  { key: 'SCAR TREATMENT P/S',       re: /scar/i },
  { key: 'ACNE BUSTER P/S',          re: /\bacne\b|\bpimples?\b/i },
];

// Amounts staff quote: "4500", "4,500/-", "₹39,999", "18k", "4K", "rs 6000".
// Noise guards: 7+ digit runs and space/hyphen-split 10-digit phones removed
// first; amounts kept only if round-ish (corpus prices end in 000/500/999) and
// ≤ 60k (lakh-grouped invoice totals like 1,10,078 drop out).
function extractAmounts(text) {
  const t = text
    .replace(/\d{7,}/g, ' ')                    // phones / invoice totals
    .replace(/\b\d{5}[\s-]\d{5}\b/g, ' ')       // phones written "99903 23294"
    .toLowerCase();
  const out = [];
  const ok = n => n >= 500 && n <= 60000 && (n % 100 === 0 || n % 1000 === 999);
  let m;
  const rxK = /(?:₹|rs\.?\s?|inr\s?)?(\d{1,3}(?:,\d{2,3})*)\s*k\b/g;         // 18k / ₹18k / 4K
  const rxRs = /(?:₹|rs\.?\s?|inr\s?)(\d{1,3}(?:,\d{2,3})+|\d{3,6})\b/g;     // ₹39,999 / rs 6000
  const rxSl = /(\d{1,3}(?:,\d{2,3})+|\d{4,6})\s*(?:\/-|\b)/g;               // 4500/- / 4,500
  const seen = new Set();
  for (const rx of [rxK, rxRs, rxSl]) {
    while ((m = rx.exec(t))) {
      let n = parseInt(m[1].replace(/,/g, ''), 10);
      if (rx === rxK) n *= 1000;
      if (ok(n) && !seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  return out;
}

function servicesIn(text) {
  let hits = SERVICE_MAP.filter(s => s.re.test(text)).map(s => s.key);
  // "acne scars" is a scar ask, not an acne-buster ask (regex overlap)
  if (/scar/i.test(text)) hits = hits.filter(k => k !== 'ACNE BUSTER P/S');
  return hits;
}

// ── Mine the corpus ─────────────────────────────────────────────────────────
// Attribution: a staff price answers the service the customer MOST RECENTLY
// asked about (context = service mentions in the last 8 customer messages,
// ordered by recency). "prp or gfc ka price" → gfc (last mentioned).
function minePrices() {
  const lines = fs.readFileSync(path.join(ROOT, 'artifacts/data/ig_export_history.jsonl'), 'utf8')
    .split('\n').filter(Boolean);
  const quotes = new Map();   // key → [{amount, at, thread}]
  let priceMsgs = 0, attributed = 0;

  for (const line of lines) {
    let thread; try { thread = JSON.parse(line); } catch { continue; }
    const msgs = (thread.messages || []).slice().sort((a, b) => (a.at || '').localeCompare(b.at || ''));
    let ctx = [];             // service keys, most recent LAST
    let inCount = 0;          // customer messages since context start
    for (const msg of msgs) {
      if (!msg.text) continue;
      if (msg.dir === 'in') {
        for (const s of servicesIn(msg.text)) {
          ctx = ctx.filter(k => k !== s);
          ctx.push(s);
        }
        if (++inCount > 8) { ctx = ctx.slice(-1); inCount = 0; }   // stale: keep freshest only
        continue;
      }
      // staff message
      if (msg.canned) continue;                       // greeting template
      if (/^\[shared post/i.test(msg.text)) continue; // re-shared posts aren't quotes
      const amounts = extractAmounts(msg.text);
      if (!amounts.length) continue;
      priceMsgs++;
      if (!ctx.length) continue;                      // no service under discussion
      attributed++;
      const key = ctx[ctx.length - 1];
      if (!quotes.has(key)) quotes.set(key, []);
      quotes.get(key).push({ amounts, at: msg.at, thread: thread.thread_id });
    }
  }
  return { quotes, priceMsgs, attributed };
}

// Latest quote wins (D22). Within the winning (latest) message, the FIRST
// amount is the headline price ("4500 single session, after disc 3500…").
function latestQuote(list) {
  const sorted = list.slice().sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const win = sorted[0];
  return { price: win.amounts[0], at: win.at, all: sorted };
}

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const write = process.argv.includes('--write');
  const { quotes, priceMsgs, attributed } = minePrices();

  console.log(`staff price messages: ${priceMsgs} · attributed to a single service: ${attributed}\n`);

  const serviceEntries = SERVICE_MAP.map(({ key }) => {
    const list = quotes.get(key) || [];
    if (!list.length) return { type: 'service', key, price: null, price_last_quoted: null, quotes_seen: 0, source: 'corpus:none→HITL' };
    const { price, at, all } = latestQuote(list);
    return { type: 'service', key, price, price_last_quoted: at?.slice(0, 7), quotes_seen: list.length,
             history: all.slice(0, 5).map(q => `${q.amounts.join('/')}@${(q.at || '').slice(0, 7)}`),
             source: 'corpus:latest-quote-wins (D22)' };
  }).sort((a, b) => (b.price || 0) - (a.price || 0));

  // Review table (the Step 4 verify artifact)
  console.log('PRICED (latest quote wins):');
  for (const e of serviceEntries.filter(e => e.price)) {
    console.log(`  ${e.key.padEnd(34)} ₹${String(e.price).padEnd(7)} last ${e.price_last_quoted}  [${e.quotes_seen} quotes: ${(e.history || []).join(', ')}]`);
  }
  console.log('\nUNPRICED (no corpus quote → kb_miss HITL, Step 13):');
  for (const e of serviceEntries.filter(e => !e.price)) console.log(`  ${e.key}`);
  console.log(`\nFAQ entries: ${FAQ_ENTRIES.length} · service entries: ${serviceEntries.length}`);

  // history stays console-only — the whole KB is injected into every prompt (D20)
  const kb = { entries: [...serviceEntries.map(({ history, ...e }) => e),
                         ...FAQ_ENTRIES.map(f => ({ type: 'faq', ...f }))],
               prices_verified_at: new Date().toISOString() };

  if (!write) { console.log('\n(dry-run — re-run with --write to merge into settings.chatbot_config)'); return; }

  loadEnv();
  const H = { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' };
  const URL = process.env.SUPABASE_URL + '/rest/v1/settings?key=eq.chatbot_config&select=value';
  let res = await fetch(URL, { headers: H });
  const rows = await res.json();
  const cfg = rows.length ? JSON.parse(rows[0].value) : {};
  cfg.kb = kb;   // merge: everything else (mode/canned/caps) untouched
  res = await fetch(process.env.SUPABASE_URL + '/rest/v1/settings', {
    method: 'POST', headers: H,
    body: JSON.stringify({ key: 'chatbot_config', value: JSON.stringify(cfg) }),
  });
  if (!res.ok) throw new Error('write failed: ' + res.status + ' ' + await res.text());
  const back = await (await fetch(URL, { headers: H })).json();
  const kbBack = JSON.parse(back[0].value).kb;
  console.log(`\nwritten ✓  kb.entries=${kbBack.entries.length}  prices_verified_at=${kbBack.prices_verified_at.slice(0, 10)}  mode=${JSON.parse(back[0].value).mode}`);
})().catch(e => { console.error(e); process.exit(1); });
