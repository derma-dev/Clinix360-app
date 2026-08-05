-- ============================================================
-- Enable Row Level Security WITHOUT breaking the app.
-- Run in: Supabase Dashboard → SQL Editor → paste → Run. Safe to re-run.
--
-- Why this is safe:
--   Every part of Clinix360 (browser app.js + ALL netlify functions) talks to
--   Supabase with the ANON key — nothing uses the service_role key. The anon
--   key is subject to RLS, so turning RLS on with NO policies would lock the
--   app out of every table (empty reads, failed writes, dead realtime inbox).
--
--   This enables RLS on EVERY table in the public schema and gives each a
--   single PERMISSIVE policy (allow all for anon/authenticated). Net behaviour
--   is IDENTICAL to RLS-off: the app keeps working exactly as today. RLS is
--   now "on" as a foundation so per-table rules can be tightened later.
--   Looping over ALL public tables (not a hardcoded list) means tables that
--   exist in the live DB but not in SUPABASE_SCHEMA.sql — e.g.
--   lead_status_history — are covered too.
--
-- This does NOT by itself make the data more private — the anon key can still
-- read/write everything. Real row-level privacy needs Supabase Auth (the app
-- currently uses a custom PIN login, so auth.uid() is null in the browser) or
-- moving writes to service_role server functions.
-- ============================================================

DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS allow_anon_all ON %I;', t.relname);
    EXECUTE format(
      'CREATE POLICY allow_anon_all ON %I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);',
      t.relname
    );
  END LOOP;
END $$;

-- Sanity check: EVERY public table should show rls_enabled = true, policy_count = 1.
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  COUNT(p.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public' AND c.relkind = 'r'
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;