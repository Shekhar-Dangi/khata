-- Starter rules for the mock data (NOT real). Apply AFTER categories.sql:
--   psql -d finance -f db/rules.sql
-- then POST /rules/apply to turn them into provisional allocations.
--
-- Re-runnable: clears rules first. NOTE the CASCADE also removes the allocations those
-- rules produced — correct, since a rule allocation's only justification is its rule.
--
-- Categories are looked up BY NAME rather than by hardcoded id, so this survives
-- categories.sql being regenerated with different identity values.
TRUNCATE rules RESTART IDENTITY CASCADE;

INSERT INTO rules (name, conditions, match_mode, category_id, priority) VALUES

-- Groceries. Every spend rule carries "money out" (amount < 0) so it cannot fire on a
-- refund from the same merchant — that is the difference between "Blinkit" and
-- "money paid to Blinkit".
('Blinkit is groceries',
 '[{"field":"narration","op":"contains","value":"blinkit"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Groceries'), 10),
('Zepto is groceries',
 '[{"field":"narration","op":"contains","value":"zepto"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Groceries'), 10),
('Reliance Smart is groceries',
 '[{"field":"narration","op":"contains","value":"reliance smart"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Groceries'), 10),

-- Food delivery. Two merchants, one category — 'any' would also work here as a single
-- rule, but separate rules make each merchant's impact measurable on its own.
('Swiggy is food delivery',
 '[{"field":"narration","op":"contains","value":"swiggy"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Food delivery'), 10),
('Zomato is food delivery',
 '[{"field":"narration","op":"contains","value":"zomato"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Food delivery'), 10),

-- Transport
('Uber is cabs',
 '[{"field":"narration","op":"contains","value":"uber"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Cabs & Auto'), 10),
('Rapido is cabs',
 '[{"field":"narration","op":"contains","value":"rapido"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Cabs & Auto'), 10),
('HP Petrol is fuel',
 '[{"field":"narration","op":"contains","value":"hp petrol"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Fuel'), 10),

-- Bills. These are the rules most likely to be RIGHT, because a utility payment really
-- is the whole transaction — no basket to itemise.
('Airtel is mobile',
 '[{"field":"narration","op":"contains","value":"airtel"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Mobile & Internet'), 10),
('BESCOM is electricity',
 '[{"field":"narration","op":"contains","value":"bescom"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Electricity & Gas'), 10),
('Netflix is a subscription',
 '[{"field":"narration","op":"contains","value":"netflix"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Subscriptions'), 10),
('Spotify is a subscription',
 '[{"field":"narration","op":"contains","value":"spotify"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Subscriptions'), 10),
('Landlord transfer is rent',
 '[{"field":"narration","op":"contains","value":"landlord"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Rent'), 20),

-- Health
('Apollo is pharmacy',
 '[{"field":"narration","op":"contains","value":"apollo"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Pharmacy'), 10),
('Cult Fit is health',
 '[{"field":"narration","op":"contains","value":"cult fit"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Health'), 10),

-- Shopping. Amazon is the honest example of the rules/evidence boundary: one Amazon
-- order can be groceries AND electronics AND a gift, so the best a NARRATION rule can
-- do is the parent category. Itemised evidence is what would split it properly.
('Amazon is shopping',
 '[{"field":"narration","op":"contains","value":"amazon"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Shopping'), 5),
('Croma is electronics',
 '[{"field":"narration","op":"contains","value":"croma"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Electronics'), 10),
('Decathlon is shopping',
 '[{"field":"narration","op":"contains","value":"decathlon"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Shopping'), 10),

-- Income. Money IN, so these use gt rather than lt.
('Salary credit',
 '[{"field":"narration","op":"contains","value":"salary credit"},{"field":"amount_paise","op":"gt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Salary'), 20),
('Bank interest',
 '[{"field":"narration","op":"contains","value":"interest credit"},{"field":"amount_paise","op":"gt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Interest'), 20),

-- Cash withdrawals are genuinely unexplained until you say what the cash went on.
-- Categorising them as "Miscellaneous" is honest: it records that we know it left the
-- account and nothing more.
('ATM cash withdrawal',
 '[{"field":"narration","op":"contains","value":"atm cash wdl"},{"field":"amount_paise","op":"lt","value":0}]',
 'all', (SELECT id FROM categories WHERE name = 'Miscellaneous'), 10);
