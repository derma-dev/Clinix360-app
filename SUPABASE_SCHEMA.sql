-- ============================================================
-- Clinix360 Cashup — CURRENT Supabase schema (as of 11 Jun 2026)
-- Project ref: plxhbtsncfkuvnywstgn  (https://plxhbtsncfkuvnywstgn.supabase.co)
-- This reflects the LIVE database including all migrations since launch.
-- (The original supabase-schema.sql is the day-1 version and is now out of date.)
-- RLS is DISABLED on all tables — access is gated at the app level by PIN.
-- The frontend talks to these tables with the public ANON key (in config.js).
-- ============================================================

-- Branches (one row per clinic). PIN is the 4-digit branch login.
CREATE TABLE IF NOT EXISTS branches (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  pin         TEXT NOT NULL,
  state       TEXT DEFAULT NULL,            -- Indian state/UT label
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- Live branch IDs:
--   Janakpuri      8db5a0fb-a7d4-435b-951e-6f1cb5d85fc9
--   Kirti Nagar    e1d26aab-025d-4136-8a91-867a16c5a9ef
--   Dwarka Sec 12  9a3aff6c-84b5-4c7f-95e8-6af3c9ec0556

-- Individual sale lines for a branch/day.
CREATE TABLE IF NOT EXISTS cashup_entries (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_id       UUID REFERENCES branches(id) ON DELETE CASCADE,
  entry_date      DATE NOT NULL,
  product_service TEXT NOT NULL DEFAULT '',
  customer_name   TEXT DEFAULT '',
  amount          DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_type    TEXT NOT NULL DEFAULT 'cash',   -- see note below
  staff           TEXT DEFAULT '',
  sort_order      INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- IMPORTANT: payment_type was originally CHECK-constrained to ('cash','scan').
-- That constraint (cashup_entries_payment_type_check) has been DROPPED so any
-- mode code can be stored. Allowed modes are now managed at the app level via
-- settings.payment_modes (see below). 'cash' is special: the cash/non-cash
-- ("Less Scan") split treats every payment_type != 'cash' as non-cash.
-- Codes currently in use: cash, scan, upi, icici_machine, pinelab,
-- bajaj_finance, savein, cheque.

-- One summary row per branch/day (the totals + closing math).
-- closing_balance = opening_balance + cash_sales - less_cash_handover + add_extra - expenses
-- (cash_sales = sum of entries where payment_type = 'cash'; expenses = sum of cashup_expenses)
CREATE TABLE IF NOT EXISTS cashup_summaries (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_id              UUID REFERENCES branches(id) ON DELETE CASCADE,
  entry_date             DATE NOT NULL,
  opening_balance        DECIMAL(12,2) DEFAULT 0,
  less_scan_override      DECIMAL(12,2) DEFAULT NULL,  -- NULL = auto-calc from entries
  less_cash_handover     DECIMAL(12,2) DEFAULT 0,
  add_extra              DECIMAL(12,2) DEFAULT 0,
  notes                  TEXT DEFAULT '',
  is_submitted           BOOLEAN DEFAULT false,        -- true once finalised (actual closing entered)
  submitted_at           TIMESTAMPTZ,
  closing_balance        DECIMAL(12,2),                -- calculated closing
  actual_closing_balance DECIMAL(12,2),                -- till count entered at submit
  variance               DECIMAL(12,2),                -- actual - calculated
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(branch_id, entry_date)
);

-- Expense lines for a branch/day.
CREATE TABLE IF NOT EXISTS cashup_expenses (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_id   UUID REFERENCES branches(id) ON DELETE CASCADE,
  entry_date  DATE NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  amount      DECIMAL(12,2) NOT NULL DEFAULT 0,
  sort_order  INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- "Add Extra (if any)" cash-added lines for a branch/day. Sum -> summary.add_extra.
CREATE TABLE IF NOT EXISTS cashup_extras (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_id   UUID REFERENCES branches(id) ON DELETE CASCADE,
  entry_date  DATE NOT NULL,
  reason      TEXT DEFAULT '',
  amount      DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Variance alerts (raised when actual closing != calculated). Shown in admin Notifications.
CREATE TABLE IF NOT EXISTS cashup_alerts (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_id          UUID REFERENCES branches(id) ON DELETE CASCADE,
  branch_name        TEXT,
  entry_date         DATE,
  calculated_closing DECIMAL(12,2),
  actual_closing     DECIMAL(12,2),
  variance           DECIMAL(12,2),
  is_read            BOOLEAN DEFAULT false,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Staff feedback submitted from the cashup screen. Shown in admin Notifications.
CREATE TABLE IF NOT EXISTS cashup_feedback (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_id     UUID REFERENCES branches(id) ON DELETE CASCADE,
  branch_name   TEXT,
  entry_date    DATE,
  feedback_text TEXT,
  submitted_by  TEXT,
  is_read       BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled / on-submit report automations (email or webhook).
CREATE TABLE IF NOT EXISTS cashup_automations (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name            TEXT,
  trigger_type    TEXT,        -- 'weekly' | 'monthly' | 'single_date'
  trigger_mode    TEXT,        -- 'on_submit' | 'scheduled'
  trigger_date    DATE,        -- for single_date
  branches        JSONB,       -- ['all'] or array of branch ids
  report_sections JSONB,       -- which sections to include
  email_to        TEXT,
  is_active       BOOLEAN DEFAULT true,
  last_sent_at    TIMESTAMPTZ, -- dedupe guard
  action_type     TEXT,        -- 'email' | 'webhook'
  webhook_url     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Key/value app settings.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- Keys in use:
--   admin_pin       -> the 4-digit admin PIN (string)
--   payment_modes   -> JSON array, e.g. [{"code":"cash","label":"Cash"}, ...]
--                      Editable from Admin Panel -> Settings -> Payment Modes.

-- Lead Hub — one row per prospective customer, scoped to a branch.
CREATE TABLE IF NOT EXISTS leads (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_id  UUID REFERENCES branches(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  phone      TEXT DEFAULT '',
  source     TEXT DEFAULT '',  -- Walk-in | WhatsApp | Instagram | Facebook | Google | Referral | Other
  service    TEXT DEFAULT '',
  status     TEXT DEFAULT 'new',  -- 'new' | 'contacted' | 'converted' | 'lost'
  notes      TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Migration: add source column if upgrading from an older schema
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT DEFAULT '';
-- Meta DM integration: platform-scoped sender ids used to dedupe inbound leads
--   instagram_user_id -> Instagram-scoped id (IGSID) for IG DM leads
--   facebook_user_id  -> Page-scoped id (PSID) for Facebook Messenger leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS instagram_user_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS facebook_user_id  TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_branch ON leads(branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_instagram_user ON leads(instagram_user_id);
CREATE INDEX IF NOT EXISTS idx_leads_facebook_user  ON leads(facebook_user_id);

-- Notes on a lead (many per lead).
CREATE TABLE IF NOT EXISTS lead_notes (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id    UUID REFERENCES leads(id) ON DELETE CASCADE,
  branch_id  UUID REFERENCES branches(id) ON DELETE CASCADE,
  note       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id, created_at DESC);

-- Messages on a lead — ordered chronologically to form a timeline.
CREATE TABLE IF NOT EXISTS lead_messages (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lead_id    UUID REFERENCES leads(id) ON DELETE CASCADE,
  branch_id  UUID REFERENCES branches(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL DEFAULT 'out',  -- 'in' (customer) | 'out' (staff)
  body       TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_messages_lead ON lead_messages(lead_id, created_at ASC);

-- RLS disabled everywhere (PIN-based app security):
ALTER TABLE branches            DISABLE ROW LEVEL SECURITY;
ALTER TABLE cashup_entries      DISABLE ROW LEVEL SECURITY;
ALTER TABLE cashup_summaries    DISABLE ROW LEVEL SECURITY;
ALTER TABLE cashup_expenses     DISABLE ROW LEVEL SECURITY;
ALTER TABLE cashup_extras       DISABLE ROW LEVEL SECURITY;
ALTER TABLE cashup_alerts       DISABLE ROW LEVEL SECURITY;
ALTER TABLE cashup_feedback     DISABLE ROW LEVEL SECURITY;
ALTER TABLE cashup_automations  DISABLE ROW LEVEL SECURITY;
ALTER TABLE settings            DISABLE ROW LEVEL SECURITY;
ALTER TABLE leads               DISABLE ROW LEVEL SECURITY;
ALTER TABLE lead_notes          DISABLE ROW LEVEL SECURITY;
ALTER TABLE lead_messages       DISABLE ROW LEVEL SECURITY;
