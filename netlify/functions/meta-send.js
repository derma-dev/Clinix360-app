// ============================================================
// Netlify Function: meta-send
// Sends an outbound reply to a lead via the Instagram Send API,
// then persists it to lead_messages (direction: 'outgoing').
//
// Body: { leadId: <uuid>, message: <string> }
// The recipient IGSID + platform are resolved from the lead row —
// the client never passes the access token or recipient id.
// ============================================================

const { sendInstagramMessage, sendFacebookMessage, createSupabaseClient } = require('./utils/meta-service');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const leadId  = body.leadId;
  const message = (body.message || '').trim();
  if (!leadId || !message) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'leadId and message are required' }) };
  }
  if (Buffer.byteLength(message, 'utf8') > 1000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message too long (max 1000 bytes)' }) };
  }

  try {
    const db   = createSupabaseClient();
    const lead = await db.getLeadById(leadId);

    if (!lead) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Lead not found' }) };
    }

    const source = (lead.source || '').toLowerCase();

    // 1) Send via the right platform (throws on API failure — e.g. 24h window closed)
    if (source === 'instagram') {
      if (!lead.instagram_user_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Lead has no Instagram recipient id' }) };
      }
      await sendInstagramMessage(lead.instagram_user_id, message);
    } else if (source === 'facebook') {
      if (!lead.facebook_user_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Lead has no Facebook recipient id' }) };
      }
      await sendFacebookMessage(lead.facebook_user_id, message);
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Outbound not supported for source "${lead.source}"` }) };
    }

    // 2) Persist the outgoing message (only after a successful send)
    const rows = await db.insertMessage({
      lead_id:   leadId,
      direction: 'outgoing',
      message,
      is_seen:   true,
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: rows[0] || null }) };
  } catch (err) {
    console.error('[meta-send] Error:', err.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
