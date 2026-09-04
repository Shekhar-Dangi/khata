-- 006 — mapping an external source's category vocabulary onto ours.
--
-- A TABLE and not a constant in TypeScript, because the
-- whole point is that a category we have never seen can be learned without a code change
-- and a deploy. This is the flywheel again — the fourth instance after merchants, people
-- and items — and it has the same shape every time: an unknown string is surfaced with
-- counts, a human decides once, and the decision applies backwards.

CREATE TABLE IF NOT EXISTS source_category_map (
  -- Keyed by source from the start. Splitwise is the only one today, but an invoice
  -- merchant has its own taxonomy and will want this same table; the discriminator costs
  -- nothing now and a rename later is not free.
  source_type     TEXT NOT NULL,
  source_category TEXT NOT NULL,

  -- NULLABLE, and the null carries meaning. There are TWO distinct states here and
  -- collapsing them is the mistake this column exists to avoid:
  --
  --   no row at all      -> never seen. Belongs in the "needs mapping" queue.
  --   row, category NULL -> deliberately unmappable. Do NOT ask again.
  --
  -- The catch-all ('General') is the second kind: it carries no information, so mapping it
  -- anywhere would be a guess. Without the distinction it would sit in the queue forever,
  -- and the owner would either map it wrongly to silence it or learn to ignore the queue.
  -- Both are worse than the honest gap.
  category_id     BIGINT REFERENCES categories(id),

  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_type, source_category)
);

COMMENT ON COLUMN source_category_map.category_id IS
  'NULL means "deliberately unmappable" — a decision already taken. A MISSING ROW means '
  '"not yet seen" and belongs in the review queue. These are different states.';

-- Seed the vocabulary observed in a real Splitwise export. Resolved by name so this does
-- not depend on seed ids, and skipped silently if a category has been renamed — a mapping
-- that quietly points at the wrong category would be worse than a missing one.
INSERT INTO source_category_map (source_type, source_category, category_id, note)
SELECT 'splitwise', m.source_category, c.id, m.note
FROM (VALUES
  -- Unambiguous.
  ('Groceries',          'Groceries',          'Food & Dining',     NULL),
  ('Dining out',         'Eating out',         'Food & Dining',     NULL),
  ('Taxi',               'Cabs & Auto',        'Transport',         NULL),
  ('Electricity',        'Electricity & Gas',  'Bills & Utilities', NULL),
  ('Household supplies', 'Household',          'Shopping',          NULL),
  ('Movies',             'Entertainment',      NULL,                NULL),
  -- Judgement calls, made to keep the import moving. Each is one UPDATE to change.
  ('Car',                'Transport',          NULL,
   'top level rather than Fuel: also covers servicing and insurance'),
  ('Furniture',          'Household',          'Shopping',          NULL),
  ('Cleaning',           'Bills & Utilities',  NULL,
   'a recurring household service, not a purchase'),
  ('Maintenance',        'Bills & Utilities',  NULL,
   'reads as a monthly society/apartment charge'),
  ('Water',              'Bills & Utilities',  NULL,
   'no Water child exists; Electricity & Gas would be wrong'),
  ('Utilities - Other',  'Bills & Utilities',  NULL,                NULL),
  ('Services',           'Miscellaneous',      NULL,
   'too vague to place more precisely')
) AS m(source_category, target, target_parent, note)
JOIN categories c ON c.name = m.target
 AND ((m.target_parent IS NULL AND c.parent_id IS NULL)
   OR (m.target_parent IS NOT NULL
       AND c.parent_id = (SELECT id FROM categories
                           WHERE name = m.target_parent AND parent_id IS NULL)))
ON CONFLICT (source_type, source_category) DO NOTHING;

-- The catch-all, mapped to NULL on purpose: 'General' says nothing, so the only honest
-- answer is that the description is the sole signal — which is where a model would earn its
-- keep, per the discipline of a deterministic core with a model on the
-- tail only. Until then it abstains, and the amount shows as unclassified rather than
-- landing in a category it does not belong to.
INSERT INTO source_category_map (source_type, source_category, category_id, note)
VALUES ('splitwise', 'General', NULL,
        'catch-all: carries no information. Only the description could classify it.')
ON CONFLICT (source_type, source_category) DO NOTHING;

-- 'Payment' is NOT a category mapping. A settle-up is a transfer between people, handled by
-- the parser's row `kind` and allocated to Transfers > Shared. Recorded here as an
-- explicit non-decision so it never appears in the "needs mapping" queue.
INSERT INTO source_category_map (source_type, source_category, category_id, note)
VALUES ('splitwise', 'Payment', NULL,
        'not an expense: a settlement. Handled by row kind, allocated to Transfers > Shared.')
ON CONFLICT (source_type, source_category) DO NOTHING;
