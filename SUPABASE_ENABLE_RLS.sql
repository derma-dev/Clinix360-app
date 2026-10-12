-- ============================================================
-- Lock down the database (service tracker S12, Q35).
-- Run in: Supabase Dashboard → SQL Editor → paste → Run. Safe to re-run.
--
--   * The public anon key (the browser holds it) gets NO access to any table.
--   * Every Netlify function uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS.
--   * The console signs in with ONE Supabase Auth account. is_console() names it,
--     and every table's only policy asks is_console(), so a stray signup sees nothing.
--     authorizeRequest (meta-service.js) asks the same function, so one rule decides both.
--   * `secrets` (S9) stays as it is: RLS on, no policy, no grants, service key only.
--
-- Before running: create the account (Authentication → Users → Add user → email +
-- password, Auto Confirm on) and put its email below. To change the account later,
-- re-run only the CREATE OR REPLACE FUNCTION with the new email.
-- Also turn off Authentication → Sign In / Providers → "Allow new users to sign up".
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_console() RETURNS boolean
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(auth.jwt()->>'email', '') = 'dermadwarka@gmail.com'
$$;

DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND c.relname <> 'secrets'   -- server-only (S9): never a policy
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS allow_anon_all ON %I;', t.relname);   -- the old allow-all
    EXECUTE format('DROP POLICY IF EXISTS console_only ON %I;', t.relname);
    EXECUTE format(
      'CREATE POLICY console_only ON %I FOR ALL TO authenticated USING ((SELECT public.is_console())) WITH CHECK ((SELECT public.is_console()));',
      t.relname
    );
  END LOOP;
END $$;

-- Grants: anon loses every table and view (a view would skip RLS), now and for tables made later.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

-- Sanity check: every row should show anon_can_read = false; tables (not views)
-- rls_enabled = true and policies = 1 (secrets: 0).
SELECT
  c.relname AS name,
  c.relkind AS kind,
  c.relrowsecurity AS rls_enabled,
  COUNT(p.polname) AS policies,
  has_table_privilege('anon', c.oid, 'SELECT') AS anon_can_read
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
GROUP BY c.relname, c.relkind, c.relrowsecurity, c.oid
ORDER BY c.relname;
