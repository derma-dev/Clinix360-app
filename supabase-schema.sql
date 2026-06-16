-- ============================================================
-- DSkin Cashup — Supabase Database Schema
-- Run this entire file in your Supabase SQL Editor
-- Project → SQL Editor → New Query → paste → Run
-- ============================================================

-- Branches table (stores branch names, state, and PINs)
CREATE TABLE IF NOT EXISTS branches (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  pin TEXT NOT NULL,
  state TEXT DEFAULT NULL,         -- Indian state / UT (e.g. 'Delhi (NCT)')
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: add state column if upgrading from an older schema
ALTER TABLE branches ADD COLUMN IF NOT EXISTS state TEXT DEFAULT NULL;

-- Sales entry rows (individual transactions per day)
CREATE TABLE IF NOT EXISTS cashup_entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  product_service TEXT NOT NULL DEFAULT '',
  customer_name TEXT DEFAULT '',
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  payment_type TEXT CHECK (payment_type IN ('cash', 'scan')) NOT NULL DEFAULT 'cash',
  staff TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Daily cashup summary (the calculated/manual fields)
CREATE TABLE IF NOT EXISTS cashup_summaries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  opening_balance DECIMAL(12,2) DEFAULT 0,
  less_scan_override DECIMAL(12,2) DEFAULT NULL,  -- NULL = auto-calc from entries
  less_cash_handover DECIMAL(12,2) DEFAULT 0,
  add_extra DECIMAL(12,2) DEFAULT 0,
  notes TEXT DEFAULT '',
  is_submitted BOOLEAN DEFAULT false,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(branch_id, entry_date)
);

-- Expense rows for each day
CREATE TABLE IF NOT EXISTS cashup_expenses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_entries_branch_date ON cashup_entries(branch_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_summaries_branch_date ON cashup_summaries(branch_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_expenses_branch_date ON cashup_expenses(branch_id, entry_date);

-- Insert the three default branches
-- IMPORTANT: Change PINs after first login!
INSERT INTO branches (name, pin) VALUES
  ('Janakpuri', '0000'),
  ('Kirti Nagar', '0000'),
  ('Dwarka Sec 12', '0000')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- Row Level Security: DISABLED (PIN-based app-level security)
-- Enable if you want Supabase Auth-based access control later
-- ============================================================
ALTER TABLE branches DISABLE ROW LEVEL SECURITY;
ALTER TABLE cashup_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE cashup_summaries DISABLE ROW LEVEL SECURITY;
ALTER TABLE cashup_expenses DISABLE ROW LEVEL SECURITY;
