// One-off: dump past staff↔customer conversations into a JSONL corpus.
// Purpose: mine past chats to build the chatbot KB / FAQ set / qualification
// flow (see artifacts/CHATBOT_AUTOMATION.md, Phase 1).
// Dev-only — not deployed, not part of the app. Output is customer PII:
// artifacts/data/ is gitignored on purpose.
//
// Usage:
//   node scripts/export-conversations.js          → DB corpus  (our lead_messages)
//   node scripts/export-conversations.js --meta   → IG history (Graph conversations API,
//                                                    includes threads older than our DB)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) throw new Error('No .env found — copy .env.example and fill SUPABASE_URL / SUPABASE_ANON_KEY');
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// PostgREST caps at 1000 rows per request — loop until a short batch comes back.
async function fetchAll(table, select, order) {
  const key = process.env.SUPABASE_ANON_KEY;
  const rows = [];
  for (;;) {
    const url = `${process.env.SUPABASE_URL}/rest/v1/${table}` +
      `?select=${encodeURIComponent(select)}&order=${encodeURIComponent(order)}&limit=1000&offset=${rows.length}`;
    const res = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`${table} ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
}

// ── IG history pull ─────────────────────────────────────────────────────────
// GET /{IG_ID}/conversations?platform=instagram, then each thread's messages edge
// with cursor paging. `me` = the account the META_ACCESS_TOKEN belongs to.
async function exportMetaHistory() {
  const token = process.env.META_ACCESS_TOKEN;
  const igId = process.env.META_IG_ID || 'me';
  const api = (path) => `https://graph.instagram.com/v21.0/${path}`;
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  // who are we? (participants include our own account — need our id to find "them")
  const self = await (await fetch(api('me?fields=user_id,username'), { ...auth, signal: AbortSignal.timeout(30000) })).json();
  console.log(`IG account: @${self.username || '?'} (${self.user_id})`);

  // page through conversations (newest-first; capped — a busy business account has
  // thousands of threads incl. spam, and the bot KB cares about recent real ones)
  // ponytail: hard cap 1000 threads; raise if the corpus needs more depth
  const MAX_THREADS = Number(process.env.CORPUS_MAX_THREADS || 1000);
  const threads = [];
  let capped = true;
  let url = api(`${igId}/conversations?platform=instagram&fields=participants,updated_time&limit=25`);
  for (let page = 1; url && threads.length < MAX_THREADS; page++) {
    const res = await fetch(url, { ...auth, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`conversations ${res.status}: ${await res.text()}`);
    const data = await res.json();
    threads.push(...(data.data || []));
    if (!(data.data || []).length) { url = null; capped = false; break; }   // empty page but a `next` cursor = API has nothing to show; the cursor never ends (seen with Standard Access)
    if (page % 10 === 0) console.log(`  listing… ${threads.length} threads`);
    url = data.paging?.next || null;
  }
  console.log(`threads : ${threads.length}${capped && threads.length ? ` (capped at ${MAX_THREADS}, newest first)` : ''} — pulling messages…`);

  // page through each thread's messages (5 threads in parallel)
  async function pullThread(t) {
    const messages = [];
    let murl = api(`${t.id}/messages?fields=from,message,created_time&limit=100`);
    while (murl) {
      const res = await fetch(murl, { ...auth, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`messages ${res.status}: ${await res.text()}`);
      const data = await res.json();
      messages.push(...(data.data || []));
      murl = data.paging?.next || null;
    }
    // API returns newest-first; our corpus convention is oldest-first
    messages.reverse();
    const them = (t.participants?.data || []).find(p => String(p.id) !== String(self.user_id))
      || (t.participants?.data || [])[0];
    return { thread_id: t.id, username: them?.username, updated_time: t.updated_time, messages };
  }

  const out = [];
  let done = 0;
  const queue = [...threads];
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try { out.push(await pullThread(t)); }
      catch (e) { console.error(`  ! @${t.participants?.data?.[1]?.username || t.id}: ${e.message}`); }
      if (++done % 25 === 0) console.log(`  … ${done}/${threads.length} threads`);
    }
  }));

  const file = path.join(ROOT, 'artifacts', 'data', 'ig_history.jsonl');
  fs.writeFileSync(file, out.map(c => JSON.stringify(c)).join('\n') + '\n');
  const total = out.reduce((a, c) => a + c.messages.length, 0);
  console.log(`corpus : artifacts/data/ig_history.jsonl  (${out.length} threads, ${total} messages)`);
  out.forEach(c => console.log(`  @${c.username || '?'} — ${c.messages.length} msgs, updated ${c.updated_time}`));
}

(async () => {
  loadEnv();
  if (process.argv.includes('--meta')) { await exportMetaHistory(); return; }
  const [leads, msgs] = await Promise.all([
    fetchAll('leads', 'id,branch_id,customer_name,source,status,created_at', 'id.asc'),
    fetchAll('lead_messages', 'lead_id,direction,message,created_at', 'lead_id.asc,created_at.asc'),
  ]);

  const byLead = new Map();
  for (const m of msgs) {
    if (!byLead.has(m.lead_id)) byLead.set(m.lead_id, []);
    byLead.get(m.lead_id).push({ dir: m.direction, at: m.created_at, text: m.message });
  }

  const convos = leads.filter(l => byLead.has(l.id))
    .map(l => ({ ...l, messages: byLead.get(l.id) }));

  const outDir = path.join(ROOT, 'artifacts', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'conversations.jsonl'),
    convos.map(c => JSON.stringify(c)).join('\n') + '\n');

  // ── stats ──
  const count = (arr, fn) => arr.reduce((a, x) => ((a[fn(x)] = (a[fn(x)] || 0) + 1), a), {});
  const withReply = convos.filter(c => c.messages.some(m => String(m.dir).startsWith('out')));
  const twoWay = convos.filter(c => c.messages.some(m => String(m.dir).startsWith('out')) && c.messages.some(m => String(m.dir).startsWith('in')));
  console.log(`corpus : artifacts/data/conversations.jsonl  (${convos.length} conversations, ${msgs.length} messages)`);
  console.log(`leads  : ${convos.length} with messages / ${leads.length} total`);
  console.log(`source :`, count(convos, c => c.source || '(none)'));
  console.log(`status :`, count(convos, c => c.status || '(none)'));
  console.log(`2-way  : ${twoWay.length} (staff actually replied: ${withReply.length})`);
  console.log(`len    : avg ${(msgs.length / Math.max(convos.length, 1)).toFixed(1)} msgs/convo`);
})().catch(e => { console.error(e.message); process.exit(1); });
