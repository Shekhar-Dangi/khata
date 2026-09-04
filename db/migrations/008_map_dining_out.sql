-- 008 — map Splitwise's 'Dining out', which 006 could not resolve.
--
-- 006 mapped it to `Food & Dining > Eating out`, the child that db/categories.sql seeds. On
-- a database whose categories were edited, that child may not exist — its `Food & Dining`
-- can hold other children entirely. So the join matched nothing and 006 inserted no row for it.
--
-- That is the failure the join was written to have: a mapping resolved by NAME either finds
-- the right category or finds nothing, and never silently points at the wrong one. It then
-- surfaced exactly as designed — the importer reported 'Dining out' as a category needing a
-- decision, with its amount counted as unclassified rather than quietly absent.
--
-- Worth knowing separately: db/categories.sql and the live database disagree about whether
-- `Eating out` exists. The seed is what a fresh database gets; this one predates it or was
-- edited. Not resolved here, because renaming or creating a category is a decision about the
-- user's own taxonomy, not a migration's business.
--
-- So: prefer the precise child where it exists, fall back to the parent where it does not.
-- The parent is a real category and a defensible home for restaurant spending; it is one
-- UPDATE to redirect once the taxonomy question is settled.
INSERT INTO source_category_map (source_type, source_category, category_id, note)
SELECT 'splitwise', 'Dining out',
       COALESCE(
         (SELECT c.id FROM categories c
           WHERE c.name = 'Eating out'
             AND c.parent_id = (SELECT id FROM categories
                                 WHERE name = 'Food & Dining' AND parent_id IS NULL)),
         (SELECT id FROM categories WHERE name = 'Food & Dining' AND parent_id IS NULL)
       ),
       'prefers Food & Dining > Eating out; falls back to the parent where that child is absent'
ON CONFLICT (source_type, source_category) DO NOTHING;
