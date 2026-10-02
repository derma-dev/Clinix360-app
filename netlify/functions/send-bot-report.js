// ============================================================
// Netlify Scheduled Function: send-bot-report
// Runs daily at 9:00 am IST (03:30 UTC). chatbot_config.report_frequency decides
// at runtime: 'daily' → every run (last 24 h) · 'weekly' → Mondays only (last 7
// days) · 'off'/unset → nothing. Same numbers as scripts/bot-metrics.sql (kept
// for ad-hoc SQL-editor runs), computed over Supabase REST, emailed via Resend
// to chatbot_config.alert_email.
// Cron: "30 3 * * *"
// ============================================================

const { schedule } = require('@netlify/functions');

const SAFETY = ['medical', 'emergency'];
const has = (v) => String(v ?? '').trim() !== '';

// Pure: handoff leads ({id, bot_state}) + messages of the safety-handoff leads
// ({lead_id, is_bot, direction, created_at}) → the #18 metrics.
function computeBotMetrics(handoffs, messages, botMessages) {
  const reason = (h) => h.bot_state?.handoff_reason;
  const complete = handoffs.filter(h => {
    const q = h.bot_state?.qualification || {};
    return has(q.phone) && has(q.service) && (has(q.branch) || has(q.location));
  }).length;
  // missed medical = an is_bot message newer than the thread's last inbound on a
  // medical/emergency-handoff thread (the bot answered what should go to staff)
  const missed = handoffs.filter(h => SAFETY.includes(reason(h))).filter(h => {
    const mine = messages.filter(m => m.lead_id === h.id);
    const lastIn = mine.filter(m => m.direction === 'incoming').map(m => m.created_at).sort().pop();
    return lastIn && mine.some(m => m.is_bot && m.created_at > lastIn);
  }).length;
  const count = (r) => handoffs.filter(h => reason(h) === r).length;
  return {
    handoffs: handoffs.length,
    complete,
    pct_complete: handoffs.length ? Math.round(1000 * complete / handoffs.length) / 10 : null,
    safety: count('medical') + count('emergency'),
    kb_miss: count('kb_miss'),
    turn_cap: count('turn_cap'),
    missed_medical: missed,
    bot_messages: botMessages,
  };
}

// 'daily' → 1 day, 'weekly' on Monday → 7 days, anything else → null (skip).
function reportWindowDays(frequency, istDow) {
  if (frequency === 'daily') return 1;
  if (frequency === 'weekly' && istDow === 1) return 7;
  return null;
}

function reportHtml(m, days) {
  const row = (label, v, note = '') =>
    `<tr><td style="padding:6px 12px 6px 0;color:#374151">${label}</td><td style="padding:6px 0;font-weight:700">${v}</td><td style="padding:6px 0 6px 12px;color:#9ca3af;font-size:12px">${note}</td></tr>`;
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1f2937">
<div style="font-size:17px;font-weight:700;color:#8B6508;margin-bottom:12px">DSkin DM Assistant — ${days === 1 ? 'daily' : 'weekly'} report</div>
<table style="border-collapse:collapse;font-size:14px">
${row('Handoffs to staff', m.handoffs)}
${row('Complete handoffs', `${m.complete}${m.pct_complete == null ? '' : ` (${m.pct_complete}%)`}`, 'phone + service + branch · target ≥60%')}
${row('Medical / emergency', m.safety)}
${row('Bot didn’t know (kb_miss)', m.kb_miss, 'answer them in Settings → Teach the Bot')}
${row('Turn cap reached', m.turn_cap)}
${row('Missed medical', m.missed_medical, m.missed_medical ? '⚠️ must be 0 — check these threads' : 'target 0')}
${row('Bot messages sent', m.bot_messages)}
</table>
<p style="margin:16px 0 0;color:#6b7280;font-size:13px">Last ${days === 1 ? '24 hours' : '7 days'}. Change or stop this email in Settings → Chatbot → Report.</p>
</div>`;
}

const handler = async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  const resend = process.env.RESEND_API_KEY;
  if (!url || !key || !resend) { console.error('[send-bot-report] missing env vars'); return { statusCode: 500 }; }
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const get = async (path) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { headers: h });
    if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status} ${await r.text()}`);
    return r.json();
  };

  const rows = await get('settings?key=eq.chatbot_config&select=value&limit=1');
  const cfg = rows[0] ? JSON.parse(rows[0].value || '{}') : {};
  const istDow = new Date(Date.now() + 5.5 * 3600e3).getUTCDay();
  const days = reportWindowDays(cfg.report_frequency, istDow);
  if (!days) return { statusCode: 200 };

  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const handoffs = await get(`leads?bot_state->>handoff_at=gt.${since}&select=id,bot_state`);
  const safetyIds = handoffs.filter(l => SAFETY.includes(l.bot_state?.handoff_reason)).map(l => l.id);
  const messages = safetyIds.length
    ? await get(`lead_messages?lead_id=in.(${safetyIds.join(',')})&select=lead_id,is_bot,direction,created_at`)
    : [];
  const botMessages = (await get(`lead_messages?is_bot=is.true&created_at=gt.${since}&select=id`)).length;
  const m = computeBotMetrics(handoffs, messages, botMessages);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resend}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'DSkin Bot <onboarding@resend.dev>',
      to: [String(cfg.alert_email || 'hospitalitybee@gmail.com').trim()],
      subject: `${m.missed_medical ? '⚠️ ' : ''}Bot report — ${m.handoffs} handoffs, ${m.pct_complete ?? 0}% complete`,
      html: reportHtml(m, days),
    }),
  });
  if (!res.ok) { console.error('[send-bot-report] email failed:', res.status, await res.text()); return { statusCode: 502 }; }
  console.log(`[send-bot-report] sent (${days}d):`, JSON.stringify(m));
  return { statusCode: 200 };
};

exports.handler = schedule('30 3 * * *', handler);
exports.computeBotMetrics = computeBotMetrics;
exports.reportWindowDays = reportWindowDays;
