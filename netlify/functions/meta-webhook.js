// ============================================================
// Netlify Function: meta-webhook
// Endpoint: /webhook/meta  (redirect configured in netlify.toml)
//
// GET  — Meta webhook verification challenge
// POST — Incoming message events from Meta
// ============================================================

const { verifyWebhook, handleWebhook } = require('./utils/meta-service');

exports.handler = async (event) => {
  // ── GET: webhook verification ─────────────────────────────
  if (event.httpMethod === 'GET') {
    const query  = event.queryStringParameters || {};
    const result = verifyWebhook(query);

    if (result.valid) {
      // Must return the challenge as plain text, not JSON
      return { statusCode: 200, body: result.challenge };
    }

    console.error('[meta-webhook] Verification failed — check META_VERIFY_TOKEN env var');
    return { statusCode: 403, body: 'Forbidden' };
  }

  // ── POST: incoming webhook event ─────────────────────────
  if (event.httpMethod === 'POST') {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid JSON body' }),
      };
    }

    // Await processing — Supabase ops must complete before returning 200
    await handleWebhook(payload);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ok' }),
    };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
