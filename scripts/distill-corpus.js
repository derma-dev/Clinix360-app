// One-off: distill the IG-export corpus into topic-clustered KB review files.
// Reads artifacts/data/ig_export_history.jsonl (from extract-ig-export.js) and
// writes artifacts/data/distill/*.md — per topic: what customers ask (their own
// phrasings), what staff actually answered, repeated answer templates, and a
// ₹-amount timeline that exposes stale/conflicting prices — for the clinician's
// one-batch sign-off (CHATBOT_CORPUS_EXPORT_SESSION_2026-08-21.md §6, locked #2).
// Also extracts the shared offer-post captions (→ future offer cache).
//
// Deliberately dumb keyword clustering (Hinglish included), zero deps, offline.
// The output is review material, NOT the KB. Check 00_INDEX.md coverage; extend
// TOPICS below and re-run. Semantic clustering (Gemini) is the upgrade path.
//
// Usage: node scripts/distill-corpus.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IN = path.join(ROOT, 'artifacts', 'data', 'ig_export_history.jsonl');
const OUTDIR = path.join(ROOT, 'artifacts', 'data', 'distill');

// topic → keywords (word-boundary match for plain ascii words, substring otherwise)
const TOPICS = [
  { id: 'price',     name: 'Price / cost',               kw: ['price','cost','costing','rate','charge','charges','fees','kitna','kitne','kitni','how much','paisa','paise','₹','rs','कितन','कीमत','भाव','प्राइस'] },
  { id: 'laser',     name: 'Laser hair removal',         kw: ['laser','hair removal','full body','underarm','bikini','beard shaping','whole body','चेहरे'] },
  { id: 'hairfall',  name: 'Hair fall / PRP / transplant', kw: ['hair fall','hairfall','hair los','baal gir','gir rahe','bald','dandruff','prp','ganti','ganth','minoxidil','transplant','hair','बाल'] },
  { id: 'skin',      name: 'Skin / pigmentation / acne',  kw: ['pimple','acne','daag','dagh','pigment','dark spot','spot','khujli','rash','fungal','glow','facial','wrinkle','melasma','tan','open pore','scar','stretch mark','white head','black head','mole','wart','til','skincare','chehre','chehra','चेहरा','दाग','झाइयां'] },
  { id: 'safety',    name: 'Side effects / safety / pain', kw: ['side effect','side effects','safe','pain','painful','hurt','risky','kharab','reaction','burn','side-effects','sideeffect','safety','दर्द','सुरक्षित'] },
  { id: 'conditions',name: 'Medical conditions',          kw: ['pcod','pcos','thyroid','diabet','pregnan','garbhvati','sugar','blood pressure','breastfeed','feeding','brestfeeding','insulin','hormone','गर्भ'] },
  { id: 'booking',   name: 'Booking / consultation',      kw: ['appointment','book','slot','available','visit','aana','aana hai','consult','consultation','opd','walk in','booking','बुक'] },
  { id: 'location',  name: 'Branch / location',          kw: ['where','address','adress','addres','location','branch','kahan','kaha','near','janakpuri','kirti','dwarka','direction','कहाँ','कहा'] },
  { id: 'timing',    name: 'Timings / days',             kw: ['timing','timings','open','close','sunday','holiday','khulta','band','baje','कब खुलता'] },
  { id: 'results',   name: 'Results / sessions / duration', kw: ['result','kitne din','how long','session','sessions','gap','permanent','how many','effect kb','difference','दिखने','रिजल्ट'] },
  { id: 'offer',     name: 'Offers / packages',          kw: ['offer','discount','deal','sale','package','combo','scheme','ऑफर'] },
  { id: 'cancel',    name: 'Cancel / reschedule',        kw: ['cancel','reschedul','postpone','shift kar'] },
  { id: 'collab',    name: 'Collab / hiring / promo spam', kw: ['collab','collaborate','collaboration','hiring','hire','job','vacancy','influencer','partnership','promotion','sponsor','follow me','like comment'] },
  { id: 'contact',   name: 'Contact sharing (phone numbers)', kw: [] },  // fallback: bare phone number
  { id: 'ack',       name: 'Acknowledgements (not questions)', kw: [] },  // fallback: ok/yes/ji/thanks…
  { id: 'greeting',  name: 'Greetings / openers',        kw: [] },  // fallback: greeting with no other topic
  { id: 'other',     name: 'Other questions',            kw: [] },  // fallback bucket — review for missed topics
];

