// ============================================================
// Netlify Function: send-pin-email
// Sends the ADMIN PIN to the admin email via Resend.
// This is the admin's private recovery path. It ONLY ever sends the
// admin PIN, to the admin email — never a branch PIN. For branch staff
// the "Forgot PIN" flow is a decoy: even with the right email guessed,
// the message goes to the admin's inbox and contains the admin PIN.
// ============================================================

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { email, branch_id } = body;
  const ADMIN_EMAIL = 'hospitalitybee@gmail.com';
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  // Only the admin email is authorised. Any other email is a hard stop.
  if (!email || email.trim().toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Not authorized' }) };
  }

  if (!RESEND_API_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured' }) };
  }

  // Fetch the ADMIN PIN from settings (key = 'admin_pin') — never a branch PIN.
  const sbRes = await fetch(
    `${SUPABASE_URL}/rest/v1/settings?key=eq.admin_pin&select=value`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    }
  );

  const rows = await sbRes.json();
  const pin = rows && rows.length ? rows[0].value : null;
  if (!pin) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Admin PIN not set' }) };
  }

  // Look up which branch was selected when Forgot PIN was triggered (for the email only).
  let branchName = null;
  if (branch_id) {
    try {
      const bRes = await fetch(
        `${SUPABASE_URL}/rest/v1/branches?id=eq.${encodeURIComponent(branch_id)}&select=name`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
      );
      const bRows = await bRes.json();
      if (bRows && bRows.length) branchName = bRows[0].name;
    } catch { /* non-fatal — email still sends without the branch name */ }
  }
  const requestedLine = branchName
    ? `<strong>${branchName}</strong> requested your <strong>Admin PIN</strong> for the Clinix360 cashup app.`
    : `You requested your <strong>Admin PIN</strong> for the Clinix360 cashup app.`;

  // Send via Resend — always to the admin email.
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Clinix360 <onboarding@resend.dev>',
      to: [ADMIN_EMAIL],
      subject: `Your Admin PIN — Clinix360`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:420px;margin:0 auto;padding:32px 24px;color:#1f2937">
          <div style="text-align:center;margin-bottom:24px">
            <img src="https://clinix360.ai/dskin-logo.png" alt="Clinix360" width="64" style="display:inline-block;margin-bottom:10px">
            <div style="font-size:18px;font-weight:700;color:#8B6914;letter-spacing:0.02em">Clinix360</div>
          </div>
          <p style="margin:0 0 16px">${requestedLine}</p>
          <div style="background:#fdf8ee;border:2px solid #c9a227;border-radius:14px;padding:28px;text-align:center;margin:0 0 24px">
            <p style="margin:0 0 10px;color:#8B6914;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">Admin PIN</p>
            <div style="font-size:48px;font-weight:700;letter-spacing:16px;color:#8B6914;line-height:1">${pin}</div>
          </div>
          <p style="margin:0 0 8px;color:#374151;font-size:13px">Use this to sign in to the Admin Panel, where you can reset any branch PIN.</p>
          <p style="margin:0;color:#9ca3af;font-size:12px">If you didn't request this, you can ignore this email — it was only sent to your address.</p>
        </div>
      `,
    }),
  });

  if (!emailRes.ok) {
    const errText = await emailRes.text();
    console.error('Resend error:', errText);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to send email' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
