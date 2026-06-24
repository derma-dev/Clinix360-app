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

  // Column on `leads` that stores the platform-scoped sender id.
  const idColumnFor = (platform) =>
    platform === 'facebook' ? 'facebook_user_id' : 'instagram_user_id';

  return {
    idColumnFor,

    async findLeadByPlatformId(platform, userId) {
      const col = idColumnFor(platform);
      const res = await fetch(
        `${url}/rest/v1/leads?${col}=eq.${encodeURIComponent(userId)}&select=id,customer_name&limit=1`,
        { headers }
      );
      if (!res.ok) throw new Error(`leads lookup failed: ${res.status} ${await res.text()}`);
      const rows = await res.json();
      return rows[0] || null;
    },

    async updateLead(id, data) {
      const res = await fetch(`${url}/rest/v1/leads?id=eq.${encodeURIComponent(id)}`, {
        method:  'PATCH',
        headers,
        body:    JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`leads update failed: ${res.status} ${await res.text()}`);
      return res.json();
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

    async getLeadById(id) {
      const res = await fetch(
        `${url}/rest/v1/leads?id=eq.${encodeURIComponent(id)}&select=id,instagram_user_id,facebook_user_id,source&limit=1`,
        { headers }
      );
      if (!res.ok) throw new Error(`lead fetch failed: ${res.status} ${await res.text()}`);
      const rows = await res.json();
      return rows[0] || null;
    },
  };
}

// ── Fetch a DM sender's Instagram profile ─────────────────────
// Uses the User Profile API. Consent is auto-granted once the user DMs us.
// Returns { name, username, profile_pic, id } or null on any failure.
async function fetchInstagramProfile(igsid) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    console.warn('[meta-service] META_ACCESS_TOKEN not set — cannot fetch IG profile');
    return null;
  }
  try {
    const res = await fetch(
      `https://graph.instagram.com/v21.0/${encodeURIComponent(igsid)}` +
      `?fields=name,username,profile_pic&access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) {
      console.warn(`[meta-service] IG profile fetch failed: ${res.status} ${await res.text()}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn('[meta-service] IG profile fetch error:', err.message);
    return null;
  }
}

// ── Fetch a Messenger sender's Facebook profile ───────────────
// Uses the Graph API with the PAGE access token. Consent is auto-granted
// once the user messages the Page. Returns { name, ... } or null on failure.
async function fetchFacebookProfile(psid) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) {
    console.warn('[meta-service] META_PAGE_ACCESS_TOKEN not set — cannot fetch FB profile');
    return null;
  }
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(psid)}` +
      `?fields=name,first_name,last_name,profile_pic&access_token=${encodeURIComponent(token)}`
    );
    if (!res.ok) {
      console.warn(`[meta-service] FB profile fetch failed: ${res.status} ${await res.text()}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn('[meta-service] FB profile fetch error:', err.message);
    return null;
  }
}

// Dispatch to the right profile fetcher by platform.
function fetchProfile(platform, senderId) {
  return platform === 'facebook'
    ? fetchFacebookProfile(senderId)
    : fetchInstagramProfile(senderId);
}

// Build a human-readable display name from a profile.
// IG profiles have a username (-> "Name (@user)"); FB profiles only have `name`.
function buildDisplayName(profile) {
  if (!profile) return null;
  if (profile.name && profile.username) return `${profile.name} (@${profile.username})`;
  return profile.username || profile.name || null;
}

