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

// ── WhatsApp: non-text (image) is dropped downstream, not crashed on ──
{
  const { events } = extractEvents({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        field: 'messages',
        value: {
          contacts: [{ profile: { name: 'Gaurav' }, wa_id: '919999999999' }],
          messages: [{ from: '919999999999', type: 'image', image: { id: 'media-id' } }],
        },
      }],
    }],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].messageText, undefined, 'no text body → handleWebhook skips it');
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

console.log('meta-service: all checks passed');
