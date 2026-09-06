-- Give every alias its own label, so grouping sizes together LOSES NOTHING.
--
-- OWNER DECISION, 2026-09-06: 150 g and 50 g of the same coffee are one product bought in two
-- sizes. That settles the open question the itemisation design raised and left unanswered,
-- and `canonicalName` now strips quantity and pack so the two meet as an exact alias hit rather
-- than as a 93%-similarity guess.
--
-- The obvious objection to that decision is that it destroys information — once "150g pouch"
-- and "50gm pouch" are one item, which did you actually buy? This column is the answer: they
-- are one item with TWO ALIASES, and each alias keeps the string the merchant printed. So
--
--   * categorising happens once, at the product level, which is what the decision was for
--   * "what do I buy" answers at EITHER level -- 8 bags of one coffee, or 6 × 150g and 2 × 50g
--   * un-grouping is re-pointing an alias, not reconstructing a row that was thrown away
--
-- That is what makes automatic grouping safe here when an automatic MERGE would not be: this
-- is a view over variants, not a destruction of them. The design warned that
-- un-merging is harder than merging; keeping the variant row is what removes that asymmetry.

ALTER TABLE item_aliases
  ADD COLUMN IF NOT EXISTS label TEXT;

COMMENT ON COLUMN item_aliases.label IS
  'The merchant''s printed string for THIS variant (size, flavour, pack). The item is the '
  'product; the alias is the thing actually bought. Grouping sizes is therefore lossless.';

-- Fill what we can for rows written before this column existed: the item''s own display name
-- is the best available approximation, and NULL would be indistinguishable from "no label".
UPDATE item_aliases a
   SET label = i.display_name
  FROM items i
 WHERE a.item_id = i.id AND a.label IS NULL;
