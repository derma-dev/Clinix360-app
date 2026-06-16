// ============================================================
// Netlify Function: get-config
// Returns Supabase public credentials to the frontend.
// Reads from Netlify environment variables so credentials
// never have to be hardcoded in any browser-served file.
// ============================================================

exports.handler = async () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY env vars');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server misconfigured — Supabase env vars not set' }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      // Safe to cache — values only change when you redeploy with new env vars
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify({ supabaseUrl, supabaseAnonKey }),
  };
};
