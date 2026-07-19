-- Mock transactions for building/navigating the UI (NOT real data).
-- Re-runnable: clears transactions + statements first, keeps the 3 accounts.
-- Wipe before importing real statements:  psql -d finance -f db/seed.sql
TRUNCATE transactions, statements RESTART IDENTITY CASCADE;

-- Signed paise (+in / -out). bank_balance_paise = the bank's stated running balance,
-- so /reconcile has checkpoints. Indian Bank has a deliberate gap -> one anomaly.
INSERT INTO transactions
  (account_id, txn_date, amount_paise, type, narration, counterparty_account_id, bank_balance_paise) VALUES
  -- Salary Account (1) — reconciles cleanly
  (1, '2026-06-01', 10000000, 'opening_balance', 'Opening balance',        NULL, 10000000),
  (1, '2026-06-03',  -230000, 'regular',         'UPI-Debit-Amazon India', NULL,  9770000),
  (1, '2026-06-05',    50000, 'regular',         'Refund - Amazon',        NULL,  9820000),
  (1, '2026-06-08',  -500000, 'transfer',        'UPI to self - Slice',    3,     9320000),
  -- Indian Bank (2) — anomaly: bank shows 15,800 but our ledger says 16,300 (a ~₹500 debit missing)
  (2, '2026-06-01',  2000000, 'opening_balance', 'Opening balance',        NULL,  2000000),
  (2, '2026-06-04',  -220000, 'regular',         'Blinkit - Paytm',        NULL,  1780000),
  (2, '2026-06-07',  -150000, 'regular',         'Swiggy',                 NULL,  1580000),
  -- Slice (3) — receives the internal transfer from HDFC
  (3, '2026-06-01',  1282037, 'opening_balance', 'Opening balance',        NULL,  1282037),
  (3, '2026-06-08',   500000, 'transfer',        'UPI from self - HDFC',   1,     1782037),
  (3, '2026-06-09',  -109900, 'regular',         'UPI-Debit-airtel.pay',   NULL,  1672137),
  (3, '2026-06-11',  -260000, 'regular',         'UPI-Debit-EatClub',      NULL,  1412137);
