// ============================================================
// Meta Integration Service
// Reads credentials from process.env — set in .env (local)
// or Netlify → Site Settings → Environment Variables (prod).
// ============================================================

function getConfig() {
  const cfg = {
    appId:       process.env.META_APP_ID,
    appSecret:   process.env.META_APP_SECRET,
    verifyToken: process.env.META_VERIFY_TOKEN,
    accessToken: process.env.META_ACCESS_TOKEN,
  };
  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing Meta env vars: ${missing.join(', ')}`);
  return cfg;
}

// ── Webhook verification (GET) ────────────────────────────────
// Meta calls GET /webhook/meta?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
// Return { valid: true, challenge } to confirm subscription.
function verifyWebhook(query) {
  let cfg;
  try { cfg = getConfig(); } catch (e) {
    console.error('[meta-service] verifyWebhook config error:', e.message);
    return { valid: false };
  }

  const mode           = query['hub.mode'];
  const hubVerifyToken = query['hub.verify_token'];
  const challenge      = query['hub.challenge'];

  console.log('VERIFY_TOKEN_ENV=', process.env.META_VERIFY_TOKEN);
  console.log('TOKEN_FROM_URL=', hubVerifyToken);

  if (mode === 'subscribe' && hubVerifyToken === cfg.verifyToken) {
    console.log('[meta-service] Webhook verified');
    return { valid: true, challenge };
  }

  console.warn('[meta-service] Webhook verification failed — token mismatch or wrong mode');
  return { valid: false };
}

// ── Incoming webhook payload handler (POST) ───────────────────
// Called for every event Meta delivers: messages, reactions, etc.
// Returns immediately so Meta gets a fast 200.
function handleWebhook(payload) {
  console.log('[meta-webhook] received object type:', payload.object);
  console.log('[meta-webhook] full payload:', JSON.stringify(payload, null, 2));

  // TODO Phase 2:
  // - parse payload.entry[].messaging[] (Facebook/Instagram messages)
  // - upsert lead row in Supabase (leads table)
  // - insert message row in Supabase (lead_messages table, direction='incoming')
  return { received: true };
}

// ── Send message via Instagram (Graph API) ───────────────────
// recipientId: Instagram-scoped user ID
// text: plain text message string
async function sendInstagramMessage(recipientId, text) {
  // TODO Phase 2: implement after webhook ingestion is working
  // POST https://graph.facebook.com/v19.0/me/messages
  // { recipient: { id: recipientId }, message: { text } }
  console.log('[meta-service] sendInstagramMessage — not yet implemented');
  throw new Error('sendInstagramMessage not yet implemented');
}

// ── Send message via Facebook Messenger (Graph API) ──────────
// recipientId: Page-scoped user ID
// text: plain text message string
async function sendFacebookMessage(recipientId, text) {
  // TODO Phase 2: implement after webhook ingestion is working
  // POST https://graph.facebook.com/v19.0/me/messages
  // { recipient: { id: recipientId }, message: { text } }
  console.log('[meta-service] sendFacebookMessage — not yet implemented');
  throw new Error('sendFacebookMessage not yet implemented');
}

module.exports = { verifyWebhook, handleWebhook, sendInstagramMessage, sendFacebookMessage };
