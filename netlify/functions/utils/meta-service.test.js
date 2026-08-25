// Payload extractor + platform column checks.
// Run: node netlify/functions/utils/meta-service.test.js
// No framework, no env vars needed — extractEvents/idColumnFor are pure.

const assert = require('node:assert');
const {
  extractEvents,
  extractComments,
  matchCommentRule,
  matchBranch,
  idColumnFor,
  verifyMetaSignature,
  classifyInbound,
  callAssistant,
  botReply,
  sendByPlatform,
  normalizePhone,
} = require('./meta-service');

// ── idColumnFor: the silent-corruption guard ─────────────────
assert.equal(idColumnFor('instagram'), 'instagram_user_id');
assert.equal(idColumnFor('facebook'),  'facebook_user_id');
assert.equal(idColumnFor('whatsapp'),  'whatsapp_user_id');
// Must THROW, not fall through to a wrong column.
assert.throws(() => idColumnFor('telegram'), /Unknown platform/);
assert.throws(() => idColumnFor(undefined), /Unknown platform/);

// ── WhatsApp: real inbound text ──────────────────────────────
{
  const { platform, events } = extractEvents({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_ID',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550001111', phone_number_id: '123456' },
          contacts: [{ profile: { name: 'Gaurav' }, wa_id: '919999999999' }],
          messages: [{
            from: '919999999999',
            id: 'wamid.ABC',
            timestamp: '1752710400',
            text: { body: 'Hi, is the clinic open today?' },
            type: 'text',
          }],
        },
      }],
    }],
  });

  assert.equal(platform, 'whatsapp');
  assert.equal(events.length, 1);
  assert.equal(events[0].senderId, '919999999999');
  assert.equal(events[0].messageText, 'Hi, is the clinic open today?');
  assert.equal(events[0].profileName, 'Gaurav');   // name inline — no profile API call
  assert.equal(events[0].isEcho, false);
}

// ── WhatsApp: delivery receipts must NOT create leads ────────
{
  const { events } = extractEvents({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: '123456' },
          statuses: [{ id: 'wamid.ABC', status: 'delivered', recipient_id: '919999999999' }],
        },
      }],
    }],
  });
  assert.equal(events.length, 0, 'status/delivery payloads must yield no events');
}

// ── WhatsApp: non-text (image) is labeled, not dropped (chatbot Step 2) ──
{
  const { events } = extractEvents({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          contacts: [{ profile: { name: 'Gaurav' }, wa_id: '919999999999' }],
          messages: [{ from: '919999999999', id: 'wamid.IMG', type: 'image', image: { id: 'media-id' } }],
        },
      }],
    }],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].messageText, '📷 image', 'image → label reaches the timeline');
}

// ── Regression: FB/IG shapes still parse (idColumnFor refactor touched this path) ──
{
  const { platform, events } = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{ sender: { id: 'IGSID_1' }, message: { text: 'hello from IG' } }] }],
  });
  assert.equal(platform, 'instagram');
  assert.equal(events[0].senderId, 'IGSID_1');
  assert.equal(events[0].messageText, 'hello from IG');
  assert.equal(events[0].profileName, null);   // fetched via API, not inline
}

{
  const { platform, events } = extractEvents({
    object: 'page',
    entry: [{ messaging: [{ sender: { id: 'PSID_1' }, message: { text: 'hello from FB' } }] }],
  });
  assert.equal(platform, 'facebook');
  assert.equal(events[0].senderId, 'PSID_1');
}

// FB/IG echoes (our own outbound) must stay flagged
{
  const { events } = extractEvents({
    object: 'page',
    entry: [{ messaging: [{ sender: { id: 'PAGE_ID' }, message: { text: 'our reply', is_echo: true } }] }],
  });
  assert.equal(events[0].isEcho, true);
}

// FB/IG test-button shape (entry[].changes[] with value.sender/value.message)
{
  const { events } = extractEvents({
    object: 'instagram',
    entry: [{ changes: [{ field: 'messages', value: { sender: { id: 'IGSID_2' }, message: { text: 'test button' } } }] }],
  });
  assert.equal(events[0].senderId, 'IGSID_2');
  assert.equal(events[0].messageText, 'test button');
}

// ── Unknown / empty payloads ─────────────────────────────────
assert.deepEqual(extractEvents({ object: 'unknown_thing' }), { platform: null, events: [] });
assert.deepEqual(extractEvents({}), { platform: null, events: [] });
assert.equal(extractEvents({ object: 'page', entry: [] }).events.length, 0);
assert.equal(extractEvents({ object: 'page' }).events.length, 0);

// ── Instagram comments: the comment-to-DM automation stream ──
{
  const payload = {
    object: 'instagram',
    entry: [{
      id: 'IG_ACCOUNT_ID',
      time: 1753660800,
      changes: [{
        field: 'comments',
        value: {
          from:  { id: 'COMMENTER_ID', username: 'priya.sharma' },
          media: { id: 'MEDIA_1', media_product_type: 'REELS' },
          id:    'COMMENT_1',
          text:  'what is the PRICE of laser?',
        },
      }],
    }],
  };

  const [c] = extractComments(payload);
  assert.equal(c.commentId, 'COMMENT_1');
  assert.equal(c.text, 'what is the PRICE of laser?');
  assert.equal(c.fromId, 'COMMENTER_ID');
  assert.equal(c.username, 'priya.sharma');
  assert.equal(c.accountId, 'IG_ACCOUNT_ID');   // entry.id = our account, for the self-guard

  // A comments payload must not leak into the DM stream (and vice versa).
  assert.equal(extractEvents(payload).events.length, 0, 'comments must not become message events');
  assert.equal(extractComments({
    object: 'instagram',
    entry: [{ messaging: [{ sender: { id: 'IGSID_1' }, message: { text: 'hi' } }] }],
  }).length, 0, 'DMs must not become comment events');
}

