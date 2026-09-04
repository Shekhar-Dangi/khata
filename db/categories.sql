-- Starter category tree (two-level hierarchy) for the meaning layer.
-- Apply AFTER schema.sql:  psql -d finance -f db/categories.sql
-- Re-runnable: wipes categories first. NOTE: CASCADE also clears `allocations`
-- (they FK to categories) — fine before real explaining work exists.
-- Categories are user-editable; this is just a sensible starting set.
TRUNCATE categories RESTART IDENTITY CASCADE;

-- One statement: a data-modifying CTE inserts the top-level parents and RETURNS their
-- generated ids; the outer INSERT then adds children, joining each to its parent by name.
WITH parents AS (
  INSERT INTO categories (name) VALUES
    ('Food & Dining'),
    ('Shopping'),
    ('Transport'),
    ('Bills & Utilities'),
    ('Entertainment'),
    ('Health'),
    ('Income'),
    ('Transfers'),
    ('Investments'),
    ('Miscellaneous')
  RETURNING id, name
)
INSERT INTO categories (name, parent_id)
SELECT child.name, p.id
FROM (VALUES
  ('Groceries',        'Food & Dining'),
  ('Eating out',       'Food & Dining'),
  ('Food delivery',    'Food & Dining'),
  ('Household',        'Shopping'),
  ('Electronics',      'Shopping'),
  ('Clothing',         'Shopping'),
  ('Stationery',       'Shopping'),
  ('Fuel',             'Transport'),
  ('Cabs & Auto',      'Transport'),
  ('Public transport', 'Transport'),
  ('Mobile & Internet','Bills & Utilities'),
  ('Electricity & Gas','Bills & Utilities'),
  ('Rent',             'Bills & Utilities'),
  ('Subscriptions',    'Bills & Utilities'),
  ('Pharmacy',         'Health'),
  ('Medical',          'Health'),
  ('Salary',           'Income'),
  ('Interest',         'Income'),
  ('Refunds',          'Income'),
  -- Money that moved between you and a PERSON rather than to a merchant: the part of a bill
  -- you fronted for others, a settlement you receive, a settlement you pay. ONE bucket, not
  -- a pair, because both directions are the same flow; a balance is a different kind of
  -- thing entirely, derived from the records rather than stored as a category.
  ('Shared',           'Transfers')
) AS child(name, parent_name)
JOIN parents p ON p.name = child.parent_name;

-- Neither of these is spending: allocations here are money that moved but was not consumed.
-- The flag is what reports filter on — a partial exclusion (half of a shared bill) cannot be
-- expressed by EXPLAINABLE_SPEND, which is a predicate over whole transactions.
UPDATE categories SET excluded_from_spend = true
 WHERE (name = 'Transfers' AND parent_id IS NULL)
    -- Income is a real inflow and not something consumed. src/consumption.ts checks the
    -- flag on a category OR ITS PARENT, so flagging the parent covers Salary/Interest/
    -- Refunds and anything added under it later.
    OR (name = 'Income' AND parent_id IS NULL)
    OR (name = 'Shared' AND parent_id = (SELECT id FROM categories
                                          WHERE name = 'Transfers' AND parent_id IS NULL));
