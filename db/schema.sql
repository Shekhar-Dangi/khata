-- Finance reconciler — schema
-- Apply with:   psql -d finance -f finance/db/schema.sql
-- Inspect with: psql -d finance   then   \d accounts   \d statements   \d transactions

-- accounts: one row per bank account you own.
CREATE TABLE accounts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,            -- your label for it: "Salary Account", "Credit Line"
  bank        TEXT NOT NULL,            -- 'hdfc' | 'indian_bank' | 'slice'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- statements: one row per import (a contiguous slice of a bank statement).
-- Carries the ordering/coverage metadata that can't be reconstructed later.
CREATE TABLE statements (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     BIGINT NOT NULL REFERENCES accounts(id),
  source         TEXT,                  -- filename/label, e.g. "hdfc_jun.xlsx"
  period_start   DATE,                  -- coverage start (from the statement; nullable for now)
  period_end     DATE,                  -- coverage end
  declared_count INT,                   -- bank-stated row count, if available (gap detection)
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- transactions: immutable cash facts. One row = one money movement on one account.
CREATE TABLE transactions (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id              BIGINT NOT NULL REFERENCES accounts(id),
  statement_id            BIGINT REFERENCES statements(id),  -- which import this row came from
  statement_seq           INT,                               -- row position within that statement (parse order)
  txn_date                DATE NOT NULL,                     -- always known
  txn_time                TIME,                              -- known only sometimes
  amount_paise            BIGINT NOT NULL,                   -- signed: +in / -out; paise, never float
  type                    TEXT NOT NULL,                     -- 'opening_balance' | 'transfer' | 'regular'
  narration               TEXT,
  counterparty_raw        TEXT,
  counterparty_account_id BIGINT REFERENCES accounts(id),    -- set when matched to YOUR account
  bank_balance_paise      BIGINT,                            -- bank's stated balance AFTER this row (evidence)
  import_hash             TEXT UNIQUE,                       -- dedup fingerprint
  -- transfer detection (filled in by detect-transfers, not at import):
  transfer_status         TEXT CHECK (transfer_status IN ('pending', 'resolved', 'suspected', 'rejected')),
  transfer_group_id       BIGINT,                            -- shared by the two paired legs
  -- WHY the link was made: 'reference:<rrn>' | 'keyword:<kw>' | 'amount+date' | 'confirmed'.
  -- Detection auto-resolves on a shared UPI reference with no human in the loop, and an
  -- automatic classification nobody can interrogate is not reversible in any useful sense.
  transfer_evidence       TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- account_keywords: identifiers that let us recognize one of your accounts in another
-- account's narration (account numbers, UPI handles, your name). One account has MANY,
-- so it's its own table (one-to-many), not columns on `accounts`.
CREATE TABLE account_keywords (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  keyword     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('account_number', 'upi_handle', 'name')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, keyword)
);

-- Shared id stamped on the two legs of a detected transfer (its own identity, not a txn id).
CREATE SEQUENCE IF NOT EXISTS transfer_group_seq;

-- Transfer detection pairs legs by (account, date, magnitude); confirm/reject then act on
-- a whole group. Neither lookup is served by the primary key.
CREATE INDEX transactions_pairing_idx ON transactions (account_id, txn_date, amount_paise);
CREATE INDEX transactions_transfer_group_idx
  ON transactions (transfer_group_id) WHERE transfer_group_id IS NOT NULL;


-- ============================================================================
-- MEANING LAYER — turning cash facts into explained money.
-- A transaction's "explanation" is its SET of allocations (no explanations table).
-- Meaning lives at the allocation (line-item) grain, not the transaction/merchant.
-- Order matters: categories -> rules -> evidence -> allocations (FK dependencies).
-- ============================================================================

-- categories: the category taxonomy. Self-referential = a hierarchy (Food > Groceries).
-- User-built. parent_id NULL = a top-level category.
CREATE TABLE categories (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   BIGINT REFERENCES categories(id),   -- NULL = top level
  -- Allocations here are money that moved but was NOT consumption. Needed because a shared
  -- expense is a PARTIAL exclusion (2,000 of a 4,000 debit is spend, 2,000 is not), and
  -- EXPLAINABLE_SPEND is a predicate over transactions, which cannot express "half of this
  -- one". A flag rather than a name checked in code, because a name in code is a lexical
  -- trap: a user category that happens to be called "debit" would match every narration
  -- that says "UPI-Debit".
  -- Checked on a category OR ITS PARENT by src/consumption.ts, so flagging a parent covers
  -- its whole subtree. Set on Transfers (own money moving) and Income (a real inflow, but
  -- not something consumed).
  excluded_from_spend BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- No two siblings share a name. NOTE: for top-level rows parent_id IS NULL, and
  -- Postgres treats NULLs as distinct in UNIQUE, so this does NOT stop two top-level
  -- "Food"s. Enforce that in the write path (or a COALESCE unique index) if it matters.
  UNIQUE (parent_id, name)
);

-- rules: user-customizable auto-explanation. Conditions are stored AS DATA (JSONB),
-- not code — so a rule is editable in the UI, and a future query-language would just
-- compile down to this same shape. Action (v1): assign a category.
CREATE TABLE rules (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  -- e.g. [{"field":"narration","op":"contains","value":"blinkit"},
  --       {"field":"amount_paise","op":"lt","value":0}]
  conditions  JSONB NOT NULL,
  match_mode  TEXT NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
  category_id BIGINT REFERENCES categories(id),   -- the action: category to assign
  priority    INT NOT NULL DEFAULT 0,             -- higher wins when rules conflict
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A retried POST after a dropped response would otherwise create a second identical
  -- rule (it happened once in testing). Duplicates are not merely untidy here: two rules
  -- that match the same transaction both compete for it, and the engine's whole claim is
  -- that its output is a function of its inputs.
  UNIQUE (name)
);

-- evidence: normalized external records (Blinkit/Amazon/Splitwise/Uber orders & receipts)
-- that JUSTIFY an allocation's meaning. STUB for now — refine when we build connectors.
-- transaction_id is nullable: evidence can exist BEFORE it's matched to a bank txn.
CREATE TABLE evidence (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_type    TEXT NOT NULL,                   -- 'blinkit' | 'amazon' | 'splitwise' | ...
  external_ref   TEXT,                            -- order/receipt id from the source
  evidence_date  DATE,
  amount_paise   BIGINT,                          -- the external record's amount
  description    TEXT,                            -- merchant / item description
  payload        JSONB,                           -- raw normalized record (line items, etc.)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which bank transactions paid for a record. A TABLE, not a column on `evidence`, because a
-- column holds one value and a Rs 6,000 expense can leave the account as Rs 1,000 + Rs 5,000.
--
-- `allocations` already pairs transaction_id with evidence_id, so this looks redundant -- but
-- an invoice whose line items cannot be categorised produces NO allocations, and reading the
-- pairing off them would then report a matched record as unmatched. Matching and allocating
-- are two facts and the first can exist without the second. See migration 010.
CREATE TABLE evidence_transactions (
  evidence_id    BIGINT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The pair is the identity: linking the same two twice is the same fact, not a second one.
  PRIMARY KEY (evidence_id, transaction_id)
);
-- The primary key serves "what pays for this record"; this serves "what explains this row".
CREATE INDEX evidence_transactions_txn_idx ON evidence_transactions (transaction_id);

-- The RECORD-level idempotency boundary: "this order is already in the
-- ledger". The layer that actually prevents duplication -- an artifact hash catches a re-drag
-- of the same bytes, but the same order downloaded twice can differ byte-for-byte and land
-- twice. Enforced by the database, not a SELECT-then-INSERT, for the reason src/http.ts gives
-- about the uniqueness race.
--
-- PARTIAL on purpose: some sources expose no stable id (a Splitwise export has no expense id).
-- A NULL external_ref says "not identifiable", and NULLs are distinct in a unique index, so
-- such rows neither collide nor pretend to be deduplicated.
CREATE UNIQUE INDEX evidence_source_ref_uniq
  ON evidence (source_type, external_ref)
  WHERE external_ref IS NOT NULL;

-- allocations: the heart. One slice of a transaction's amount, with ONE category and its
-- own confidence + provenance. A transaction has N allocations; the unexplained remainder
-- (txn.amount_paise - SUM(allocations)) is COMPUTED, never stored.
CREATE TABLE allocations (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount_paise   BIGINT NOT NULL CHECK (amount_paise <> 0),  -- signed, same convention as txn
  category_id    BIGINT NOT NULL REFERENCES categories(id),  -- exactly one category per allocation
  confidence     NUMERIC(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- provenance: what produced this allocation, and (for rule/evidence) which one.
  source         TEXT NOT NULL CHECK (source IN ('rule', 'user', 'evidence')),
  rule_id        BIGINT REFERENCES rules(id),
  evidence_id    BIGINT REFERENCES evidence(id),
  -- HISTORY, not ownership. `rule_id` means "a rule owns this row and the engine manages
  -- it"; this means "a rule proposed it and a human accepted it". They are mutually
  -- exclusive: confirming nulls rule_id (the CHECK below demands it) and sets this.
  -- Without it, confirming destroys the link instead of moving it, and /reports/by-rule
  -- reports every rule as dead the moment its guesses are claimed.
  confirmed_from_rule_id BIGINT REFERENCES rules(id),
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Provenance integrity: make illegal states unrepresentable. A rule allocation must name
  -- its rule; an evidence allocation its evidence; a user allocation neither. When a user
  -- edits a rule-made allocation it flips to source='user' (the override invariant).
  CHECK (
    (source = 'rule'     AND rule_id IS NOT NULL AND evidence_id IS NULL) OR
    (source = 'evidence' AND evidence_id IS NOT NULL AND rule_id IS NULL) OR
    (source = 'user'     AND rule_id IS NULL AND evidence_id IS NULL)
  ),
  -- Only a USER row can have been confirmed from a rule: a 'rule' row still owns its rule
  -- through rule_id, and an 'evidence' row was never proposed by one.
  CONSTRAINT allocations_confirmed_from_rule_check
    CHECK (confirmed_from_rule_id IS NULL OR source = 'user')
);

-- We read allocations per-transaction constantly (to compute the unexplained remainder).
CREATE INDEX allocations_transaction_id_idx ON allocations (transaction_id);
-- /reports/by-rule joins on this as well as rule_id, so it needs the same index.
CREATE INDEX allocations_confirmed_from_rule_idx
  ON allocations (confirmed_from_rule_id) WHERE confirmed_from_rule_id IS NOT NULL;

-- connections: a token we hold for an external service, on the user's behalf. Not `.env`,
-- because a token is not configuration — it is obtained at runtime, the other side can
-- revoke it at any moment, and re-connecting must replace it without a redeploy.
-- source_type is UNIQUE so re-connecting UPSERTs instead of accumulating tokens where the
-- newest is only PROBABLY the live one. Stored in plaintext deliberately: the same
-- database already holds the ledger, which is more sensitive than a read-scoped token.
-- See migration 004 for the full reasoning.
CREATE TABLE connections (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_type        TEXT NOT NULL UNIQUE,          -- 'splitwise' | ...
  access_token       TEXT NOT NULL,
  -- Both nullable, honestly: this provider's token lifetime is UNVERIFIED. A wrong
  -- default expiry either refreshes a live token or trusts a dead one.
  refresh_token      TEXT,
  expires_at         TIMESTAMPTZ,
  external_user_id   TEXT,                          -- who the provider says we are
  external_user_name TEXT,                          -- the acceptance test for slice 1
  scope              TEXT,                          -- as RETURNED, not as requested
  connected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- oauth_states: the CSRF nonce, alive for one handshake. The flow spans two unconnected
-- requests (we redirect out; the provider redirects back), and nothing else in this app
-- needs to remember anything between requests — there is no auth, no cookie parser, no
-- session middleware. An in-memory Map loses the state whenever `npm start` restarts
-- mid-handshake and then rejects a legitimate callback with the same error as an attack.
CREATE TABLE oauth_states (
  state       TEXT PRIMARY KEY,                     -- crypto.randomBytes; predictable = no state at all
  source_type TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,                 -- minutes: it only spans one click of "Allow"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Consume the nonce in ONE statement:
--   DELETE FROM oauth_states WHERE state = $1 AND source_type = $2 AND expires_at > now()
--   RETURNING state;
-- rowCount = 0 rejects invalid, expired and already-used alike. A SELECT then a DELETE is
-- the check-then-act race src/http.ts warns about, and it makes a single-use nonce
-- replayable. Unredeemed rows are swept opportunistically when the next handshake starts.
CREATE INDEX oauth_states_expires_idx ON oauth_states (expires_at);

-- consumption: burden that never moved through the bank — someone else paid for your share.
-- In a real Splitwise export a large share of expenses were this, so it is not an edge case.
--
-- A SEPARATE slice table rather than a nullable allocations.transaction_id, and the reason is
-- measured: EXPLAINABLE_SPEND is a predicate over transactions and cannot gate allocations,
-- and four of the ~19 queries touching `allocations` never join a transaction, so they would
-- silently start counting non-cash rows with no single place to fix it. The default would be
-- wrong. A category_id on `evidence` fails differently — one evidence row can carry many
-- categories, which is why the itemisation design keeps categories out of it.
--
-- The consumption FIGURE is a union of this table and allocations-excluding-shared. That union
-- belongs in ONE module (src/consumption.ts), for the reason src/spend.ts already argues about
-- EXPLAINABLE_SPEND.
CREATE TABLE consumption (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evidence_id  BIGINT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  category_id  BIGINT NOT NULL REFERENCES categories(id),
  -- Signed like allocations. One convention beats two: these rows are UNIONed with
  -- allocations, and mixed sign conventions inside a UNION is how a report subtracts.
  amount_paise BIGINT NOT NULL CHECK (amount_paise <> 0),
  -- The EXPENSE date. A settlement often lands in a different month from what it paid for.
  consumed_on  DATE NOT NULL,
  -- Same provenance vocabulary as allocations, so the override invariant carries over: a
  -- 'user' row is never overwritten by a re-import.
  source       TEXT NOT NULL CHECK (source IN ('evidence', 'user', 'rule')),
  -- Deliberately NO `confidence`, unlike allocations: the category comes from a static map of
  -- a closed taxonomy, so it would be a constant. Same disease as the parked constant-0.8
  -- per-rule confidence; measurement showed that self-reported confidence carries no
  -- information. A model handling the catch-all should ABSTAIN, not record a number.
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX consumption_evidence_idx ON consumption (evidence_id);
CREATE INDEX consumption_consumed_on_idx ON consumption (consumed_on);

-- artifacts: the bytes a person uploaded, kept BEFORE anything tries to understand them.
-- Storing the bytes first is slice 1 of invoice ingestion, for one reason: a parser
-- bug must cost a re-run, never the document. A Splitwise CSV is re-downloadable in ten
-- seconds; a Blinkit invoice is exposed per order and never in bulk. See migration 011 for
-- the full reasoning on each column.
CREATE TABLE artifacts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The ARTIFACT layer of the three idempotency layers: "you already uploaded this exact file".
  -- Cheap, needs no parse, and deliberately NOT the correctness boundary.
  content_hash  TEXT NOT NULL,
  -- In the database, not on disk, because POST /evidence/import?dry_run=1 rolls back: a file
  -- written to the filesystem inside that transaction would not, and every preview would leak
  -- an orphan the database has no row for.
  bytes         BYTEA NOT NULL,
  byte_size     INTEGER NOT NULL,
  -- SNIFFED FROM THE LEADING BYTES, never the Content-Type header and never the filename.
  mime          TEXT NOT NULL,
  original_name TEXT,
  -- NULL means nothing recognised it — a real answer, not a missing one.
  source_type   TEXT,
  parse_status  TEXT NOT NULL DEFAULT 'pending'
                CHECK (parse_status IN ('pending', 'staged', 'parsed', 'unsupported', 'failed')),
  parse_error   TEXT,
  -- Loose reference on purpose: an artifact outlives the evidence row it produced.
  external_ref  TEXT,
  -- The parsed OrderRecord, held pending confirmation. NULL once landed is not meaningful
  -- — read parse_status instead. Nothing reaches the ledger until a person confirms it.
  record        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  parsed_at     TIMESTAMPTZ,
  CONSTRAINT artifacts_byte_size_positive CHECK (byte_size > 0),
  CONSTRAINT artifacts_content_hash_sha256 CHECK (content_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX artifacts_content_hash_uniq ON artifacts (content_hash);
CREATE INDEX artifacts_parse_status_idx ON artifacts (parse_status, created_at DESC);
CREATE INDEX artifacts_external_ref_idx ON artifacts (external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX artifacts_staged_idx ON artifacts (created_at DESC) WHERE parse_status = 'staged';

-- ═══════════════════════════════════════════════════════════════════════════════════════
-- What a source's own category vocabulary means here.
--
-- From migration 006, and missing from this file for the same reason 012-016 were: nobody
-- folded it back. The SEEDED ROWS are deliberately not here — a schema declares shape, and the
-- mappings are data the import path and db/categories.sql supply.
-- ═══════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS source_category_map (
  -- Keyed by source from the start. Splitwise is the only one today, but an invoice
  -- merchant has its own taxonomy and will want this same table; the discriminator costs
  -- nothing now and a rename later is not free.
  source_type     TEXT NOT NULL,
  source_category TEXT NOT NULL,

  -- NULLABLE, and the null carries meaning. There are TWO distinct states here and
  -- collapsing them is the mistake this column exists to avoid:
  --
  --   no row at all      -> never seen. Belongs in the "needs mapping" queue.
  --   row, category NULL -> deliberately unmappable. Do NOT ask again.
  --
  -- The catch-all ('General') is the second kind: it carries no information, so mapping it
  -- anywhere would be a guess. Without the distinction it would sit in the queue forever,
  -- and the owner would either map it wrongly to silence it or learn to ignore the queue.
  -- Both are worse than the honest gap.
  category_id     BIGINT REFERENCES categories(id),

  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_type, source_category)
);

COMMENT ON COLUMN source_category_map.category_id IS
  'NULL means "deliberately unmappable" — a decision already taken. A MISSING ROW means '
  '"not yet seen" and belongs in the review queue. These are different states.';

-- Seed the vocabulary observed in a real Splitwise export. Resolved by name so this does
-- not depend on seed ids, and skipped silently if a category has been renamed — a mapping
-- that quietly points at the wrong category would be worse than a missing one.

-- ═══════════════════════════════════════════════════════════════════════════════════════
-- The product catalogue, and what each confirmed invoice line landed on.
--
-- Folded in from migrations 012-016, which had never reached this file: a database built from
-- it lacked the whole catalogue AND rejected `parse_status = 'staged'`, so a fresh install
-- could not import a single receipt. The migrations are how an EXISTING database gets here;
-- this file is what a new one is built from, and the two have to describe the same thing.
-- ═══════════════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS items (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- What a person sees, and what similarity is computed against. Normalised for comparison
  -- (lowercased, merchant noise stripped) — see `canonicalName` in src/items.ts.
  canonical_name TEXT NOT NULL,
  -- The fullest raw string we have seen for this product, kept verbatim. When a merchant
  -- truncates a name differently next week, the longest one we ever saw is still here.
  display_name   TEXT,

  -- NULL means "not classified yet", and that is a VALID state, not a missing value.
  -- An unclassified item simply is not allocated, and its
  -- amount lands in the computed remainder — partial itemisation is a first-class outcome.
  category_id    BIGINT REFERENCES categories(id),
  -- Who decided the CATEGORY. 'user' is the override the model may never overwrite; that is
  -- the same invariant `allocations.source` carries and the rules engine calls its most
  -- important one. 'seed' exists so a shipped starter catalogue stays distinguishable from a
  -- person's decisions — without it a seed error is uncorrectable in bulk.
  category_source     TEXT CHECK (category_source IN ('user', 'llm', 'seed', 'hsn')),
  -- 0..100. NOT displayed as a model's self-report: measurement showed that a local
  -- model returned 0.95 for a correct answer and 0.95 for "Unknown", so a self-reported number
  -- carries no information. This column is for a DERIVED confidence only.
  category_confidence SMALLINT CHECK (category_confidence BETWEEN 0 AND 100),

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT items_canonical_name_not_blank CHECK (btrim(canonical_name) <> ''),
  -- A category without a provenance is unreviewable: nobody can tell whether a person chose it
  -- or a model guessed. Either both are present or neither is.
  CONSTRAINT items_category_has_source
    CHECK ((category_id IS NULL) = (category_source IS NULL))
);

-- Similarity search for merge CANDIDATES. A GIN trigram index,
-- so `similarity(canonical_name, $1)` is an index scan rather than a table scan. This is the
-- whole reason pg_trgm is enabled: candidate generation is a Postgres feature here, not a new
-- dependency or a service.
CREATE INDEX IF NOT EXISTS items_canonical_name_trgm
  ON items USING gin (canonical_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_unclassified_idx
  ON items (updated_at DESC) WHERE category_id IS NULL;

-- The merchant strings that point at an item. THE identity mechanism.
CREATE TABLE IF NOT EXISTS item_aliases (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,

  -- Scoped to the merchant DELIBERATELY, including for name aliases. A cross-merchant name
  -- alias would auto-merge products the corpus proves are different: Blinkit's "Coca-Cola Zero
  -- Sugar Soft Drink(PET Bottle)" (HSN 22029990) and Amazon's "Coca-Cola Zero Sugar ... Can,
  -- 300 Ml" (HSN 22021010) canonicalise alike and are not the same thing — the Government
  -- taxes them differently. Cross-merchant identity is NEVER automatic; it happens only
  -- through an accepted merge proposal, which re-points these rows.
  source_type TEXT NOT NULL,
  -- 'sku'  the merchant's own id — ASIN, UPC/EAN. Exact, stable, free.
  -- 'name'  a canonicalised name, for merchants that expose no id.
  alias_kind  TEXT NOT NULL CHECK (alias_kind IN ('sku', 'name')),
  alias_value TEXT NOT NULL,

  -- How this link was decided. 'exact' is a SKU or a previously-seen name; 'trigram' is a
  -- string-similarity link that is provisional until reviewed; 'user' is a person's decision
  -- and outranks everything; 'llm' is reserved and unused today.
  source      TEXT NOT NULL DEFAULT 'exact'
              CHECK (source IN ('exact', 'trigram', 'user', 'llm')),
  -- 0..100, DERIVED — an exact SKU hit is 100, a trigram link carries its similarity. Unlike
  -- the category confidence above this one is meaningful, because it is computed rather than
  -- reported.
  confidence  SMALLINT NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  -- The merchant's printed string for THIS variant (size, flavour, pack). The item is the
  -- product; the alias is the thing actually bought, so grouping sizes stays lossless.
  label       TEXT,
  -- What distinguishes this variant: {"size":"750 ml","pack":"pet bottle"}. size and pack are
  -- extracted deterministically; open-set axes are derived from sibling names.
  attributes  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The alias IS the identity. One raw string can mean exactly one product, and making the
  -- duplicate unrepresentable is better than asking every future writer to remember
  -- (a dedupe implemented as SELECT-then-INSERT is a race and a lie).
  CONSTRAINT item_aliases_uniq UNIQUE (source_type, alias_kind, alias_value)
);

CREATE INDEX IF NOT EXISTS item_aliases_item_idx ON item_aliases (item_id);

-- Merges a person has not decided yet.
--
-- A proposal, never an action. The asymmetry that drives the whole design: a DUPLICATE item
-- costs a split frequency count and one manual merge, and is visible on the Items page; a
-- WRONG MERGE silently routes every future purchase of both products into one category and is
-- invisible. So the resolver creates rather than merges, and everything uncertain lands here.
CREATE TABLE IF NOT EXISTS item_merge_proposals (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Ordered by the writer so (A,B) and (B,A) are the same row. Without that a pair proposed
  -- from both directions becomes two questions about one decision.
  lo_item_id  BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  hi_item_id  BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  similarity  SMALLINT NOT NULL CHECK (similarity BETWEEN 0 AND 100),
  source      TEXT NOT NULL DEFAULT 'trigram' CHECK (source IN ('trigram', 'llm')),
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ,

  CONSTRAINT item_merge_ordered CHECK (lo_item_id < hi_item_id),
  CONSTRAINT item_merge_uniq UNIQUE (lo_item_id, hi_item_id)
);

CREATE INDEX IF NOT EXISTS item_merge_open_idx
  ON item_merge_proposals (created_at DESC) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS item_aliases_attributes_gin
  ON item_aliases USING gin (attributes jsonb_path_ops);

CREATE TABLE IF NOT EXISTS evidence_lines (
  evidence_id  BIGINT  NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  -- Position within the record's flattened line list, exactly as `listStaged` numbers it and
  -- as an override key names it (`"<artifact_id>:<line_index>"`). One order can be several
  -- invoices, so this counts across all of them rather than restarting per invoice.
  line_index   INT     NOT NULL,

  -- NULL for a fee. A delivery charge is money, not merchandise: it never reaches the
  -- catalogue, and a row pointing at no item is how that is said. It is still stored, because
  -- the fee is part of what the order cost and dropping it would make the lines stop summing.
  item_id      BIGINT  REFERENCES items(id) ON DELETE SET NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('goods', 'fee')),
  amount_paise BIGINT  NOT NULL,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (evidence_id, line_index),
  -- 'goods' must name an item; a fee must not. Without this a line could be goods pointing at
  -- nothing, which allocates nothing and looks identical to an uncategorised product — two
  -- different facts that must not wear the same shape.
  CONSTRAINT evidence_lines_kind_has_item
    CHECK ((kind = 'fee') = (item_id IS NULL))
);

-- The re-derivation lookup: "every order touching this product". Runs on every category edit.
CREATE INDEX IF NOT EXISTS evidence_lines_item_idx ON evidence_lines (item_id);

COMMENT ON TABLE evidence_lines IS
  'Which catalogue item each confirmed invoice line resolved to. The handle that makes a '
  'category retroactive: filing a product re-derives every order containing it.';

-- ---------------------------------------------------------------------------------------
-- The parse queue: reading documents with a local model, durably.
--
-- A hundred invoices at 20-60s each is under an hour of work and nowhere near a request, so
-- it has to outlive the request that asked for it, and it has to outlive the PROCESS: `npm
-- run dev` restarts on every file change, and a restart must cost one document rather than
-- the batch.
--
-- The batch exists so consent has somewhere to live. Nothing runs until `consented_at` is
-- set, which is what makes the estimate showable and declinable.
-- ---------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parse_batches (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('llm_receipt')),
  total        INTEGER NOT NULL CHECK (total > 0),
  consented_at TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parse_jobs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artifact_id  BIGINT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  batch_id     BIGINT NOT NULL REFERENCES parse_batches(id) ON DELETE CASCADE,

  state        TEXT NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued', 'running', 'done', 'failed')),
  -- Incremented when a worker CLAIMS the job, not when it fails. A process killed mid-read
  -- leaves no failure behind to count, and a job that can be reclaimed without cost is a job
  -- that retries forever.
  attempts     INTEGER NOT NULL DEFAULT 0,
  -- The lease. A claim with a heartbeat, so a worker that dies is noticed by its silence.
  claimed_at   TIMESTAMPTZ,

  -- WHY it failed, as a closed vocabulary rather than prose. A worker that reports "failed"
  -- is a worker nobody trusts, and the kind is what decides whether a retry is worth
  -- anything: some are transient and retrying fixes them, some are deterministic and
  -- retrying spends three minutes to be told the same thing.
  error_kind   TEXT,
  error_detail TEXT,

  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT parse_jobs_claim_check
    CHECK ((state = 'running') = (claimed_at IS NOT NULL)),
  CONSTRAINT parse_jobs_finished_check
    CHECK ((state IN ('done', 'failed')) = (finished_at IS NOT NULL))
);

-- One outstanding job per document, enforced rather than remembered: two workers reading the
-- same invoice would spend twice the time to write the same row.
CREATE UNIQUE INDEX IF NOT EXISTS parse_jobs_one_outstanding
  ON parse_jobs (artifact_id) WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS parse_jobs_claimable
  ON parse_jobs (created_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS parse_jobs_leases
  ON parse_jobs (claimed_at) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS parse_jobs_batch_idx ON parse_jobs (batch_id, state);

COMMENT ON TABLE parse_jobs IS
  'One document to read with the model. Durable because the work outlives both the request '
  'that asked for it and the process that runs it.';