// Facebook uses the 'feed' field (with item:'comment'), never 'comments';
// a page + 'comments' combo yields nothing.
assert.equal(extractComments({ object: 'page', entry: [{ changes: [{ field: 'comments', value: {} }] }] }).length, 0);
assert.equal(extractComments({}).length, 0);

// ── Facebook Page feed comments: the comment-to-DM stream ──
{
  const payload = {
    object: 'page',
    entry: [{ id: 'PAGE_ID', time: 1753660800, changes: [{ field: 'feed', value: {
      item: 'comment', verb: 'add',
      comment_id: 'FB_COMMENT_1',
      message: 'what is the PRICE of laser?',
      from: { id: 'FB_USER_1', name: 'Priya Sharma' },
      post_id: 'FB_POST_1',
    } }] }],
  };

  const [c] = extractComments(payload);
  assert.equal(c.platform,  'facebook');
  assert.equal(c.commentId, 'FB_COMMENT_1');
  assert.equal(c.text,      'what is the PRICE of laser?');
  assert.equal(c.fromId,    'FB_USER_1');
  assert.equal(c.name,      'Priya Sharma');        // FB gives the display name inline
  assert.equal(c.accountId, 'PAGE_ID');             // entry.id = our page, for the self-guard

  // 'feed' must not leak non-comment items, edits or removals
  assert.equal(extractComments({ object:'page', entry:[{ id:'P', changes:[{ field:'feed', value:{ item:'post',  verb:'add' } }] }] }).length, 0);
  assert.equal(extractComments({ object:'page', entry:[{ id:'P', changes:[{ field:'feed', value:{ item:'like',  verb:'add' } }] }] }).length, 0);
  assert.equal(extractComments({ object:'page', entry:[{ id:'P', changes:[{ field:'feed', value:{ item:'comment', verb:'edited', comment_id:'x' } }] }] }).length, 0);
  assert.equal(extractComments({ object:'page', entry:[{ id:'P', changes:[{ field:'feed', value:{ item:'comment', verb:'remove', comment_id:'x' } }] }] }).length, 0);

  // A feed-comment payload must not leak into the DM stream
  assert.equal(extractEvents(payload).events.length, 0, 'feed comment must not become a message event');

  // Threaded-reply marker survives extraction
  const [c2] = extractComments({ object:'page', entry:[{ id:'PAGE_ID', changes:[{ field:'feed', value: {
    item:'comment', verb:'add', comment_id:'FB_C2', message:'ok',
    from:{ id:'U', name:'X' }, parent_id:'FB_COMMENT_1',
  } }] }] });
  assert.equal(c2.parentId, 'FB_COMMENT_1');

  // Self-comment guard: a Page-authored comment has from.id === entry.id
  const [c3] = extractComments({ object:'page', entry:[{ id:'PAGE_ID', changes:[{ field:'feed', value: {
    item:'comment', verb:'add', comment_id:'FB_C3', message:'Check your DM',
    from:{ id:'PAGE_ID', name:'Clinix360' },
  } }] }] });
  assert.equal(c3.fromId, c3.accountId, 'our own reply must be detectable → no infinite loop');

  // Facebook sets parent_id on EVERY comment — for a top-level comment it equals
  // post_id. Such a comment must NOT be flagged as a threaded reply (processComment
  // would otherwise skip it — the exact bug that hid the first real test comment).
  const [c4] = extractComments({ object:'page', entry:[{ id:'PAGE_ID', changes:[{ field:'feed', value: {
    item:'comment', verb:'add', comment_id:'FB_C4', message:'book',
    from:{ id:'U', name:'X' },
    post_id:'POST_1', parent_id:'POST_1',        // parent_id === post_id → top-level
  } }] }] });
  assert.equal(c4.parentId, null, 'top-level comment (parent_id===post_id) must not be skipped as threaded');
}

// Regression: the IG branch of the generalized extractor still works
{
  const [ig] = extractComments({ object:'instagram', entry:[{ id:'IG_ID', changes:[{ field:'comments', value: {
    from: { id: 'IG_USER', username: 'priya.sharma' }, id: 'IG_C1', text: 'hi', parent_id: 'IG_PARENT',
  } }] }] });
  assert.equal(ig.platform,  'instagram');
  assert.equal(ig.commentId, 'IG_C1');
  assert.equal(ig.username,  'priya.sharma');
  assert.equal(ig.parentId,  'IG_PARENT');
  assert.equal(ig.name,      null);
}

// Instagram top-level comment whose parent_id points at the media (the post) — the
// same shape that hid every top-level FB comment (commit d793b23). If Meta sends this,
// processComment must NOT skip it as a threaded reply, or IG automation never fires.
{
  const [ig] = extractComments({ object:'instagram', entry:[{ id:'IG_ID', changes:[{ field:'comments', value: {
    from: { id: 'IG_USER', username: 'priya.sharma' },
    media: { id: 'MEDIA_1' },
    id: 'IG_TOP', text: 'price?', parent_id: 'MEDIA_1',   // parent_id === media.id → top-level
  } }] }] });
  assert.equal(ig.parentId, null, 'top-level IG comment (parent_id===media.id) must not be skipped as threaded');
}

