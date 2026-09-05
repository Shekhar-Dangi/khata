-- The artifact store: keep the bytes a person uploaded, BEFORE trying to understand them.
--
-- Storing the bytes first is slice 1 of invoice ingestion, for one reason: a
-- parser bug must cost a re-run, never the document. That was tolerable to skip for a
-- Splitwise CSV — re-downloadable in ten seconds — and is not tolerable for an invoice PDF,
-- which Blinkit exposes per order and never in bulk. Lose the file and the order is gone.
--
-- It is also what makes the reconcile gate safe to enforce: rejecting a
-- parse that does not add up is only a sane default if the rejected bytes survive to be
-- parsed again by a better parser.

CREATE TABLE IF NOT EXISTS artifacts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- sha256 of the bytes, lowercase hex. The ARTIFACT-level idempotency layer of
  -- the three: "you already uploaded this exact file". Cheap, needs no parse, and
  -- deliberately NOT the correctness boundary -- the same order downloaded twice can differ
  -- byte-for-byte (a generation timestamp inside the PDF), so it would pass this check and
  -- land twice. `evidence_source_ref_uniq` is the layer that actually prevents duplication.
  content_hash  TEXT NOT NULL,

  -- The bytes themselves, in the database rather than on disk.
  --
  -- The deciding argument is this codebase's own dry_run: POST /evidence/import runs the
  -- WHOLE import and then ROLLS BACK. A file written to the filesystem inside that
  -- transaction does not roll back, so every preview would leak an orphan the database has
  -- no row for. BYTEA participates in the transaction, so an artifact and its parse status
  -- can never disagree. At invoice sizes (~170 KB) and single-user volumes this costs
  -- nothing; revisit at gigabytes, not before.
  bytes         BYTEA NOT NULL,

  -- Stored rather than derived from `length(bytes)` so a listing does not have to read the
  -- blob off TOAST just to show a size.
  byte_size     INTEGER NOT NULL,

  -- SNIFFED FROM THE LEADING BYTES, never from the Content-Type header and never from the
  -- filename. Both are client-controlled: curl defaults to a form content-type, a phone
  -- renames files on the way out, and a PDF called .csv would otherwise pick a parser that
  -- mangles it. The magic number is the file telling you what it is.
  mime          TEXT NOT NULL,

  -- Advisory only, for a person reading a list. Never used to choose a parser.
  original_name TEXT,

  -- What content sniffing decided, or NULL for "nothing recognised it". NULL is a real
  -- answer here, not a missing one: an unrecognised artifact is stored and listed for
  -- review rather than forced through a parser.
  source_type   TEXT,

  -- 'pending'      stored, not yet parsed -- the state it is written in, before any parse
  -- 'parsed'       a parser ran and the record landed
  -- 'unsupported'  we recognise nothing that can read this yet; try again when a parser exists
  -- 'failed'       a parser ran and did not agree with itself (the reconcile gate)
  --
  -- 'unsupported' and 'failed' are separate on purpose. The first is fixed by writing code;
  -- the second is fixed by fixing code. Collapsing them loses the difference between "we
  -- never tried" and "we tried and were wrong", which is exactly what a re-run needs to know.
  parse_status  TEXT NOT NULL DEFAULT 'pending'
                CHECK (parse_status IN ('pending', 'parsed', 'unsupported', 'failed')),

  -- Why it failed, in the parser's own words. Kept so a re-run is a decision rather than a
  -- guess.
  parse_error   TEXT,

  -- The record this artifact produced, once it produced one. Deliberately a loose TEXT
  -- reference and not a foreign key: an artifact can outlive the evidence row it produced
  -- (purge and re-import), and the store's whole job is to survive things going wrong.
  external_ref  TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  parsed_at     TIMESTAMPTZ,

  -- An empty upload is never a real artifact; rejecting it here means no route has to
  -- remember to.
  CONSTRAINT artifacts_byte_size_positive CHECK (byte_size > 0),
  -- sha256 in lowercase hex is exactly 64 characters. A CHECK because a truncated or
  -- upper-cased hash would silently defeat the unique index below -- the same file would
  -- hash to a "different" artifact and land twice.
  CONSTRAINT artifacts_content_hash_sha256 CHECK (content_hash ~ '^[0-9a-f]{64}$')
);

-- Make the duplicate UNREPRESENTABLE rather than something a writer has to remember to
-- check. A dedupe implemented as SELECT-then-INSERT is a race and a lie;
-- ON CONFLICT DO NOTHING against a unique index is neither.
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_content_hash_uniq ON artifacts (content_hash);

-- The two listings this table exists to serve: "what still needs a parser" and "what did
-- this order come from".
CREATE INDEX IF NOT EXISTS artifacts_parse_status_idx ON artifacts (parse_status, created_at DESC);
CREATE INDEX IF NOT EXISTS artifacts_external_ref_idx ON artifacts (external_ref)
  WHERE external_ref IS NOT NULL;
