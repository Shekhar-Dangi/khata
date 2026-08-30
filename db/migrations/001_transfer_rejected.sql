-- 001 — a fourth transfer state: 'rejected'.
--
-- Why: detection now proposes pairs from amount+date alone (the design's "suspected"
-- branch, which the first implementation never reached). A proposal the user turns down
-- has to be REMEMBERED, or the next detection run proposes it again — forever. NULL
-- cannot carry that memory: NULL means "never looked at".
--
-- 'rejected' is deliberately NOT excluded from EXPLAINABLE_SPEND. "This is not a
-- transfer" means it IS spend, which is the opposite of hiding it.
--
-- Idempotent: safe to run on a database that already has it.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_transfer_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_transfer_status_check
  CHECK (transfer_status IN ('pending', 'resolved', 'suspected', 'rejected'));

-- Detection pairs legs by (amount, date) across accounts, and confirm/reject act on a
-- whole group. Both are lookups this index serves and the PK does not.
CREATE INDEX IF NOT EXISTS transactions_transfer_group_idx
  ON transactions (transfer_group_id) WHERE transfer_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_pairing_idx
  ON transactions (account_id, txn_date, amount_paise);
