// ============================================================
// Netlify Function: send-automation-webhook
// Fires a webhook POST with branch-by-branch weekly/monthly data
// ============================================================

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { automation_id, date_from, date_to } = body;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };

  const sbHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

  // Load automation config
  const autoRes = await fetch(`${SUPABASE_URL}/rest/v1/cashup_automations?id=eq.${automation_id}&select=*`, { headers: sbHeaders });
  const autoData = await autoRes.json();
  if (!autoData || !autoData[0]) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Automation not found' }) };
  const automation = autoData[0];

  if (!automation.webhook_url) {
    console.error('No webhook_url set for automation', automation_id);
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No webhook URL configured' }) };
  }

  // Load branches
  const branchRes = await fetch(`${SUPABASE_URL}/rest/v1/branches?select=id,name&order=name`, { headers: sbHeaders });
  const allBranches = await branchRes.json();
  const branchFilter = Array.isArray(automation.branches) && !automation.branches.includes('all')
    ? automation.branches : allBranches.map(b => b.id);
  const branches = allBranches.filter(b => branchFilter.includes(b.id));
  const branchIdStr = branches.map(b => b.id).join(',');

  const qs = `branch_id=in.(${branchIdStr})&entry_date=gte.${date_from}&entry_date=lte.${date_to}`;

  // Fetch data in parallel
  const [entriesRes, summariesRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/cashup_entries?${qs}&select=branch_id,amount,payment_type`, { headers: sbHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/cashup_summaries?${qs}&select=branch_id,entry_date,closing_balance,less_cash_handover`, { headers: sbHeaders }),
  ]);
  const [entries, summaries] = await Promise.all([entriesRes.json(), summariesRes.json()]);

  // Build per-branch stats
  const branchData = branches.map(branch => {
    const bid = branch.id;

    // Total sale = sum of all entries for this branch
    const branchEntries = entries.filter(e => e.branch_id === bid);
    const totalSale = branchEntries.reduce((a, e) => a + parseFloat(e.amount || 0), 0);
    const scanSale = branchEntries.filter(e => e.payment_type !== 'cash').reduce((a, e) => a + parseFloat(e.amount || 0), 0);
    const cashSale = branchEntries.filter(e => e.payment_type === 'cash').reduce((a, e) => a + parseFloat(e.amount || 0), 0);

    // Cash handover = sum of all less_cash_handover entries for this branch in the period
    const branchSummaries = summaries.filter(s => s.branch_id === bid);
    const cashHandover = branchSummaries.reduce((a, s) => a + parseFloat(s.less_cash_handover || 0), 0);

    // Closing balance = the summary for the last date (date_to = Sunday)
    const sundaySummary = branchSummaries.find(s => s.entry_date === date_to)
      || branchSummaries.sort((a, b) => b.entry_date.localeCompare(a.entry_date))[0];
    const closingBalance = sundaySummary ? parseFloat(sundaySummary.closing_balance || 0) : 0;

    return {
      branch: branch.name,
      weekly_total_sale: Math.round(totalSale),
      scan_sale: Math.round(scanSale),
      cash_sale: Math.round(cashSale),
      cash_handover: Math.round(cashHandover),
      closing_balance: Math.round(closingBalance),
    };
  });

  // Format date as "18 May 2026"
  const [dy, dm, dd] = date_to.split('-').map(Number);
  const dateLabel = new Date(dy, dm - 1, dd).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  // Format currency as ₹1,23,456
  const fmt = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

  // Build single formatted text block
  const lines = [`Date - ${dateLabel}`, ''];
  branchData.forEach((b, i) => {
    if (i > 0) lines.push('');
    lines.push(b.branch);
    lines.push(`Weekly Total Sale - ${fmt(b.weekly_total_sale)}`);
    lines.push(`Scan Sale - ${fmt(b.scan_sale)}`);
    lines.push(`Cash Sale - ${fmt(b.cash_sale)}`);
    lines.push(`Cash Handover - ${fmt(b.cash_handover)}`);
    lines.push(`Closing Balance - ${fmt(b.closing_balance)}`);
  });

  const payload = { report: lines.join('\n') };

  // Fire webhook with 3 retries
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const whRes = await fetch(automation.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (whRes.ok || (whRes.status >= 200 && whRes.status < 300)) {
        // Update last_sent_at
        await fetch(`${SUPABASE_URL}/rest/v1/cashup_automations?id=eq.${automation_id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ last_sent_at: new Date().toISOString() }),
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, payload }) };
      }
      lastError = `HTTP ${whRes.status}`;
    } catch (e) {
      lastError = e.message;
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
  }

  console.error('Webhook failed after 3 attempts:', lastError);
  return { statusCode: 502, headers, body: JSON.stringify({ error: 'Webhook delivery failed', detail: lastError }) };
};