// Self-comment + threaded-reply markers survive extraction so processComment can skip them
{
  const [c] = extractComments({
    object: 'instagram',
    entry: [{ id: 'IG_ACCOUNT_ID', changes: [{ field: 'comments', value: {
      from: { id: 'IG_ACCOUNT_ID' }, id: 'COMMENT_2', text: 'Check your DM', parent_id: 'COMMENT_1',
    } }] }],
  });
  assert.equal(c.fromId, c.accountId, 'our own reply must be detectable → no infinite loop');
  assert.equal(c.parentId, 'COMMENT_1');
}

// A postback (button tap) must survive extraction — before this it was dropped entirely
{
  const { events } = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{
      sender:   { id: 'IGSID_1' },
      postback: { mid: 'm1', title: 'Dwarka', payload: 'BRANCH:9a3aff6c' },
    }] }],
  });
  assert.equal(events.length, 1, 'a button tap must not be dropped');
  assert.equal(events[0].payload, 'BRANCH:9a3aff6c');
  // The title becomes the message text so the tap reads as "Dwarka" in the inbox.
  assert.equal(events[0].messageText, 'Dwarka');
}
// A quick-reply tap lands on the same field
{
  const { events } = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{
      sender:  { id: 'IGSID_1' },
      message: { mid: 'm1', text: 'Dwarka', quick_reply: { payload: 'BRANCH:9a3aff6c' } },
    }] }],
  });
  assert.equal(events[0].payload, 'BRANCH:9a3aff6c');
  assert.equal(events[0].messageText, 'Dwarka');
}
// A typed reply has no payload — the router falls back to name matching
{
  const { events } = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{ sender: { id: 'IGSID_1' }, message: { text: 'dwarka' } }] }],
  });
  assert.equal(events[0].payload, undefined);
  assert.equal(events[0].messageText, 'dwarka');
}
// Regression: postback handling must not resurrect echoes or break plain DMs
{
  const { events } = extractEvents({
    object: 'page',
    entry: [{ messaging: [{ sender: { id: 'PAGE_ID' }, message: { text: 'our reply', is_echo: true } }] }],
  });
  assert.equal(events[0].isEcho, true);
  assert.equal(events[0].payload, undefined);
}

// ── Attachments: shares/images are labeled, not dropped (chatbot Step 2) ──
{
  // IG shared post — current type `ig_post` (legacy `share` removed ~Feb 2026):
  // caption as title, CDN url, and the media id directly (final plan §3.4).
  const { events } = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{
      sender:  { id: 'IGSID_1' },
      message: { mid: 'm_share', attachments: [{
        type: 'ig_post',
        payload: {
          ig_post_media_id: '18139494541428835',
          title: 'Full arms laser — special offer this month!',
          url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18139494541428835',
        },
      }] },
    }] }],
  });
  assert.equal(events.length, 1, 'a share must not be dropped');
  assert.equal(events[0].messageText, '🔗 shared post: Full arms laser — special offer this month!');
  assert.equal(events[0].attachment.type, 'ig_post');
  assert.equal(events[0].attachment.mediaId, '18139494541428835');
  assert.equal(events[0].attachment.url, 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18139494541428835');
  assert.equal(events[0].messageId, 'm_share', 'share carries its mid for dedup');
  assert.equal(events[0].isEcho, false);

  // ig_reel (shared reel) gets the same share label; no title → falls back to url
  const reel = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{
      sender:  { id: 'IGSID_1' },
      message: { mid: 'm_reel', attachments: [{ type: 'ig_reel', payload: { ig_post_media_id: 'M2', url: 'https://cdn.example/x' } }] },
    }] }],
  });
  assert.equal(reel.events[0].messageText, '🔗 shared post: https://cdn.example/x');

  // Legacy `share` type (pre-Feb-2026 payloads) still labeled
  const legacy = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{
      sender:  { id: 'IGSID_1' },
      message: { mid: 'm_leg', attachments: [{ type: 'share', payload: { url: 'https://instagram.com/p/OLD/' } }] },
    }] }],
  });
  assert.equal(legacy.events[0].messageText, '🔗 shared post: https://instagram.com/p/OLD/');

  // IG image — often arrives URL-less; label needs no URL
  const img = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{
      sender:  { id: 'IGSID_1' },
      message: { mid: 'm_img', attachments: [{ type: 'image', payload: {} }] },
    }] }],
  });
  assert.equal(img.events.length, 1);
  assert.equal(img.events[0].messageText, '📷 image');
  assert.equal(img.events[0].attachment.type, 'image');

  // Text + attachment together (captioned share): text wins, media id still rides along
  const both = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{
      sender:  { id: 'IGSID_1' },
      message: { mid: 'm_both', text: 'price of this?', attachments: [{
        type: 'ig_post', payload: { ig_post_media_id: '1813', title: 'Laser offer' },
      }] },
    }] }],
  });
  assert.equal(both.events[0].messageText, 'price of this?');
  assert.equal(both.events[0].attachment.mediaId, '1813');

  // Unknown attachment type: still labeled, never dropped
  const odd = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{
      sender:  { id: 'IGSID_1' },
      message: { mid: 'm_v', attachments: [{ type: 'video' }] },
    }] }],
  });
  assert.equal(odd.events[0].messageText, '📎 video');
}

