-- Finance reconciler — dev seed data
-- Apply AFTER schema.sql:  psql -d finance -f finance/db/seed.sql
-- Re-runnable: it clears existing rows first, so you get identical state every time.

-- Wipe first. TRUNCATE is faster than DELETE for clearing a whole table.
--   RESTART IDENTITY -> resets the id counter so ids are 1,2,... on every run
--                       (so the hard-coded account_id values below stay valid).
--   CASCADE          -> also clears rows that reference these (the FK dependency).
TRUNCATE transactions, accounts RESTART IDENTITY CASCADE;

-- We never insert `id` (GENERATED ALWAYS — the DB assigns it) or `created_at` (DEFAULT now()).
-- We list columns explicitly ON PURPOSE: positional inserts silently break the day the
-- schema changes. Explicit column lists > terse-but-fragile.

INSERT INTO accounts (name, bank) VALUES
  ('Salary Account', 'hdfc'),      -- becomes id 1
  ('Savings Account', 'indian_bank'), -- becomes id 2
  ('Credit Line', 'slice');       -- becomes id 3

-- No seed transactions on purpose: real data now comes via ingestion (ingest/ingest.py),
-- so the DB starts with just the 3 empty accounts.
