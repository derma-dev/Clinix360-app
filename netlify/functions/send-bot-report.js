// ============================================================
// Netlify Scheduled Function: send-bot-report
// Runs daily at 9:00 am IST (03:30 UTC). chatbot_config.report_frequency decides
// at runtime: 'daily' → every run (last 24 h) · 'weekly' → Mondays only (last 7
// days) · 'off'/unset → nothing. Computed over Supabase REST, sent to the owner's
// Telegram (settings.telegram_owner, service tracker S8 / Q22).
// Cron: "30 3 * * *"
// ============================================================

const { schedule } = require('@netlify/functions');
const { getSettingJson, sendTelegram } = require('./utils/meta-service');

const has = (v) => String(v ?? '').trim() !== '';

// "A 3 · B 1" (top n), or "none".
function tally(values, n = Infinity) {
  const c = {};
  for (const v of values) c[v] = (c[v] || 0) + 1;
  const top = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n);
  return top.length ? top.map(([k, v]) => `${k} ${v}`).join(' · ') : 'none';
}

// Pure → the report numbers.
//   chats:      leads the customer wrote to in the window ({id, category, bot_state})
//   stamped:    leads with any bot_state stamp in the window ({bot_state})
//   commentIds: ids of chats that started from a comment in the window
// Customers = category 'lead' (collab / sales / misc left out), split by what the bot
// gathered: complete = phone + service + branch · potential = a service, details
// missing · general = asked something, no service. Stamps are ISO strings, so a
// string compare with `since` is a time compare.
function computeBotMetrics({ chats, stamped, commentIds, botMessages }, since) {
  const inWindow  = (t) => (t || '') > since;
  const qOf       = (l) => l.bot_state?.qualification || {};
  const customers = chats.filter(l => (l.category || 'lead') === 'lead');
  const leads     = customers.filter(l => has(qOf(l).service));
  const complete  = leads.filter(l => { const q = qOf(l); return has(q.phone) && (has(q.branch) || has(q.location)); }).length;
  const handoffs  = stamped.filter(l => inWindow(l.bot_state?.handoff_at));
  const count     = (r) => handoffs.filter(h => h.bot_state?.handoff_reason === r).length;
  let pushed = 0, pushFailed = 0;
  for (const { bot_state: bs } of stamped) {
    const sent = bs?.lead_pushed || {}, alerted = bs?.lead_push_alerted || {};
    pushed     += Object.values(sent).filter(inWindow).length;
    pushFailed += Object.keys(alerted).filter(t => inWindow(alerted[t]) && !sent[t]).length;
  }
  return {
    chats: chats.length,
    complete,
    potential: leads.length - complete,
    general: customers.length - leads.length,
    comment_dms: commentIds.length,
    comment_leads: leads.filter(l => commentIds.includes(l.id)).length,
    top_services: tally(leads.map(l => qOf(l).service), 3),
    branches: tally(leads.map(l => qOf(l).branch || qOf(l).location || 'no branch yet')),
    pushed,
    push_failed: pushFailed,
    price_asked: stamped.filter(l => inWindow(l.bot_state?.owner_asked_at)).length,
    price_answered: stamped.filter(l => inWindow(l.bot_state?.owner_answered_at)).length,
    price_no_reply: count('owner_no_reply'),
    safety: count('medical') + count('emergency'),
    kb_miss: count('kb_miss'),
    turn_cap: count('turn_cap'),
    bot_messages: botMessages,
  };
}

// 'daily' → 1 day, 'weekly' on Monday → 7 days, anything else → null (skip).
function reportWindowDays(frequency, istDow) {
  if (frequency === 'daily') return 1;
  if (frequency === 'weekly' && istDow === 1) return 7;
  return null;
}

// Plain text (sendTelegram sends no parse_mode).
function reportText(m, days) {
  const row = (label, v, note) => `${label}: ${v}${note ? ` · ${note}` : ''}`;
  return [
    `📊 DSkin DM Assistant — ${days === 1 ? 'daily' : 'weekly'} report (last ${days === 1 ? '24 hours' : '7 days'})`,
    '',
    row('Chats', m.chats),
    row('Complete leads', m.complete, 'phone + service + branch'),
    row('Potential leads', m.potential, 'interested, details missing'),
    row('General enquiries', m.general, 'asked a question, no service'),
    row('From comments', `${m.comment_dms} DMs`, `${m.comment_leads} became leads`),
    row('Top services', m.top_services),
    row('Leads per branch', m.branches),
    '',
    row('Leads sent to Make', m.pushed, m.push_failed ? `⚠️ ${m.push_failed} failed, check the webhook` : ''),
    row('Price questions to you', m.price_asked, `${m.price_answered} answered · ${m.price_no_reply} no reply in time`),
    row('Medical / emergency', m.safety),
    row('Bot didn’t know (kb_miss)', m.kb_miss),
    row('Turn cap reached', m.turn_cap),
    row('Bot messages sent', m.bot_messages),
    '',
    'Change or stop this report in Settings → Chatbot → Report.',
  ].join('\n');
}

const handler = async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) { console.error('[send-bot-report] missing env vars'); return { statusCode: 500 }; }
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
  const owner = await getSettingJson('telegram_owner');
  if (!owner?.chat_id) { console.error('[send-bot-report] no Telegram owner linked'); return { statusCode: 500 }; }

  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const stamps = ['handoff_at', 'owner_asked_at', 'owner_answered_at', 'lead_pushed->>lead', 'lead_pushed->>potential_lead',
                  'lead_push_alerted->>lead', 'lead_push_alerted->>potential_lead']
    .map(p => `bot_state${p.includes('->>') ? '->' : '->>'}${p}.gt."${since}"`).join(',');
  const stamped = await get(`leads?or=(${stamps})&select=bot_state`);
  // ponytail: PostgREST caps a response at 1000 rows and the id list rides in the
  // URL; fine at this clinic's DM volume, page both if it grows.
  const inbound = await get(`lead_messages?direction=in.(in,incoming)&created_at=gt.${since}&select=lead_id,message`);
  const ids = [...new Set(inbound.map(r => r.lead_id))];
  const commentIds = [...new Set(inbound.filter(r => String(r.message).startsWith('[comment]')).map(r => r.lead_id))];
  const chats = ids.length ? await get(`leads?id=in.(${ids.join(',')})&select=id,category,bot_state`) : [];
  const botMessages = (await get(`lead_messages?is_bot=is.true&created_at=gt.${since}&select=id`)).length;
  const m = computeBotMetrics({ chats, stamped, commentIds, botMessages }, since);

  try { await sendTelegram(owner.chat_id, reportText(m, days)); }
  catch (e) { console.error('[send-bot-report] Telegram failed:', e.message); return { statusCode: 502 }; }
  console.log(`[send-bot-report] sent (${days}d):`, JSON.stringify(m));
  return { statusCode: 200 };
};

exports.handler = schedule('30 3 * * *', handler);
exports.computeBotMetrics = computeBotMetrics;
exports.reportWindowDays = reportWindowDays;
exports.reportText = reportText;
