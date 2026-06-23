// ============================================================
// DSkin Cashup — Configuration
// SUPABASE_URL and SUPABASE_ANON_KEY are NOT stored here.
// They are loaded at runtime from /.netlify/functions/get-config,
// which reads Netlify environment variables server-side.
// See .env.example for local dev setup.
// ============================================================

const CONFIG = {
  // Dev/admin account email
  ADMIN_EMAIL: 'hospitalitybee@gmail.com',

  // Accountant emails (view-only access)
  ACCOUNTANT_EMAILS: [],

  // App URL (used for magic link redirect)
  APP_URL: 'https://eloquent-pothos-dc09dc.netlify.app',

  // Currency symbol
  CURRENCY: '₹',

  // Timezone for date calculations
  TIMEZONE: 'Asia/Kolkata',
};