// ── Process one incoming message (Instagram OR Facebook) ──────
async function processIncomingMessage(senderId, messageText, platform = 'instagram') {
  const branchId = process.env.META_BRANCH_ID;
  if (!branchId) throw new Error('Missing META_BRANCH_ID env var');

  const db          = createSupabaseClient();
  const idColumn    = db.idColumnFor(platform);             // instagram_user_id | facebook_user_id
  const placeholder = platform === 'facebook' ? 'Facebook User' : 'Instagram User';

  // Find existing lead by the platform-scoped sender id.
  let lead = await db.findLeadByPlatformId(platform, senderId);

  if (lead) {
    console.log(`[meta-service] Lead found: id=${lead.id} (${platform})`);
    // Backfill the real name on older leads still showing the placeholder.
    if (!lead.customer_name || lead.customer_name === placeholder) {
      const displayName = buildDisplayName(await fetchProfile(platform, senderId));
      if (displayName) {
        await db.updateLead(lead.id, { customer_name: displayName });
        console.log(`[meta-service] Lead name backfilled: "${displayName}"`);
      }
    }
  } else {
    // Fetch the sender's real profile for the new lead's name.
    const displayName = buildDisplayName(await fetchProfile(platform, senderId)) || placeholder;
    lead = await db.createLead({
      branch_id:     branchId,
      source:        platform,
      customer_name: displayName,
      [idColumn]:    senderId,
      status:        'new',
    });
    console.log(`[meta-service] Lead created: id=${lead.id} name="${displayName}" for ${platform} sender=${senderId}`);
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
// Both Instagram and Facebook Messenger POST to the same callback URL.
//   object='instagram' → Instagram DMs  (entry[].messaging[])
//   object='page'      → Facebook Messenger  (entry[].messaging[])
// Real DMs arrive as entry[].messaging[]; Meta's webhook "Test" button sends
// entry[].changes[].field=messages. Handle BOTH shapes for BOTH platforms.
async function handleWebhook(payload) {
  console.log('[meta-webhook] Webhook received — object:', payload.object);
  console.log('[meta-webhook] Full payload:', JSON.stringify(payload, null, 2));

  // Map the Meta `object` to our internal platform name.
  const platform =
    payload.object === 'instagram' ? 'instagram' :
    payload.object === 'page'      ? 'facebook'  : null;

  if (!platform) {
    console.log('[meta-service] Ignoring unsupported payload (object=' + payload.object + ')');
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
        shape:       'messaging',
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
        shape:       'changes',
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
      console.log(`[meta-service] Skipping ${platform}/${ev.shape} event — missing sender.id or message.text`);
      continue;
    }

    console.log(`[meta-service] Processing ${platform} message (${ev.shape}) from sender=${ev.senderId}: "${ev.messageText}"`);

    try {
      await processIncomingMessage(ev.senderId, ev.messageText, platform);
    } catch (err) {
      console.error(`[meta-service] Error processing ${platform} message from sender=${ev.senderId}:`, err.message);
    }
  }

  return { received: true };
}

// ── Send message via Instagram (Send API) ────────────────────
// POST https://graph.instagram.com/v21.0/me/messages
// Note: 24-hour window — you may only reply within 24h of the user's last message.
async function sendInstagramMessage(recipientId, text) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('Missing META_ACCESS_TOKEN env var');

  const igId = process.env.META_IG_ID || 'me';
  const res  = await fetch(`https://graph.instagram.com/v21.0/${igId}/messages`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message:   { text },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`Instagram send failed: ${res.status} ${msg}`);
  }
  console.log(`[meta-service] Instagram message sent to ${recipientId} (message_id=${data.message_id || 'n/a'})`);
  return data; // { recipient_id, message_id }
}

// ── Send message via Facebook Messenger (Graph API) ──────────
// POST https://graph.facebook.com/v21.0/me/messages  (PAGE access token)
// Note: 24-hour standard messaging window — you may only reply within 24h
// of the user's last message unless using a message tag.
async function sendFacebookMessage(recipientId, text) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error('Missing META_PAGE_ACCESS_TOKEN env var');

  const res = await fetch(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(token)}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_type: 'RESPONSE',
        recipient:      { id: recipientId },
        message:        { text },
      }),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`Facebook send failed: ${res.status} ${msg}`);
  }
  console.log(`[meta-service] Facebook message sent to ${recipientId} (message_id=${data.message_id || 'n/a'})`);
  return data; // { recipient_id, message_id }
}

module.exports = { verifyWebhook, handleWebhook, sendInstagramMessage, sendFacebookMessage, createSupabaseClient };
