-- Structured variant facts on each alias: which size, which pack, which flavour.
--
-- The information was already being parsed and then THROWN AWAY. `canonicalName` matches
-- "750ml" and "PET Bottle" in order to strip them so two pack sizes group as one product;
-- migration 013 kept the printed string as a label, but a label is prose — you cannot filter,
-- sort or total by it, and a person still has to read 200 characters of marketing copy to find
-- out whether they bought the 750 ml or the 300 ml.
--
-- JSONB rather than an attribute table, for the reason the owner gave: "it is hard to guess
-- what might come later". Size and pack are knowable today; flavour and colour are derived
-- from sibling names; whatever a future merchant prints is neither. A closed schema would have
-- to be migrated for each new axis, and this codebase already made exactly this call once --
-- `evidence.payload` is JSONB so a parser can record a shape nobody has designed for yet.
--
-- KNOWN LIMIT, stated rather than discovered: nothing constrains the KEYS, so `flavour` and
-- `flavor` can both exist. The fix is a small registry of known attribute names, and it is not
-- worth building until there are enough attributes for the inconsistency to cost something.
ALTER TABLE item_aliases
  ADD COLUMN IF NOT EXISTS attributes JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN item_aliases.attributes IS
  'What distinguishes THIS variant: {"size":"750 ml","pack":"pet bottle","flavour":"cola"}. '
  'size/pack are extracted deterministically; open-set axes are derived from sibling names.';

-- Supports "every variant that is 750 ml" and "which axes does this product vary on", both of
-- which the Items screen wants and neither of which a text label can answer.
CREATE INDEX IF NOT EXISTS item_aliases_attributes_gin
  ON item_aliases USING gin (attributes jsonb_path_ops);