// ── helpers ──────────────────────────────────────────────────────────────────
const clean = s => s.replace(/\s+/g, ' ').trim();
const excerpt = (s, n = 300) => { s = clean(s); return s.length > n ? s.slice(0, n) + '…' : s; };
const norm = s => clean(s.toLowerCase()
  .replace(/\[shared post:[\s\S]*?\]/g, '')
  .replace(/[^\p{L}\p{N}\s₹]/gu, ' ')
  .replace(/\d+/g, '#'));

const hit = (text, kw) => /^[a-z0-9 ]+$/i.test(kw)
  ? new RegExp(`\\b${kw.replace(/ +/g, '\\s+')}\\b`, 'i').test(text)
  : text.toLowerCase().includes(kw.toLowerCase());

const GREETING = /^\s*(hi+|hy|hie+|hlw|hallo|hello+|hey+|hlo+|namaste|namaskar|good (morning|afternoon|evening))\b/i;
const CONTACT_RE = /^\+?\d[\d\s-]{7,13}\??$/;
const ACK_SET = new Set(['ok','okay','k','okk','oky','okh','ohk','ohkk','yes','y','ya','yeah','yep','yup','no','nope','np','sure','ji','jii','ha','han','haan','hanji','hnji','hmm','hmmmm','hm','mm','good','fine','acha','achha','done','bolo','btaiye','bataiye','btaye','thanks','thank','thankyou','thank you','thx','ty','tysm','pls','please','mam','maam','sir','madam','👍','🙏']);
const isAck = t => { const w = t.toLowerCase().replace(/[.?!\s]+$/, '').trim().split(/\s+/); return w.length > 0 && (w.join('') === '?' || w.every(x => ACK_SET.has(x))); };
function classify(text) {
  return TOPICS.filter(t => t.kw.some(k => hit(text, k))).map(t => t.id);
}

// staff quote prices as bare digits ("4500", "4999/-", "18k") — ₹-prefixed only misses them.
// 4–5 digits / comma-groups / Nk; 1–3 digits excluded (session counts, ages, "98-99%").
const AMOUNT_RE = [/₹\s*([\d,]+(?:\.\d+)?)/g, /\brs\.?\s*([\d,]+(?:\.\d+)?)/gi, /\b(\d{1,3}(?:,\d{3})+|\d{4,5})\b/g, /\b(\d+(?:\.\d+)?)k\b/gi];

// ── state ────────────────────────────────────────────────────────────────────
const T = new Map(TOPICS.map(t => [t.id, { ...t, phr: new Map(), ans: [], ansTop: new Map(), thr: new Set(), amt: new Map() }]));
const offers = new Map();          // norm caption → {n, example, first, last, amounts:Set}
const unassigned = new Map();      // norm phrasing → {n, example}
let qTotal = 0, qTagged = 0, greetingOnly = 0, ackN = 0, contactN = 0, otherN = 0;

// ── walk the corpus ─────────────────────────────────────────────────────────
const threads = fs.readFileSync(IN, 'utf8').trim().split('\n').map(l => JSON.parse(l));

