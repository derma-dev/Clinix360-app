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

// ── Supabase REST client ──────────────────────────────────────
// Uses Node 18 built-in fetch — no extra dependency needed.
function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars');

  const headers = {
    apikey:          key,
    Authorization:   `Bearer ${key}`,
    'Content-Type':  'application/json',
    Prefer:          'return=representation',
  };

  return {
    async findLeadByInstagramId(instagramUserId) {
      const res = await fetch(
        `${url}/rest/v1/leads?instagram_user_id=eq.${encodeURIComponent(instagramUserId)}&select=id&limit=1`,
        { headers }
      );
      if (!res.ok) throw new Error(`leads lookup failed: ${res.status} ${await res.text()}`);
      const rows = await res.json();
      return rows[0] || null;
    },

    async createLead(data) {
      const res = await fetch(`${url}/rest/v1/leads`, {
        method:  'POST',
        headers,
        body:    JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`leads insert failed: ${res.status} ${await res.text()}`);
      const rows = await res.json();
      return rows[0];
    },

    async insertMessage(data) {
      const res = await fetch(`${url}/rest/v1/lead_messages`, {
        method:  'POST',
        headers,
        body:    JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`lead_messages insert failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
  };
}

// ── Process one incoming Instagram message ────────────────────
async function processIncomingMessage(senderId, messageText) {
  const branchId = process.env.META_BRANCH_ID;
  if (!branchId) throw new Error('Missing META_BRANCH_ID env var');

  const db = createSupabaseClient();

  // Find existing lead by instagram_user_id
  let lead = await db.findLeadByInstagramId(senderId);

  if (lead) {
    console.log(`[meta-service] Lead found: id=${lead.id}`);
  } else {
    // Create new lead
    lead = await db.createLead({
      branch_id:          branchId,
      source:             'instagram',
      customer_name:      'Instagram User',
      instagram_user_id:  senderId,
      status:             'new',
    });
    console.log(`[meta-service] Lead created: id=${lead.id} for sender=${senderId}`);
  }

  // Insert incoming message
  await db.insertMessage({
    lead_id:   lead.id,
    direction: 'incoming',
    message:   messageText,
    is_seen:   false,
  });
  console.log(`[meta-service] Message inserted for lead_id=${lead.id}`);
}

// ── Webhook verification (GET) ────────────────────────────────
// Meta calls GET /webhook/meta?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
function verifyWebhook(query) {
  // Verification only needs META_VERIFY_TOKEN — do NOT require the other Meta
  // vars here, or a missing app secret/access token blocks the GET handshake.
  const expected       = process.env.META_VERIFY_TOKEN;
  const mode           = query['hub.mode'];
  const hubVerifyToken = query['hub.verify_token'];
  const challenge      = query['hub.challenge'];

  console.log('VERIFY_TOKEN_ENV=', expected ? '(set)' : '(MISSING)');
  console.log('TOKEN_FROM_URL=', hubVerifyToken);

  if (!expected) {
    console.error('[meta-service] META_VERIFY_TOKEN is not set in the environment');
    return { valid: false };
  }

  if (mode === 'subscribe' && hubVerifyToken === expected) {
    console.log('[meta-service] Webhook verified');
    return { valid: true, challenge };
  }

  console.warn('[meta-service] Webhook verification failed — token mismatch or wrong mode');
  return { valid: false };
}

// ── Incoming webhook payload handler (POST) ───────────────────
// Real Instagram DMs (Instagram Login API) arrive as entry[].messaging[].
// Meta's "Test" button in the webhook UI sends entry[].changes[].field=messages.
// Handle BOTH shapes so test events and live traffic both ingest.
async function handleWebhook(payload) {
  console.log('[meta-webhook] Webhook received — object:', payload.object);
  console.log('[meta-webhook] Full payload:', JSON.stringify(payload, null, 2));

  if (payload.object !== 'instagram') {
    console.log('[meta-service] Ignoring non-Instagram payload (object=' + payload.object + ')');
    return { received: true };
  }

  // Collect message events from both payload shapes into a flat list.
  const events = [];

  for (const entry of (payload.entry || [])) {
    // Shape A — real DMs: entry[].messaging[]
    for (const msg of (entry.messaging || [])) {
      events.push({
        senderId:    msg.sender?.id,
        messageText: msg.message?.text,
        isEcho:      msg.message?.is_echo === true,
        source:      'messaging',
      });
    }

    // Shape B — Meta test button: entry[].changes[].field=messages
    for (const change of (entry.changes || [])) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      events.push({
        senderId:    value.sender?.id,
        messageText: value.message?.text,
        isEcho:      value.message?.is_echo === true,
        source:      'changes',
      });
    }
  }

  if (!events.length) {
    console.log('[meta-service] No message events found in payload (no messaging[] or changes[] entries)');
  }

  for (const ev of events) {
    // Skip echoes — these are copies of OUR outbound messages, not inbound DMs.
    if (ev.isEcho) {
      console.log('[meta-service] Skipping echo (our own outbound message)');
      continue;
    }

    if (!ev.senderId || !ev.messageText) {
      console.log(`[meta-service] Skipping ${ev.source} event — missing sender.id or message.text`);
      continue;
    }

    console.log(`[meta-service] Processing message (${ev.source}) from sender=${ev.senderId}: "${ev.messageText}"`);

    try {
      await processIncomingMessage(ev.senderId, ev.messageText);
    } catch (err) {
      console.error(`[meta-service] Error processing message from sender=${ev.senderId}:`, err.message);
    }
  }

  return { received: true };
}

// ── Send message via Instagram (Graph API) ───────────────────
async function sendInstagramMessage(recipientId, text) {
  // TODO: implement in Phase 2 after ingestion is confirmed working
  console.log('[meta-service] sendInstagramMessage — not yet implemented');
  throw new Error('sendInstagramMessage not yet implemented');
}

// ── Send message via Facebook Messenger (Graph API) ──────────
async function sendFacebookMessage(recipientId, text) {
  // TODO: implement in Phase 2 after ingestion is confirmed working
  console.log('[meta-service] sendFacebookMessage — not yet implemented');
  throw new Error('sendFacebookMessage not yet implemented');
}

module.exports = { verifyWebhook, handleWebhook, sendInstagramMessage, sendFacebookMessage };
