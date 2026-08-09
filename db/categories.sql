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
  ('Refunds',          'Income')
) AS child(name, parent_name)
JOIN parents p ON p.name = child.parent_name;
