// ============================================================
// Netlify Scheduled Function: bot-hourly
// Runs every hour, on the hour. Live mode only.
// S2: a chat with no new message for chatbot_config.lead_quiet_hours (default 2)
// has settled → pushLead (a no-op when nothing new is due for that lead).
// S6 adds the owner-question timeouts here.
// Cron: "0 * * * *" (trigger it by hand from the Netlify UI for a quick test)
// ============================================================

const { schedule } = require('@netlify/functions');
const { createSupabaseClient, getSettingJson, pushLead } = require('./utils/meta-service');

// ponytail: only chats active in the 48 h before they went quiet are checked, so a
// push that keeps failing gives up after 2 days (we were emailed on the first failure).
const LOOKBACK_MS = 48 * 3600e3;

// Pure: [{lead_id, created_at}] → ids whose newest message is at least quietMs old.
function quietLeadIds(rows, now, quietMs) {
  const last = {};
  for (const m of rows) if (!last[m.lead_id] || m.created_at > last[m.lead_id]) last[m.lead_id] = m.created_at;
  return Object.keys(last).filter(id => now - Date.parse(last[id]) >= quietMs);
}

const handler = async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) { console.error('[bot-hourly] missing env vars'); return { statusCode: 500 }; }
  const cfg = (await getSettingJson('chatbot_config')) || {};
  if (cfg.mode !== 'live') return { statusCode: 200 };

  const get = async (path) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status} ${await r.text()}`);
    return r.json();
  };
  const now = Date.now();
  const quietMs = Number(cfg.lead_quiet_hours ?? 2) * 3600e3;
  // ponytail: PostgREST caps a response at 1000 rows and the id list rides in the
  // URL; fine at this clinic's DM volume, page both if it grows.
  const rows = await get(`lead_messages?created_at=gt.${new Date(now - quietMs - LOOKBACK_MS).toISOString()}&select=lead_id,created_at`);
  const ids = quietLeadIds(rows, now, quietMs);
  if (!ids.length) return { statusCode: 200 };
  const leads = await get(`leads?id=in.(${ids.join(',')})&select=id,customer_name,branch_id,category,bot_state,created_at,source,instagram_user_id`);

  const db = createSupabaseClient();
  let pushed = 0;
  for (const lead of leads) if (await pushLead(db, lead, cfg, true)) pushed++;
  console.log(`[bot-hourly] quiet chats: ${leads.length}, pushed: ${pushed}`);
  return { statusCode: 200 };
};

exports.handler = schedule('0 * * * *', handler);
exports.quietLeadIds = quietLeadIds;