for (const th of threads) {
  const msgs = th.messages;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.dir !== 'in') continue;

    const isShare = m.text.startsWith('[shared post:');
    if (isShare) {
      const caption = m.text.slice('[shared post: '.length, -1);
      const k = norm(caption).slice(0, 120);
      const o = offers.get(k) || { n: 0, example: caption, first: m.at, last: m.at, amounts: new Set() };
      o.n++; if (m.at < o.first) o.first = m.at; if (m.at > o.last) o.last = m.at;
      for (const re of AMOUNT_RE) for (const mm of caption.matchAll(re)) o.amounts.add(mm[1]);
      offers.set(k, o);
    }

    if (m.canned) continue;
    qTotal++;
    let topics = isShare ? ['offer'] : classify(m.text);
    if (topics.length) qTagged++;
    else {
      // fallback ladder: bare phone number → greeting → ack → other
      const c = clean(m.text);
      if (!isShare && CONTACT_RE.test(c)) { contactN++; topics = ['contact']; }
      else if (GREETING.test(m.text)) { greetingOnly++; topics = ['greeting']; }
      else if (isAck(c)) { ackN++; topics = ['ack']; }
      else {
        otherN++;
        const k = norm(m.text).slice(0, 80);
        const u = unassigned.get(k) || { n: 0, example: c };
        u.n++; unassigned.set(k, u);
        topics = ['other'];
      }
    }

    // staff answer(s) = outgoing messages before the next inbound (canned skipped, max 2)
    const answers = [];
    for (let j = i + 1; j < msgs.length && msgs[j].dir === 'out' && answers.length < 2; j++) {
      if (!msgs[j].canned) answers.push(msgs[j]);
    }

    for (const id of new Set(topics)) {
      const t = T.get(id);
      t.thr.add(th.thread_id);
      if (!isShare && !['greeting', 'ack', 'contact'].includes(id)) {
        const k = norm(m.text).slice(0, 100);
        const p = t.phr.get(k) || { n: 0, example: clean(m.text) };
        p.n++; t.phr.set(k, p);
      }
      for (const a of answers) {
        if (t.ans.length < 500) t.ans.push({ ym: a.at.slice(0, 7), text: excerpt(a.text) });
        const ka = norm(a.text).slice(0, 100);
        t.ansTop.set(ka, (t.ansTop.get(ka) || 0) + 1);
        const ctx = clean(m.text).toLowerCase();
        for (const re of AMOUNT_RE) for (const mm of a.text.matchAll(re)) {
          let amt = mm[1].replace(/,/g, '');
          if (re === AMOUNT_RE[3]) amt = String(Math.round(parseFloat(amt) * 1000));   // "20k" → 20000
          const rec = t.amt.get(amt) || { n: 0, first: a.at.slice(0, 7), last: a.at.slice(0, 7), q: new Set() };
          rec.n++; if (a.at < rec.first) rec.first = a.at.slice(0, 7); if (a.at > rec.last) rec.last = a.at.slice(0, 7);
          rec.q.add(ctx.slice(0, 60));
          t.amt.set(amt, rec);
        }
      }
    }
  }
}

// ── write review files ──────────────────────────────────────────────────────
fs.rmSync(OUTDIR, { recursive: true, force: true });
fs.mkdirSync(OUTDIR, { recursive: true });
const W = (f, s) => fs.writeFileSync(path.join(OUTDIR, f), s);

const sorted = (map, n) => [...map.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, n);

TOPICS.forEach((topic, idx) => {
  const t = T.get(topic.id);
  let md = `# ${t.name}\n\n` +
    `**${t.thr.size} threads · ${t.phr.size} distinct phrasings · ${t.ans.length} sampled answers** (multi-label: a message can hit several topics)\n\n`;

  if (t.phr.size) {
    md += `## What customers ask — top phrasings (their own words)\n`;
    for (const [k, p] of sorted(t.phr, 40)) md += `- (${p.n}×) ${JSON.stringify(excerpt(p.example, 140))}\n`;
    md += `\n`;
  }

  if (t.ansTop.size > 1) {
    md += `## Repeated staff answers (de-facto templates)\n`;
    for (const [k, n] of sorted(t.ansTop, 8)) {
      const ex = t.ans.find(a => norm(a.text).slice(0, 100) === k);
      if (ex && n > 1) md += `- (${n}×) ${JSON.stringify(excerpt(ex.text, 200))}\n`;
    }
    md += `\n`;
  }

  if (t.ans.length) {
    md += `## Staff answer examples (newest first — check dates for staleness)\n`;
    for (const a of t.ans.slice().sort((x, y) => y.ym.localeCompare(x.ym)).slice(0, 30))
      md += `- **[${a.ym}]** ${JSON.stringify(a.text)}\n`;
    md += `\n`;
  }

  if (t.amt.size) {
    md += `## ₹ amounts mentioned in these answers — conflict check\n\n` +
      `| ₹ | times | first seen | last seen | asked about |\n|---|---|---|---|---|\n`;
    for (const [amt, r] of [...t.amt.entries()].sort((a, b) => b[1].last.localeCompare(a[1].last) || b[1].n - a[1].n).slice(0, 25)) {
      const qs = [...r.q][Math.floor(r.q.size / 2)] || '';
      md += `| ${Number(amt).toLocaleString('en-IN')} | ${r.n} | ${r.first} | ${r.last} | ${JSON.stringify(excerpt(qs, 60))} |\n`;
    }
    md += `\n> Same service at different ₹ over time = pick the current price for the KB.\n`;
  }
  W(`${String(idx + 1).padStart(2, '0')}_${t.id}.md`, md);
});

