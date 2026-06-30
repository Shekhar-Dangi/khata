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
