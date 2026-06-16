# DSkin Cashup — Setup Guide

5 steps to go live on dskin.co.

---

## 🚨 DEPLOY TARGET — DO NOT MIX UP WITH THE MARKETING SITE
This Cashup app deploys ONLY to its OWN Netlify site:
  - Cashup app → site ID **eabc30b1-b8d9-4d57-978f-c37ab643f35e** (dskin-cashup → cashup.dskin.co)

The Derma PUBLIC marketing site is a DIFFERENT project and a DIFFERENT Netlify site
(2645c785-a8d5-4e06-b72b-aedf1fedca47, cosmic-cascaron-69cab5). Never deploy the
marketing site to this Cashup site ID — doing so overwrites the live Cashup app and
breaks staff access (this happened 6–7 June 2026).

Redeploy this app with:
`NETLIFY_AUTH_TOKEN=<token> npx netlify-cli@22 deploy --prod --dir . --site eabc30b1-b8d9-4d57-978f-c37ab643f35e`
(Working token is in `.netlify-token.env`.)

---

## Step 1: Create Supabase Project

1. Go to https://supabase.com → Sign up (free)
2. Click **New Project**
3. Name it `dskin-cashup`, set a DB password, pick **Singapore** region (closest to India)
4. Wait ~2 minutes for it to spin up

---

## Step 2: Set Up the Database

1. In Supabase → go to **SQL Editor** → click **New Query**
2. Open `supabase-schema.sql` from this folder
3. Paste the entire file contents → click **Run**
4. This creates all tables and inserts the 3 branches with PIN `0000`

---

## Step 3: Set Your Credentials in config.js

1. In Supabase → **Settings → API**
2. Copy **Project URL** and **anon public** key
3. Open `config.js` and replace:
   ```
   SUPABASE_URL: 'YOUR_SUPABASE_URL',
   SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',
   ```
4. Set `APP_URL` to `https://www.dskin.co`

---

## Step 4: Deploy to Netlify

1. Go to https://netlify.com → Log in
2. Click **Add new site → Deploy manually**
3. Drag the entire `cashup-website` folder into the drop zone
4. Netlify gives you a random URL — it works immediately

---

## Step 5: Point dskin.co to Netlify

### In Netlify:
1. Site settings → **Domain management → Add custom domain**
2. Type `dskin.co` → click Verify
3. Also add `www.dskin.co`
4. Netlify will give you nameservers or a CNAME record

### In Namecheap:
1. Log in → Manage Domain → **Advanced DNS**
2. Add a CNAME record:
   - Host: `www`
   - Value: `[your-netlify-site].netlify.app`
3. For the root domain (dskin.co), add Netlify's provided A records
4. DNS takes 15 minutes to 1 hour to propagate

### Enable Supabase Auth Redirect:
1. In Supabase → **Authentication → URL Configuration**
2. Add `https://www.dskin.co` as a **Redirect URL**
3. This is needed for admin magic link login to work

---

## Step 6: Set Branch PINs

1. Open the app → click **Admin / Accountant Login**
2. Enter `hospitalitybee@gmail.com` → click Send Login Link
3. Click the link in your email
4. In the admin panel, click **Edit** next to each branch
5. Set proper PINs for each branch (share with staff)

---

## Features

- **Branch PIN login** — 4-digit per branch, no account needed for staff
- **Daily cashup form** — entry rows, auto-calculated summary, expenses
- **Smart fill** — autocomplete on Product/Service and Staff from past entries
- **Dashboard stats** — this week / last week / this month / last month
- **Admin panel** — manage branches, change PINs, view any branch
- **Date override** — admin can view/edit any date
- **Accountant login** — read-only access (add emails to ACCOUNTANT_EMAILS in config.js)
- **Forgot PIN** — opens email to admin requesting PIN

---

## Adding an Accountant

In `config.js`, add their email to `ACCOUNTANT_EMAILS`:
```js
ACCOUNTANT_EMAILS: ['accountant@example.com'],
```
They get view-only access across all branches.

---

## Branch Staff Instructions

1. Open dskin.co on phone or computer
2. Tap your branch name
3. Enter 4-digit PIN
4. Tap **Enter Today's Cashup**
5. Fill in entries, summary, expenses
6. Tap **Save Cashup**

That's it. No login needed.
