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
  ('Indian Bank', 'indian_bank'); -- becomes id 2

-- amount_paise is SIGNED paise: rupees * 100, + in / - out. Never rupees, never float.
INSERT INTO transactions
  (account_id, txn_date, amount_paise, type, narration, counterparty_account_id) VALUES
  -- HDFC (account 1)
  (1, '2026-06-01',  4200000, 'opening_balance', 'Opening balance',    NULL),  -- +42,000.00
  (1, '2026-06-03',  -230000, 'regular',         'Amazon',             NULL),  --  -2,300.00
  (1, '2026-06-05',   150000, 'regular',         'Refund',             NULL),  --  +1,500.00
  (1, '2026-06-10', -2000000, 'transfer',        'UPI to self IB',     2),     -- -20,000.00 -> acct 2
  -- Indian Bank (account 2)
  (2, '2026-06-01',   850000, 'opening_balance', 'Opening balance',    NULL),  --  +8,500.00
  (2, '2026-06-10',  2000000, 'transfer',        'UPI from self HDFC', 1);     -- +20,000.00 <- acct 1