// ── Rule matching ────────────────────────────────────────────
{
  const rules = [
    { keyword: '*',      public: 'Thanks!',       dm: 'Hi there!' },
    { keyword: 'price',  public: 'Check your DM', dm: 'Our price list…' },
    { keyword: 'timing', public: 'Sent!',         dm: '10am–8pm' },
  ];

  // Keyword beats the catch-all even when '*' is listed first, and is case-insensitive.
  assert.equal(matchCommentRule('What is the PRICE?', rules).keyword, 'price');
  assert.equal(matchCommentRule('timing please', rules).keyword, 'timing');
  // Nothing specific matched → catch-all.
  assert.equal(matchCommentRule('nice post 😍', rules).keyword, '*');
  // No catch-all configured → no reply at all.
  assert.equal(matchCommentRule('nice post', [{ keyword: 'price', dm: 'x' }]), null);
  assert.equal(matchCommentRule('anything', []), null);
  assert.equal(matchCommentRule(undefined, rules).keyword, '*');
}

// ── Branch routing from the reply (real branch names) ────────
{
  const BRANCHES = [
    { id: '8db5a0fb-a7d4-435b-951e-6f1cb5d85fc9', name: 'Janakpuri' },
    { id: 'e1d26aab-025d-4136-8a91-867a16c5a9ef', name: 'Kirti Nagar' },
    { id: '9a3aff6c-84b5-4c7f-95e8-6af3c9ec0556', name: 'Dwarka Sec 12' },
  ];

  assert.equal(matchBranch('Janakpuri', BRANCHES).name, 'Janakpuri');
  assert.equal(matchBranch('janakpuri', BRANCHES).name, 'Janakpuri');
  // First-word match — nobody types "Dwarka Sec 12"
  assert.equal(matchBranch('dwarka', BRANCHES).name, 'Dwarka Sec 12');
  assert.equal(matchBranch('kirti', BRANCHES).name, 'Kirti Nagar');
  // Inside a sentence
  assert.equal(matchBranch("i'm closest to Dwarka sec 12 branch", BRANCHES).name, 'Dwarka Sec 12');
  assert.equal(matchBranch('Janakpuri please', BRANCHES).name, 'Janakpuri');
  // Ambiguous → null, never a guess
  assert.equal(matchBranch('janakpuri or dwarka?', BRANCHES), null);
  // Unrecognised → null, lead stays in the fallback inbox for staff
  assert.equal(matchBranch('the nearest one', BRANCHES), null);
  assert.equal(matchBranch('hi', BRANCHES), null);
  assert.equal(matchBranch('', BRANCHES), null);
  assert.equal(matchBranch(undefined, BRANCHES), null);
  assert.equal(matchBranch('janakpuri', []), null);
  // A blank/missing branch name must not match everything
  assert.equal(matchBranch('janakpuri', [{ id: 'x', name: '' }, { id: 'y' }]), null);
}

// ── Webhook signature verification (#1) ─────────────────────
{
  const crypto = require('crypto');
  const body = JSON.stringify({ object: 'page', entry: [{ messaging: [{ sender: { id: 'S' }, message: { text: 'hi' } }] }] });
  const secret = 'test_app_secret_value';
  const good = 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  process.env.META_APP_SECRET = secret;
  assert.equal(verifyMetaSignature(body, good), true, 'a valid HMAC signature must verify');
  assert.equal(verifyMetaSignature(body, 'sha256=' + '0'.repeat(64)), false, 'a wrong signature must reject');
  assert.equal(verifyMetaSignature(body, undefined), false, 'a missing signature header must reject');
  assert.equal(verifyMetaSignature(body, 'badprefix=abc'), false, 'a malformed header must reject');
  delete process.env.META_APP_SECRET;
  assert.equal(verifyMetaSignature(body, undefined), true, 'no secret configured → dev fallback (allow + warn)');
}

// ── extractEvents carries Meta message ids for inbound idempotency (#4) ──
{
  const wa = extractEvents({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ profile: { name: 'A' }, wa_id: '91' }],
      messages: [{ from: '91', id: 'wamid.XYZ', text: { body: 'hi' } }],
    } }] }],
  });
  assert.equal(wa.events[0].messageId, 'wamid.XYZ', 'WA event must carry the wamid for dedup');

  const ig = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{ sender: { id: 'IGS' }, message: { mid: 'm_123', text: 'hi' } }] }],
  });
  assert.equal(ig.events[0].messageId, 'm_123', 'IG/FB event must carry message.mid for dedup');

  const pb = extractEvents({
    object: 'instagram',
    entry: [{ messaging: [{ sender: { id: 'IGS' }, postback: { mid: 'pb_1', title: 'Dwarka', payload: 'BRANCH:x' } }] }],
  });
  assert.equal(pb.events[0].messageId, 'pb_1', 'a postback must carry its mid for dedup');
}

