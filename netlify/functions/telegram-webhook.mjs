// ============================================================
// Netlify Function: telegram-webhook
// Endpoint: /webhook/telegram  (redirect configured in netlify.toml)
//
// Owner alerts (service tracker S3). Telegram POSTs every bot update here once
// setWebhook has run with secret_token = TELEGRAM_WEBHOOK_SECRET. That header is
// our only proof an update came from Telegram (like Meta's HMAC), so no secret
// set = everything rejected.
// S3: binding. The owner opens t.me/<bot>?start=<TELEGRAM_LINK_CODE>, which
// sends "/start <code>" and saves their chat id in settings.telegram_owner.
// Opening the link from another account moves the alerts there. Everything
// else is ignored; S4 adds the owner's replies to alerts.
// .mjs (modern syntax) like meta-webhook: the body arrives decoded.
// ============================================================

import metaService from './utils/meta-service.js';

const { safeEqual, createSupabaseClient, sendTelegram } = metaService;

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const got    = req.headers.get('x-telegram-bot-api-secret-token');
  if (!secret || !got || !safeEqual(got, secret)) return new Response('Forbidden', { status: 403 });

  const msg   = (await req.json().catch(() => ({}))).message;
  const code  = process.env.TELEGRAM_LINK_CODE;
  const start = /^\/start (\S+)$/.exec(msg?.text || '');
  if (msg?.chat?.id && start && code && safeEqual(start[1], code)) {
    await createSupabaseClient().upsertSetting('telegram_owner',
      JSON.stringify({ chat_id: msg.chat.id, name: msg.from?.first_name || '' }));
    await sendTelegram(msg.chat.id, '✅ Linked. DSkin bot alerts will arrive in this chat.');
    console.log(`[telegram-webhook] owner linked: chat ${msg.chat.id}`);
  }
  return new Response('ok');
};
