-- 005 — the consumption view: category-level spend exclusion, and non-cash consumption.
--
-- Two separate things, in one migration because neither is
-- usable without the other.

-- ---------------------------------------------------------------------------------------
-- Part 1: categories can be excluded from spend.
-- ---------------------------------------------------------------------------------------
--
-- The first design said the shared bucket would be "excluded from spending reports the
-- way transfers are". It cannot be, and finding out why matters more than the fix.
--
-- EXPLAINABLE_SPEND (src/spend.ts) is a predicate over TRANSACTIONS: `type <> 'transfer'`
-- and so on. That works because a transfer is a whole transaction — every paise of it is
-- your own money moving between your own accounts.
--
-- A shared expense is not. You pay 4,000, of which 2,000 is your consumption and 2,000 is
-- other people's share you happened to front. The exclusion is PARTIAL, and no predicate
-- over the transaction row can express "half of this one". It has to happen where the
-- money is already sliced — at the allocation, via its category.
--
-- Hence a flag on the category rather than a name checked in code. Name-matching has a
-- known cost: a category named "debit" matches every narration that says "UPI-Debit", a
-- lexical trap for anything that reads it. A category's spend-ness is a
-- PROPERTY of the category, so it belongs in the row.
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS excluded_from_spend BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN categories.excluded_from_spend IS
  'Allocations in this category are money that moved but was not consumption. Reports that '
  'answer "what did I spend" must filter these out; the ledger still holds them, because '
  'the cash genuinely moved.';

-- `Transfers` has existed as a category since the first seed and nothing has ever read it —
-- transfer exclusion happens at the transaction level, so the category was decorative.
-- It is exactly the thing this flag describes, so say so.
UPDATE categories SET excluded_from_spend = true
 WHERE name = 'Transfers' AND parent_id IS NULL;

-- The shared bucket. ONE category, not a pair, because both directions are the same flow:
-- cash moving between you and a PERSON rather than to a merchant. Splitting it into
-- "owed to me" and "owed by me" would be trying to model a stock (a balance at an instant)
-- with a flow mechanism (a category that accumulates over a period).
--
-- It holds three things, all of them cash that moved and none of them consumption:
--   - the part of a bill you fronted for other people
--   - a settlement you receive
--   - a settlement you pay
--
-- Its running balance is therefore meaningful: after a group settles up, a non-zero balance
-- is exactly the value others bought for you that you settled by cancellation rather than
-- cash. That is a measurement, not drift.
INSERT INTO categories (name, parent_id, excluded_from_spend)
SELECT 'Shared', id, true FROM categories WHERE name = 'Transfers' AND parent_id IS NULL
ON CONFLICT (parent_id, name) DO NOTHING;

-- ---------------------------------------------------------------------------------------
-- Part 2: consumption — burden that never moved through the bank.
-- ---------------------------------------------------------------------------------------
--
-- When someone else pays for your share, you consumed something and no cash left your
-- account. Close to half the expenses in a real export were this. It is not an edge case.
--
-- It gets its own slice table rather than riding `allocations` with a nullable
-- transaction_id, and the reason is measured rather than aesthetic: EXPLAINABLE_SPEND is a
-- predicate over transactions and cannot gate allocations, and four of the ~19 queries that
-- touch `allocations` never join a transaction at all (routes/categories.ts twice,
-- routes/reports.ts, routes/rules.ts). They would silently begin counting non-cash rows,
-- with no single place to fix it and no way for a query written later to know. The DEFAULT
-- would be wrong, which is the worst property a money query can have.
--
-- A category_id on `evidence` was the other candidate and fails differently: one evidence
-- row can carry many categories (a shared online order is one record, several categories).
-- The itemisation design already keeps categories out of evidence for that reason.
CREATE TABLE IF NOT EXISTS consumption (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evidence_id  BIGINT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  category_id  BIGINT NOT NULL REFERENCES categories(id),

  -- Signed, same convention as allocations, even though a positive "consumed" number reads
  -- more naturally. One convention beats two: the consumption figure is a UNION of this
  -- table and allocations, and mixing sign conventions inside a UNION is how a report ends
  -- up subtracting when it meant to add.
  amount_paise BIGINT NOT NULL CHECK (amount_paise <> 0),

  -- The EXPENSE date, not the import date and not any bank date. A settlement often lands
  -- in a different month from the thing it paid for, and a monthly consumption report that
  -- used the settlement date would attribute the burden to the wrong month.
  consumed_on  DATE NOT NULL,

  -- Same provenance vocabulary as allocations, so the override invariant carries over
  -- unchanged: the source's own category lands as 'evidence', a human correction becomes
  -- 'user', and no re-import may overwrite a 'user' row. That invariant is why this column
  -- exists; it is not decoration.
  source       TEXT NOT NULL CHECK (source IN ('evidence', 'user', 'rule')),

  -- NOTE: there is deliberately NO `confidence` column, unlike allocations. The category
  -- comes from a static map of the source's own closed taxonomy — a lookup, not a guess —
  -- so the value would be a constant for every 'evidence' row and meaningless for a 'user'
  -- one. Measurement showed that self-reported confidence carries no
  -- information, and the parked constant-0.8 per-rule confidence is the same disease. If a
  -- model ever classifies the catch-all category, it should ABSTAIN rather than record a
  -- number.
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Read per evidence row when re-deriving after a re-import, and grouped by category and
-- month for the reports. Both are covered adequately by these two.
CREATE INDEX IF NOT EXISTS consumption_evidence_idx ON consumption (evidence_id);
CREATE INDEX IF NOT EXISTS consumption_consumed_on_idx ON consumption (consumed_on);
