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
  createSupabaseClient,
  maybeCaptureKbCandidate,
  parseOfferCaption,
  isOfferFresh,
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

  // Comma-separated alternatives share one rule; stray spaces/empty parts ignored.
  const multi = [{ keyword: 'price, cost ,kitna,', dm: 'x' }];
  assert.equal(matchCommentRule('Kitna hai ye?', multi), multi[0]);
  assert.equal(matchCommentRule('laser COST?', multi), multi[0]);
  assert.equal(matchCommentRule('nice post', multi), null, 'an empty part must not match everything');

  // S7: word-start matching, so the Q27 keywords don't fire inside other words
  const q27 = [{ keyword: 'price, cost, rate, kitna, kitne, charges, fees, details, info, interested, book, dm', dm: 'x' }];
  for (const s of ['Great results 😍', 'so accurate!', 'tagging @admin_x', 'saw it on facebook'])
    assert.equal(matchCommentRule(s, q27), null, s);
  for (const s of ['rates?', 'DM me', 'booking kaise karu', 'Price??', 'pls share info', 'kitne ka hai', '#price'])
    assert.equal(matchCommentRule(s, q27), q27[0], s);
  assert.equal(matchCommentRule('cost (approx)?', [{ keyword: 'cost (approx', dm: 'x' }])?.dm, 'x', 'regex characters are literal');
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
  assert.equal(classifyInbound('Is this offer av right now as well'), null, '"right now" is a time phrase, not an emergency');
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
        ['category', 'is_medical', 'reply', 'kb_covers', 'asks_price', 'handoff', 'reason']);
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

  // ── parseOfferCaption + isOfferFresh (D9/D10, Step 14) ──
  {
    process.env.GEMINI_API_KEY = 'test_key';
    const KEYS = ['LHR FULL BODY P/S', 'HYDRA FACIAL P/S'];
    const okFetch = parsed => async () => ({ ok: true, json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(parsed) }] } }] }) });

    global.fetch = okFetch({ service: 'LHR FULL BODY P/S', offer_price: 9999 });
    let r = await parseOfferCaption({ caption: 'Full body laser special 9999!', serviceKeys: KEYS });
    assert.equal(r.service, 'LHR FULL BODY P/S');
    assert.equal(r.offer_price, 9999);

    // service not in the key list / no price / "" service → null (no offer)
    global.fetch = okFetch({ service: 'Not A Service', offer_price: 5000 });
    assert.equal(await parseOfferCaption({ caption: 'x', serviceKeys: KEYS }), null);
    global.fetch = okFetch({ service: 'HYDRA FACIAL P/S', offer_price: 0 });
    assert.equal(await parseOfferCaption({ caption: 'x', serviceKeys: KEYS }), null);
    global.fetch = okFetch({ service: '', offer_price: 5000 });
    assert.equal(await parseOfferCaption({ caption: 'x', serviceKeys: KEYS }), null);

    // HTTP failure → throws (caller degrades to "no offer")
    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) });
    await assert.rejects(() => parseOfferCaption({ caption: 'x', serviceKeys: KEYS }), /429/);
    delete process.env.GEMINI_API_KEY;

    // freshness: ms compare, 0 days = instantly stale, absent = 30-day default
    assert.equal(isOfferFresh(new Date().toISOString(), 30), true);
    assert.equal(isOfferFresh(new Date().toISOString(), 0), false);
    assert.equal(isOfferFresh(new Date(Date.now() - 5 * 864e5).toISOString(), 30), true);
    assert.equal(isOfferFresh(new Date(Date.now() - 40 * 864e5).toISOString(), 30), false);
    assert.equal(isOfferFresh(new Date().toISOString(), null), true);
    assert.equal(isOfferFresh(null, 30), false);
    assert.equal(isOfferFresh('garbage', 30), false);
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

  // ── routing happens BEFORE the inbound insert: the row carries the new branch,
  //    so the branch inbox's realtime feed (filtered on branch_id) shows it ──
  {
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'test_anon';
    process.env.META_BRANCH_ID = 'FALLBACK';
    const { handleWebhook } = require('./meta-service');
    const run = async (routeFails) => {
      const calls = { inserts: [], patches: [] };
      global.fetch = async (url, opts = {}) => {
        if (url.includes('settings?key=eq.')) return { ok: true, json: async () => [] };
        if (url.includes('/leads?instagram_user_id=eq.IGS_R'))
          return { ok: true, json: async () => [{ id: 'LR', branch_id: 'FALLBACK', bot_active: false, customer_name: 'Priya' }] };
        if (url.includes('/branches?')) return { ok: true, json: async () => [{ id: 'DWK', name: 'Dwarka Sec 12' }, { id: 'JPR', name: 'Janakpuri' }] };
        if (url.includes('/leads?id=eq.LR') && opts.method === 'PATCH') {
          if (routeFails) return { ok: false, status: 500, text: async () => 'db down' };
          calls.patches.push(JSON.parse(opts.body));
          return { ok: true, json: async () => [] };
        }
        if (url.includes('/lead_messages') && opts.method === 'POST') {
          calls.inserts.push(JSON.parse(opts.body));
          return { ok: true, json: async () => [{ id: 'in1' }] };
        }
        throw new Error('unexpected fetch: ' + url);
      };
      await handleWebhook({ object: 'instagram', entry: [{ messaging: [{ sender: { id: 'IGS_R' }, message: { mid: 'm_r', text: 'dwarka' } }] }] });
      return calls;
    };
    let calls = await run(false);
    assert.deepEqual(calls.patches, [{ branch_id: 'DWK' }]);
    assert.equal(calls.inserts[0].branch_id, 'DWK', 'the routing reply itself lands in the new branch inbox');
    calls = await run(true);
    assert.equal(calls.inserts.length, 1, 'a routing failure never drops the message');
    assert.equal(calls.inserts[0].branch_id, 'FALLBACK');
    delete process.env.META_BRANCH_ID;
  }

  // ── processEcho: a reply typed in the IG app is stored + takes the bot over;
  //    the echo of our own send (same text, just stored) is ignored ──
  {
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'test_anon';
    const { processEcho } = require('./meta-service');
    const echoMock = ({ history = [], dup = false } = {}) => {
      const calls = { fetches: 0, inserts: [], patches: [] };
      global.fetch = async (url, opts = {}) => {
        calls.fetches++;
        if (url.includes('/leads?instagram_user_id=eq.IGSID_9'))
          return { ok: true, json: async () => [{ id: 'L1', branch_id: 'B1', bot_active: true, bot_state: {} }] };
        if (url.includes('lead_messages?lead_id=eq.')) return { ok: true, json: async () => [...history].reverse() };
        if (url.includes('/lead_messages') && opts.method === 'POST') {
          calls.inserts.push(JSON.parse(opts.body));
          return dup ? { ok: false, status: 409, json: async () => ({ code: '23505' }) }
                     : { ok: true, json: async () => [{ id: 'row1' }] };
        }
        if (url.includes('/leads?id=eq.L1') && opts.method === 'PATCH') {
          calls.patches.push(JSON.parse(opts.body));
          return { ok: true, json: async () => [] };
        }
        throw new Error('unexpected fetch: ' + url);
      };
      return calls;
    };
    const echo = (text, extra = {}) => ({ isEcho: true, senderId: 'IG_ACCOUNT', recipientId: 'IGSID_9', messageId: 'm_echo', messageText: text, ...extra });
    const now = new Date().toISOString();

    // our own send (bot / dashboard) — the row is already there → nothing happens
    let calls = echoMock({ history: [{ id: 'o1', direction: 'outgoing', message: 'Which branch?', created_at: now }] });
    await processEcho(echo('Which branch?'), 'instagram', 0);
    assert.equal(calls.inserts.length + calls.patches.length, 0, 'the echo of our own send is not a takeover');

    // staff typed in the IG app → stored as outgoing (dashboard shows it) + bot off
    calls = echoMock({ history: [{ id: 'o1', direction: 'outgoing', message: 'Which branch?', created_at: now }] });
    await processEcho(echo('Hi, Dr. Mehta here — 11am works'), 'instagram', 0);
    assert.equal(calls.inserts.length, 1);
    assert.equal(calls.inserts[0].direction, 'outgoing');
    assert.equal(calls.inserts[0].external_message_id, 'm_echo');
    assert.deepEqual(calls.patches, [{ bot_active: false }], 'an app reply is a D12 takeover');

    // same text as an OLD bot line (not a fresh send) → still a staff reply
    calls = echoMock({ history: [{ id: 'o1', direction: 'outgoing', message: 'Thank you!', created_at: '2026-08-25T07:00:00Z' }] });
    await processEcho(echo('Thank you!'), 'instagram', 0);
    assert.equal(calls.patches.length, 1);

    // a redelivered app echo stores nothing twice and flips nothing twice
    calls = echoMock({ dup: true });
    await processEcho(echo('hello'), 'instagram', 0);
    assert.equal(calls.patches.length, 0);

    // our comment-DM button template echo, and Meta's text-less test echo → no DB at all
    calls = echoMock();
    await processEcho(echo(undefined, { attachment: { type: 'template' } }), 'instagram', 0);
    await processEcho(echo('📎 template', { attachment: { type: 'template' } }), 'instagram', 0);
    await processEcho(echo('hi', { recipientId: undefined }), 'instagram', 0);
    assert.equal(calls.fetches, 0);
  }

  // ── botReply: the full turn pipeline (§8.1 — Steps 8–12) ──
  {
    // dummy creds so getSettingJson/createSupabaseClient actually fetch (mocked)
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'test_anon';
    process.env.GEMINI_API_KEY = 'test_key';
    process.env.META_ACCESS_TOKEN = 'ig_token';
    process.env.RESEND_API_KEY = 'test_resend';

    const EV = { messageText: 'price of laser', senderId: 'IGSID_9', messageId: 'mid_1' };
    // created_at fresh so the conversation-age cap (#17) never fires unless a test wants it
    const LEAD = { id: 'L1', branch_id: 'B1', bot_active: true, customer_name: 'Priya Sharma',
                   created_at: new Date().toISOString() };

    // One mock that routes every URL botReply can touch, recording each call
    // kind. `history` = rows listRecentMessages returns (newest-first from the
    // API; the client reverses — pass oldest-first like the real helper returns).
    // `offerCache` seeds settings.offer_cache; `offerParse` is what a caption
    // parse returns ('error' → HTTP failure; null → no service match).
    const botMock = ({ config, history = [], decision, geminiError, sendFails = false,
                       offerCache = null, offerParse, imageFails = false, alertFails = false,
                       owner = null, telegram = 200 } = {}) => {
      const calls = { sends: [], msgInserts: [], patches: [], shadowLogs: [], gemini: [],
                      historyFetches: 0, settingUpserts: [], offerCacheReads: 0, imageFetches: 0,
                      alerts: [], telegrams: [] };
      global.fetch = async (url, opts = {}) => {
        if (url.includes('api.resend.com')) {                              // alert email (fallback)
          if (alertFails) return { ok: false, status: 500, text: async () => 'smtp down' };
          calls.alerts.push(JSON.parse(opts.body));
          return { ok: true, json: async () => ({}) };
        }
        if (url.includes('api.telegram.org')) {                            // S3 owner alert
          calls.telegrams.push({ url, body: JSON.parse(opts.body) });
          return telegram === 200
            ? { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 700 + calls.telegrams.length } }) }
            : { ok: false, status: telegram, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) };
        }
        if (url.includes('settings?key=eq.telegram_owner'))
          return { ok: true, json: async () => owner ? [{ value: JSON.stringify(owner) }] : [] };
        if (url.includes('settings?key=eq.chatbot_config'))
          return { ok: true, json: async () => [{ value: JSON.stringify(config) }] };
        if (url.includes('settings?key=eq.offer_cache')) {
          calls.offerCacheReads++;
          return { ok: true, json: async () => offerCache == null ? [] : [{ value: JSON.stringify(offerCache) }] };
        }
        if (url.includes('/settings') && opts.method === 'POST') {         // offer cache upsert
          calls.settingUpserts.push(JSON.parse(opts.body));
          return { ok: true, json: async () => [] };
        }
        if (url.includes('generativelanguage.googleapis.com')) {
          calls.gemini.push({ url, opts });
          if (geminiError) return { ok: false, status: 500, json: async () => ({ error: { message: geminiError } }) };
          const b = JSON.parse(opts.body);
          const isOfferParse = (b.systemInstruction?.parts?.[0]?.text || '').includes('offer-post');
          if (isOfferParse) {
            if (offerParse === 'error') return { ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) };
            return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(offerParse || { service: '', offer_price: 0 }) }] } }] }) };
          }
          return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(decision) }] } }] }) };
        }
        if (url.includes('cdn.example')) {                                 // image DM bytes
          calls.imageFetches++;
          if (imageFails) return { ok: false, status: 403, json: async () => ({}) };
          return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
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
    // A price the KB doesn't have (Q30: the only kb_miss that hands off)
    const PRICE_MISS = { ...REPLY_DECISION, kb_covers: false, asks_price: true, handoff: true, reason: 'kb_miss', reply: '' };

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

    // 7b) "Ok" on a thread already filed as a lead: misc is NOT refiled — no
    //     canned reply, category stays lead, bot stays on (replay: 5 such turns)
    {
      const calls = botMock({
        config: CFG('live'),
        decision: { ...REPLY_DECISION, category: 'misc', reply: '', handoff: true, reason: 'non_lead' },
      });
      const r = await botReply({ ...LEAD, category: 'lead' }, { ...EV, messageText: 'Ok' }, 'instagram');
      assert.deepEqual(r, { skipped: 'empty_reply' });
      assert.equal(calls.sends.length + calls.patches.length, 0, 'an acknowledgement neither replies nor refiles');
      // …but a real handoff reason on a misc label still hands off, filed as a lead
      const c2 = botMock({
        config: CFG('live'),
        decision: { ...REPLY_DECISION, category: 'misc', reply: '', handoff: true, reason: 'declined_booking' },
      });
      assert.equal((await botReply({ ...LEAD, category: 'lead' }, { ...EV, messageText: 'Thanks, you too' }, 'instagram')).handoff, 'declined_booking');
      assert.equal(c2.patches[0].body.category, 'lead');
    }

    // 7c) burst guard: the older turn yields to a newer inbound; a share never
    //     yields and a text turn yields to a share earlier in its burst
    {
      const t = (s) => new Date(Date.parse('2026-08-25T07:09:00Z') + s * 1000).toISOString();
      const row = (id, message, s, direction = 'incoming') => ({ id, direction, message, is_bot: direction !== 'incoming', created_at: t(s) });
      const SHARE = '🔗 shared post: Get 5 Sessions of PRP';
      const run = async (history, rowId) => {
        const calls = botMock({ config: CFG('live'), history, decision: REPLY_DECISION });
        const text = history.find(m => m.id === rowId).message;
        return { r: await botReply(LEAD, { ...EV, messageText: text }, 'instagram', { id: rowId }), calls };
      };
      // a) "hi" then "price?" 2 s later → the "hi" turn yields, sends/writes nothing
      let { r, calls } = await run([row('a', 'hi', 0), row('b', 'price?', 2)], 'a');
      assert.deepEqual(r, { skipped: 'burst' });
      assert.equal(calls.sends.length + calls.patches.length + calls.msgInserts.length, 0);
      // …and the "price?" turn answers both
      ({ r } = await run([row('a', 'hi', 0), row('b', 'price?', 2)], 'b'));
      assert.deepEqual(r, { sent: true });
      // b) share then "price of this?" (the 25 Aug case) → the share turn still sends…
      ({ r } = await run([row('a', SHARE, 0), row('b', 'price of this?', 25)], 'a'));
      assert.deepEqual(r, { sent: true }, 'a share turn never yields');
      // …and the text turn yields to it
      ({ r } = await run([row('a', SHARE, 0), row('b', 'price of this?', 25)], 'b'));
      assert.deepEqual(r, { skipped: 'burst' });
      // c) the share was already answered, or is older than a function can live → send
      ({ r } = await run([row('a', SHARE, 0), row('o', 'offer reply', 3, 'outgoing'), row('b', 'price?', 25)], 'b'));
      assert.deepEqual(r, { sent: true });
      ({ r } = await run([row('a', SHARE, 0), row('b', 'price?', 61)], 'b'));
      assert.deepEqual(r, { sent: true }, 'a crashed share turn must not mute the thread');
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
      assert.equal(b.bot_active, true, 'a soft handoff keeps the bot on until staff reply (D12 takeover)');
      assert.equal(b.status, 'qualified');
      assert.match(b.bot_state.handoff_summary, /qualified/);
      assert.match(b.bot_state.handoff_summary, /LHR FULL BODY P\/S/);
      assert.match(b.bot_state.handoff_summary, /9876543210/);

      // …so the customer's next question still gets an answer (live 2026-09-22:
      // "any other branch?" after a qualified handoff got silence)
      const next = botMock({ config: CFG('live'), decision: REPLY_DECISION });
      const r2 = await botReply({ ...LEAD, bot_active: b.bot_active, bot_state: b.bot_state }, EV, 'instagram');
      assert.deepEqual(r2, { sent: true });
      assert.equal(next.sends.length, 1);
    }

    // 9) kb_miss → canned hold copy + handoff; the missed question rides in the
    //    summary + bot_state for the teach-the-bot capture (D13/D17, Step 13)
    {
      const calls = botMock({
        config: CFG('live'),
        decision: PRICE_MISS,
      });
      const r = await botReply(LEAD, EV, 'instagram');
      assert.equal(r.handoff, 'kb_miss');
      assert.equal(calls.sends[0].message.text,
        'Hi! I am the clinic’s assistant 🤖\n\nLet me check with our team.',
        'first bot turn: disclosure + canned hold copy (D13/D15)');
      const b = calls.patches[0].body;
      assert.match(b.bot_state.handoff_summary, /Bot didn't know: "price of laser"/,
        'kb_miss summary names the question (D17)');
      assert.equal(b.bot_state.kb_miss_question, 'price of laser',
        'question stashed for the meta-send capture');
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

    // 14) teach-the-bot capture (D17, Step 13): FIRST staff reply on a kb_miss
    //     thread → one kb_candidates row + exactly-once flag on bot_state
    {
      const calls = [];
      global.fetch = async (url, opts = {}) => {
        calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
        return { ok: true, json: async () => (url.includes('/kb_candidates') ? [{ id: 1 }] : []) };
      };
      const db   = createSupabaseClient();
      const lead = { id: 'L1', bot_state: { handoff_reason: 'kb_miss', kb_miss_question: 'cosmelan peel ka price?' } };
      assert.equal(await maybeCaptureKbCandidate(db, lead, 'It is 8000 per session 🙏'), true);
      const post = calls.find(c => c.url.includes('/kb_candidates'));
      assert.equal(post.body.lead_id, 'L1');
      assert.equal(post.body.question, 'cosmelan peel ka price?');
      assert.equal(post.body.answer, 'It is 8000 per session 🙏');
      const patch = calls.find(c => c.url.includes('/leads?id=eq.') && c.method === 'PATCH');
      assert.equal(patch.body.bot_state.kb_candidate_captured, true, 'exactly-once flag set');

      // already captured / not a kb_miss thread → no-op
      assert.equal(await maybeCaptureKbCandidate(db, { id: 'L1',
        bot_state: { handoff_reason: 'kb_miss', kb_miss_question: 'q', kb_candidate_captured: true } }, 'again'), false);
      assert.equal(await maybeCaptureKbCandidate(db, { id: 'L1', bot_state: { handoff_reason: 'medical' } }, 'x'), false);
      assert.equal(calls.filter(c => c.url.includes('/kb_candidates')).length, 1, 'only ONE candidate per thread');
    }

    // 14b) settings upsert: PostgREST's 201 has an EMPTY body here. Parsing it
    //      threw → Telegram /start 502'd and "✅ Linked" never came (live, 2026-10-05).
    {
      global.fetch = async () => ({ ok: true, status: 201, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
      await createSupabaseClient().upsertSetting('telegram_owner', '{"chat_id":1}');
    }

    // 15) offer ladder (D9/D10, Step 14): fresh → LIVE OFFER block; stale →
    //     STALE block; cache miss → one parse, cached, remembered on bot_state
    {
      const KB   = { entries: [{ type: 'service', key: 'LHR FULL BODY P/S', price: 35000 }] };
      const now  = new Date().toISOString();
      const CASH = { service: 'LHR FULL BODY P/S', offer_price: 9999, last_seen: now, source_caption: 'Full body laser special!' };
      const shareEv = (mediaId = 'M1', title = 'Full body laser special 9999!') =>
        ({ ...EV, messageText: '🔗 shared post: ' + title, attachment: { type: 'ig_post', mediaId, title } });

      // a) cache HIT + fresh → LIVE OFFER in the prompt, no parse call, no write
      {
        const calls = botMock({ config: CFG('live', { offer_stale_days: 30, kb: KB }),
                                offerCache: { offers: { M1: CASH } }, decision: REPLY_DECISION });
        const r = await botReply(LEAD, shareEv(), 'instagram');
        assert.deepEqual(r, { sent: true });
        assert.equal(calls.gemini.length, 1, 'cache hit must not re-parse the post');
        const sys = JSON.parse(calls.gemini[0].opts.body).systemInstruction.parts.map(p => p.text).join('\n');
        assert.ok(sys.includes('looking at our post offering LHR FULL BODY P/S at ₹9999'),
          'fresh offer is marked quotable');
        assert.ok(!sys.includes('sighting is older'));
        assert.ok(sys.includes('"""Full body laser special!"""'),
          'a live offer carries its caption (session count / branch live there)');
        assert.equal(calls.settingUpserts.length, 0);
        assert.equal(calls.patches[0].body.bot_state.last_offer.offer_price, 9999,
          'the thread remembers its latest offer');
      }

      // b) same share, offer_stale_days=0 → STALE block (KB ladder instead)
      {
        const calls = botMock({ config: CFG('live', { offer_stale_days: 0, kb: KB }),
                                offerCache: { offers: { M1: CASH } }, decision: REPLY_DECISION });
        await botReply(LEAD, shareEv(), 'instagram');
        const sys = JSON.parse(calls.gemini[0].opts.body).systemInstruction.parts.map(p => p.text).join('\n');
        assert.ok(sys.includes('sighting is older than the offer window'),
          'stale_days=0 makes any sighting stale');
        assert.ok(!sys.includes('looking at our post offering'));
        assert.ok(!sys.includes('Full body laser special'), 'a stale offer never carries its caption');
      }

      // c) cache MISS → one caption parse, offer cached cross-lead, last_offer set
      {
        const calls = botMock({ config: CFG('live', { kb: KB }), decision: REPLY_DECISION,
                                offerParse: { service: 'LHR FULL BODY P/S', offer_price: 9999 } });
        await botReply(LEAD, shareEv('NEW1'), 'instagram');
        assert.equal(calls.gemini.length, 2, 'parse call + assistant call');
        const sys = JSON.parse(calls.gemini[1].opts.body).systemInstruction.parts.map(p => p.text).join('\n');
        assert.ok(sys.includes('looking at our post offering LHR FULL BODY P/S at ₹9999'));
        assert.equal(calls.settingUpserts.length, 1);
        assert.equal(calls.settingUpserts[0].key, 'offer_cache');
        const cached = JSON.parse(calls.settingUpserts[0].value).offers.NEW1;
        assert.equal(cached.offer_price, 9999);
        assert.equal(cached.source_caption, 'Full body laser special 9999!');
        assert.equal(calls.patches[0].body.bot_state.last_offer.service, 'LHR FULL BODY P/S');
      }

      // d) parse finds no KB service → no offer at all, turn still replies
      {
        const calls = botMock({ config: CFG('live', { kb: KB }), decision: REPLY_DECISION,
                                offerParse: null });
        const r = await botReply(LEAD, shareEv('M2', 'Mystery treatment 4999'), 'instagram');
        assert.deepEqual(r, { sent: true });
        const sys = JSON.parse(calls.gemini[1].opts.body).systemInstruction.parts.map(p => p.text).join('\n');
        assert.ok(!sys.includes('looking at our post offering') && !sys.includes('sighting is older'));
        assert.equal(calls.settingUpserts.length, 0);
      }

      // e) parse API failure → degrade to a plain KB turn (never kills the reply)
      {
        const calls = botMock({ config: CFG('live', { kb: KB }), decision: REPLY_DECISION,
                                offerParse: 'error' });
        assert.deepEqual(await botReply(LEAD, shareEv('M3'), 'instagram'), { sent: true });
        const sys = JSON.parse(calls.gemini[1].opts.body).systemInstruction.parts.map(p => p.text).join('\n');
        assert.ok(!sys.includes('looking at our post offering') && !sys.includes('sighting is older'));
      }

      // f) follow-up "price?" (no attachment) → last_offer from bot_state
      {
        const calls = botMock({ config: CFG('live', { offer_stale_days: 30, kb: KB }), decision: REPLY_DECISION });
        await botReply({ ...LEAD, bot_state: { last_offer: CASH } }, EV, 'instagram');
        const sys = JSON.parse(calls.gemini[0].opts.body).systemInstruction.parts.map(p => p.text).join('\n');
        assert.ok(sys.includes('looking at our post offering'), 'a remembered offer feeds follow-up turns');
        assert.equal(calls.offerCacheReads, 0, 'no cache read when there is no share');
      }

      // g) share with no caption → no offer resolution at all
      {
        const calls = botMock({ config: CFG('live', { kb: KB }), decision: REPLY_DECISION });
        await botReply(LEAD, shareEv('M4', ''), 'instagram');
        assert.equal(calls.gemini.length, 1);
        assert.equal(calls.offerCacheReads, 0);
      }

      // h) shadow logs the resolved offer but writes nothing (D19)
      {
        const calls = botMock({ config: CFG('shadow', { offer_stale_days: 30, kb: KB }),
                                offerCache: { offers: { M1: CASH } }, decision: REPLY_DECISION });
        assert.deepEqual(await botReply(LEAD, shareEv(), 'instagram'), { shadow: true });
        assert.equal(calls.shadowLogs[0].decision.offer.offer_price, 9999, 'offer rides in the shadow row');
        assert.equal(calls.settingUpserts.length, 0);
        assert.equal(calls.patches.length, 0);
      }
    }

    // 16) raw-image vision fallback (Step 15): image DM → inline_data on the
    //     turn's user content; a fetch failure degrades to a plain text turn
    {
      const imgEv = { ...EV, messageText: '📷 image', attachment: { type: 'image', url: 'https://cdn.example/pic.png' } };
      {
        const calls = botMock({ config: CFG('live'), decision: REPLY_DECISION });
        assert.deepEqual(await botReply(LEAD, imgEv, 'instagram'), { sent: true });
        assert.equal(calls.imageFetches, 1);
        const last = JSON.parse(calls.gemini[0].opts.body).contents.at(-1);
        assert.equal(last.parts.length, 2, 'image rides as a second part');
        assert.equal(last.parts[1].inline_data.mime_type, 'image/png');
        assert.equal(last.parts[1].inline_data.data, Buffer.from(new Uint8Array([1, 2, 3])).toString('base64'));
        assert.ok(last.parts[0].text.includes('attached image'));
      }
      {
        const calls = botMock({ config: CFG('live'), decision: REPLY_DECISION, imageFails: true });
        assert.deepEqual(await botReply(LEAD, imgEv, 'instagram'), { sent: true },
          'a dead CDN link must not kill the turn');
        const last = JSON.parse(calls.gemini[0].opts.body).contents.at(-1);
        assert.equal(last.parts.length, 1, 'no inline_data when the bytes could not be fetched');
      }
    }

    // 17) soft booking (Step 17, D3): the prompt drives toward a preferred
    //     day/time; a booking handoff carries it on the summary
    {
      const calls = botMock({
        config: CFG('live'),
        decision: { ...REPLY_DECISION, handoff: true, reason: 'wants_booking',
                    reply: 'Noted! Our team will confirm shortly 🙏',
                    qualification: { service: 'LHR FULL BODY P/S', branch: 'Dwarka Sec 12',
                                     preferred_time: 'Saturday evening' } },
      });
      const r = await botReply(LEAD, { ...EV, messageText: 'haan book kar do saturday evening' }, 'instagram');
      assert.equal(r.handoff, 'wants_booking');
      const b = calls.patches[0].body;
      assert.match(b.bot_state.handoff_summary, /branch Dwarka Sec 12/);
      assert.match(b.bot_state.handoff_summary, /preferred Saturday evening/,
        'the summary carries the soft-booking day/time (D3)');
      assert.equal(b.bot_state.qualification.preferred_time, 'Saturday evening');

      // the prompt itself names the soft-booking rule + never-confirm guard
      const calls2 = botMock({ config: CFG('live'), decision: REPLY_DECISION });
      await botReply(LEAD, EV, 'instagram');
      const sys = JSON.parse(calls2.gemini[0].opts.body).systemInstruction.parts.map(p => p.text).join('\n');
      assert.ok(sys.includes('Soft booking') && sys.includes('NEVER confirm a slot'),
        'prompt drives the soft-booking collection (D3)');
    }

    // 18) turn + conversation-age caps (Step 18, open #17): checked after the
    //     safety net, before Gemini; the counter ticks on normal live turns
    {
      // at the cap (10 bot replies sent) → the 11th inbound hands off, no Gemini
      let calls = botMock({ config: CFG('live', { turn_cap: 10 }) });
      let r = await botReply({ ...LEAD, bot_state: { turn_count: 10 } }, EV, 'instagram');
      assert.equal(r.handoff, 'turn_cap');
      assert.equal(calls.gemini.length, 0, 'a capped thread spends no Gemini call');
      assert.equal(calls.sends.length, 1, 'a capped thread gets the hold copy, not silence');
      assert.ok(calls.sends[0].message.text.includes('connect you with our team'),
        'turn_cap reuses the llm_error hold copy (dedicated canned.turn_cap wins if set)');
      assert.ok(!calls.sends[0].message.text.includes('assistant'),
        'no disclosure prepend — a turn-capped thread disclosed long ago');
      let b = calls.patches[0].body;
      assert.equal(b.bot_active, false);
      assert.match(b.bot_state.handoff_summary, /turn_cap/);

      // one under the cap → normal reply, counter ticks to 10
      calls = botMock({ config: CFG('live', { turn_cap: 10 }), decision: REPLY_DECISION });
      assert.deepEqual(await botReply({ ...LEAD, bot_state: { turn_count: 9 } }, EV, 'instagram'), { sent: true });
      assert.equal(calls.patches[0].body.bot_state.turn_count, 10);

      // missing config → code defaults (cap 10 / age 7 d): 9 turns still fine
      calls = botMock({ config: CFG('live'), decision: REPLY_DECISION });
      assert.deepEqual(await botReply({ ...LEAD, bot_state: { turn_count: 9 } }, EV, 'instagram'), { sent: true });

      // conversation-age cap: an 8-day-old lead with cap 7 → same turn_cap handoff
      calls = botMock({ config: CFG('live', { conversation_age_cap_days: 7 }) });
      const old = { ...LEAD, created_at: new Date(Date.now() - 8 * 864e5).toISOString() };
      assert.equal((await botReply(old, EV, 'instagram')).handoff, 'turn_cap');
      assert.equal(calls.gemini.length, 0);
      // …and an age-capped FIRST-EVER turn still discloses (nothing was sent before)
      assert.ok(calls.sends[0].message.text.startsWith('Hi! I am the clinic’s assistant'),
        'age-cap-only thread keeps the disclosure prepend');

      // safety outranks the cap: a medical inbound on a capped thread is MEDICAL
      calls = botMock({ config: CFG('live') });
      assert.equal((await botReply({ ...LEAD, bot_state: { turn_count: 99 } },
        { ...EV, messageText: 'khujli ho rahi hai' }, 'instagram')).handoff, 'medical');

      // shadow mirrors the cap: one row, no send, no mutation (D19)
      calls = botMock({ config: CFG('shadow') });
      assert.deepEqual(await botReply({ ...LEAD, bot_state: { turn_count: 10 } }, EV, 'instagram'), { shadow: true });
      assert.equal(calls.shadowLogs[0].decision.reason, 'turn_cap');
      assert.equal(calls.sends.length + calls.patches.length, 0);
    }

    // 19) S3 owner alerts (Q12 Q30 Q32): Telegram to the bound owner, email as
    //     the fallback; a failed alert never breaks the handoff
    {
      process.env.TELEGRAM_BOT_TOKEN = 'tg_token';
      const OWNER = { chat_id: 4242, name: 'Owner' };

      // price kb_miss → ONE question, ForceReply, name + known details + question +
      // deadline; its message id lands in the handoff's own bot_state write
      let calls = botMock({ config: CFG('live'), decision: PRICE_MISS, owner: OWNER });
      assert.equal((await botReply(LEAD, EV, 'instagram')).handoff, 'kb_miss');
      assert.equal(calls.telegrams.length, 1);
      assert.equal(calls.alerts.length, 0, 'Telegram worked → no email');
      const t = calls.telegrams[0];
      assert.match(t.url, /api\.telegram\.org\/bottg_token\/sendMessage$/);
      assert.equal(t.body.chat_id, 4242);
      assert.equal(t.body.text.split('\n')[0], '❓ Price question: Priya Sharma — service LHR FULL BODY P/S, WhatsApp 9876543210');
      assert.equal(t.body.text.split('\n')[1], '"price of laser"');
      assert.match(t.body.text, /Reply to this message with the price/);
      assert.match(t.body.text, /⏳ You can reply until \d{1,2} \w{3}, \d\d:\d\d\.$/, '24 h window deadline, IST');
      assert.equal(t.body.reply_markup.force_reply, true, 'tapping the alert opens a reply');
      assert.equal(calls.patches.length, 1, 'one lead write: the id rides in it');
      assert.equal(calls.patches[0].body.bot_state.owner_alert_msg_id, 701, 'S4 maps the reply back by this id');
      assert.equal(calls.patches[0].body.bot_active, false, 'bot waits for the owner (resumes in S4)');
      assert.equal(calls.sends[0].message.text, 'Hi! I am the clinic’s assistant 🤖\n\nLet me check with our team.',
        'the customer gets the hold copy');

      // a non-price question the KB lacks → no owner question, no handoff: the bot
      // says the team will confirm and keeps going; the question is kept for the lead
      calls = botMock({ config: CFG('live'), owner: OWNER, decision: { ...PRICE_MISS, asks_price: false, handoff: false,
        reply: 'The team will confirm parking for you. Which branch suits you?' } });
      assert.deepEqual(await botReply(LEAD, { ...EV, messageText: 'is there parking?' }, 'instagram'), { sent: true });
      assert.equal(calls.telegrams.length + calls.alerts.length, 0, 'the owner is asked about prices only');
      assert.match(calls.sends[0].message.text, /Which branch suits you\?$/);
      assert.equal(calls.patches[0].body.bot_active, undefined, 'bot stays on');
      assert.deepEqual(calls.patches[0].body.bot_state.team_questions, ['is there parking?']);
      // …even when the model still hands it off: code turns it into a normal turn
      // (empty reply → the canned hold copy) and appends to the earlier questions
      calls = botMock({ config: CFG('live'), owner: OWNER, decision: { ...PRICE_MISS, asks_price: false } });
      const r19 = await botReply({ ...LEAD, bot_state: { team_questions: ['is there parking?'] } },
        { ...EV, messageText: 'do you open on Sunday?' }, 'instagram');
      assert.deepEqual(r19, { sent: true });
      assert.equal(calls.telegrams.length, 0);
      assert.match(calls.sends[0].message.text, /Let me check with our team\.$/);
      assert.deepEqual(calls.patches[0].body.bot_state.team_questions, ['is there parking?', 'do you open on Sunday?']);

      // FYIs: emergency (nothing sent to the customer), asks for a person, LLM down.
      // No ForceReply, no stored message id.
      for (const [ev, over, head] of [
        [{ ...EV, messageText: 'emergency! khoon beh raha hai' }, {}, '🔴 Emergency: Priya Sharma'],
        [{ ...EV, messageText: 'talk to a human please' }, {}, '🙋 Asked for a person: Priya Sharma'],
        [EV, { geminiError: 'overloaded' }, '⚠️ Bot error: Priya Sharma'],
      ]) {
        calls = botMock({ config: CFG('live'), owner: OWNER, ...over });
        await botReply(LEAD, ev, 'instagram');
        assert.equal(calls.telegrams.length, 1, head);
        assert.ok(calls.telegrams[0].body.text.startsWith(head), head);
        assert.ok(calls.telegrams[0].body.text.includes(`"${ev.messageText}"`), 'their words ride in the FYI');
        assert.equal(calls.telegrams[0].body.reply_markup, undefined, 'an FYI expects no reply');
        assert.equal(calls.patches[0].body.bot_state.owner_alert_msg_id, undefined);
      }
      assert.equal(calls.sends.length, 1, 'llm_error still sends its hold copy');

      // one alert per incident: the alerting handoff switched the bot off, so the
      // next message in the outage reaches no alert at all
      const after = calls.patches[0].body;
      calls = botMock({ config: CFG('live'), owner: OWNER, geminiError: 'overloaded' });
      assert.deepEqual(await botReply({ ...LEAD, ...after }, EV, 'instagram'), { skipped: 'bot_inactive' });
      assert.equal(calls.telegrams.length + calls.alerts.length, 0);

      // medical, turn_cap, soft handoff, normal turn → nobody alerted
      let quiet = 0;
      for (const [lead, ev, over] of [
        [LEAD, { ...EV, messageText: 'khujli ho rahi hai' }, {}],
        [{ ...LEAD, bot_state: { turn_count: 10 } }, EV, { decision: REPLY_DECISION }],
        [LEAD, EV, { decision: { ...REPLY_DECISION, handoff: true, reason: 'qualified', reply: 'Team will confirm 🙏' } }],
        [LEAD, EV, { decision: REPLY_DECISION }],
      ]) {
        calls = botMock({ config: CFG('live'), owner: OWNER, ...over });
        await botReply(lead, ev, 'instagram');
        quiet += calls.telegrams.length + calls.alerts.length;
      }
      assert.equal(quiet, 0, 'only price questions + emergency/requested/llm_error alert');

      // email fallback: no owner linked, or Telegram refuses (403 = owner blocked
      // the bot) → the same alert by email to cfg.alert_email, no message id
      for (const over of [{ owner: null }, { owner: OWNER, telegram: 403 }]) {
        calls = botMock({ config: CFG('live', { alert_email: 'owner@clinic.example' }), decision: PRICE_MISS, ...over });
        assert.equal((await botReply(LEAD, EV, 'instagram')).handoff, 'kb_miss');
        assert.equal(calls.alerts.length, 1, 'emailed instead');
        assert.equal(calls.alerts[0].to[0], 'owner@clinic.example');
        assert.equal(calls.alerts[0].subject, '❓ Price question: Priya Sharma — service LHR FULL BODY P/S, WhatsApp 9876543210');
        assert.match(calls.alerts[0].html, /Bot didn&#39;t know: &quot;price of laser&quot;/,
          'the missed question rides in the email body (HTML-escaped, verbatim customer text)');
        assert.equal(calls.patches[0].body.bot_state.owner_alert_msg_id, null);
      }
      assert.match(calls.alerts[0].html, /Telegram 403 Forbidden: bot was blocked by the user/, 'why it came by email');
      delete process.env.TELEGRAM_BOT_TOKEN;
      calls = botMock({ config: CFG('live'), decision: PRICE_MISS, owner: OWNER });
      await botReply(LEAD, EV, 'instagram');
      assert.equal(calls.telegrams.length, 0);
      assert.equal(calls.alerts.length, 1, 'no bot token yet → email, as before S3');

      // Telegram AND email down / no RESEND_API_KEY → handoff still completes
      calls = botMock({ config: CFG('live'), alertFails: true, decision: PRICE_MISS });
      assert.equal((await botReply(LEAD, EV, 'instagram')).handoff, 'kb_miss',
        'a failed alert must not break the handoff');
      delete process.env.RESEND_API_KEY;
      calls = botMock({ config: CFG('live'), decision: PRICE_MISS });
      assert.equal((await botReply(LEAD, EV, 'instagram')).handoff, 'kb_miss');
      assert.equal(calls.alerts.length, 0);
      process.env.RESEND_API_KEY = 'test_resend';
    }

    // 20) a mid-turn crash is swallowed — returns {error}, never throws (D13)
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
    delete process.env.RESEND_API_KEY;
  }

  global.fetch = realFetch;

  // ── meta-webhook handler: verify, reject forgeries, ack before processing ──
  {
    const crypto = require('crypto');
    const { default: webhook } = await import('../meta-webhook.mjs');
    const url = 'https://x/webhook/meta';
    process.env.META_VERIFY_TOKEN = 'vt';
    let r = await webhook(new Request(`${url}?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc`), {});
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'abc', 'challenge echoed as plain text');
    r = await webhook(new Request(`${url}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc`), {});
    assert.equal(r.status, 403);

    process.env.META_APP_SECRET = 's3cret';
    const body = JSON.stringify({ object: 'not_meta' });   // unsupported object → handleWebhook touches no DB
    const post = (sig, ctx) => webhook(new Request(url, { method: 'POST', body, headers: { 'x-hub-signature-256': sig } }), ctx);
    r = await post('sha256=forged', {});
    assert.equal(r.status, 403, 'bad signature rejected before any processing');

    const pending = [];
    r = await post('sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex'),
                   { waitUntil: (p) => pending.push(p) });
    assert.equal(r.status, 200);
    assert.equal(pending.length, 1, 'processing handed to waitUntil, not awaited before the 200');
    await Promise.all(pending);
    delete process.env.META_APP_SECRET;
    delete process.env.META_VERIFY_TOKEN;
  }

  // ── telegram-webhook (S3): secret header, owner binding, everything else ignored ──
  {
    const { default: tg } = await import('../telegram-webhook.mjs');
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'test_anon';
    process.env.TELEGRAM_BOT_TOKEN = 'tg_token';
    process.env.TELEGRAM_LINK_CODE = 'link_abc';
    const calls = { upserts: [], telegrams: [] };
    global.fetch = async (url, opts = {}) => {
      if (url.includes('/settings') && opts.method === 'POST') { calls.upserts.push(JSON.parse(opts.body)); return { ok: true, json: async () => [] }; }
      if (url.includes('api.telegram.org')) { calls.telegrams.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; }
      throw new Error('unexpected fetch: ' + url);
    };
    const update = (text, chatId = 555) => ({ update_id: 1, message: { message_id: 9, text,
      chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: 'Gaurav' } } });
    // Resolves once the waitUntil work (S4) is done too.
    const post = async (body, secret = 'tg_secret') => {
      const pending = [];
      const r = await tg(new Request('https://x/webhook/telegram', { method: 'POST', body: JSON.stringify(body),
        headers: secret ? { 'x-telegram-bot-api-secret-token': secret } : {} }), { waitUntil: (p) => pending.push(p) });
      await Promise.all(pending);
      return r;
    };

    assert.equal((await post(update('/start link_abc'))).status, 403, 'no TELEGRAM_WEBHOOK_SECRET set → reject everything');
    process.env.TELEGRAM_WEBHOOK_SECRET = 'tg_secret';
    assert.equal((await post(update('/start link_abc'), null)).status, 403, 'missing header');
    assert.equal((await post(update('/start link_abc'), 'wrong')).status, 403, 'wrong header');
    assert.equal(calls.upserts.length, 0);

    // the right link code binds that chat as the owner, and confirms there
    let r = await post(update('/start link_abc'));
    assert.equal(r.status, 200);
    assert.deepEqual(calls.upserts, [{ key: 'telegram_owner', value: JSON.stringify({ chat_id: 555, name: 'Gaurav' }) }]);
    assert.equal(calls.telegrams.length, 1);
    assert.equal(calls.telegrams[0].chat_id, 555);
    assert.match(calls.telegrams[0].text, /^✅ Linked/);

    // wrong code, plain /start, other text, non-message updates → 200, nothing done
    for (const body of [update('/start nope', 666), update('/start', 666), update('hello', 666), update('hello'), { update_id: 2 }]) {
      assert.equal((await post(body)).status, 200);
    }
    assert.equal(calls.upserts.length + calls.telegrams.length, 2, 'only the one binding');
    assert.equal((await tg(new Request('https://x/webhook/telegram'))).status, 405);

    // ── S4: the owner's answer → customer → KB (Q13 Q26 Q29 Q30) ──
    process.env.GEMINI_API_KEY = 'test_key';
    process.env.META_ACCESS_TOKEN = 'ig_token';
    const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
    const KB = () => ({ entries: [{ type: 'service', key: 'LHR FULL BODY P/S' },
                                  { type: 'service', key: 'HYDRA FACIAL P/S', price: 3000, price_last_quoted: '2026-05', quotes_seen: 2 }] });
    const ALERTED = () => ({ id: 'L1', customer_name: 'Priya Sharma', branch_id: 'B1', source: 'instagram',
      instagram_user_id: 'IGSID_9', bot_active: false,
      bot_state: { qualification: { service: 'LHR FULL BODY P/S' }, handoff_reason: 'kb_miss', handoff_at: ago(60),
                   kb_miss_question: 'price of laser', owner_alert_msg_id: 701 } });
    // `rephrase`: the model's text, or 'error'. `history` oldest-first. Patches and
    // config upserts are applied, so a later [Don't save] sees them.
    const s4 = ({ rephrase = 'Full body laser is ₹3,500 😊', history, configOk = true, sendFails = false } = {}) => {
      const st = { lead: ALERTED(), config: { mode: 'live', model: 'm', kb: KB() },
                   tg: [], sends: [], inserts: [], patches: [], gemini: [], upserts: 0 };
      const rows = history || [{ direction: 'incoming', message: 'price of laser', created_at: ago(61) },
                               { direction: 'outgoing', is_bot: true, message: 'Let me check with our team.', created_at: ago(60) }];
      global.fetch = async (url, opts = {}) => {
        const json = (v) => ({ ok: true, json: async () => v });
        if (url.includes('api.telegram.org')) {
          st.tg.push({ method: url.split('/').pop(), ...JSON.parse(opts.body) });
          return json({ ok: true, result: { message_id: 900 } });
        }
        if (url.includes('settings?key=eq.telegram_owner')) return json([{ value: JSON.stringify({ chat_id: 555 }) }]);
        if (url.includes('settings?key=eq.chatbot_config'))
          return configOk ? json([{ value: JSON.stringify(st.config) }]) : { ok: false, json: async () => ({}) };
        if (url.includes('/settings') && opts.method === 'POST') {
          const b = JSON.parse(opts.body);
          if (b.key === 'chatbot_config') { st.config = JSON.parse(b.value); st.upserts++; }
          return json([]);
        }
        if (url.includes('or=(bot_state->>owner_alert_msg_id.eq.')) {             // the question, or its S6 reminder
          const id = Number(/owner_alert_msg_id\.eq\.(\d+),bot_state->>owner_reminder_msg_id\.eq\.\1\)/.exec(url)[1]);
          const bs = st.lead.bot_state;
          return json([bs.owner_alert_msg_id, bs.owner_reminder_msg_id].includes(id) ? [st.lead] : []);
        }
        if (url.includes('/leads?id=eq.') && opts.method === 'PATCH') {
          const b = JSON.parse(opts.body);
          st.patches.push(b);
          Object.assign(st.lead, b);
          return json([]);
        }
        if (url.includes('/leads?id=eq.')) return json([st.lead]);
        if (url.includes('lead_messages?lead_id=eq.')) return json([...rows].reverse());
        if (url.includes('/lead_messages') && opts.method === 'POST') { st.inserts.push(JSON.parse(opts.body)); return json([{ id: 'o1' }]); }
        if (url.includes('generativelanguage.googleapis.com')) {
          st.gemini.push(JSON.parse(opts.body));
          if (rephrase === 'error') return { ok: false, status: 503, json: async () => ({ error: { message: 'overloaded' } }) };
          return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text: rephrase }) }] } }] });
        }
        if (url.includes('graph.instagram.com')) {
          if (sendFails) return { ok: false, status: 400, json: async () => ({ error: { message: 'window closed' } }) };
          st.sends.push(JSON.parse(opts.body));
          return json({ message_id: 'm1' });
        }
        throw new Error('unexpected fetch: ' + url);
      };
      return st;
    };
    const reply = (text, to = 701, chatId = 555) => ({ update_id: 3, message: { message_id: 20, text,
      chat: { id: chatId }, from: { id: chatId }, ...(to && { reply_to_message: { message_id: to } }) } });
    const tap = (msgText = '✅ Sent…') => ({ update_id: 4, callback_query: { id: 'cq1', data: 'nosave:L1',
      message: { message_id: 900, chat: { id: 555 }, text: msgText } } });
    const laser = (cfg) => cfg.kb.entries.find(e => e.key === 'LHR FULL BODY P/S');

    // a reply to the price question → rephrased, sent on IG, stored, bot resumes,
    // price saved for everyone (the thread's service: "price of laser" names no KB key)
    let st = s4();
    assert.equal((await post(reply('3500 rs'))).status, 200);
    assert.deepEqual(st.sends.map(s => s.recipient.id), ['IGSID_9']);
    assert.equal(st.sends[0].message.text, 'Full body laser is ₹3,500 😊', 'commas aside, the numbers match → rephrased text');
    assert.match(st.gemini[0].contents[0].parts[0].text, /Customer asked: """price of laser"""[\s\S]*Team's answer: """3500 rs"""/);
    assert.deepEqual(st.inserts, [{ lead_id: 'L1', branch_id: 'B1', direction: 'outgoing',
                                    message: 'Full body laser is ₹3,500 😊', is_seen: true, is_bot: true }]);
    const p = st.patches[0];
    assert.equal(p.bot_active, true, 'Q26: the bot resumes');
    assert.equal(p.bot_state.owner_alert_msg_id, 701, 'earlier bot_state kept');
    assert.ok(p.bot_state.owner_answered_at);
    assert.equal(p.bot_state.kb_candidate_captured, true, 'no second Teach-the-Bot entry from a later staff reply');
    assert.equal(laser(st.config).price, 3500);
    assert.equal(laser(st.config).source, `learned:${new Date().toISOString().slice(0, 7)}`);
    assert.equal(st.config.mode, 'live', 'the rest of the config survives the KB write');
    assert.equal(st.tg.length, 1);
    assert.equal(st.tg[0].chat_id, 555);
    assert.equal(st.tg[0].text, '✅ Sent to Priya Sharma:\n"Full body laser is ₹3,500 😊"\n' +
      '💾 Saved: LHR FULL BODY P/S → ₹3500. The bot quotes it to everyone from now on.');
    assert.deepEqual(st.tg[0].reply_markup.inline_keyboard[0][0], { text: '🚫 Don’t save', callback_data: 'nosave:L1' });

    // [Don't save] → the price goes back to what it was (none), the button goes away;
    // a second tap has nothing to undo
    st.tg = [];
    await post(tap());
    assert.equal(laser(st.config).price, null, 'back to "no price yet"');
    assert.deepEqual(st.tg.map(t => t.method), ['answerCallbackQuery', 'editMessageText']);
    assert.equal(st.tg[0].text, 'Not saved');
    assert.equal(st.tg[1].text, '✅ Sent…\n🗑 Undone: not saved for other customers.');
    assert.equal(st.tg[1].reply_markup, undefined);
    st.tg = [];
    await post(tap());
    assert.equal(st.tg[0].text, 'Nothing to undo');
    assert.equal(st.upserts, 2, 'save + one undo');

    // S6: a reply to the reminder works like a reply to the question
    st = s4();
    st.lead.bot_state.owner_reminder_msg_id = 702;
    await post(reply('3500', 702));
    assert.equal(st.sends.length, 1);
    assert.equal(laser(st.config).price, 3500);

    // a newer answer for the same service since → the old button undoes nothing
    st = s4();
    await post(reply('3500'));
    laser(st.config).price = 4000;
    st.tg = [];
    await post(tap());
    assert.equal(laser(st.config).price, 4000);
    assert.equal(st.tg[0].text, 'Nothing to undo');

    // Q29 number guard: a dropped or changed number, or no rephrase at all → the owner's words
    for (const rephrase of ['Full body laser is ₹3,000 😊', 'Full body laser is ₹3,500 😊', 'error']) {
      st = s4({ rephrase });
      await post(reply('3500, or 6 sessions for 18000'));
      assert.equal(st.sends[0].message.text, '3500, or 6 sessions for 18000', rephrase);
    }

    // a question naming a KB service updates that one; an answer with no price → learned FAQ
    st = s4();
    st.lead.bot_state.kb_miss_question = 'hydra facial kitna hai';
    await post(reply('₹3,800'));
    assert.equal(st.config.kb.entries.find(e => e.key === 'HYDRA FACIAL P/S').price, 3800);
    assert.equal(laser(st.config).price, undefined);
    st = s4({ rephrase: 'We don’t do that treatment, sorry!' });
    st.lead.bot_state = { ...st.lead.bot_state, kb_miss_question: 'tattoo removal cost?', qualification: {} };
    await post(reply('We don’t do that treatment'));
    const faq = st.config.kb.entries.at(-1);
    assert.equal(faq.type, 'faq');
    assert.deepEqual(faq.tags, ['tattoo', 'removal']);
    assert.match(st.tg[0].text, /💾 Saved: the bot gives this answer to everyone who asks\.$/);
    await post(tap());
    assert.equal(st.config.kb.entries.length, 2, 'FAQ removed again');

    // 24 h window: their last message is 25 h old → nothing sent, no rephrase call,
    // the owner is told; the price is still saved
    st = s4({ history: [{ direction: 'incoming', message: 'price of laser', created_at: ago(25 * 60) }] });
    await post(reply('3500'));
    assert.equal(st.sends.length + st.inserts.length + st.gemini.length, 0);
    assert.match(st.tg[0].text, /^⚠️ Not sent: Priya Sharma’s last message is over 24 h old/);
    assert.equal(laser(st.config).price, 3500);

    // staff replied in the IG app since the handoff → answer still sent, bot stays off (D12)
    st = s4({ history: [{ direction: 'incoming', message: 'price of laser', created_at: ago(61) },
                        { direction: 'outgoing', is_bot: false, message: 'Checking!', created_at: ago(30) }] });
    await post(reply('3500'));
    assert.equal(st.sends.length, 1);
    assert.equal(st.patches[0].bot_active, false);

    // settings unreadable → the config is never written back (that would wipe it), no button
    st = s4({ configOk: false });
    await post(reply('3500'));
    assert.equal(st.sends.length, 1, 'the customer still gets the answer');
    assert.equal(st.upserts, 0);
    assert.match(st.tg[0].text, /⚠️ Not saved for other customers \(settings unreadable\)\.$/);
    assert.equal(st.tg[0].reply_markup, undefined);
    assert.equal(st.patches[0].bot_state.kb_saved, null);

    // a failed IG send → the owner is told, nothing saved or resumed
    st = s4({ sendFails: true });
    await post(reply('3500'));
    assert.match(st.tg[0].text, /^⚠️ That didn’t go through \(Instagram send failed: 400 window closed\)/);
    assert.equal(st.patches.length + st.upserts, 0);

    // not a reply / a reply to something else → a hint only; other chats → nothing
    for (const body of [reply('3500', null), reply('3500', 123)]) {
      st = s4();
      await post(body);
      assert.equal(st.sends.length + st.patches.length + st.upserts, 0);
      assert.match(st.tg[0].text, /^Reply to a ❓ price question/);
    }
    st = s4();
    await post(reply('3500', 701, 666));
    await post({ update_id: 5, callback_query: { ...tap().callback_query, message: { message_id: 900, chat: { id: 666 }, text: 'x' } } });
    assert.equal(st.tg.length + st.sends.length + st.patches.length + st.upserts, 0, 'only the bound owner is heard');

    for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_LINK_CODE', 'TELEGRAM_WEBHOOK_SECRET',
                     'GEMINI_API_KEY', 'META_ACCESS_TOKEN'])
      delete process.env[k];
  }

  // ── send-bot-report: #18 metrics + frequency gate ──
  {
    const { computeBotMetrics, reportWindowDays } = require('../send-bot-report');
    const q = (o) => ({ qualification: o });
    const handoffs = [
      { id: 'a', bot_state: { ...q({ phone: '9876543210', service: 'laser', branch: 'b1' }), handoff_reason: 'qualified' } },
      { id: 'b', bot_state: { ...q({ phone: '9876543210', service: 'laser', location: 'Adajan' }), handoff_reason: 'wants_booking' } },
      { id: 'c', bot_state: { ...q({ service: 'laser' }), handoff_reason: 'kb_miss' } },
      { id: 'd', bot_state: { handoff_reason: 'medical' } },
      { id: 'e', bot_state: { handoff_reason: 'emergency' } },
      { id: 'f', bot_state: { handoff_reason: 'turn_cap' } },
    ];
    const messages = [
      // d: earlier bot reply, then the medical inbound → not missed
      { lead_id: 'd', is_bot: true,  direction: 'outgoing', created_at: '2026-09-23T10:00:00Z' },
      { lead_id: 'd', is_bot: false, direction: 'incoming', created_at: '2026-09-23T10:01:00Z' },
      // e: bot replied AFTER the emergency inbound → missed
      { lead_id: 'e', is_bot: false, direction: 'incoming', created_at: '2026-09-23T10:00:00Z' },
      { lead_id: 'e', is_bot: true,  direction: 'outgoing', created_at: '2026-09-23T10:00:05Z' },
    ];
    const m = computeBotMetrics(handoffs, messages, 12);
    assert.deepEqual(m, { handoffs: 6, complete: 2, pct_complete: 33.3, safety: 2, kb_miss: 1,
                          turn_cap: 1, missed_medical: 1, bot_messages: 12 });
    assert.equal(computeBotMetrics([], [], 0).pct_complete, null, 'no handoffs → no % (not NaN)');
    assert.equal(reportWindowDays('daily', 3), 1);
    assert.equal(reportWindowDays('weekly', 1), 7, 'weekly fires Mondays');
    assert.equal(reportWindowDays('weekly', 2), null);
    assert.equal(reportWindowDays('off', 1), null);
    assert.equal(reportWindowDays(undefined, 1), null, 'unset = off');

    // S8 (Q22): the report goes to the owner's Telegram as plain text
    const { reportText } = require('../send-bot-report');
    assert.equal(reportText(m, 1), [
      '⚠️ 📊 DSkin DM Assistant — daily report (last 24 hours)',
      '',
      'Handoffs to staff: 6',
      'Complete handoffs: 2 (33.3%) · phone + service + branch, target ≥60%',
      'Medical / emergency: 2',
      'Bot didn’t know (kb_miss): 1 · answer them in Settings → Teach the Bot',
      'Turn cap reached: 1',
      'Missed medical: 1 · ⚠️ must be 0, check these threads',
      'Bot messages sent: 12',
      '',
      'Change or stop this report in Settings → Chatbot → Report.',
    ].join('\n'));
    const quiet = reportText(computeBotMetrics([], [], 0), 7);
    assert.ok(quiet.startsWith('📊 DSkin DM Assistant — weekly report (last 7 days)'), 'no ⚠️ when nothing was missed');
    assert.ok(quiet.includes('\nComplete handoffs: 0 · phone'), 'no % when there were no handoffs');
    assert.ok(quiet.includes('\nMissed medical: 0 · target 0\n'));
  }

  // ── S2 lead push → client webhook (Q7 Q31 Q34) ──
  {
    const { pushLead, leadPushDue } = require('./meta-service');
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => realSetTimeout(fn, 0);           // no real backoff waits
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'test_anon';
    process.env.META_ACCESS_TOKEN = 'ig_token';
    process.env.META_BRANCH_ID = 'FALLBACK';
    process.env.RESEND_API_KEY = 'test_resend';
    process.env.LEAD_WEBHOOK_URL = 'https://hook.make.test/abc';

    // Types (Q34): phone → lead · service only → potential_lead · else nothing;
    // a sent type never repeats, a potential_lead upgrades once to a lead.
    const L = (q, extra = {}) => ({ category: 'lead', bot_state: { qualification: q, ...extra } });
    assert.equal(leadPushDue(L({ service: 'LHR', phone: '9876543210' })), 'lead');
    assert.equal(leadPushDue(L({ phone: '9876543210' })), 'lead', 'a phone alone is a lead');
    assert.equal(leadPushDue(L({ service: 'LHR' })), 'potential_lead');
    assert.equal(leadPushDue(L({ location: 'Uttam Nagar' })), null, 'neither phone nor service → nothing');
    assert.equal(leadPushDue({ ...L({ service: 'LHR', phone: '9876543210' }), category: 'collaboration' }), null);
    assert.equal(leadPushDue({ ...L({ service: 'LHR' }), category: 'sales_pitch' }), null);
    assert.equal(leadPushDue(L({ service: 'LHR' }, { lead_pushed: { potential_lead: 't' } })), null, 'same type never resent');
    assert.equal(leadPushDue(L({ service: 'LHR', phone: '9876543210' }, { lead_pushed: { potential_lead: 't' } })), 'lead', 'upgrade');
    assert.equal(leadPushDue(L({ service: 'LHR', phone: '9876543210' }, { lead_pushed: { lead: 't' } })), null, 'at most twice');
    assert.equal(leadPushDue(L({ service: 'LHR' }, { lead_pushed: { lead: 't' } })), null);

    // `hook` = the webhook's answers in order (a number = status, 'net' = network error)
    const pushMock = ({ hook = [200], history = [], botTurn = null } = {}) => {
      const calls = { hooks: [], alerts: [], patches: [], profiles: 0, sends: [], inserts: [] };
      global.fetch = async (url, opts = {}) => {
        if (url.startsWith('https://hook.make.test')) {
          calls.hooks.push({ headers: opts.headers, body: JSON.parse(opts.body) });
          const r = hook[calls.hooks.length - 1] ?? hook.at(-1);
          if (r === 'net') throw new Error('fetch failed');
          return { ok: r < 300, status: r };
        }
        if (url.includes('api.resend.com')) { calls.alerts.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
        if (url.includes('graph.instagram.com') && url.includes('fields=')) {
          calls.profiles++;
          return { ok: true, json: async () => ({ name: 'Riya Sharma', username: 'riya.s' }) };
        }
        if (url.includes('graph.instagram.com')) {                       // the bot's send
          calls.sends.push(JSON.parse(opts.body));
          return { ok: true, json: async () => ({ message_id: 'm' }) };
        }
        if (url.includes('/branches?')) return { ok: true, json: async () => [{ id: 'DWK', name: 'Dwarka Sec 12' }] };
        if (url.includes('lead_messages?lead_id=eq.')) return { ok: true, json: async () => [...history].reverse() };
        if (url.includes('/lead_messages') && opts.method === 'POST') { calls.inserts.push(JSON.parse(opts.body)); return { ok: true, json: async () => [{ id: 'o1' }] }; }
        if (url.includes('/leads?id=eq.') && opts.method === 'PATCH') { calls.patches.push(JSON.parse(opts.body)); return { ok: true, json: async () => [] }; }
        if (url.includes('settings?key=eq.chatbot_config'))
          return { ok: true, json: async () => [{ value: JSON.stringify({ mode: 'live', canned: {}, kb: { entries: [] } }) }] };
        if (url.includes('generativelanguage.googleapis.com'))
          return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(botTurn) }] } }] }) };
        throw new Error('unexpected fetch: ' + url);
      };
      return calls;
    };
    const db = createSupabaseClient();
    const CFG = { kb: { entries: [{ type: 'service', key: 'LHR FULL BODY P/S', price: 35000 }] } };
    const HISTORY = [
      { id: 'm1', direction: 'incoming', message: 'laser price?', is_bot: false, created_at: '2026-10-02T04:45:00Z' },
      { id: 'm2', direction: 'outgoing', message: 'Starts from ₹35000. Your WhatsApp?', is_bot: true, created_at: '2026-10-02T04:45:05Z' },
      { id: 'm3', direction: 'incoming', message: '9876543210', is_bot: false, created_at: '2026-10-02T04:46:00Z' },
      { id: 'm4', direction: 'outgoing', message: 'Our team will call you.', is_bot: false, created_at: '2026-10-02T05:00:00Z' },
    ];
    const LEAD = { id: 'L9', customer_name: 'Riya Sharma', instagram_user_id: 'IGS_9', source: 'instagram',
                   branch_id: 'FALLBACK', category: 'lead', created_at: '2026-10-02T04:44:00Z',
                   bot_state: { qualification: { service: 'LHR FULL BODY P/S', phone: '9876543210', branch: 'Janakpuri',
                                                 location: 'Uttam Nagar', preferred_time: 'Saturday evening' },
                                handoff_reason: 'wants_booking', handoff_summary: 'Bot handed off (wants_booking) — service LHR FULL BODY P/S',
                                turn_count: 2 } };

    // Payload: fixed field list, every key present, values from the lead + thread
    let calls = pushMock({ history: HISTORY });
    assert.equal(await pushLead(db, LEAD, CFG), 'lead');
    assert.equal(calls.hooks.length, 1);
    const p = calls.hooks[0].body;
    assert.deepEqual(Object.keys(p), ['lead_type', 'source', 'ig_user_id', 'name', 'phone', 'service', 'branch',
      'location', 'preferred_time', 'price_quoted', 'reason', 'summary', 'conversation', 'conversation_url',
      'post_url', 'created_at'], 'fixed field list (Make locks it after the first sample)');
    assert.deepEqual({ ...p, conversation: undefined }, {
      lead_type: 'lead', source: 'instagram', ig_user_id: 'IGS_9', name: 'Riya Sharma', phone: '9876543210',
      service: 'LHR FULL BODY P/S', branch: 'Janakpuri', location: 'Uttam Nagar', preferred_time: 'Saturday evening',
      price_quoted: 'from ₹35000', reason: 'wants_booking',
      summary: 'Bot handed off (wants_booking) — service LHR FULL BODY P/S',
      conversation: undefined, conversation_url: 'https://ig.me/m/riya.s', post_url: '', created_at: '2026-10-02T04:44:00Z' });
    assert.equal(p.conversation, [
      '[2 Oct, 10:15] Customer: laser price?',
      '[2 Oct, 10:15] Bot: Starts from ₹35000. Your WhatsApp?',
      '[2 Oct, 10:16] Customer: 9876543210',
      '[2 Oct, 10:30] Staff: Our team will call you.'].join('\n'), 'whole thread, one IST-stamped line per message');
    assert.equal(calls.hooks[0].headers['x-make-apikey'], undefined, 'no key header unless LEAD_WEBHOOK_KEY is set');
    // stamp keeps the rest of bot_state
    assert.equal(calls.patches.length, 1);
    assert.ok(calls.patches[0].bot_state.lead_pushed.lead, 'type stamped with a time');
    assert.equal(calls.patches[0].bot_state.turn_count, 2, 'stamp merges into bot_state, never replaces it');

    // Quiet push: "Chat went quiet" summary keeps the earlier handoff; a routed
    // branch is named when the customer never typed one; a fresh post offer wins
    process.env.LEAD_WEBHOOK_KEY = 'mk_123';
    calls = pushMock({ history: HISTORY });
    const quietLead = { ...LEAD, branch_id: 'DWK', bot_state: { ...LEAD.bot_state,
      qualification: { service: 'LHR FULL BODY P/S' }, lead_pushed: {},
      last_offer: { service: 'LHR FULL BODY P/S', offer_price: 9999, last_seen: new Date().toISOString() } } };
    assert.equal(await pushLead(db, quietLead, CFG, true), 'potential_lead');
    const q = calls.hooks[0].body;
    assert.equal(q.lead_type, 'potential_lead');
    assert.equal(q.phone, '');
    assert.equal(q.branch, 'Dwarka Sec 12');
    assert.equal(q.price_quoted, '₹9999 (post offer)');
    assert.equal(q.summary, 'Chat went quiet — service LHR FULL BODY P/S\nEarlier: Bot handed off (wants_booking) — service LHR FULL BODY P/S');
    assert.equal(calls.hooks[0].headers['x-make-apikey'], 'mk_123', 'LEAD_WEBHOOK_KEY → Make API-key header (Q10)');
    delete process.env.LEAD_WEBHOOK_KEY;

    // Retry: 429 / 5xx / network errors get 3 tries; success on the 3rd still stamps
    calls = pushMock({ hook: [503, 'net', 200], history: HISTORY });
    assert.equal(await pushLead(db, LEAD, CFG), 'lead');
    assert.equal(calls.hooks.length, 3);
    assert.equal(calls.alerts.length, 0);
    calls = pushMock({ hook: [429], history: HISTORY });
    assert.equal(await pushLead(db, LEAD, CFG), null);
    assert.equal(calls.hooks.length, 3, '429 retried, gives up after 3');

    // No retry on 400 / 410: one try, one alert email, no lead_pushed stamp (the
    // hourly run retries) — and the alert is sent once per lead + type
    for (const status of [400, 410]) {
      calls = pushMock({ hook: [status], history: HISTORY });
      assert.equal(await pushLead(db, LEAD, CFG), null);
      assert.equal(calls.hooks.length, 1, `${status} not retried`);
      assert.equal(calls.alerts.length, 1, `${status} alerts us`);
      assert.match(calls.alerts[0].subject, /Lead push failed — Riya Sharma/);
      assert.match(calls.alerts[0].html, new RegExp(`HTTP ${status}`));
      assert.equal(calls.patches.length, 1);
      assert.equal(calls.patches[0].bot_state.lead_pushed, undefined, 'a failed push is not stamped as sent');
      assert.ok(calls.patches[0].bot_state.lead_push_alerted.lead);
    }
    calls = pushMock({ hook: [410], history: HISTORY });
    await pushLead(db, { ...LEAD, bot_state: { ...LEAD.bot_state, lead_push_alerted: { lead: 't' } } }, CFG);
    assert.equal(calls.alerts.length, 0, 'already alerted for this lead + type → no second email');

    // Nothing due / no URL → no webhook call at all
    calls = pushMock({ history: HISTORY });
    assert.equal(await pushLead(db, { ...LEAD, bot_state: { ...LEAD.bot_state, lead_pushed: { lead: 't' } } }, CFG), null);
    delete process.env.LEAD_WEBHOOK_URL;
    assert.equal(await pushLead(db, LEAD, CFG), null);
    assert.equal(calls.hooks.length + calls.patches.length, 0);
    process.env.LEAD_WEBHOOK_URL = 'https://hook.make.test/abc';

    // S3 (Q30): non-price questions the bot left to the team ride in the summary
    calls = pushMock({ history: HISTORY });
    await pushLead(db, { ...LEAD, bot_state: { ...LEAD.bot_state, team_questions: ['is there parking?', 'open Sunday?'] } }, CFG);
    assert.equal(calls.hooks[0].body.summary,
      'Bot handed off (wants_booking) — service LHR FULL BODY P/S\nTeam to confirm: "is there parking?", "open Sunday?"');

    // Settle trigger 1 — a handoff pushes; a failed push never blocks the handoff
    process.env.GEMINI_API_KEY = 'test_key';
    const BOT_LEAD = { id: 'L9', customer_name: 'Riya Sharma', instagram_user_id: 'IGS_9', source: 'instagram',
                       branch_id: 'FALLBACK', bot_active: true, category: 'lead', created_at: new Date().toISOString(),
                       bot_state: { qualification: { service: 'LHR FULL BODY P/S' } } };
    const HANDOFF = { category: 'lead', is_medical: false, reply: 'Thanks! Our team will call you on WhatsApp.',
                      kb_covers: true, handoff: true, reason: 'qualified', qualification: { phone: '98765 43210' } };
    const EV9 = { messageText: '98765 43210', senderId: 'IGS_9', messageId: 'mid_9' };
    calls = pushMock({ history: HISTORY, botTurn: HANDOFF });
    let r = await botReply(BOT_LEAD, EV9, 'instagram');
    assert.equal(r.handoff, 'qualified');
    assert.equal(calls.hooks.length, 1, 'the handoff settles the chat → one push');
    assert.equal(calls.hooks[0].body.lead_type, 'lead');
    assert.equal(calls.hooks[0].body.phone, '9876543210');
    assert.equal(calls.hooks[0].body.reason, 'qualified');
    assert.match(calls.hooks[0].body.summary, /^Bot handed off \(qualified\)/);
    assert.ok(calls.patches.at(-1).bot_state.lead_pushed.lead);
    assert.equal(calls.patches.at(-1).bot_state.handoff_reason, 'qualified', 'stamp kept the handoff state');
    calls = pushMock({ hook: [500], history: HISTORY, botTurn: HANDOFF });
    r = await botReply(BOT_LEAD, EV9, 'instagram');
    assert.equal(r.handoff, 'qualified', 'webhook down → the handoff still completes');
    assert.equal(calls.sends.length, 1, 'and the customer still got the reply');
    // a normal (non-handoff) turn never pushes
    calls = pushMock({ history: HISTORY, botTurn: { ...HANDOFF, handoff: false } });
    await botReply(BOT_LEAD, EV9, 'instagram');
    assert.equal(calls.hooks.length, 0);
    delete process.env.GEMINI_API_KEY;

    // Settle trigger 2 — bot-hourly: chats quiet ≥ lead_quiet_hours, live mode only
    const { quietLeadIds, handler: hourly } = require('../bot-hourly');
    const now = Date.parse('2026-10-02T12:00:00Z');
    assert.deepEqual(quietLeadIds([
      { lead_id: 'A', created_at: '2026-10-02T09:00:00Z' },
      { lead_id: 'A', created_at: '2026-10-02T09:30:00Z' },     // A's newest: 2.5 h ago → quiet
      { lead_id: 'B', created_at: '2026-10-02T08:00:00Z' },
      { lead_id: 'B', created_at: '2026-10-02T11:00:00Z' },     // B's newest: 1 h ago → still talking
      { lead_id: 'C', created_at: '2026-10-02T10:00:00Z' },     // exactly 2 h → quiet
    ], now, 2 * 3600e3), ['A', 'C']);

    const hourlyMock = ({ mode, quietHours, msgs, leads }) => {
      const calls = { hooks: [], patches: [], msgQueries: [] };
      global.fetch = async (url, opts = {}) => {
        if (url.includes('settings?key=eq.chatbot_config'))
          return { ok: true, json: async () => [{ value: JSON.stringify({ mode, lead_quiet_hours: quietHours }) }] };
        if (url.includes('lead_messages?created_at=gt.')) { calls.msgQueries.push(url); return { ok: true, json: async () => msgs }; }
        if (url.includes('leads?bot_state->>handoff_reason=eq.kb_miss')) return { ok: true, json: async () => [] };   // S6: no open owner questions
        if (url.includes('/leads?id=in.(')) return { ok: true, json: async () => leads.filter(l => url.includes(l.id)) };
        if (url.includes('lead_messages?lead_id=eq.')) return { ok: true, json: async () => [] };
        if (url.includes('graph.instagram.com')) return { ok: true, json: async () => ({ username: 'u' }) };
        if (url.startsWith('https://hook.make.test')) { calls.hooks.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; }
        if (url.includes('/leads?id=eq.') && opts.method === 'PATCH') { calls.patches.push(JSON.parse(opts.body)); return { ok: true, json: async () => [] }; }
        throw new Error('unexpected fetch: ' + url);
      };
      return calls;
    };
    const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
    const QUIET = { id: 'Q1', customer_name: 'A', instagram_user_id: 'I1', category: 'lead', branch_id: 'FALLBACK',
                    bot_state: { qualification: { service: 'LHR FULL BODY P/S' } } };
    const BUSY  = { ...QUIET, id: 'Q2' };
    const opts = { quietHours: 0.05, msgs: [{ lead_id: 'Q1', created_at: ago(10) }, { lead_id: 'Q2', created_at: ago(1) }],
                   leads: [QUIET, BUSY] };
    calls = hourlyMock({ mode: 'live', ...opts });
    await hourly();
    assert.equal(calls.hooks.length, 1, 'only the chat quiet ≥ 3 min (0.05 h) is pushed');
    assert.equal(calls.hooks[0].lead_type, 'potential_lead');
    assert.match(calls.hooks[0].summary, /^Chat went quiet/);
    assert.equal(calls.hooks[0].reason, 'quiet');
    calls = hourlyMock({ mode: 'shadow', ...opts });
    await hourly();
    assert.equal(calls.msgQueries.length + calls.hooks.length, 0, 'not live → the hourly run does nothing');

    global.setTimeout = realSetTimeout;
    for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'META_ACCESS_TOKEN', 'META_BRANCH_ID', 'RESEND_API_KEY', 'LEAD_WEBHOOK_URL'])
      delete process.env[k];
  }

  // ── S6 owner timeouts (Q14): 2 h reminder, 20 h fallback ──
  {
    const { ownerTimerDue, handoffToStaff } = require('./meta-service');
    const { handler: hourly } = require('../bot-hourly');
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'test_anon';
    process.env.META_ACCESS_TOKEN = 'ig_token';
    process.env.TELEGRAM_BOT_TOKEN = 'tg_token';
    process.env.RESEND_API_KEY = 'test_resend';
    process.env.LEAD_WEBHOOK_URL = 'https://hook.make.test/abc';
    const H = 3600e3;

    // Fake clock: the price question went to the owner at T0
    const T0 = Date.parse('2026-10-06T04:00:00Z');
    const ASKED = { handoff_reason: 'kb_miss', handoff_at: new Date(T0).toISOString(), owner_alert_msg_id: 701 };
    assert.equal(ownerTimerDue(ASKED, T0 + 1.9 * H, {}), null);
    assert.equal(ownerTimerDue(ASKED, T0 + 2 * H, {}), 'remind');
    assert.equal(ownerTimerDue({ ...ASKED, owner_reminded_at: 't' }, T0 + 3 * H, {}), null, 'one reminder');
    assert.equal(ownerTimerDue({ ...ASKED, owner_reminded_at: 't' }, T0 + 20 * H, {}), 'fallback');
    assert.equal(ownerTimerDue(ASKED, T0 + 20 * H, {}), 'fallback', 'a missed reminder never delays the fallback');
    assert.equal(ownerTimerDue({ ...ASKED, owner_answered_at: 't' }, T0 + 20 * H, {}), null, 'answered → skipped');
    assert.equal(ownerTimerDue({ ...ASKED, owner_alert_msg_id: null }, T0 + 20 * H, {}), null, 'emailed alert → no timers');
    assert.equal(ownerTimerDue({ ...ASKED, handoff_reason: 'owner_no_reply' }, T0 + 21 * H, {}), null, 'one fallback');
    const MINUTES = { owner_remind_hours: 2 / 60, owner_fallback_hours: 5 / 60 };   // the live test
    assert.equal(ownerTimerDue(ASKED, T0 + 2 * 60e3, MINUTES), 'remind');
    assert.equal(ownerTimerDue(ASKED, T0 + 5 * 60e3, MINUTES), 'fallback');

    // DB mock: patches apply to `leads`; `msgs[id]` oldest-first
    const ago = (h) => new Date(Date.now() - h * H).toISOString();
    const mk = (id, h, extra = {}) => ({ id, customer_name: `Cust ${id}`, branch_id: 'B1', category: 'lead',
      source: 'instagram', instagram_user_id: `IG_${id}`, created_at: ago(h + 0.1),
      bot_state: { qualification: { service: 'LHR FULL BODY P/S' }, handoff_reason: 'kb_miss', handoff_at: ago(h),
                   handoff_summary: 'Bot handed off (kb_miss) — service LHR FULL BODY P/S',
                   kb_miss_question: 'price of laser', owner_alert_msg_id: 700, ...extra } });
    const hold = (h) => [{ direction: 'incoming', message: 'price of laser', created_at: ago(h + 0.01) },
                         { direction: 'outgoing', is_bot: true, message: 'Let me check with our team.', created_at: ago(h) }];
    const CANNED = { owner_no_reply: 'Our team will get in touch here soon 🙏', llm_error: 'Connecting you to our team 🙏' };
    const s6 = ({ leads = [], msgs = {}, cfg = {}, owner = { chat_id: 555 } }) => {
      const st = { leads, tg: [], sends: [], inserts: [], hooks: [], alerts: [] };
      const json = (v) => ({ ok: true, json: async () => v });
      const open = (l) => l.bot_state.handoff_reason === 'kb_miss' && l.bot_state.owner_alert_msg_id && !l.bot_state.owner_answered_at;
      global.fetch = async (url, opts = {}) => {
        if (url.includes('settings?key=eq.chatbot_config')) return json([{ value: JSON.stringify({ mode: 'live', canned: CANNED, ...cfg }) }]);
        if (url.includes('settings?key=eq.telegram_owner')) return json(owner ? [{ value: JSON.stringify(owner) }] : []);
        if (url.includes('api.telegram.org')) { st.tg.push(JSON.parse(opts.body)); return json({ ok: true, result: { message_id: 900 } }); }
        if (url.includes('api.resend.com')) { st.alerts.push(JSON.parse(opts.body)); return json({}); }
        if (url.includes('leads?bot_state->>handoff_reason=eq.kb_miss&bot_state->>owner_alert_msg_id=not.is.null&bot_state->>owner_answered_at=is.null'))
          return json(st.leads.filter(open));
        if (url.includes('lead_messages?created_at=gt.'))
          return json(Object.entries(msgs).flatMap(([lead_id, rows]) => rows.map(m => ({ lead_id, created_at: m.created_at }))));
        if (url.includes('/leads?id=in.(')) return json(st.leads.filter(l => url.includes(l.id)));
        if (url.includes('/branches?')) return json([{ id: 'B1', name: 'Janakpuri' }]);
        if (url.includes('lead_messages?lead_id=eq.')) return json([...(msgs[/lead_id=eq\.([^&]+)/.exec(url)[1]] || [])].reverse());
        if (url.includes('/lead_messages') && opts.method === 'POST') { st.inserts.push(JSON.parse(opts.body)); return json([{ id: 'o1' }]); }
        if (url.includes('/leads?id=eq.') && opts.method === 'PATCH') {
          Object.assign(st.leads.find(l => l.id === /id=eq\.([^&]+)/.exec(url)[1]) || {}, JSON.parse(opts.body));
          return json([]);
        }
        if (url.includes('graph.instagram.com') && url.includes('fields=')) return json({ username: 'u' });
        if (url.includes('graph.instagram.com')) { st.sends.push(JSON.parse(opts.body)); return json({ message_id: 'm' }); }
        if (url.startsWith('https://hook.make.test')) { st.hooks.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; }
        throw new Error('unexpected fetch: ' + url);
      };
      return st;
    };

    // One hourly run: R (3 h, unanswered) → reminder · F (21 h, reminded) → fallback ·
    // S (3 h, staff replied in the IG app) → closed, nothing sent · N (1 h) → nothing yet
    const R = mk('R', 3), F = mk('F', 21, { owner_reminded_at: ago(19) }), S = mk('S', 3), N = mk('N', 1);
    const msgs = { R: hold(3), F: hold(21), N: hold(1),
                   S: [...hold(3), { direction: 'outgoing', is_bot: false, message: 'Checking!', created_at: ago(1) }] };
    let st = s6({ leads: [R, F, S, N], msgs });
    await hourly();

    assert.equal(st.tg.length, 1, 'one reminder, for R only');
    assert.equal(st.tg[0].chat_id, 555);
    assert.deepEqual(st.tg[0].text.split('\n').slice(0, 2),
      ['⏰ Still waiting for a price: Cust R — service LHR FULL BODY P/S', '"price of laser"']);
    assert.match(st.tg[0].text, /Reply to this message with the price.* No answer by \d{1,2} \w{3}, \d\d:\d\d → they’re told the team will get in touch\.$/);
    assert.equal(st.tg[0].reply_markup.force_reply, true, 'answerable like the question itself');
    assert.equal(R.bot_state.owner_reminder_msg_id, 900, 'the owner’s reply to it maps back (S4)');
    assert.ok(R.bot_state.owner_reminded_at);
    assert.equal(R.bot_state.kb_miss_question, 'price of laser', 'rest of bot_state kept');

    assert.deepEqual(st.sends.map(s => [s.recipient.id, s.message.text]), [['IG_F', 'Our team will get in touch here soon 🙏']],
      'only F’s customer hears from the bot');
    assert.equal(st.inserts.length, 1);
    assert.equal(st.inserts[0].is_bot, true);
    assert.equal(F.bot_state.handoff_reason, 'owner_no_reply');
    assert.equal(st.hooks.length, 1, 'only F is pushed: R’s question is still open, so R hasn’t settled');
    assert.equal(st.hooks[0].ig_user_id, 'IG_F');
    assert.equal(st.hooks[0].lead_type, 'potential_lead');
    assert.equal(st.hooks[0].reason, 'owner_no_reply');
    assert.equal(st.hooks[0].summary, 'Bot handed off (owner_no_reply) — service LHR FULL BODY P/S\nBot didn\'t know: "price of laser"');

    assert.ok(S.bot_state.owner_answered_at, 'staff reply closes S’s question');
    assert.equal(N.bot_state.owner_reminded_at, undefined);

    // The next run: nothing repeats
    st.tg.length = st.sends.length = st.hooks.length = 0;
    await hourly();
    assert.equal(st.tg.length + st.sends.length + st.hooks.length, 0, 'one reminder, one fallback, one push');

    // A config saved before S6 has no owner_no_reply copy → the llm_error hold copy
    st = s6({ leads: [mk('G', 21)], msgs: { G: hold(21) }, cfg: { canned: { llm_error: 'Connecting you to our team 🙏' } } });
    await hourly();
    assert.equal(st.sends[0].message.text, 'Connecting you to our team 🙏');

    // The owner unlinked → the reminder isn't stamped, so the next run tries again
    st = s6({ leads: [mk('U', 3)], msgs: { U: hold(3) }, owner: null });
    await hourly();
    assert.equal(st.leads[0].bot_state.owner_reminded_at, undefined);

    // Not live → nothing
    st = s6({ leads: [mk('X', 21)], msgs: { X: hold(21) }, cfg: { mode: 'shadow' } });
    await hourly();
    assert.equal(st.sends.length + st.tg.length + st.hooks.length, 0);

    // A price question the owner can answer doesn't settle the chat at the handoff;
    // an emailed one (no reply path) does. A new question resets the last one's stamps.
    const db = createSupabaseClient();
    const prev = { ...mk('Q', 30).bot_state, handoff_reason: 'qualified',
                   owner_answered_at: 'old', owner_reminded_at: 'old', owner_reminder_msg_id: 5 };
    const price = () => handoffToStaff(db, { ...mk('Q', 0), bot_state: prev }, { senderId: 'IG_Q', messageText: 'hydra price?' },
                                        'instagram', { mode: 'live', canned: {} }, { reason: 'kb_miss', category: 'lead' }, prev, false);
    const q = mk('Q', 0);
    st = s6({ leads: [q] });
    await price();
    assert.equal(st.tg.length, 1);
    assert.equal(st.hooks.length, 0, 'waiting on the owner → not pushed yet');
    assert.deepEqual([q.bot_state.owner_alert_msg_id, q.bot_state.owner_answered_at, q.bot_state.owner_reminded_at,
                      q.bot_state.owner_reminder_msg_id], [900, null, null, null]);
    st = s6({ leads: [mk('Q', 0)], owner: null });
    await price();
    assert.equal(st.alerts.length, 1, 'no owner linked → emailed');
    assert.equal(st.hooks.length, 1, 'nobody can answer it in Telegram → settled now, as before S6');
    assert.equal(st.hooks[0].reason, 'kb_miss');

    for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'META_ACCESS_TOKEN', 'TELEGRAM_BOT_TOKEN', 'RESEND_API_KEY', 'LEAD_WEBHOOK_URL'])
      delete process.env[k];
  }

  // ── S7 comment automation in the service (Q6 Q27) ──
  {
    const { handleWebhook, pushLead } = require('./meta-service');
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'test_anon';
    process.env.META_ACCESS_TOKEN = 'ig_token';
    process.env.META_BRANCH_ID = 'FALLBACK';
    process.env.GEMINI_API_KEY = 'test_key';
    process.env.LEAD_WEBHOOK_URL = 'https://hook.make.test/abc';
    const RULES = [{ keyword: 'price, cost, rate, kitna, kitne, charges, fees, details, info, interested, book, dm',
                     public: 'Sent you a DM 💬', dm: 'Hi! Thanks for asking 😊 Which branch is closest to you — Janakpuri, Kirti Nagar or Dwarka?' }];
    const POST_URL = 'https://www.instagram.com/p/ABC123/';
    const TURN = { category: 'lead', is_medical: false, reply: 'It’s ₹9999 per session, as in the post! Which day suits you?',
                   kb_covers: true, asks_price: true, handoff: false, reason: 'qualified',
                   qualification: { service: 'LHR FULL BODY P/S', branch: 'Janakpuri' } };
    const s7 = ({ mode = 'live', media = true, offerCache = null } = {}) => {
      const st = { leads: [], msgs: [], shadow: [], dms: [], publics: [], sends: [], cache: [], hooks: [], media: 0, parses: 0, turns: [] };
      const json = (v) => ({ ok: true, json: async () => v });
      global.fetch = async (url, opts = {}) => {
        const body = opts.body ? JSON.parse(opts.body) : null;
        if (url.includes('settings?key=eq.integrations')) return json([]);
        if (url.includes('settings?key=eq.comment_rules')) return json([{ value: JSON.stringify(RULES) }]);
        if (url.includes('settings?key=eq.chatbot_config')) return json([{ value: JSON.stringify({ mode, canned: {},
          kb: { entries: [{ type: 'service', key: 'LHR FULL BODY P/S', price: 35000 }] } }) }]);
        if (url.includes('settings?key=eq.offer_cache')) return json(offerCache ? [{ value: JSON.stringify(offerCache) }] : []);
        if (url.endsWith('/rest/v1/settings')) { st.cache.push(body); return { ok: true, status: 201 }; }
        if (url.includes('/branches?')) return json([{ id: 'DWK', name: 'Dwarka Sec 12' }, { id: 'JPR', name: 'Janakpuri' }, { id: 'KN', name: 'Kirti Nagar' }]);
        if (url.includes('graph.instagram.com/v21.0/MEDIA_1?fields=caption,permalink')) {
          st.media++;
          return media ? json({ caption: 'Full body laser this month: ₹9,999 per session!', permalink: POST_URL })
                       : { ok: false, status: 400, json: async () => ({ error: { message: 'bad media id' } }) };
        }
        if (url.includes('graph.instagram.com') && url.includes('fields=')) return json({ name: 'Riya Sharma', username: 'riya.s' });
        if (url.includes('/C1/replies')) { st.publics.push(body); return json({ id: 'R1' }); }
        if (url.includes('graph.instagram.com') && body?.recipient?.comment_id) { st.dms.push(body); return json({ recipient_id: 'IGSID_C', message_id: 'pm1' }); }
        if (url.includes('graph.instagram.com')) { st.sends.push(body); return json({ message_id: 'm' }); }
        if (url.includes('generativelanguage.googleapis.com')) {
          const parse = body.systemInstruction.parts[0].text.startsWith('You parse');
          parse ? st.parses++ : st.turns.push(body);
          return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(parse
            ? { service: 'LHR FULL BODY P/S', offer_price: 9999 } : TURN) }] } }] });
        }
        if (url.includes('/leads?instagram_user_id=eq.IGSID_C')) return json(st.leads.slice(0, 1));
        if (url.endsWith('/rest/v1/leads') && opts.method === 'POST') {
          const l = { id: 'LC', bot_state: null, created_at: new Date().toISOString(), ...body };
          st.leads.push(l); return json([l]);
        }
        if (url.includes('/leads?id=eq.LC') && opts.method === 'PATCH') { Object.assign(st.leads[0], body); return json([]); }
        if (url.includes('/leads?id=eq.LC')) return json(st.leads.slice(0, 1));
        if (url.includes('lead_messages?lead_id=eq.')) return json([...st.msgs].reverse());
        if (url.includes('/lead_messages') && opts.method === 'POST') {
          const m = { id: `msg${st.msgs.length}`, created_at: new Date().toISOString(), ...body };
          st.msgs.push(m); return json([m]);
        }
        if (url.includes('/bot_shadow_log')) { st.shadow.push(body); return json([{}]); }
        if (url.startsWith('https://hook.make.test')) { st.hooks.push(body); return { ok: true, status: 200 }; }
        throw new Error('unexpected fetch: ' + url);
      };
      return st;
    };
    const comment = (text) => ({ object: 'instagram', entry: [{ id: 'IG_ACCOUNT', changes: [{ field: 'comments', value: {
      id: 'C1', text, from: { id: 'IGSCOPED_1', username: 'riya.s' }, media: { id: 'MEDIA_1', media_product_type: 'FEED' } } }] }] });

    // Live: DM with branch buttons + public reply, as before; the lead now carries
    // where it came from and the post's offer (parsed once, then cached)
    let st = s7();
    await handleWebhook(comment('Price kya hai?'));
    assert.equal(st.dms.length, 1);
    assert.deepEqual(st.dms[0].message.attachment.payload.buttons.map(b => b.title), ['Dwarka Sec 12', 'Janakpuri', 'Kirti Nagar']);
    assert.deepEqual(st.publics, [{ message: 'Sent you a DM 💬' }]);
    const lead = st.leads[0];
    assert.equal(lead.instagram_user_id, 'IGSID_C', 'filed under the messaging id, not the comment’s from.id');
    assert.equal(lead.bot_state.source, 'instagram_comment');
    assert.equal(lead.bot_state.post_url, POST_URL);
    assert.deepEqual([lead.bot_state.last_offer.service, lead.bot_state.last_offer.offer_price], ['LHR FULL BODY P/S', 9999]);
    assert.equal(st.parses, 1);
    assert.equal(st.cache.length, 1);
    assert.equal(st.cache[0].key, 'offer_cache', 'the post joins the offer cache');
    assert.deepEqual(st.msgs.map(m => m.message), ['[comment] Price kya hai?', RULES[0].dm]);

    // The branch tap: routed, and the bot's turn gets the post's offer as quotable
    await handleWebhook({ object: 'instagram', entry: [{ messaging: [{ sender: { id: 'IGSID_C' }, recipient: { id: 'IG_ACCOUNT' },
      postback: { mid: 'pb1', title: 'Janakpuri', payload: 'BRANCH:JPR' } }] }] });
    assert.equal(lead.branch_id, 'JPR');
    assert.ok(st.turns[0].systemInstruction.parts.some(p => p.text.startsWith('LIVE OFFER (quotable)') && p.text.includes('₹9999')),
      'the bot quotes the post’s offer price');
    assert.equal(st.sends.length, 1);
    assert.match(st.sends[0].message.text, /₹9999/);

    // The lead push carries the comment fields
    assert.equal(await pushLead(createSupabaseClient(), lead, {}, true), 'potential_lead');
    assert.equal(st.hooks[0].source, 'instagram_comment');
    assert.equal(st.hooks[0].post_url, POST_URL);
    assert.equal(st.hooks[0].price_quoted, '₹9999 (post offer)');

    // A post already in the cache isn't parsed again; a post that can't be fetched
    // costs the offer and post_url, never the DM
    st = s7({ offerCache: { offers: { MEDIA_1: { service: 'LHR FULL BODY P/S', offer_price: 8888, last_seen: new Date().toISOString() } } } });
    await handleWebhook(comment('cost?'));
    assert.equal(st.parses, 0);
    assert.equal(st.leads[0].bot_state.last_offer.offer_price, 8888);
    st = s7({ media: false });
    st.leads.push({ id: 'LC', branch_id: 'JPR', bot_active: true, bot_state: { turn_count: 3 } });   // a returning customer
    await handleWebhook(comment('cost?'));
    assert.equal(st.leads[0].bot_state.turn_count, 3, 'the rest of bot_state is kept');
    assert.equal(st.dms.length, 1);
    assert.equal(st.leads[0].bot_state.source, 'instagram_comment');
    assert.equal(st.leads[0].bot_state.post_url, '');
    assert.equal(st.leads[0].bot_state.last_offer, undefined);

    // "Great results 😍" matches no keyword → left alone (no catch-all, Q27)
    st = s7();
    await handleWebhook(comment('Great results 😍'));
    assert.equal(st.dms.length + st.publics.length + st.leads.length + st.media, 0);

    // Shadow: one log row with what live would send; nothing sent, no lead
    st = s7({ mode: 'shadow' });
    await handleWebhook(comment('Price kya hai?'));
    assert.equal(st.dms.length + st.publics.length + st.sends.length + st.leads.length + st.msgs.length, 0);
    assert.equal(st.shadow.length, 1);
    assert.deepEqual({ ...st.shadow[0], decision: { ...st.shadow[0].decision, offer: undefined } }, {
      lead_id: null, message_id: 'C1', platform: 'instagram',
      decision: { comment: 'Price kya hai?', rule: RULES[0].keyword, public: 'Sent you a DM 💬', dm: RULES[0].dm,
                  buttons: ['Dwarka Sec 12', 'Janakpuri', 'Kirti Nagar'], post_url: POST_URL, offer: undefined } });
    assert.equal(st.shadow[0].decision.offer.offer_price, 9999, 'the offer the bot would quote');

    // Off: nothing at all, not even the post lookup
    st = s7({ mode: 'off' });
    await handleWebhook(comment('Price kya hai?'));
    assert.equal(st.dms.length + st.publics.length + st.leads.length + st.shadow.length + st.media, 0);

    for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'META_ACCESS_TOKEN', 'META_BRANCH_ID', 'GEMINI_API_KEY', 'LEAD_WEBHOOK_URL'])
      delete process.env[k];
  }

  // ── S9 Instagram connect + secure token storage (Q16 Q20 Q28) ──
  {
    const { getIgToken, igAuthorizeUrl, connectInstagram, igTokenDue, refreshIgToken, sendInstagramMessage } = require('./meta-service');
    const DAY = 86400e3, NOW = Date.parse('2026-10-08T00:00:00Z');
    const isoDaysAgo = (d, now) => new Date(now - d * DAY).toISOString();
    process.env.SUPABASE_URL = 'http://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'test_anon';
    process.env.IG_APP_ID = 'APP1';
    process.env.IG_APP_SECRET = 'APPSECRET';
    const s9 = ({ secret = null, secretsStatus = 200, failAt = null } = {}) => {
      const st = { secret, saved: [], calls: [], tg: [], mails: [], secretHeaders: [] };
      const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v, text: async () => JSON.stringify(v) });
      global.fetch = async (url, opts = {}) => {
        st.calls.push(String(url));
        if (failAt && String(url).includes(failAt)) return json({ error: { message: 'Invalid OAuth access token' } }, 400);
        if (url.startsWith('http://supabase.test/rest/v1/secrets')) {
          st.secretHeaders.push(opts.headers.apikey);
          if (opts.method === 'POST') { const b = JSON.parse(opts.body); st.saved.push(b); st.secret = b.value; return json(null, 201); }
          return json(secretsStatus === 200 ? (st.secret ? [{ value: st.secret }] : []) : { message: 'no' }, secretsStatus);
        }
        if (url.includes('settings?key=eq.telegram_owner')) return json([{ value: JSON.stringify({ chat_id: 42 }) }]);
        if (url.includes('api.telegram.org')) { st.tg.push(JSON.parse(opts.body)); return json({ ok: true, result: { message_id: 1 } }); }
        if (url.includes('api.resend.com')) { st.mails.push(JSON.parse(opts.body)); return json({}); }
        if (url === 'https://api.instagram.com/oauth/access_token') {
          st.exchange = Object.fromEntries(opts.body);
          return json({ data: [{ access_token: 'SHORT', user_id: '111', permissions: 'instagram_business_basic' }] });
        }
        if (url.includes('graph.instagram.com/access_token?grant_type=ig_exchange_token')) return json({ access_token: 'LONG', token_type: 'bearer', expires_in: 5184000 });
        if (url.includes('graph.instagram.com/v21.0/me?fields=user_id,username')) return json({ user_id: 17841400000, username: 'dskin.test' });
        if (url.includes('/me/subscribed_apps')) { st.subscribed = opts.method; return json({ success: true }); }
        if (url.includes('refresh_access_token')) return json({ access_token: 'LONG2', expires_in: 5184000 });
        if (url.includes('graph.instagram.com')) { st.send = { url, auth: opts.headers?.Authorization }; return json({ message_id: 'm' }); }
        throw new Error('unexpected fetch ' + url);
      };
      return st;
    };

    // Authorize link: our app, the exact redirect URI, all three scopes, the state
    const au = new URL(igAuthorizeUrl('https://site.test/.netlify/functions/ig-connect', 'CODE_1'));
    assert.equal(au.origin + au.pathname, 'https://www.instagram.com/oauth/authorize');
    assert.deepEqual([au.searchParams.get('client_id'), au.searchParams.get('redirect_uri'), au.searchParams.get('state'),
                      au.searchParams.get('response_type')],
                     ['APP1', 'https://site.test/.netlify/functions/ig-connect', 'CODE_1', 'code']);
    assert.match(au.searchParams.get('scope'), /instagram_business_manage_messages/);
    assert.match(au.searchParams.get('scope'), /instagram_business_manage_comments/);

    // Code exchange: code → short → long-lived → account → saved (service key) → subscribed
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_key';
    let st = s9();
    const s = await connectInstagram('AUTHCODE', 'https://site.test/cb', NOW);
    assert.deepEqual(st.exchange, { client_id: 'APP1', client_secret: 'APPSECRET', grant_type: 'authorization_code',
                                    redirect_uri: 'https://site.test/cb', code: 'AUTHCODE' });
    assert.ok(st.calls.some(u => u.includes('ig_exchange_token') && u.includes('access_token=SHORT')));
    assert.deepEqual(st.saved, [{ key: 'instagram', value: { token: 'LONG', ig_user_id: '17841400000', username: 'dskin.test',
      refreshed_at: '2026-10-08T00:00:00.000Z', expires_at: '2026-12-07T00:00:00.000Z' } }]);
    assert.deepEqual(st.secretHeaders, ['service_key'], 'secrets go through the service key, never the anon key');
    assert.equal(st.subscribed, 'POST');
    assert.ok(st.calls.some(u => u.includes('subscribed_fields=messages,messaging_postbacks,comments') && u.includes('access_token=LONG')));
    assert.equal(s.username, 'dskin.test');
    // A failed step throws with Meta's reason, and nothing is saved
    st = s9({ failAt: 'ig_exchange_token' });
    await assert.rejects(connectInstagram('AUTHCODE', 'https://site.test/cb', NOW), /long-lived exchange failed: 400 Invalid OAuth/);
    assert.equal(st.saved.length, 0);

    // Fallback order: DB token → env → throw
    process.env.META_ACCESS_TOKEN = 'env_token';
    process.env.META_IG_ID = 'ENV_IG';
    const fresh = { token: 'DB_TOKEN', ig_user_id: '1784', username: 'dskin.test',
                    refreshed_at: new Date(Date.now() - DAY).toISOString(), expires_at: new Date(Date.now() + 59 * DAY).toISOString() };
    s9({ secret: fresh });
    assert.deepEqual(await getIgToken(), { token: 'DB_TOKEN', igId: 'me' });
    st = s9({ secret: fresh });
    await sendInstagramMessage('IGSID_1', 'hi');
    assert.deepEqual(st.send, { url: 'https://graph.instagram.com/v21.0/me/messages', auth: 'Bearer DB_TOKEN' }, 'sends use the DB token');
    s9({ secret: { ...fresh, expires_at: new Date(Date.now() - 1000).toISOString() } });
    assert.deepEqual(await getIgToken(), { token: 'env_token', igId: 'ENV_IG' }, 'expired DB token → env');
    s9();
    assert.equal((await getIgToken()).token, 'env_token', 'not connected → env');
    s9({ secret: fresh, secretsStatus: 404 });
    assert.equal((await getIgToken()).token, 'env_token', 'secrets unreadable (no table yet) → env');
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    st = s9({ secret: fresh });
    assert.equal((await getIgToken()).token, 'env_token', 'no service key → env, DB not asked');
    assert.equal(st.calls.length, 0);
    delete process.env.META_ACCESS_TOKEN;
    await assert.rejects(getIgToken(), /No Instagram token/);
    delete process.env.META_IG_ID;

    // Refresh window: only past 50 days, only a stored token
    assert.equal(igTokenDue({ token: 't', refreshed_at: isoDaysAgo(50, NOW) }, NOW), false);
    assert.equal(igTokenDue({ token: 't', refreshed_at: isoDaysAgo(50.1, NOW) }, NOW), true);
    assert.equal(igTokenDue(null, NOW), false);
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service_key';
    process.env.TELEGRAM_BOT_TOKEN = 'tg';
    const old = { ...fresh, refreshed_at: isoDaysAgo(51, NOW), expires_at: isoDaysAgo(-9, NOW) };
    st = s9({ secret: { ...fresh, refreshed_at: isoDaysAgo(10, NOW) } });
    assert.equal(await refreshIgToken(NOW), 'not due');
    assert.equal(st.saved.length + st.tg.length, 0);
    st = s9({ secret: old });
    assert.equal(await refreshIgToken(NOW), 'refreshed');
    assert.ok(st.calls.some(u => u.includes('grant_type=ig_refresh_token') && u.includes('access_token=DB_TOKEN')));
    assert.deepEqual(st.saved[0].value, { ...old, token: 'LONG2', refreshed_at: '2026-10-08T00:00:00.000Z', expires_at: '2026-12-07T00:00:00.000Z' });
    // A failed refresh keeps the old token and alerts the owner's Telegram
    st = s9({ secret: old, failAt: 'refresh_access_token' });
    assert.equal(await refreshIgToken(NOW), 'failed');
    assert.equal(st.saved.length, 0);
    assert.equal(st.tg.length, 1);
    assert.equal(st.tg[0].chat_id, 42);
    assert.match(st.tg[0].text, /Instagram token refresh failed \(token refresh failed: 400 Invalid OAuth access token\)/);
    assert.match(st.tg[0].text, /stops working on 17 Oct/);
    assert.ok(!st.tg[0].text.includes('DB_TOKEN'), 'the token never appears in an alert');

    for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'IG_APP_ID', 'IG_APP_SECRET', 'TELEGRAM_BOT_TOKEN'])
      delete process.env[k];
  }

  global.fetch = realFetch;
  console.log('meta-service: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
