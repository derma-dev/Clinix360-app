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

// ── Platform tables ───────────────────────────────────────────
// Column on `leads` that stores the platform-scoped sender id, and the name
// shown until the real profile name is known.
const ID_COLUMNS = {
  instagram: 'instagram_user_id',
  facebook:  'facebook_user_id',
  whatsapp:  'whatsapp_user_id',
};

const PLACEHOLDER_NAMES = {
  instagram: 'Instagram User',
  facebook:  'Facebook User',
  whatsapp:  'WhatsApp User',
};

// Throw on an unknown platform rather than silently defaulting — a wrong column
// here writes a sender id into another platform's column and corrupts dedupe.
function idColumnFor(platform) {
  const col = ID_COLUMNS[platform];
  if (!col) throw new Error(`[meta-service] Unknown platform: "${platform}"`);
  return col;
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
        `${url}/rest/v1/leads?id=eq.${encodeURIComponent(id)}&select=id,instagram_user_id,facebook_user_id,whatsapp_user_id,source&limit=1`,
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
// WhatsApp has no profile API — the name rides in the webhook payload
// (contacts[].profile.name), so it's passed in instead of fetched.
function fetchProfile(platform, senderId) {
  if (platform === 'whatsapp') return Promise.resolve(null);
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

// ── Process one incoming message (Instagram, Facebook OR WhatsApp) ──
// `profileName` is set only for WhatsApp, which ships the sender's name in the
// webhook payload instead of exposing a profile API.
async function processIncomingMessage(senderId, messageText, platform = 'instagram', profileName = null) {
  const branchId = process.env.META_BRANCH_ID;
  if (!branchId) throw new Error('Missing META_BRANCH_ID env var');

  const db          = createSupabaseClient();
  const idColumn    = db.idColumnFor(platform);             // instagram_user_id | facebook_user_id | whatsapp_user_id
  const placeholder = PLACEHOLDER_NAMES[platform];

  // Find existing lead by the platform-scoped sender id.
  let lead = await db.findLeadByPlatformId(platform, senderId);

  if (lead) {
    console.log(`[meta-service] Lead found: id=${lead.id} (${platform})`);
    // Backfill the real name on older leads still showing the placeholder.
    if (!lead.customer_name || lead.customer_name === placeholder) {
      const displayName = profileName || buildDisplayName(await fetchProfile(platform, senderId));
      if (displayName) {
        await db.updateLead(lead.id, { customer_name: displayName });
        console.log(`[meta-service] Lead name backfilled: "${displayName}"`);
      }
    }
  } else {
    // Fetch the sender's real profile for the new lead's name.
    const displayName = profileName || buildDisplayName(await fetchProfile(platform, senderId)) || placeholder;
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

// ── Payload parsing (pure — see meta-service.test.js) ─────────
// All three platforms POST to the same callback URL, keyed by `object`:
//   object='instagram'                 → Instagram DMs        (entry[].messaging[])
//   object='page'                      → Facebook Messenger   (entry[].messaging[])
//   object='whatsapp_business_account' → WhatsApp Cloud API   (entry[].changes[])
function platformFor(object) {
  return object === 'instagram'                 ? 'instagram'
       : object === 'page'                      ? 'facebook'
       : object === 'whatsapp_business_account' ? 'whatsapp'
       : null;
}

// Flatten a webhook payload into a list of message events.
// Returns { platform: null, events: [] } for anything we don't handle.
function extractEvents(payload) {
  const platform = platformFor(payload.object);
  if (!platform) return { platform: null, events: [] };

  const events = [];

  for (const entry of (payload.entry || [])) {
    // Shape A — real FB/IG DMs: entry[].messaging[]
    for (const msg of (entry.messaging || [])) {
      events.push({
        senderId:    msg.sender?.id,
        messageText: msg.message?.text,
        profileName: null,
        isEcho:      msg.message?.is_echo === true,
        shape:       'messaging',
      });
    }

    // Shape B — entry[].changes[].field=messages.
    // Used by BOTH Meta's FB/IG test button AND real WhatsApp traffic, but the
    // `value` differs completely between them — hence the split below.
    for (const change of (entry.changes || [])) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};

      if (platform === 'whatsapp') {
        // WA: value.messages[] + value.contacts[] (name inline, no profile API).
        // Delivery receipts arrive as value.statuses[] with no messages[] —
        // the loop below skips them for free.
        const nameByWaId = new Map(
          (value.contacts || []).map((c) => [c.wa_id, c.profile?.name])
        );
        for (const m of (value.messages || [])) {
          events.push({
            senderId:    m.from,
            messageText: m.text?.body,   // non-text (image/audio/…) → undefined → skipped downstream
            profileName: nameByWaId.get(m.from) || null,
            isEcho:      false,          // we only subscribe `messages`, not `message_echoes`
            shape:       'whatsapp',
          });
        }
        continue;
      }

      // FB/IG test button: value.sender / value.message
      events.push({
        senderId:    value.sender?.id,
        messageText: value.message?.text,
        profileName: null,
        isEcho:      value.message?.is_echo === true,
        shape:       'changes',
      });
    }
  }

  return { platform, events };
}

// ── Per-platform enable flag (admin "Connected Accounts" toggle) ──
// Reads settings.integrations JSON, e.g. {"instagram":true,"facebook":false}.
// FAIL-OPEN: a missing key, unset DB creds, or any error → enabled. A toggle
// glitch must never silently swallow real inbound messages.
async function isPlatformEnabled(platform) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return true;
  try {
    const res = await fetch(
      `${url}/rest/v1/settings?key=eq.integrations&select=value&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) return true;
    const rows = await res.json();
    if (!rows.length) return true;
    const flags = JSON.parse(rows[0].value || '{}');
    return flags[platform] !== false;   // only an explicit false disables
  } catch (err) {
    console.warn('[meta-service] isPlatformEnabled check failed — defaulting ON:', err.message);
    return true;
  }
}

// ── Incoming webhook payload handler (POST) ───────────────────
async function handleWebhook(payload) {
  console.log('[meta-webhook] Webhook received — object:', payload.object);
  console.log('[meta-webhook] Full payload:', JSON.stringify(payload, null, 2));

  const { platform, events } = extractEvents(payload);

  if (!platform) {
    console.log('[meta-service] Ignoring unsupported payload (object=' + payload.object + ')');
    return { received: true };
  }

  if (!(await isPlatformEnabled(platform))) {
    console.log(`[meta-service] ${platform} ingestion disabled in settings — skipping payload`);
    return { received: true };
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
      await processIncomingMessage(ev.senderId, ev.messageText, platform, ev.profileName);
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

// ── Send message via WhatsApp (Cloud API) ────────────────────
// POST https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages
// Unlike FB/IG this takes the phone number id in the PATH (not `me`), and the
// recipient is a wa_id (phone number in international format), not a PSID/IGSID.
// Note: 24-hour service window — free-form replies only work within 24h of the
// customer's last message. Outside it, WhatsApp requires a paid template and
// this call fails (surfaced as a 502 by meta-send).
async function sendWhatsAppMessage(recipientId, text) {
  const token         = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token)         throw new Error('Missing WHATSAPP_ACCESS_TOKEN env var');
  if (!phoneNumberId) throw new Error('Missing WHATSAPP_PHONE_NUMBER_ID env var');

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type:    'individual',
        to:                recipientId,
        type:              'text',
        text:              { body: text },
      }),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`WhatsApp send failed: ${res.status} ${msg}`);
  }
  console.log(`[meta-service] WhatsApp message sent to ${recipientId} (message_id=${data.messages?.[0]?.id || 'n/a'})`);
  return data; // { messaging_product, contacts:[...], messages:[{ id }] }
}

module.exports = {
  verifyWebhook,
  handleWebhook,
  sendInstagramMessage,
  sendFacebookMessage,
  sendWhatsAppMessage,
  createSupabaseClient,
  // exported for tests
  extractEvents,
  idColumnFor,
};
