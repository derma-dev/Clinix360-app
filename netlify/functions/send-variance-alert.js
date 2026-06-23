// ============================================================
// Netlify Function: send-variance-alert
// Emails admin when a cashup variance is detected
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

  const { branch_name, entry_date, calculated_closing, actual_closing, variance } = body;
  const ADMIN_EMAIL = 'hospitalitybee@gmail.com';
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };

  const varAmt = parseFloat(variance) || 0;
  const isOver = varAmt > 0;
  const varLabel = isOver ? `Over by ₹${Math.abs(varAmt).toFixed(2)}` : `Short by ₹${Math.abs(varAmt).toFixed(2)}`;
  const varColor = isOver ? '#43a047' : '#e53935';

  const [y, m, d] = entry_date.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const dateFormatted = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(dateObj);

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'DSkin Cashup <onboarding@resend.dev>',
      to: [ADMIN_EMAIL],
      subject: `⚠️ Variance Alert — ${branch_name} (${entry_date})`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:460px;margin:0 auto;padding:32px 24px;color:#1f2937">
          <div style="text-align:center;margin-bottom:24px">
            <img src="https://eloquent-pothos-dc09dc.netlify.app/dskin-logo.png" alt="Clinix360" width="56" style="display:inline-block;margin-bottom:10px">
            <div style="font-size:17px;font-weight:700;color:#8B6508">DSkin Cashup</div>
          </div>
          <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:10px;padding:16px 20px;margin-bottom:20px;text-align:center">
            <div style="font-size:13px;color:#856404;font-weight:600;text-transform:uppercase;margin-bottom:4px">Variance Detected</div>
            <div style="font-size:28px;font-weight:700;color:${varColor}">${varLabel}</div>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:10px 0;color:#6b7280">Branch</td>
              <td style="padding:10px 0;font-weight:600;text-align:right">${branch_name}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:10px 0;color:#6b7280">Date</td>
              <td style="padding:10px 0;font-weight:600;text-align:right">${dateFormatted}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:10px 0;color:#6b7280">Calculated Closing</td>
              <td style="padding:10px 0;font-weight:600;text-align:right">₹${parseFloat(calculated_closing).toFixed(2)}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb">
              <td style="padding:10px 0;color:#6b7280">Actual Closing (Counted)</td>
              <td style="padding:10px 0;font-weight:600;text-align:right">₹${parseFloat(actual_closing).toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;color:#6b7280">Variance</td>
              <td style="padding:10px 0;font-weight:700;text-align:right;color:${varColor}">${varLabel}</td>
            </tr>
          </table>
          <p style="margin:20px 0 0;color:#9ca3af;font-size:12px;text-align:center">Check the Admin Panel → Variance Alerts for details.</p>
        </div>
      `,
    }),
  });

  if (!emailRes.ok) {
    console.error('Resend error:', await emailRes.text());
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email failed' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