// ── classifyInbound: the D7 layer-1 safety net (chatbot Step 5) ──
{
  // medical → corpus-mined symptom / medicine / pregnancy phrasings
  assert.equal(classifyInbound('khujli ho rahi hai'), 'medical');
  assert.equal(classifyInbound('skin pe khujali aa rahi hai'), 'medical');
  assert.equal(classifyInbound('koi dawai lagni hai kya'), 'medical');
  assert.equal(classifyInbound('can you prescribe any medicine?'), 'medical');
  assert.equal(classifyInbound('main garbhvati hoon, laser karwa sakti hu?'), 'medical');
  assert.equal(classifyInbound('I am pregnant — is laser safe?'), 'medical');
  assert.equal(classifyInbound('after the facial I have burning and rash'), 'medical');
  assert.equal(classifyInbound('pimple ka ilaj kaiese hota hai'), 'medical');
  // emergency → outranks medical when both are present (§8.1)
  assert.equal(classifyInbound('URGENT! khoon beh raha hai after laser'), 'emergency');
  assert.equal(classifyInbound('bukhar aa gaya hai after the treatment'), 'emergency');
  assert.equal(classifyInbound('skin jal gaya hai'), 'emergency');
  assert.equal(classifyInbound('khujli ho rahi hai aur khoon bhi beh raha hai'), 'emergency',
    'emergency must outrank medical');
  // requested → wants a human
  assert.equal(classifyInbound('talk to a human please'), 'requested');
  assert.equal(classifyInbound('insaan se baat karo'), 'requested');
  assert.equal(classifyInbound('can I speak to a real person?'), 'requested');
  // FAQ / lead traffic passes through to the LLM (null = no safety tier)
  assert.equal(classifyInbound('price of laser'), null);
  assert.equal(classifyInbound('PCOS hai to laser safe?'), null, 'condition + risk-FAQ is NOT layer-1 medical');
  assert.equal(classifyInbound('kya laser painful hai?'), null, '"is it painful" is the signed-off risk FAQ');
  assert.equal(classifyInbound('hydra facial ka kitna price hai'), null);
  assert.equal(classifyInbound('full body laser ke liye offer hai?'), null);
  assert.equal(classifyInbound('we would love to collaborate'), null);
  assert.equal(classifyInbound('fat freezing coolsculpt ka price'), null);
  // attachment labels / junk never trip the net
  assert.equal(classifyInbound('📷 image'), null);
  assert.equal(classifyInbound('🔗 shared post: Laser offer'), null);
  assert.equal(classifyInbound(''), null);
  assert.equal(classifyInbound(undefined), null);
}

