# Clinix360 — Instagram Webhook Go-Live Session

**Date:** 23 June 2026
**Goal:** Get the Instagram DM → Leads webhook ingesting end-to-end on the new infrastructure (new GitHub repo + new Netlify account, same Supabase), and take the Meta app Live so real DMs are delivered.

**Result:** ✅ Working. Real Instagram DMs now create a lead + message row in Supabase and appear in the dashboard.

---

## 1. Context — what changed before this session

The project was migrated to a **new GitHub repo** and **redeployed to a new Netlify account**. Supabase was **reused** (same database). New site URL:

```
https://eloquent-pothos-dc09dc.netlify.app
```

Hardcoded references to the old infra were patched to the new URL in:

- `config.js` → `APP_URL`
- `netlify/functions/check-automations.js` → `SITE_URL` fallback
- `netlify/functions/send-automation-report.js` → logo + footer link
- `netlify/functions/send-feedback-email.js` → logo
- `netlify/functions/send-variance-alert.js` → logo
- `netlify/functions/send-pin-email.js` → logo

---

## 2. Netlify environment variables (set in Netlify dashboard, NOT in repo)

`.env` is gitignored / local-only — these must be set in **Netlify → Site settings → Environment variables**:

| Var | Purpose |
|-----|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `RESEND_API_KEY` | Resend email sending |
| `META_VERIFY_TOKEN` | Webhook GET verification handshake |
| `META_APP_ID` | Meta app id |
| `META_APP_SECRET` | Meta app secret |
| `META_ACCESS_TOKEN` | Instagram access token (`IGAA…`) |
| `META_BRANCH_ID` | Branch UUID new IG leads attach to |

> Any env var change requires a **redeploy** to take effect.

**Branch UUIDs (live Supabase):**
- Dwarka Sec 12 → `9a3aff6c-84b5-4c7f-95e8-6af3c9ec0556` (the one used — derma**dwarka**)
- Janakpuri → `8db5a0fb-a7d4-435b-951e-6f1cb5d85fc9`
- Kirti Nagar → `e1d26aab-025d-4136-8a91-867a16c5a9ef`

---

## 3. Code changes this session

### a. `verifyWebhook` — decoupled from full Meta config
`netlify/functions/utils/meta-service.js`. Verification (GET handshake) now depends **only** on `META_VERIFY_TOKEN`, so a missing app secret / access token no longer blocks the URL verification.

### b. `handleWebhook` — handle BOTH payload shapes
Real Instagram DMs (Instagram Login API) arrive as `entry[].messaging[]`. Meta's dashboard **"Test" button** sends `entry[].changes[].field=messages`. The handler was only reading `changes[]`, so real DMs were silently skipped. Patched to:
- read both `messaging[]` and `changes[]`,
- skip **echoes** (`message.is_echo` — copies of our own outbound messages),
- log when no events are found.

### c. Privacy policy page (required to go Live)
Created `privacy.html` (served statically by Netlify) →
`https://eloquent-pothos-dc09dc.netlify.app/privacy.html`
Includes a `#data-deletion` section for Meta's data-deletion URL field.

---

## 4. Meta App / Instagram configuration

### Webhook config
- Callback URL: `https://eloquent-pothos-dc09dc.netlify.app/webhook/meta`
  (redirect → `meta-webhook` function, defined in `netlify.toml`)
- Verify token: must match `META_VERIFY_TOKEN` exactly.
- **Gotcha hit:** during a browser test the literal placeholder `<TOKEN>` was left in the URL → "Forbidden". Replacing with the real token returned the challenge.
- Subscribed field: `messages` — must show **Subscribed** (verifying the URL ≠ subscribing the field).

### Per-account subscription (`subscribed_apps`)
Confirmed the IG account is subscribed to the app for `messages`:
```powershell
# Check (PowerShell — note: curl is aliased to Invoke-WebRequest, use curl.exe or Invoke-RestMethod)
(Invoke-RestMethod "https://graph.instagram.com/v21.0/me/subscribed_apps?access_token=YOUR_IG_TOKEN").data.subscribed_fields
# → messages   ✅

# Subscribe if empty:
Invoke-RestMethod -Method Post "https://graph.instagram.com/v21.0/me/subscribed_apps?subscribed_fields=messages&access_token=YOUR_IG_TOKEN"
```
IG token is generated at: App Dashboard → **Instagram → API setup with Instagram login → Generate access tokens**. (`META_ACCESS_TOKEN` is this token.)

### THE root blocker — app was in Development mode
Per Meta docs: **"Your app must be set to Live in the App Dashboard for Meta to send webhook notifications."**
In Development mode, Meta sends **zero** real webhook notifications — even from tester accounts. The dashboard "Test" button still works because it's a manual sample, not a real notification. This is why every real DM produced an empty log.

**To go Live**, App Settings → Basic required these (were missing):
- App icon (1024 × 1024 PNG)
- Privacy policy URL → used the new `privacy.html`
- Category → "Business and pages"

After filling them → flipped app to **Live** → real DMs started delivering. 🎉

---

## 5. End-to-end flow (now working)

```
IG user DM → Meta → POST /webhook/meta
  → meta-webhook.js (POST)
  → handleWebhook(): parse entry[].messaging[]  (skip echoes)
  → processIncomingMessage(senderId, text):
        findLeadByInstagramId(senderId)
          → exists? reuse : createLead({ branch_id: META_BRANCH_ID, source:'instagram',
                                         customer_name:'Instagram User', instagram_user_id, status:'new' })
        insertMessage({ lead_id, direction:'incoming', message, is_seen:false })
  → row visible in dashboard → Leads tab
```

Supabase columns confirmed present (lead dedupe lookup succeeded, so `leads.instagram_user_id` exists):
`leads.instagram_user_id`, `leads.customer_name`, `lead_messages.message`, `lead_messages.is_seen`.

---

## 6. Remaining / not done yet

1. **Outbound replies not implemented.** `sendInstagramMessage()` in `meta-service.js` is a stub; the dashboard reply box only inserts to the DB, it does NOT send via the Graph API. (Phase 2.)
2. **Public DMs need App Review.** Live mode + tester roles = Standard Access (testers work). DMs from the **general public** require **Advanced Access** on `instagram_business_manage_messages` via full **App Review** submission.
3. **Realtime inbox UI** — leads currently load on tab open; no live push.
4. Old site-id references in docs (if any) can be cleaned up.

---

## 7. Commands run / to remember

```bash
# Deploy code + privacy page (Netlify auto-builds on push)
git add -A
git commit -m "webhook: handle real IG messaging[] payload + add privacy policy page"
git push
```
