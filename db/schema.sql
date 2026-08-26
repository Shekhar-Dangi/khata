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
  transfer_status         TEXT CHECK (transfer_status IN ('pending', 'resolved', 'suspected')),
  transfer_group_id       BIGINT,                            -- shared by the two paired legs
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
  transaction_id BIGINT REFERENCES transactions(id),  -- set once matched (nullable)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Provenance integrity: make illegal states unrepresentable. A rule allocation must name
  -- its rule; an evidence allocation its evidence; a user allocation neither. When a user
  -- edits a rule-made allocation it flips to source='user' (the override invariant).
  CHECK (
    (source = 'rule'     AND rule_id IS NOT NULL AND evidence_id IS NULL) OR
    (source = 'evidence' AND evidence_id IS NOT NULL AND rule_id IS NULL) OR
    (source = 'user'     AND rule_id IS NULL AND evidence_id IS NULL)
  )
);

-- We read allocations per-transaction constantly (to compute the unexplained remainder).
CREATE INDEX allocations_transaction_id_idx ON allocations (transaction_id);