// offers.md — shared offer-post captions (seeds the {service, offer_price, valid_until} cache)
{
  let md = `# Shared offer posts — captions customers sent us\n\n` +
    `Distinct captions: ${offers.size}. Seeds the offer cache (design-review open #4).\n\n` +
    `| shares | first | last | ₹ in caption | caption |\n|---|---|---|---|---|\n`;
  for (const [, o] of sorted(offers, 40)
    .sort((a, b) => (a[1].last < b[1].last ? 1 : -1)))
    md += `| ${o.n} | ${o.first.slice(0, 10)} | ${o.last.slice(0, 10)} | ${[...o.amounts].join(', ') || '—'} | ${JSON.stringify(excerpt(o.example, 200))} |\n`;
  W('offers.md', md);
}

// 00_INDEX.md
{
  const substantive = qTotal - ackN - greetingOnly - contactN;
  const pct = substantive ? Math.round(100 * qTagged / substantive) : 0;
  let md = `# Distill index — generated ${new Date().toISOString().slice(0, 10)}\n\n` +
    `Input: ig_export_history.jsonl (${threads.length} threads)\n` +
    `Coverage: **${qTagged}/${substantive}** substantive questions topic-tagged (**${pct}%**) · ` +
    `acks ${ackN} · greetings ${greetingOnly} · contact shares ${contactN} · unclassified other ${otherN}\n` +
    `Improve coverage: extend TOPICS in scripts/distill-corpus.js, re-run, check this file again.\n\n` +
    `| # | topic | threads | top phrasings | ₹ amounts |\n|---|---|---|---|---|\n`;
  TOPICS.forEach((topic, i) => {
    const t = T.get(topic.id);
    md += `| ${i + 1} | [${t.name}](${String(i + 1).padStart(2, '0')}_${t.id}.md) | ${t.thr.size} | ${t.phr.size} | ${t.amt.size} |\n`;
  });
  md += `| — | [offers](offers.md) | ${offers.size} distinct captions | | |\n\n`;
  md += `## Top unassigned phrasings (the "other" bucket — mine these for missing topics)\n`;
  for (const [, u] of sorted(unassigned, 30)) md += `- (${u.n}×) ${JSON.stringify(excerpt(u.example, 120))}\n`;
  W('00_INDEX.md', md);
}

const topLine = TOPICS.map(t => T.get(t.id).thr.size).join(' · ');
console.log(`distill : artifacts/data/distill/ (${TOPICS.length} topics + offers.md + 00_INDEX.md)`);
console.log(`coverage: ${qTagged}/${qTotal - ackN - greetingOnly - contactN} substantive questions tagged (${qTotal - ackN - greetingOnly - contactN ? Math.round(100 * qTagged / (qTotal - ackN - greetingOnly - contactN)) : 0}%) · contact ${contactN} · acks ${ackN} · greetings ${greetingOnly} · other ${otherN}`);
console.log(`threads : ${topLine}`);
console.log(`offers  : ${offers.size} distinct shared-post captions`);
console.log(`next    : read 00_INDEX.md → extend TOPICS for coverage → clinician reviews topic files`);
