// ============================================================
// Netlify Function: ig-connect
// The "Connect Instagram" link (service tracker S9). Two legs:
//   1. GET ?start=<IG_CONNECT_CODE> → 302 to Instagram's login (state = the code)
//   2. Instagram → GET ?code=…&state=… → connectInstagram: long-lived token in
//      `secrets`, account subscribed to our webhooks → a one-line result page.
// The code gates both legs: without it anyone could connect their own account
// and take over the bot's token. Unset = everything rejected.
// Redirect URI (add it in the Meta app, exactly): <site URL>/.netlify/functions/ig-connect
// ============================================================

const { safeEqual, igAuthorizeUrl, connectInstagram } = require('./utils/meta-service');

// Plain text, so nothing from Instagram's answer can inject markup.
const page = (statusCode, text) => ({ statusCode, body: text,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

exports.handler = async (event) => {
  const q    = event.queryStringParameters || {};
  const code = process.env.IG_CONNECT_CODE;
  const ok   = (v) => !!code && !!v && safeEqual(v, code);
  const redirectUri = `${process.env.URL || 'https://' + event.headers.host}/.netlify/functions/ig-connect`;

  if (q.start) {
    if (!ok(q.start)) return page(403, 'This Connect link is not valid.');
    return { statusCode: 302, headers: { Location: igAuthorizeUrl(redirectUri, code), 'Cache-Control': 'no-store' } };
  }
  if (q.error) return page(400, `Instagram did not connect: ${String(q.error_description || q.error).replace(/\.$/, '')}. Open the Connect link to try again.`);
  if (!q.code || !ok(q.state)) return page(403, 'This Connect link is not valid.');
  try {
    const s = await connectInstagram(q.code, redirectUri);
    return page(200, `✅ Instagram connected: @${s.username}. The bot now uses this account. You can close this tab.`);
  } catch (e) {
    console.error('[ig-connect]', e.message);
    return page(502, `Connecting Instagram failed: ${e.message}. Open the Connect link to try again.`);
  }
};
