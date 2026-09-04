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
  -- one". A flag rather than a name checked in code, because a name in code is the
  -- a category named debit lexical trap. See the design.
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
-- See the design.
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
-- 43 of 93 expenses in the verified Splitwise sample were this, so it is not an edge case.
--
-- A SEPARATE slice table rather than a nullable allocations.transaction_id, and the reason is
-- measured: EXPLAINABLE_SPEND is a predicate over transactions and cannot gate allocations,
-- and four of the ~19 queries touching `allocations` never join a transaction, so they would
-- silently start counting non-cash rows with no single place to fix it. The default would be
-- wrong. A category_id on `evidence` fails differently — one evidence row can carry many
-- categories, which is why the design keeps categories out of it.
--
-- The consumption FIGURE is a union of this table and allocations-excluding-shared. That union
-- belongs in ONE module (src/consumption.ts), for the reason src/spend.ts already argues about
-- EXPLAINABLE_SPEND. See the design.
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
  -- per-rule confidence; the design measured that self-reported confidence carries no
  -- information. A model handling the catch-all should ABSTAIN, not record a number.
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX consumption_evidence_idx ON consumption (evidence_id);
CREATE INDEX consumption_consumed_on_idx ON consumption (consumed_on);
