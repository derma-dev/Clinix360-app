// ============================================================
// Netlify Function: meta-status
// Read-only connection check for the admin "Connected Accounts" panel.
// Pings the Graph API per platform using the env token and reports
// { connected, name }. No secret ever leaves the server.
// ============================================================

async function checkInstagram() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { connected: false };
  try {
    const res = await fetch(`https://graph.instagram.com/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
    if (!res.ok) return { connected: false };
    const d = await res.json();
    return { connected: true, name: d.username ? '@' + d.username : 'Connected' };
  } catch { return { connected: false }; }
}

async function checkFacebook() {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) return { connected: false };
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/me?fields=name&access_token=${encodeURIComponent(token)}`);
    if (!res.ok) return { connected: false };
    const d = await res.json();
    return { connected: true, name: d.name || 'Connected' };
  } catch { return { connected: false }; }
}

async function checkWhatsApp() {
  const token   = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { connected: false };
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}?fields=display_phone_number,verified_name&access_token=${encodeURIComponent(token)}`);
    if (!res.ok) return { connected: false };
    const d = await res.json();
    return { connected: true, name: d.verified_name || d.display_phone_number || 'Connected' };
  } catch { return { connected: false }; }
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const [instagram, facebook, whatsapp] = await Promise.all([
    checkInstagram(), checkFacebook(), checkWhatsApp(),
  ]);

  return { statusCode: 200, headers, body: JSON.stringify({ instagram, facebook, whatsapp }) };
};
