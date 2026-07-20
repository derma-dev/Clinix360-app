// Payload extractor + platform column checks.
// Run: node netlify/functions/utils/meta-service.test.js
// No framework, no env vars needed — extractEvents/idColumnFor are pure.

const assert = require('node:assert');
const { extractEvents, idColumnFor } = require('./meta-service');

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

console.log('meta-service: all checks passed');
