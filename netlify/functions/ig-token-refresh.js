// ============================================================
// Netlify Scheduled Function: ig-token-refresh
// Daily (service tracker S9): renews the connected Instagram token once it's
// > 50 days old (it lives 60). A failure logs an error row in bot_events (the
// console's Activity page) with the days left, once a day until it works.
// Cron: "0 4 * * *" = 09:30 IST (trigger it by hand from the Netlify UI to test)
// ============================================================

const { schedule } = require('@netlify/functions');
const { refreshIgToken } = require('./utils/meta-service');

exports.handler = schedule('0 4 * * *', async () => {
  console.log('[ig-token-refresh]', await refreshIgToken());
  return { statusCode: 200 };
});
