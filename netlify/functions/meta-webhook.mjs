// ============================================================
// Netlify Function: meta-webhook
// Endpoint: /webhook/meta  (redirect configured in netlify.toml)
//
// GET  — Meta webhook verification challenge
// POST — Incoming message events from Meta
//
// Modern (Request/Response) syntax — .mjs because the project is CommonJS —
// for context.waitUntil: Meta gets its 200 as soon as the signature checks out
// and the DB writes + bot turn finish after the response. A first-seen shared
// post took 27 s end to end (offer parse + reply), past Meta's delivery
// timeout, which then retries. handleWebhook already swallows every per-event
// error and 200s anyway, so acking early loses nothing a retry would recover.
// ============================================================

import crypto from 'node:crypto';
import metaService from './utils/meta-service.js';

const { verifyWebhook, verifyMetaSignature, handleWebhook } = metaService;

export default async (req, context) => {
  // ── GET: webhook verification ─────────────────────────────
  if (req.method === 'GET') {
    const result = verifyWebhook(Object.fromEntries(new URL(req.url).searchParams));
    // Must return the challenge as plain text, not JSON
    if (result.valid) return new Response(result.challenge, { status: 200 });

    console.error('[meta-webhook] Verification failed — check META_VERIFY_TOKEN env var');
    return new Response('Forbidden', { status: 403 });
  }

  // ── POST: incoming webhook event ─────────────────────────
  if (req.method === 'POST') {
    // req.text() is the decoded body (the old handler had to undo Netlify's
    // base64 encoding itself before the HMAC).
    const rawBody = await req.text();

    // Verify Meta's HMAC signature BEFORE trusting the body — without it anyone who
    // knows the public webhook URL can forge inbound messages / comment automation.
    const signature = req.headers.get('x-hub-signature-256');
    if (!verifyMetaSignature(rawBody, signature)) {
      // Diagnostic (fires only on rejection): tells wrong secret (NO_SECRET_SET /
      // digest mismatch) from mangled body (odd contentType/bodyLen) from a missing
      // header. No body content is logged — DMs can contain patient messages.
      const sec = process.env.META_APP_SECRET || '';
      const expected = sec ? 'sha256=' + crypto.createHmac('sha256', sec).update(rawBody, 'utf8').digest('hex') : null;
      console.error('[meta-webhook] SIG-DEBUG ' + JSON.stringify({
        sigHeader: signature || null,
        expected: expected ? expected.slice(0, 20) + '…' : 'NO_SECRET_SET',
        sigLen: (signature || '').length,
        bodyLen: rawBody.length,
        contentType: req.headers.get('content-type'),
      }));
      console.error('[meta-webhook] Invalid X-Hub-Signature-256 — rejecting');
      return new Response('Invalid signature', { status: 403 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody || '{}');
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Ack now, process after the response (still bounded by the 60 s limit).
    context.waitUntil(handleWebhook(payload).catch(err =>
      console.error('[meta-webhook] handleWebhook failed:', err.message)));

    return Response.json({ status: 'ok' });
  }

  return new Response('Method Not Allowed', { status: 405 });
};
