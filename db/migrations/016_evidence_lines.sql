-- 016 — which product each confirmed invoice line landed on.
--
-- The link that makes a category retroactive. Setting "Groceries" on a product has to reach
-- every basket that already contains it (re-running is required,
-- not optional), and until now nothing could answer "which orders contain this product?"
-- without re-parsing every stored payload and re-joining it to `item_aliases` on the sku.
--
-- WHY STORE IT WHEN THE PAYLOAD ALREADY HAS IT. This codebase deliberately re-resolves at read
-- time — `listStaged` recomputes every staged line because the catalogue moves between upload
-- and confirm, and a stored preview would describe a catalogue that no longer exists. That
-- argument is about STAGED rows, where the answer is still provisional.
--
-- Confirming is where it stops being provisional. line -> item is then a decision a person
-- either made or accepted, and storing a decision is what `allocations` itself does. Deriving
-- it forever afterwards would mean the answer could silently CHANGE under a row that was
-- already confirmed: re-run the resolver next month, against a catalogue with new aliases, and
-- a line that landed on item A starts reporting item B — with allocations still written for A.
--
-- It also pays for three things that are otherwise expensive or impossible:
--   * "how often was this bought" becomes a COUNT instead of a walk over every payload
--   * "which orders contain this product" becomes answerable at all
--   * re-deriving after a MERGE is a re-point, because item_id carries the FK

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

-- ── backfill ────────────────────────────────────────────────────────────────────────────
--
-- Orders confirmed before this table existed still have their lines in `evidence.payload`, and
-- their resolution is recoverable the same way the catalogue recorded it: `resolveAndRecord`
-- wrote an alias keyed on (source_type, 'sku', the merchant's id), so joining a payload line's
-- sku back to `item_aliases` reproduces exactly the item it landed on.
--
-- A line whose sku matches no alias gets NO row rather than a guess. That is honest — it is a
-- line we cannot attribute — and it is visible: the lines of an order will not sum to its
-- total, which is the same signal the reconcile gate already uses.
INSERT INTO evidence_lines (evidence_id, line_index, item_id, kind, amount_paise)
SELECT e.id,
       (ln.ord - 1)::int AS line_index,
       a.item_id,
       CASE WHEN ln.line->>'kind' = 'fee' THEN 'fee' ELSE 'goods' END,
       COALESCE((ln.line->>'amount_paise')::bigint, 0)
  FROM evidence e
  CROSS JOIN LATERAL (
    SELECT line, row_number() OVER () AS ord
      FROM jsonb_array_elements(e.payload->'invoices') inv
      CROSS JOIN LATERAL jsonb_array_elements(inv->'lines') line
  ) ln
  LEFT JOIN item_aliases a
    ON a.source_type = e.source_type
   AND a.alias_kind  = 'sku'
   AND a.alias_value = ln.line->>'sku'
 WHERE e.payload ? 'invoices'
   -- Goods with no recoverable item are skipped; a fee legitimately has none.
   AND (ln.line->>'kind' = 'fee' OR a.item_id IS NOT NULL)
ON CONFLICT (evidence_id, line_index) DO NOTHING;
