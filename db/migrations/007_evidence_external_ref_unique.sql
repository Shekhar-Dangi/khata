-- 007 — the record-level idempotency boundary for evidence.
--
-- The import design specifies three layers of idempotency and names the enforcement for
-- each. This one was specified and never built:
--
--   artifact  sha256(bytes)                "you already uploaded this exact file"
--   record    (source_type, external_ref)  "this order is already in the ledger"   <- here
--   row       import_hash                  "this transaction line already exists"  (exists)
--
-- The record layer is the one that actually protects against duplication. An artifact hash
-- catches a re-drag of the same bytes, but the same order downloaded twice can differ
-- byte-for-byte (a generation timestamp inside a PDF), pass the hash check, and land twice.
--
-- Enforced by the DATABASE rather than by a SELECT-then-INSERT in the importer, for the
-- reason src/http.ts already gives about the uniqueness race: checking and then inserting
-- is two statements, and two statements are not atomic. ON CONFLICT against a unique index
-- is one.

-- PARTIAL, on `external_ref IS NOT NULL`, and the exclusion is meaningful rather than
-- defensive. Some sources expose no stable id: a Splitwise
-- export has no expense id, and an invoice template may have no order number. A row with a
-- NULL external_ref is saying "this record is not identifiable", and a NULL is exactly the
-- right way to say it — Postgres treats NULLs as distinct in a unique index, so such rows
-- neither collide with each other nor pretend to be deduplicated.
--
-- (A plain UNIQUE constraint would behave identically on NULLs. The partial index is chosen
-- so the intent is stated in the schema instead of relying on the reader knowing that.)
CREATE UNIQUE INDEX IF NOT EXISTS evidence_source_ref_uniq
  ON evidence (source_type, external_ref)
  WHERE external_ref IS NOT NULL;
