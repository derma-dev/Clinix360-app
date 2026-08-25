// One-off: extract the client's IG data-export DMs into the JSONL corpus.
// Source: Instagram "Download your information" → inbox/*/message_1.json
// (history to 2026-08-18). Unblocks the chatbot corpus (design-review open #2):
// the --meta API pull returns empty on Standard Access, but the export has it all.
// Dev-only — not deployed. Output is customer PII: artifacts/data/ + inbox/ are
// gitignored on purpose. Spec: artifacts/CHATBOT_CORPUS_EXPORT_SESSION_2026-08-21.md §3.
//
// Usage:
//   node scripts/extract-ig-export.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INBOX = path.join(ROOT, 'inbox');
const OUT = path.join(ROOT, 'artifacts', 'data', 'ig_export_history.jsonl');

// The exported account's display name — sender_name on staff messages.
const CLINIC = 'Derma skin and hair solutions';
// Saved-reply templates — flagged `canned` so KB mining skips them.
// #1 client-confirmed; #2/#3 discovered in the corpus (verbatim, many times, 2026 —
// note #2 arrives with a newline after "Hi,", so match on whitespace-collapsed text).
const CANNED_PREFIXES = ['thanks for reaching out', 'hi, thanks for contacting derma skin', 'thanks for contacting derma skin', 'thanks for contacting us'];

// IG system events stored as message `content` — not real text, never extract
// (substring, case-insensitive: Meta has many variants — "You missed a video chat",
// "<name> started an audio call", "added to a collection", reaction notices…)
const SYSTEM_RE = /(liked a message|reacted .+ to your message|you missed .*(call|chat)|started an? (audio|video)|call (started|ended)|added to a collection)/i;

// IG exports double-encode non-ASCII: UTF-8 bytes read as cp1252, re-saved as UTF-8
// ("₹" → "â‚¹", emoji → "ðŸ”¥"). Reverse it: chars → cp1252 bytes → utf-8. Self-guarding:
// any char not representable, or a decode that yields U+FFFD, keeps the original string.
const CP1252 = { 0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,
  0x2021:0x87,0x02C6:0x88,0x2030:0x89,0x0160:0x8A,0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,
  0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,
  0x02DC:0x98,0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F };
let repaired = 0;
function fix(s) {
  if (!/[^\x00-\x7F]/.test(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) { bytes.push(c); continue; }
    if (c <= 0xFF) { bytes.push(c); continue; }
    if (CP1252[c] === undefined) return s;
    bytes.push(CP1252[c]);
  }
  const out = Buffer.from(bytes).toString('utf8');
  if (out.includes('�') || out === s) return s;
  repaired++;
  return out;
}

const all = fs.readdirSync(INBOX, { withFileTypes: true }).filter(d => d.isDirectory());
const folders = all.filter(d => fs.existsSync(path.join(INBOX, d.name, 'message_1.json')));

const threads = [];
let badParse = 0, noText = 0, totalIn = 0, totalOut = 0, canned = 0, shared = 0;
let minTs = Infinity, maxTs = 0;

for (const d of folders) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(INBOX, d.name, 'message_1.json'), 'utf8')); }
  catch (e) { badParse++; console.error(`  ! parse ${d.name}: ${e.message}`); continue; }

  // folder name: <username>_<IGSID> or bare <IGSID>
  const m = d.name.match(/^(.*?_)?(\d+)$/);
  const igsid = m ? m[2] : d.name;
  const username = (m && m[1] && m[1].replace(/_$/, '')) || (data.title ? fix(data.title) : '');

  const msgs = [];
  for (const msg of (data.messages || []).slice().reverse()) {   // export is newest-first
    if (!msg.timestamp_ms) continue;
    const dir = msg.sender_name === CLINIC ? 'out' : 'in';
    let text = null;
    if (msg.share && msg.share.share_text) { text = `[shared post: ${fix(msg.share.share_text.trim())}]`; shared++; }
    else if (typeof msg.content === 'string' && !/ sent an attachment\.?$/i.test(msg.content)) text = fix(msg.content);
    if (!text || SYSTEM_RE.test(text)) continue;   // photos / calls / stickers / reactions — dropped (decision #1)
    minTs = Math.min(minTs, msg.timestamp_ms); maxTs = Math.max(maxTs, msg.timestamp_ms);
    const rec = { dir, at: new Date(msg.timestamp_ms).toISOString(), text };
    if (dir === 'out' && CANNED_PREFIXES.some(p => text.toLowerCase().replace(/\s+/g, ' ').startsWith(p))) { rec.canned = true; canned++; }
    dir === 'out' ? totalOut++ : totalIn++;
    msgs.push(rec);
  }
  if (!msgs.length) { noText++; continue; }
  threads.push({ thread_id: igsid, username: username || '?',
                 updated_time: msgs[msgs.length - 1].at, messages: msgs });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, threads.map(t => JSON.stringify(t)).join('\n') + '\n');

// UTF-8 assert: fatal decode throws on invalid sequences (classic IG-export double-encoding)
const raw = fs.readFileSync(OUT);
const decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
if (decoded.includes('�')) { console.error('UTF-8 check FAILED: replacement chars in output'); process.exit(1); }

const twoWay = threads.filter(t => t.messages.some(x => x.dir === 'in') && t.messages.some(x => x.dir === 'out'));
const day = ts => new Date(ts).toISOString().slice(0, 10);
console.log(`corpus : artifacts/data/ig_export_history.jsonl  (${threads.length} threads, ${totalIn + totalOut} messages)`);
console.log(`folders: ${folders.length} with message_1.json / ${all.length} total · parse errors ${badParse} · no-text-after-filter ${noText}`);
console.log(`span   : ${day(minTs)} → ${day(maxTs)}`);
console.log(`in/out : ${totalIn} in / ${totalOut} out`);
console.log(`2-way  : ${twoWay.length} (staff actually replied in both directions)`);
console.log(`shared : ${shared} shared-post texts · canned: ${canned} greetings`);
console.log(`utf8   : ok · mojibake repaired on ${repaired} strings · ₹ appears ${(decoded.match(/₹/g) || []).length}×`);
