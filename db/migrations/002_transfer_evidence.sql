-- 002 — record WHY a transfer was linked.
--
-- Detection now auto-resolves on a shared UPI reference with no human in the loop, and an
-- automatic classification nobody can interrogate is the thing transfer detection warned
-- about from the start ("record which signals fired... the user can undo a wrong
-- auto-match"). Money silently leaving the spend column needs to be able to say why.
--
-- Free text, not an enum: the value carries the actual signal, e.g.
--   'reference:100000000001'  — both legs quote the same 12-digit RRN
--   'keyword:name@okbank' — the narration names another account of yours
--   'amount+date'             — a proposal, confirmed by the user
-- Cleared whenever a link is cleared, so it can never outlive the claim it justifies.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_evidence TEXT;

-- Backfill. Proposals written before this column existed can only have come from the
-- amount+date pass (the keyword pass needs `account_keywords`, which was empty, and the
-- reference pass did not exist yet), so that is what they are — not an unknown.
-- A link with no recorded reason would render as a bare "linked", which is the exact
-- unexplainable classification this column was added to prevent.
UPDATE transactions
   SET transfer_evidence = 'amount+date'
 WHERE transfer_status = 'suspected' AND transfer_evidence IS NULL;
