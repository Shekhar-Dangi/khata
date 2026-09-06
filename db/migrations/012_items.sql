-- The product catalogue: our own stable identity for a thing you buy, and the merchant
-- strings that point at it.
--
-- This is the flywheel's third entity, after merchants and
-- people, and the one with the best economics: a household buys the same few hundred things
-- forever, so classifying "rolled oats" once covers every future basket. The resolver
-- decides HOW a raw line becomes one of these rows.
--
-- MEASURED ON A REAL CORPUS (a few hundred Amazon invoices, 2026-09-06), because the numbers
-- decide the shape:
--
--   the distinct ASINs produced far more distinct printed description strings, and
--   22% of those ASINs appeared under MORE THAN ONE name.
--
-- and the variation is not only rebranding — it is TRUNCATION at different column widths:
--
--   "Example Dairy Pouch Curd, 400 G | B0XXXXXXX1 ( B0XXXXXXX1 )"
--   "Example Dairy Pouch Curd, 400 G | B0XXXXXXX1 ("
--
-- Name-keyed identity would therefore have split a fifth of the products into duplicates, from ONE
-- merchant, with no way to notice. The merchant's own id is exact and free. That is why
-- `item_aliases` is keyed on (source_type, alias_kind, alias_value) rather than on raw text.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS items (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- What a person sees, and what similarity is computed against. Normalised for comparison
  -- (lowercased, merchant noise stripped) — see `canonicalName` in src/items.ts.
  canonical_name TEXT NOT NULL,
  -- The fullest raw string we have seen for this product, kept verbatim. When a merchant
  -- truncates a name differently next week, the longest one we ever saw is still here.
  display_name   TEXT,

  -- NULL means "not classified yet", and that is a VALID state, not a missing value
  -- (never a guess). An unclassified item simply is not allocated, and its
  -- amount lands in the computed remainder — partial itemisation is a first-class outcome.
  category_id    BIGINT REFERENCES categories(id),
  -- Who decided the CATEGORY. 'user' is the override the model may never overwrite; that is
  -- the same invariant `allocations.source` carries and the rules engine calls its most
  -- important one. 'seed' exists so a shipped starter catalogue stays distinguishable from a
  -- person's decisions — without it a seed error is uncorrectable in bulk.
  category_source     TEXT CHECK (category_source IN ('user', 'llm', 'seed', 'hsn')),
  -- 0..100. NOT displayed as a model's self-report: llm-assistance.md measured that a local
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
