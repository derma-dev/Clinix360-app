// ============================================================
// Netlify Scheduled Function: check-automations
// Runs daily at 11:30 pm IST (18:00 UTC) to fire scheduled automations
// Cron: "0 18 * * *"
// ============================================================

const { schedule } = require('@netlify/functions');

const handler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SITE_URL = process.env.URL || 'https://eloquent-pothos-dc09dc.netlify.app';

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Missing env vars');
    return { statusCode: 500 };
  }

  const sbHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

  // Get today's date in IST (UTC+5:30)
  const nowUtc = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(nowUtc.getTime() + istOffset);
  const today = istNow.toISOString().split('T')[0]; // YYYY-MM-DD
  const [y, m, d] = today.split('-').map(Number);

  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const isSunday = dow === 0;
  const isLastDay = d === lastDay;

  // Fetch all active scheduled automations
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/cashup_automations?is_active=eq.true&trigger_mode=eq.scheduled&select=*`,
    { headers: sbHeaders }
  );
  const automations = await res.json();
  if (!automations || !automations.length) return { statusCode: 200 };

  for (const auto of automations) {
    let shouldFire = false;
    let from, to;

    if (auto.trigger_type === 'weekly' && isSunday) {
      shouldFire = true;
      // Mon–Sun of this week
      const dt = new Date(Date.UTC(y, m - 1, d));
      const mon = new Date(dt); mon.setUTCDate(dt.getUTCDate() - 6);
      from = mon.toISOString().split('T')[0];
      to = today;
    } else if (auto.trigger_type === 'monthly' && isLastDay) {
      shouldFire = true;
      from = new Date(Date.UTC(y, m - 1, 1)).toISOString().split('T')[0];
      to = today;
    } else if (auto.trigger_type === 'single_date' && auto.trigger_date === today) {
      shouldFire = true;
      from = today;
      to = today;
    }

    // Skip if already sent today
    if (shouldFire && auto.last_sent_at) {
      const lastSent = auto.last_sent_at.split('T')[0];
      if (lastSent === today) shouldFire = false;
    }

    if (!shouldFire) continue;

    console.log(`Firing automation: ${auto.name} (${auto.id}) for ${from} – ${to}`);

    const fnName = auto.action_type === 'webhook'
      ? 'send-automation-webhook'
      : 'send-automation-report';
    try {
      await fetch(`${SITE_URL}/.netlify/functions/${fnName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ automation_id: auto.id, date_from: from, date_to: to }),
      });
    } catch (e) {
      console.error(`Failed to fire automation ${auto.id}:`, e.message);
    }
  }

  return { statusCode: 200 };
};

exports.handler = schedule('0 18 * * *', handler);
