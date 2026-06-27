-- Finance reconciler — v1 schema
-- Apply with:   psql -d finance -f finance/db/schema.sql
-- Inspect with: psql -d finance   then   \d accounts   and   \d transactions

-- accounts: one row per bank account you own.
-- (WORKED EXAMPLE — study every line, then write `transactions` yourself below.)
CREATE TABLE accounts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,            -- your label for it: "Salary Account", "Credit Line"
  bank        TEXT NOT NULL,            -- 'hdfc' | 'indian_bank' | 'slice'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- transactions: immutable cash facts. One row = one money movement on one account.
-- YOU write this. Include exactly these columns, and get the decisions right:
--   id                       BIGINT identity PK  (same pattern as accounts)
--   account_id               BIGINT, NOT NULL, FK -> accounts(id)
--   txn_date                 DATE, NOT NULL            (always known)
--   txn_time                 TIME, NULL                (known only sometimes)
--   amount_paise             BIGINT, NOT NULL          (signed: +in / -out; paise, never float)
--   type                     TEXT, NOT NULL            ('opening_balance' | 'transfer' | 'regular')
--   narration                TEXT
--   counterparty_raw         TEXT
--   counterparty_account_id  BIGINT, NULL, FK -> accounts(id)   (set when matched to YOUR account)
--   bank_balance_paise       BIGINT, NULL              (bank's stated balance = evidence, not truth)
--   import_hash              TEXT                      (dedup; we'll refine later)
--   created_at               TIMESTAMPTZ, NOT NULL, DEFAULT now()
--
-- FK syntax reminder (column-level):   account_id BIGINT NOT NULL REFERENCES accounts(id),
--
-- Write your CREATE TABLE transactions ( ... ); below:

CREATE TABLE transactions (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id        BIGINT NOT NULL REFERENCES accounts(id),
  txn_date          DATE NOT NULL,
  txn_time          TIME,
  amount_paise      BIGINT NOT NULL,
  type              TEXT NOT NULL,
  narration         TEXT,
  counterparty_raw  TEXT,
  counterparty_account_id BIGINT REFERENCES accounts(id),
  bank_balance_paise  BIGINT,
  import_hash       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);