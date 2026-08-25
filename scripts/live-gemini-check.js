// One-off: the single live Gemini validation call (chatbot checklist Step 6's
// deferred live check — "one live call with real key returns parseable
// structured JSON"). Dev-only; run: node scripts/live-gemini-check.js
// Mirrors seed-kb.js's .env loader — no dotenv dependency.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { callAssistant } = require('../netlify/functions/utils/meta-service');

(async () => {
  const t0 = Date.now();
  const decision = await callAssistant({
    model: 'gemini-3.5-flash-lite',
    kb: { entries: [
      { type: 'service', key: 'LHR FULL BODY P/S', price: 35000, price_last_quoted: '2026-03' },
      { type: 'faq', tags: ['branches'], a: 'Three branches: Janakpuri (main), Kirti Nagar, Dwarka Sec 12.' },
    ] },
    history: [{ role: 'user', text: 'hi' }, { role: 'model', text: 'Hello! I can help with prices and bookings.' }],
    inboundText: 'price of laser full body',
  });
  const ms = Date.now() - t0;
  console.log(`[live-gemini-check] OK in ${ms}ms — structured decision parsed:`);
  console.log(JSON.stringify(decision, null, 2));
  const ok = decision && typeof decision.category === 'string'
    && typeof decision.is_medical === 'boolean' && typeof decision.reply === 'string';
  console.log(ok ? '[live-gemini-check] PASS — key, model and responseSchema all work'
                 : '[live-gemini-check] FAIL — decision missing required fields');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('[live-gemini-check] FAIL:', e.message); process.exit(1); });