// ── callAssistant + botReply (chatbot Steps 6–12): async, mocked fetch ──
(async () => {
  const realFetch = global.fetch;

  // callAssistant: happy path → parsed decision + correct request shape
  {
    process.env.GEMINI_API_KEY = 'test_key';
    let captured;
    global.fetch = async (url, opts = {}) => {
      captured = { url, opts };
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{
        text: JSON.stringify({ category: 'lead', is_medical: false, reply: 'Full body laser is ₹35,000…',
                               kb_covers: true, handoff: false, reason: 'wants_booking',
                               qualification: { service: 'LHR FULL BODY P/S' } }),
      }] } }] }) };
    };
    try {
      const decision = await callAssistant({
        model: 'gemini-3.5-flash-lite',
        kb: { entries: [{ type: 'service', key: 'LHR FULL BODY P/S', price: 35000 }] },
        history: [{ role: 'user', text: 'hi' }, { role: 'model', text: 'hello!' }],
        inboundText: 'price of laser',
      });
      assert.equal(decision.category, 'lead');
      assert.equal(decision.qualification.service, 'LHR FULL BODY P/S');
      // model in the URL, key in a header (never the query string)
      assert.match(captured.url, /models\/gemini-3\.5-flash-lite:generateContent$/);
      assert.ok(!captured.url.includes('test_key'), 'API key must not leak into the URL');
      assert.equal(captured.opts.headers['x-goog-api-key'], 'test_key');
      const body = JSON.parse(captured.opts.body);
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.deepEqual(body.generationConfig.responseSchema.required,
        ['category', 'is_medical', 'reply', 'kb_covers', 'handoff', 'reason']);
      assert.ok(body.systemInstruction.parts.some(p => p.text.includes('LHR FULL BODY P/S')),
        'whole KB injected into the prompt (D20)');
      assert.ok(body.contents.at(-1).parts[0].text.includes('price of laser'));
      assert.equal(body.contents.length, 3, 'history + current message');

      // HTTP failure → throws (caller maps to llm_error, D13)
      global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) });
      await assert.rejects(() => callAssistant({ inboundText: 'x' }), /Gemini call failed: 429/);

      // malformed output (prose instead of JSON) → throws, never parsed loosely
      global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Sure! The price is…' }] } }] }) });
      await assert.rejects(() => callAssistant({ inboundText: 'x' }));

      // blocked / empty candidates → throws
      global.fetch = async () => ({ ok: true, json: async () => ({ candidates: [] }) });
      await assert.rejects(() => callAssistant({ inboundText: 'x' }));

      // missing key → throws
      delete process.env.GEMINI_API_KEY;
      await assert.rejects(() => callAssistant({ inboundText: 'x' }), /GEMINI_API_KEY/);
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  }

  // ── normalizePhone (D16): digit-normalized in CODE, 10-digit IN mobile only ──
  assert.equal(normalizePhone('+91 98765 43210'), '9876543210');
  assert.equal(normalizePhone('09876543210'), '9876543210');
  assert.equal(normalizePhone('9876543210'), '9876543210');
  assert.equal(normalizePhone('my number is 9876543210 ok?'), '9876543210');
  assert.equal(normalizePhone('1234567890'), null, 'must start 6–9 (IN mobile)');
  assert.equal(normalizePhone('987654321'), null, '9 digits rejected');
  assert.equal(normalizePhone('+1 555 123 4567'), null, 'US number rejected');
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone(undefined), null);

  // ── sendByPlatform dispatch ──
  {
    const hit = [];
    // sendByPlatform closes over the module-local sender fns — verify dispatch
    // via its observable effect: stub global.fetch per platform endpoint.
    global.fetch = async (url, opts = {}) => {
      // WA shares graph.facebook.com with FB — its body is the tell.
      const body = JSON.parse(opts.body || '{}');
      hit.push(body.messaging_product === 'whatsapp' ? 'wa'
        : url.includes('graph.facebook') ? 'fb' : 'ig');
      return { ok: true, json: async () => ({}) };
    };
    process.env.META_ACCESS_TOKEN = 't'; process.env.META_PAGE_ACCESS_TOKEN = 't';
    process.env.WHATSAPP_ACCESS_TOKEN = 't'; process.env.WHATSAPP_PHONE_NUMBER_ID = 'p';
    await sendByPlatform('facebook', 'P', 'hi');
    await sendByPlatform('whatsapp', 'W', 'hi');
    await sendByPlatform('instagram', 'I', 'hi');
    assert.deepEqual(hit, ['fb', 'wa', 'ig'], 'each platform hits its own sender endpoint');
    delete process.env.META_PAGE_ACCESS_TOKEN; delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  }

  // ── botReply: the full turn pipeline (§8.1 — Steps 8–12) ──
  {
    // dummy creds so getSettingJson/createSupabaseClient actually fetch (mocked)
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'test_anon';
    process.env.GEMINI_API_KEY = 'test_key';
    process.env.META_ACCESS_TOKEN = 'ig_token';

    const EV = { messageText: 'price of laser', senderId: 'IGSID_9', messageId: 'mid_1' };
    const LEAD = { id: 'L1', branch_id: 'B1', bot_active: true };

    // One mock that routes every URL botReply can touch, recording each call
    // kind. `history` = rows listRecentMessages returns (newest-first from the
    // API; the client reverses — pass oldest-first like the real helper returns).
    const botMock = ({ config, history = [], decision, geminiError, sendFails = false } = {}) => {
      const calls = { sends: [], msgInserts: [], patches: [], shadowLogs: [], gemini: [], historyFetches: 0 };
      global.fetch = async (url, opts = {}) => {
        if (url.includes('settings?key=eq.chatbot_config'))
          return { ok: true, json: async () => [{ value: JSON.stringify(config) }] };
        if (url.includes('generativelanguage.googleapis.com')) {
          calls.gemini.push({ url, opts });
          if (geminiError) return { ok: false, status: 500, json: async () => ({ error: { message: geminiError } }) };
          return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(decision) }] } }] }) };
        }
        if (url.includes('graph.instagram.com')) {              // the bot's send
          if (sendFails) return { ok: false, status: 400, json: async () => ({ error: { message: 'window closed' } }) };
          calls.sends.push(JSON.parse(opts.body));
          return { ok: true, json: async () => ({ recipient_id: 'IGSID_9', message_id: 'm_bot' }) };
        }
        if (url.includes('/lead_messages') && (opts.method === 'POST')) {   // bot outgoing persist
          calls.msgInserts.push(JSON.parse(opts.body));
          return { ok: true, json: async () => [{ id: 'out_' + calls.msgInserts.length }] };
        }
        if (url.includes('lead_messages?lead_id=eq.')) {        // history GET
          calls.historyFetches++;
          // The real API returns newest-first; listRecentMessages reverses it.
          // Spread so the client's in-place reverse() can't mutate the fixture.
          return { ok: true, json: async () => [...history].reverse() };
        }
        if (url.includes('/leads?id=eq.') && opts.method === 'PATCH') {
          calls.patches.push({ url, body: JSON.parse(opts.body) });
          return { ok: true, json: async () => [] };
        }
        if (url.includes('/bot_shadow_log')) {
          calls.shadowLogs.push(JSON.parse(opts.body));
          return { ok: true, json: async () => [{ id: 1 }] };
        }
        throw new Error('unexpected fetch: ' + url);
      };
      return calls;
    };

    const CFG = (mode, over = {}) => ({
      mode,
      model: 'gemini-3.5-flash-lite',
      kb: { entries: [] },
      canned: {
        collaboration: 'Thanks for reaching out about collaborations!',
        sales_pitch:   'Thank you for the information.',
        misc:          'Thanks for your message!',
        kb_miss:       'Let me check with our team.',
        llm_error:     'Let me connect you with our team.',
        disclosure:    'Hi! I am the clinic’s assistant 🤖',
        refusal_ok:    'No problem at all.',
      },
      ...over,
    });

    const REPLY_DECISION = {
      category: 'lead', is_medical: false,
      reply: 'Full body laser is ₹35,000 per session. Which branch is closest to you?',
      kb_covers: true, handoff: false, reason: 'wants_booking',
      qualification: { service: 'LHR FULL BODY P/S', phone: '+91 98765 43210' },
    };

    // 1) bot_active=false → strict no-op, zero network calls
    {
      const calls = botMock({ config: CFG('live') });
      const r = await botReply({ ...LEAD, bot_active: false }, EV, 'instagram');
      assert.deepEqual(r, { skipped: 'bot_inactive' });
      assert.equal(calls.sends.length + calls.patches.length + calls.gemini.length, 0,
        'inactive lead must not touch the network');
    }

    // 2) mode='off' (or absent) → no-op after reading settings, no writes
    {
      const calls = botMock({ config: CFG('off') });
      assert.deepEqual(await botReply(LEAD, EV, 'instagram'), { skipped: 'mode_off' });
      assert.equal(calls.patches.length, 0);
      botMock({ config: {} });
      assert.deepEqual(await botReply(LEAD, EV, 'instagram'), { skipped: 'mode_off' },
        'missing mode defaults to off');
    }

    // 3) safety net fires BEFORE Gemini: medical text → handoff, NO reply sent (D7)
    {
      const calls = botMock({ config: CFG('live') });
      const r = await botReply(LEAD, { ...EV, messageText: 'khujli ho rahi hai' }, 'instagram');
      assert.equal(r.handoff, 'medical');
      assert.equal(calls.gemini.length, 0, 'a safety-tier hit must NEVER reach Gemini (D7 layer 1)');
      assert.equal(calls.sends.length, 0, 'a medical handoff sends NOTHING — no answer, no courtesy line');
      assert.equal(calls.patches.length, 1);
      assert.equal(calls.patches[0].url.includes('leads?id=eq.L1'), true);
      const b = calls.patches[0].body;
      assert.equal(b.bot_active, false, 'handoff must flip bot_active off');
      assert.equal(b.status, 'qualified');
      assert.match(b.bot_state.handoff_summary, /medical/);
      assert.match(b.bot_state.handoff_summary, /khujli ho rahi hai/,
        'medical summary carries the customer verbatim (D11)');
      assert.equal(b.bot_state.handoff_reason, 'medical');
    }

    // 4) live happy path, FIRST bot turn: disclosure prepend (D15), reply sent
    //    via the platform sender, outgoing persisted is_bot=true, category +
    //    normalized qualification persisted (D14/D16)
    {
      const calls = botMock({ config: CFG('live'), decision: REPLY_DECISION });
      const r = await botReply(LEAD, EV, 'instagram', { id: 'inbound_row' });
      assert.deepEqual(r, { sent: true });
      assert.equal(calls.gemini.length, 1);
      assert.equal(calls.sends.length, 1);
      const sent = calls.sends[0].message.text;
      assert.ok(sent.startsWith('Hi! I am the clinic’s assistant 🤖\n\n'), 'disclosure prepends the first bot turn');
      assert.ok(sent.includes('₹35,000'));
      assert.equal(calls.msgInserts.length, 1);
      assert.equal(calls.msgInserts[0].is_bot, true);
      assert.equal(calls.msgInserts[0].direction, 'outgoing');
      assert.equal(calls.patches.length, 1);
      assert.equal(calls.patches[0].body.category, 'lead');
      assert.equal(calls.patches[0].body.bot_state.qualification.phone, '9876543210',
        'phone digit-normalized in code (D16)');
      assert.equal(calls.patches[0].body.bot_state.qualification.service, 'LHR FULL BODY P/S');
      assert.equal(calls.patches[0].body.bot_active, undefined, 'a normal turn never flips the bot off');
    }

    // 5) NOT the first bot turn: no disclosure; bot messages map to model role
    {
      const history = [
        { id: 'h0', direction: 'incoming', message: 'hi', is_bot: false, created_at: '2026-08-24T10:00:00Z' },
        { id: 'h1', direction: 'outgoing', message: 'hello! I can help', is_bot: true, created_at: '2026-08-24T10:00:05Z' },
      ];
      const calls = botMock({ config: CFG('live'), history, decision: REPLY_DECISION });
      const r = await botReply(LEAD, EV, 'instagram');
      assert.deepEqual(r, { sent: true });
      assert.equal(calls.sends[0].message.text, REPLY_DECISION.reply, 'no disclosure after the first bot turn');
      const body = JSON.parse(calls.gemini[0].opts.body);
      assert.equal(body.contents.length, 3, 'history + current message');
      assert.equal(body.contents[0].role, 'user');
      assert.equal(body.contents[1].role, 'model');
      assert.ok(body.contents.at(-1).parts[0].text.includes('price of laser'));
    }

    // 6) the inbound row is excluded from prompt history (no double-fed inbound)
    {
      const history = [{ id: 'm_current', direction: 'incoming', message: 'price of laser', is_bot: false, created_at: '2026-08-24T10:00:00Z' }];
      const calls = botMock({ config: CFG('live'), history, decision: REPLY_DECISION });
      await botReply(LEAD, EV, 'instagram', { id: 'm_current' });
      const body = JSON.parse(calls.gemini[0].opts.body);
      assert.equal(body.contents.length, 1, 'the just-stored inbound must not appear twice in the prompt');
    }

    // 7) non-lead (D2): ONE canned reply, filed, bot off, no status change
    {
      const calls = botMock({
        config: CFG('live'),
        decision: { ...REPLY_DECISION, category: 'collaboration', reply: '', handoff: false, reason: 'non_lead' },
      });
      const r = await botReply(LEAD, { ...EV, messageText: 'we would love to collaborate' }, 'instagram');
      assert.deepEqual(r, { non_lead: 'collaboration' });
      assert.equal(calls.sends.length, 1);
      assert.ok(calls.sends[0].message.text.includes('collaborations'), 'canned collaboration copy sent');
      assert.equal(calls.msgInserts[0].is_bot, true);
      const b = calls.patches[0].body;
      assert.equal(b.category, 'collaboration');
      assert.equal(b.bot_active, false, 'bot goes silent after the one canned reply');
      assert.equal(b.status, undefined, 'non-leads are not marked qualified');
    }

    // 8) model-decided handoff: model's closing reply sent, summary + qualified
    {
      const calls = botMock({
        config: CFG('live'),
        decision: { ...REPLY_DECISION, handoff: true, reason: 'qualified',
                    reply: 'Wonderful! Our team will confirm your slot shortly 🙏' },
      });
      const r = await botReply(LEAD, EV, 'instagram');
      assert.equal(r.handoff, 'qualified');
      assert.equal(calls.sends.length, 1);
      // First bot turn → disclosure prepends even a handoff closing reply (D15)
      assert.equal(calls.sends[0].message.text,
        'Hi! I am the clinic’s assistant 🤖\n\nWonderful! Our team will confirm your slot shortly 🙏');
      const b = calls.patches[0].body;
      assert.equal(b.bot_active, false);
      assert.equal(b.status, 'qualified');
      assert.match(b.bot_state.handoff_summary, /qualified/);
      assert.match(b.bot_state.handoff_summary, /LHR FULL BODY P\/S/);
      assert.match(b.bot_state.handoff_summary, /9876543210/);
    }

    // 9) kb_miss → canned hold copy + handoff (D13/D17 wiring; teach-loop is Step 13)
    {
      const calls = botMock({
        config: CFG('live'),
        decision: { ...REPLY_DECISION, kb_covers: false, handoff: true, reason: 'kb_miss', reply: '' },
      });
      const r = await botReply(LEAD, EV, 'instagram');
      assert.equal(r.handoff, 'kb_miss');
      assert.equal(calls.sends[0].message.text,
        'Hi! I am the clinic’s assistant 🤖\n\nLet me check with our team.',
        'first bot turn: disclosure + canned hold copy (D13/D15)');
    }

    // 10) is_medical (D7 layer 2): the model's own flag overrides its reply
    {
      const calls = botMock({
        config: CFG('live'),
        decision: { ...REPLY_DECISION, is_medical: true, reply: 'here is what the rash could be…' },
      });
      const r = await botReply(LEAD, EV, 'instagram');
      assert.equal(r.handoff, 'medical');
      assert.equal(calls.sends.length, 0, 'an is_medical reply must NEVER be sent');
      assert.equal(calls.patches[0].body.bot_state.handoff_reason, 'medical');
    }

    // 11) llm_error (D13): Gemini fails → canned "connect you" + handoff; the
    //     inbound (stored earlier) is untouched and the thread is never silent
    {
      const calls = botMock({ config: CFG('live'), geminiError: 'quota exceeded' });
      const r = await botReply(LEAD, EV, 'instagram');
      assert.equal(r.handoff, 'llm_error');
      assert.equal(calls.sends[0].message.text,
        'Hi! I am the clinic’s assistant 🤖\n\nLet me connect you with our team.');
      assert.equal(calls.patches[0].body.bot_active, false);
      assert.equal(calls.patches[0].body.status, 'qualified');
    }

    // 12) handoff survives a failed SEND: message delivery is not the handoff
    {
      const calls = botMock({ config: CFG('live'), geminiError: 'boom', sendFails: true });
      const r = await botReply(LEAD, EV, 'instagram');
      assert.equal(r.handoff, 'llm_error', 'handoff completes even when the courtesy reply cannot send');
      assert.equal(calls.patches.length, 1);
      assert.equal(calls.patches[0].body.bot_active, false);
    }

    // 13) shadow invariants (D19): one log row per turn, zero sends, zero lead
    //     mutations — on success, on Gemini error, AND on a safety-tier hit
    {
      // success
      let calls = botMock({ config: CFG('shadow'), decision: REPLY_DECISION });
      let r = await botReply(LEAD, EV, 'instagram', { id: 'm1' });
      assert.deepEqual(r, { shadow: true });
      assert.equal(calls.shadowLogs.length, 1, 'exactly one bot_shadow_log row per turn');
      assert.equal(calls.sends.length, 0, 'shadow NEVER sends');
      assert.equal(calls.patches.length, 0, 'shadow NEVER mutates leads');
      assert.equal(calls.msgInserts.length, 0, 'shadow persists no outgoing message');
      assert.equal(calls.shadowLogs[0].message_id, 'mid_1');
      assert.equal(calls.shadowLogs[0].platform, 'instagram');
      assert.equal(calls.shadowLogs[0].decision.reason, 'wants_booking');
      assert.ok(Number.isFinite(calls.shadowLogs[0].latency_ms));

      // Gemini error → still exactly one row, error recorded
      calls = botMock({ config: CFG('shadow'), geminiError: '429' });
      r = await botReply(LEAD, EV, 'instagram');
      assert.deepEqual(r, { shadow: true });
      assert.equal(calls.shadowLogs.length, 1, 'an error turn still logs exactly one row');
      assert.match(calls.shadowLogs[0].error, /429/);
      assert.equal(calls.shadowLogs[0].decision.reason, 'llm_error');
      assert.equal(calls.sends.length + calls.patches.length, 0);

      // safety tier in shadow: no Gemini call, no mutation — just the row
      calls = botMock({ config: CFG('shadow') });
      r = await botReply(LEAD, { ...EV, messageText: 'khujli ho rahi hai' }, 'instagram');
      assert.deepEqual(r, { shadow: true });
      assert.equal(calls.gemini.length, 0, 'keyword net still runs before Gemini in shadow');
      assert.equal(calls.shadowLogs.length, 1);
      assert.equal(calls.shadowLogs[0].decision.reason, 'medical');
      assert.equal(calls.patches.length, 0, 'a shadow safety hit must not flip the real lead');
    }

    // 14) a mid-turn crash is swallowed — returns {error}, never throws (D13)
    {
      global.fetch = async (url) => url.includes('settings')
        ? { ok: true, json: async () => [{ value: JSON.stringify({ mode: 'live' }) }] }
        : Promise.reject(new Error('network down'));
      const r = await botReply(LEAD, { ...EV, messageText: 'khujli ho rahi hai' }, 'instagram');
      assert.match(r.error, /network down/);
    }

    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.META_ACCESS_TOKEN;
  }

  global.fetch = realFetch;
  console.log('meta-service: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
