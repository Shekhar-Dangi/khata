-- 010 — a record can be paid by more than one transaction.
--
-- `evidence.transaction_id` is one column, and one column holds one value. So a record could
-- name exactly one bank row. That is fine until a Rs 6,000 expense goes out of the account as
-- Rs 1,000 + Rs 5,000, which is ordinary: a wallet topping up a card, a partial UPI, a bill
-- settled in two goes. The second payment had nowhere to be written.
--
-- WHY A TABLE AND NOT A CLEVERER COLUMN. `allocations` already stores transaction_id and
-- evidence_id together, so the pairing is implied by it and no new table looks necessary.
-- That breaks on a real case: an invoice whose line items we cannot categorise produces NO
-- allocations, so reading the pairing off allocations reports the record as unmatched when it
-- is matched. Matching and allocating are two facts, and the first can exist without the
-- second, so the first needs its own home.
--
-- Keeping the old column as "the main one" alongside the new table was the other option, and
-- is worse than either: the same fact in two places, where every `WHERE transaction_id = ...`
-- is right for ordinary expenses and silently short by Rs 5,000 on split ones. Nothing errors;
-- a number is just quietly wrong.

CREATE TABLE IF NOT EXISTS evidence_transactions (
  evidence_id    BIGINT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The pair IS the identity: linking the same record to the same transaction twice is not a
  -- second fact, it is the same one. A primary key here makes the duplicate unrepresentable
  -- rather than something the writer has to remember to check.
  PRIMARY KEY (evidence_id, transaction_id)
);

-- CASCADE on both sides, and they mean different things. Deleting a record should take its
-- pairings with it — a pairing to a record that no longer exists says nothing. Deleting a
-- transaction is rarer (a re-import correcting a bad row) and the same reasoning applies.
-- Neither cascade reaches `allocations`, which is deliberate: an allocation is money, and it
-- is removed explicitly by code that knows why, never as a side effect.

-- Read from both directions: "what pays for this record" when allocating, and "what explains
-- this transaction" when showing a row in the ledger. The primary key indexes the first;
-- this covers the second.
CREATE INDEX IF NOT EXISTS evidence_transactions_txn_idx
  ON evidence_transactions (transaction_id);

-- Carry across every link the single column already held. Runs before the DROP, so a database
-- that has matched records keeps them; on an empty one it is a no-op.
INSERT INTO evidence_transactions (evidence_id, transaction_id)
SELECT id, transaction_id FROM evidence WHERE transaction_id IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE evidence DROP COLUMN IF EXISTS transaction_id;
