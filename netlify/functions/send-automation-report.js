// ============================================================
// Netlify Function: send-automation-report
// Generates a .doc report file and emails it as an attachment
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
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!RESEND_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY)
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };

  const sbHeaders = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

  // Load automation config
  const autoRes = await fetch(`${SUPABASE_URL}/rest/v1/cashup_automations?id=eq.${automation_id}&select=*`, { headers: sbHeaders });
  const autoData = await autoRes.json();
  if (!autoData || !autoData[0]) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Automation not found' }) };
  const automation = autoData[0];

  // Load branches
  const branchRes = await fetch(`${SUPABASE_URL}/rest/v1/branches?select=id,name&order=name`, { headers: sbHeaders });
  const allBranches = await branchRes.json();
  const branchFilter = Array.isArray(automation.branches) && !automation.branches.includes('all')
    ? automation.branches : allBranches.map(b => b.id);
  const branches = allBranches.filter(b => branchFilter.includes(b.id));
  const branchIdStr = branches.map(b => `"${b.id}"`).join(',');
  const branchMap = Object.fromEntries(branches.map(b => [b.id, b.name]));
  const showBranch = branches.length > 1;

  const qs = `branch_id=in.(${branchIdStr})&entry_date=gte.${date_from}&entry_date=lte.${date_to}`;

  // Fetch data in parallel
  const [entriesRes, expensesRes, summariesRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/cashup_entries?${qs}&select=*&order=entry_date,sort_order`, { headers: sbHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/cashup_expenses?${qs}&select=*&order=entry_date`, { headers: sbHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/cashup_summaries?${qs}&select=*&order=entry_date`, { headers: sbHeaders }),
  ]);
  const [entries, expenses, summaries] = await Promise.all([
    entriesRes.json(), expensesRes.json(), summariesRes.json(),
  ]);

  const sections = automation.report_sections || [];
  const fmt = (n) => '₹' + parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fmtDate = (d) => {
    const [y, m, dd] = d.split('-').map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  const BADGE_COLORS = {
    cash: '#dcfce7', scan: '#dbeafe', upi: '#ede9fe',
    'icici machine': '#fef3c7', bajaj: '#fce7f3', savein: '#e0f2fe',
  };

  // ── CSS for .doc ──────────────────────────────────────────
  const docStyles = `
    body { font-family: Arial, sans-serif; font-size: 13px; color: #374151; max-width: 820px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 20px; font-weight: 800; color: #111827; margin: 0 0 4px; }
    .subtitle { font-size: 13px; color: #6b7280; margin-bottom: 24px; }
    .section { border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin-bottom: 20px; page-break-inside: avoid; }
    .section-title { font-size: 14px; font-weight: 700; color: #111827; margin: 0 0 12px; }
    .kpi { font-size: 24px; font-weight: 800; color: #C4922A; margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #f9fafb; color: #6b7280; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 7px 10px; text-align: left; border-bottom: 1.5px solid #e5e7eb; }
    td { padding: 7px 10px; border-bottom: 1px solid #f3f4f6; vertical-align: middle; }
    .amt { text-align: right; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
    tfoot td { font-weight: 700; border-top: 2px solid #e5e7eb; border-bottom: none; background: #f9fafb; }
    .red { color: #dc2626; } .green { color: #16a34a; }
  `;

  let docBody = '';
  const periodLabel = date_from === date_to ? fmtDate(date_from) : `${fmtDate(date_from)} – ${fmtDate(date_to)}`;
  const branchLabel = showBranch ? 'All Branches' : (branches[0]?.name || '');
  docBody += `<h1>${automation.name}</h1><div class="subtitle">${periodLabel} · ${branchLabel}</div>`;

  // 1. Daily Summary
  if (sections.includes('daily_summary') && summaries.length) {
    const rows = summaries.map(s => {
      const v = parseFloat(s.variance || 0);
      const vClass = v > 0 ? 'green' : v < 0 ? 'red' : '';
      return `<tr>
        <td>${fmtDate(s.entry_date)}</td>
        ${showBranch ? `<td>${branchMap[s.branch_id] || ''}</td>` : ''}
        <td class="amt">${fmt(s.opening_balance)}</td>
        <td class="amt">${fmt(s.closing_balance)}</td>
        <td class="amt ${vClass}">${v !== 0 ? fmt(v) : '—'}</td>
      </tr>`;
    }).join('');
    docBody += `<div class="section"><div class="section-title">📅 Daily Summary</div>
      <table><thead><tr>
        <th>Date</th>${showBranch ? '<th>Branch</th>' : ''}
        <th style="text-align:right">Opening</th><th style="text-align:right">Closing</th><th style="text-align:right">Variance</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // 2. Total Sales
  if (sections.includes('total_sale') && entries.length) {
    const byBranch = {};
    entries.forEach(e => { byBranch[e.branch_id] = (byBranch[e.branch_id] || 0) + parseFloat(e.amount || 0); });
    const total = Object.values(byBranch).reduce((a, b) => a + b, 0);
    const rows = Object.entries(byBranch).map(([bid, amt]) =>
      `<tr><td>${branchMap[bid] || bid}</td><td class="amt">${fmt(amt)}</td></tr>`).join('');
    docBody += `<div class="section"><div class="section-title">💰 Total Sales</div>
      <div class="kpi">${fmt(total)}</div>
      <table><thead><tr><th>Branch</th><th style="text-align:right">Total Sale</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>All Branches</td><td class="amt">${fmt(total)}</td></tr></tfoot></table></div>`;
  }

  // 3. All Transactions
  if (sections.includes('all_transactions') && entries.length) {
    const totalAmt = entries.reduce((a, e) => a + parseFloat(e.amount || 0), 0);
    const rows = entries.map(e => {
      const pt = (e.payment_type || 'scan').toLowerCase();
      const bg = BADGE_COLORS[pt] || '#f3f4f6';
      const label = e.payment_type ? e.payment_type.charAt(0).toUpperCase() + e.payment_type.slice(1) : 'Scan';
      return `<tr>
        <td>${fmtDate(e.entry_date)}</td>
        ${showBranch ? `<td>${branchMap[e.branch_id] || ''}</td>` : ''}
        <td>${e.product_service || '—'}</td>
        <td>${e.customer_name || '—'}</td>
        <td>${e.staff || '—'}</td>
        <td><span class="badge" style="background:${bg}">${label}</span></td>
        <td class="amt">${fmt(e.amount)}</td>
      </tr>`;
    }).join('');
    docBody += `<div class="section"><div class="section-title">📋 All Transactions</div>
      <div class="kpi">${fmt(totalAmt)}</div>
      <table><thead><tr>
        <th>Date</th>${showBranch ? '<th>Branch</th>' : ''}
        <th>Service</th><th>Customer</th><th>Staff</th><th>Type</th><th style="text-align:right">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td colspan="${showBranch ? 6 : 5}">Total</td><td class="amt">${fmt(totalAmt)}</td>
      </tr></tfoot></table></div>`;
  }

  // 4. Sales by Staff
  if (sections.includes('staff_breakdown') && entries.length) {
    const byStaff = {};
    entries.forEach(e => {
      const s = (e.staff || 'Unknown').trim();
      byStaff[s] = (byStaff[s] || 0) + parseFloat(e.amount || 0);
    });
    const sorted = Object.entries(byStaff).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((a, [, v]) => a + v, 0);
    const rows = sorted.map(([name, amt]) =>
      `<tr><td>${name}</td><td class="amt">${fmt(amt)}</td><td class="amt">${total > 0 ? (amt/total*100).toFixed(1)+'%' : '—'}</td></tr>`).join('');
    docBody += `<div class="section"><div class="section-title">👤 Sales by Staff</div>
      <table><thead><tr><th>Staff</th><th style="text-align:right">Total</th><th style="text-align:right">Share</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  // 5. Payment Breakdown
  if (sections.includes('payment_breakdown') && entries.length) {
    const byType = {};
    entries.forEach(e => {
      const pt = (e.payment_type || 'scan');
      byType[pt] = (byType[pt] || 0) + parseFloat(e.amount || 0);
    });
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    const rows = Object.entries(byType).sort((a,b)=>b[1]-a[1]).map(([type, amt]) => {
      const bg = BADGE_COLORS[type.toLowerCase()] || '#f3f4f6';
      const label = type.charAt(0).toUpperCase() + type.slice(1);
      return `<tr>
        <td><span class="badge" style="background:${bg}">${label}</span></td>
        <td class="amt">${fmt(amt)}</td>
        <td class="amt">${total > 0 ? (amt/total*100).toFixed(1)+'%' : '—'}</td>
      </tr>`;
    }).join('');
    docBody += `<div class="section"><div class="section-title">💳 Payment Breakdown</div>
      <table><thead><tr><th>Type</th><th style="text-align:right">Amount</th><th style="text-align:right">Share</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>Total</td><td class="amt">${fmt(total)}</td><td></td></tr></tfoot></table></div>`;
  }

  // 6. Expenses
  if (sections.includes('expenses') && expenses.length) {
    const total = expenses.reduce((a, e) => a + parseFloat(e.amount || 0), 0);
    const rows = expenses.map(e => `<tr>
      <td>${fmtDate(e.entry_date)}</td>
      ${showBranch ? `<td>${branchMap[e.branch_id] || ''}</td>` : ''}
      <td>${e.reason || '—'}</td>
      <td class="amt red">${fmt(e.amount)}</td>
    </tr>`).join('');
    docBody += `<div class="section"><div class="section-title">🧾 Expenses</div>
      <table><thead><tr>
        <th>Date</th>${showBranch ? '<th>Branch</th>' : ''}
        <th>Item</th><th style="text-align:right">Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td colspan="${showBranch ? 3 : 2}">Total Expenses</td>
        <td class="amt red">${fmt(total)}</td>
      </tr></tfoot></table></div>`;
  }

  // ── Build .doc file ───────────────────────────────────────
  const docHtml = `<html><head><meta charset="UTF-8"><style>${docStyles}</style></head><body>${docBody}</body></html>`;
  const docBase64 = Buffer.from(docHtml, 'utf8').toString('base64');
  const filename = `CashupReport_${branchLabel.replace(/\s+/g,'_')}_${date_from}_to_${date_to}.doc`;

  // ── Simple notification email body ────────────────────────
  const emailHtml = `
    <div style="font-family:Arial,sans-serif;max-width:460px;margin:0 auto;padding:32px 24px;color:#1f2937">
      <div style="text-align:center;margin-bottom:24px">
        <img src="https://cashup.dskin.co/dskin-logo.png" alt="DSkin" width="56" style="display:inline-block;margin-bottom:10px">
        <div style="font-size:17px;font-weight:700;color:#8B6508">DSkin Cashup</div>
      </div>
      <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:14px 20px;margin-bottom:20px;text-align:center">
        <div style="font-size:12px;color:#92400e;font-weight:600;text-transform:uppercase;margin-bottom:4px">Scheduled Report</div>
        <div style="font-size:18px;font-weight:700;color:#78350f">${automation.name}</div>
        <div style="font-size:14px;color:#92400e;margin-top:4px">${periodLabel}</div>
      </div>
      <p style="font-size:14px;color:#374151;margin:0 0 8px">Your report is attached as a <strong>.doc</strong> file. Open it in Word or Google Docs to view.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:16px">
        <tr style="border-bottom:1px solid #e5e7eb">
          <td style="padding:8px 0;color:#6b7280">Period</td>
          <td style="padding:8px 0;font-weight:600;text-align:right">${periodLabel}</td>
        </tr>
        <tr style="border-bottom:1px solid #e5e7eb">
          <td style="padding:8px 0;color:#6b7280">Branch</td>
          <td style="padding:8px 0;font-weight:600;text-align:right">${branchLabel}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#6b7280">Sections</td>
          <td style="padding:8px 0;font-weight:600;text-align:right">${sections.length}</td>
        </tr>
      </table>
      <p style="margin:20px 0 0;color:#9ca3af;font-size:12px;text-align:center">
        <a href="https://cashup.dskin.co" style="color:#9ca3af">cashup.dskin.co</a>
      </p>
    </div>`;

  const triggerLabel = automation.trigger_type === 'weekly' ? 'Weekly Report'
    : automation.trigger_type === 'monthly' ? 'Monthly Report' : 'Report';

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'DSkin Cashup <onboarding@resend.dev>',
      to: [automation.email_to],
      subject: `📊 ${triggerLabel} — ${automation.name} (${periodLabel})`,
      html: emailHtml,
      attachments: [{ filename, content: docBase64 }],
    }),
  });

  if (!emailRes.ok) {
    const errText = await emailRes.text();
    console.error('Resend error:', errText);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email failed', detail: errText }) };
  }

  // Update last_sent_at
  await fetch(`${SUPABASE_URL}/rest/v1/cashup_automations?id=eq.${automation_id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ last_sent_at: new Date().toISOString() }),
  });

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, filename }) };
};
