# Testing while Netlify production deploys are blocked

**Situation:** Netlify Free plan hit the credit limit. Production deploys show
`Skipped due to account credit usage exceeded`. The **live site still works** —
only new production publishes are paused.

**Key fact:** only *production* deploys cost credits (15 each). Draft deploys,
branch deploys and Deploy Previews cost **0 credits** and are unlimited on Free.
So you can still deploy — just not to the production URL.

---

## Option A — Alias deploy (recommended)

One command, stable URL, same site, same env vars, same functions. No git branch
needed.

```bash
npm i -g netlify-cli      # once
netlify login             # once
netlify link              # once — pick the Clinix360 site
netlify deploy --alias staging
```

Result: **`https://staging--eloquent-pothos-dc09dc.netlify.app`**

- Costs 0 credits, does not touch the published production deploy.
- Re-run `netlify deploy --alias staging` after every change — the URL stays the same.
- All `netlify/functions/*` are live there, including `/webhook/meta`
  (the `netlify.toml` redirect applies).
- Env vars (`META_*`, `WHATSAPP_*`, `SUPABASE_*`) are inherited from the site
  unless you scoped them to the Production context only. If the webhook returns
  403, check Site config → Environment variables → each var's **deploy contexts**
  includes "Deploy Previews / branch deploys".

## Option B — Local + tunnel (fastest debug loop)

No deploy at all. You get live console logs and edit-save-retest.

```bash
netlify dev                                        # :8888, honors netlify.toml, pulls live env vars
cloudflared tunnel --url http://localhost:8888     # → https://<random>.trycloudflare.com
```

- URL changes on every restart → re-verify the webhook in Meta each time.
- Use this while actively debugging, Option A for anything that must stay up.

## Option C — Ask Netlify to reset it

There is a known **July 2026 credit-migration bug** where Free-plan accounts get
flagged `credit usage exceeded` while still showing credits remaining. Check
**Usage & Billing** — if credits remain, post on
[answers.netlify.com](https://answers.netlify.com) with your site name and ask
them to reset the stale flag. Otherwise credits reset at the start of your next
billing cycle.

---

# What to change in the Meta account

Replace `NEW_URL` below with your Option A or B URL, e.g.
`https://staging--eloquent-pothos-dc09dc.netlify.app`.

## The one thing that actually matters: the webhook callback

`developers.facebook.com` → your app → **each product** below → Webhooks →
**Edit callback URL**:

| Product | Where | Callback URL | Verify token |
|---|---|---|---|
| WhatsApp | WhatsApp → Configuration → Webhook | `NEW_URL/webhook/meta` | value of `META_VERIFY_TOKEN` |
| Messenger | Messenger → Settings → Webhooks | `NEW_URL/webhook/meta` | same |
| Instagram | Instagram → Settings → Webhooks | `NEW_URL/webhook/meta` | same |

Click **Verify and save**. Meta sends a `GET` with `hub.challenge`;
[meta-webhook.js](netlify/functions/meta-webhook.js#L12-L23) echoes it back if the
token matches. A 403 means `META_VERIFY_TOKEN` isn't reaching that deploy context.

After saving, re-check the **subscribed fields** are still ticked — Meta sometimes
clears them when the URL changes:

- WhatsApp: `messages`
- Messenger: `messages`, `messaging_postbacks`
- Instagram: `messages`

## Also update (only if you use them)

- **App settings → Basic → App Domains**: add the new host
  (`staging--eloquent-pothos-dc09dc.netlify.app` or the `trycloudflare.com` host).
- **Facebook Login → Valid OAuth Redirect URIs**: add `NEW_URL/` if the dashboard
  does FB login.
- **Privacy Policy URL / Data Deletion URL**: only needed for App Review, not for
  testing.

## ⚠️ One callback URL per product

Meta allows a single callback URL per product per app. Pointing it at staging
**diverts live incoming messages away from production** for as long as it's set.

- Short test window → fine, just switch it back afterwards.
- Need production to keep receiving → create a **second Meta app** for dev, add
  the same WhatsApp number / Page / IG account to it, and point that app's webhook
  at staging. Standard practice, worth doing once.

---

# When credits are back

1. Point every Meta webhook back to
   `https://eloquent-pothos-dc09dc.netlify.app/webhook/meta`.
2. Re-tick subscribed fields.
3. `git push origin main` — production deploy runs normally.

---

## Sources

- [How credits work — Netlify Docs](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)
- [Create deploys — Netlify Docs](https://docs.netlify.com/deploy/create-deploys/)
- [netlify deploy CLI reference](https://cli.netlify.com/commands/deploy/)
- [Environment variables & deploy contexts](https://docs.netlify.com/build/environment-variables/overview/)
- [July 2026 stale credit-flag bug thread](https://answers.netlify.com/t/free-plan-run-out-of-credits-banner-but-30-30-credits-remaining-deploys-blocked/165092)
