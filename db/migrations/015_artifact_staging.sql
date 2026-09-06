-- The inbox becomes a STAGING area: a parsed order held until a person confirms it.
--
-- Nothing reaches the ledger until someone says so. That needs the
-- parsed record to live somewhere between the upload and the confirmation, and the artifact
-- row is the right home for it — it already holds the bytes the record came from, so the two
-- cannot drift apart or be orphaned from each other.
--
-- The alternative was holding parsed orders in browser memory and posting them back on
-- confirm. That loses three things the owner asked for: the review surviving a page refresh,
-- uploading 200 today and confirming tomorrow, and confirming without re-uploading anything.

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS record JSONB;

COMMENT ON COLUMN artifacts.record IS
  'The parsed OrderRecord, held pending confirmation. NULL once landed is not meaningful — '
  'read parse_status.';

-- 'staged' is a fifth state, and it is genuinely distinct from the four that exist:
--
--   pending      stored, nothing has looked at it
--   staged       PARSED AND RECONCILED, waiting for a person   <- new
--   parsed       landed in the ledger
--   unsupported  no code can read this yet
--   failed       code ran and could not produce a record
--
-- Collapsing 'staged' into 'parsed' would make "waiting for you" indistinguishable from
-- "already in your ledger", which is the one distinction the whole two-phase design exists to
-- make. A constraint cannot be altered in place, so it is dropped and rebuilt — safe here
-- because every existing value remains legal under the new definition.
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_parse_status_check;
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_parse_status_check
  CHECK (parse_status IN ('pending', 'staged', 'parsed', 'unsupported', 'failed'));

-- The review screen's own query: "what is waiting for me", newest first.
CREATE INDEX IF NOT EXISTS artifacts_staged_idx
  ON artifacts (created_at DESC) WHERE parse_status = 'staged';
