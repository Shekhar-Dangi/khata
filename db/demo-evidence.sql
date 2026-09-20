-- Demo content for the screens a statement alone cannot fill.
--
-- db/mock.sql gives the demo a ledger. It cannot give it a product catalogue, invoices on
-- the ledger, an inbox with work in it, or shared expenses, because none of those come from
-- a bank. Without them the Products, Sources and Consumed screens load and sit empty, which
-- reads as broken rather than as new.
--
-- GENERATED and obviously so. Every product is a category of thing rather than a brand,
-- every order id is a DEMO- prefix, and the amounts come from the mock transactions they are
-- attached to. Applied by scripts/seed-demo.ts AFTER mock.sql and demo-unexplained.sql,
-- because the orders here are built around rows those files insert.
--
-- Re-runnable: it truncates what it owns first, so re-seeding does not double anything.

TRUNCATE evidence, artifacts, items RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------------------
-- What the source's own words mean here. Two of these map to nothing ON PURPOSE: a
-- catch-all category carries no information, so any mapping would be a guess, and the
-- honest result is an amount that shows as unclassified.
-- ---------------------------------------------------------------------------------------
INSERT INTO source_category_map (source_type, source_category, category_id, note)
SELECT 'splitwise', v.word, c.id, v.note
  FROM (VALUES
         ('Groceries',  'Groceries',         NULL),
         ('Dining out', 'Eating out',        NULL),
         ('Utilities',  'Electricity & Gas', NULL),
         ('General',    NULL,                'catch-all: carries no information, so it is answered per record')
       ) AS v(word, child, note)
  LEFT JOIN categories c ON c.name = v.child AND c.parent_id IS NOT NULL
ON CONFLICT (source_type, source_category) DO NOTHING;

-- ---------------------------------------------------------------------------------------
-- The product catalogue.
--
-- Four rows are deliberately left unclassified. An item with no category is a VALID state,
-- its amount lands in the computed remainder rather than in a category it does not belong
-- to, and the Products screen's working list is exactly that set. A demo where everything
-- is already filed hides the thing the screen is for.
-- ---------------------------------------------------------------------------------------
INSERT INTO items (canonical_name, display_name, category_id, category_source, category_confidence)
SELECT lower(v.name), v.name, c.id,
       CASE WHEN c.id IS NULL THEN NULL ELSE 'seed' END,
       CASE WHEN c.id IS NULL THEN NULL ELSE 100 END
  FROM (VALUES
         ('Toned Milk 1 L',          'Groceries'),
         ('Brown Bread 400 g',       'Groceries'),
         ('Farm Eggs, 6 pieces',     'Groceries'),
         ('Basmati Rice 5 kg',       'Groceries'),
         ('Toor Dal 1 kg',           'Groceries'),
         ('Atta 5 kg',               'Groceries'),
         ('Sunflower Oil 1 L',       'Groceries'),
         ('Sugar 1 kg',              'Groceries'),
         ('Tea Leaves 250 g',        'Groceries'),
         ('Instant Coffee 100 g',    'Groceries'),
         ('Curd 400 g',              'Groceries'),
         ('Paneer 200 g',            'Groceries'),
         ('Bananas 1 kg',            'Groceries'),
         ('Tomatoes 1 kg',           'Groceries'),
         ('Salted Chips 52 g',       'Groceries'),
         ('Cola Zero 300 ml',        'Groceries'),
         ('Dish Wash Gel 750 ml',    'Household'),
         ('Floor Cleaner 1 L',       'Household'),
         ('Laundry Detergent 2 kg',  'Household'),
         ('Paper Towels, 2 rolls',   'Household'),
         ('Garbage Bags, medium',    'Household'),
         ('Paracetamol 500 mg',      'Pharmacy'),
         ('Vitamin D3 Tablets',      'Pharmacy'),
         ('Antiseptic Liquid 200 ml','Pharmacy'),
         ('Cotton Buds, 100',        NULL),
         ('Steel Scrubber, 3 pack',  NULL),
         ('Face Wash 100 ml',        NULL),
         ('Room Freshener 240 ml',   NULL)
       ) AS v(name, child)
  LEFT JOIN categories c ON c.name = v.child AND c.parent_id IS NOT NULL;

-- Both alias kinds, because both are how a line finds its product: the merchant's id when
-- there is one, and the normalised name when there is not.
INSERT INTO item_aliases (item_id, source_type, alias_kind, alias_value, source, confidence, label)
SELECT i.id, 'blinkit', 'sku', 'DEMO' || lpad(i.id::text, 6, '0'), 'exact', 100, i.display_name
  FROM items i;

INSERT INTO item_aliases (item_id, source_type, alias_kind, alias_value, source, confidence, label)
SELECT i.id, 'blinkit', 'name', i.canonical_name, 'exact', 100, i.display_name
  FROM items i;

-- ---------------------------------------------------------------------------------------
-- Orders that are ON THE LEDGER: an invoice, its lines, the bank row it paid for, and the
-- allocations those lines become.
--
-- Built around real mock transactions rather than invented beside them, so the amounts
-- reconcile: the lines and the delivery fee sum to exactly what left the account. The fee is
-- a line but never an allocation, which is why each of these orders leaves a small honest
-- remainder instead of claiming the whole debit.
-- ---------------------------------------------------------------------------------------
DO $$
DECLARE
  txn          RECORD;
  n            INT := 0;
  ev           BIGINT;
  fee          BIGINT := 2500;          -- a flat delivery charge, in paise
  goods        BIGINT;
  picks        BIGINT[];
  amounts      BIGINT[];
  lines        JSONB;
  line_no      INT;
  item         RECORD;
  catalogue    BIGINT[];
BEGIN
  SELECT array_agg(id ORDER BY id) INTO catalogue FROM items WHERE category_id IS NOT NULL;

  FOR txn IN
    SELECT id, txn_date, amount_paise
      FROM transactions
     WHERE amount_paise < 0 AND narration ILIKE '%BLINKIT%'
     ORDER BY txn_date
     LIMIT 14
  LOOP
    n := n + 1;
    goods := -txn.amount_paise - fee;

    -- Three products per order, rotating through the catalogue so the same things come round
    -- again. That repetition is the whole economic argument for a catalogue, so a demo that
    -- never repeats a product would argue against the feature it is showing.
    picks := ARRAY[
      catalogue[1 + (n * 3) % array_length(catalogue, 1)],
      catalogue[1 + (n * 5 + 1) % array_length(catalogue, 1)],
      catalogue[1 + (n * 7 + 2) % array_length(catalogue, 1)]
    ];
    -- The last line takes the remainder, so rounding can never break the sum.
    amounts := ARRAY[
      (goods * 45 / 100 / 100) * 100,
      (goods * 30 / 100 / 100) * 100,
      goods - (goods * 45 / 100 / 100) * 100 - (goods * 30 / 100 / 100) * 100
    ];

    lines := '[]'::jsonb;
    FOR line_no IN 1..3 LOOP
      SELECT * INTO item FROM items WHERE id = picks[line_no];
      lines := lines || jsonb_build_object(
        'kind', 'goods',
        'invoice_number', 'DEMO-INV-' || lpad(n::text, 4, '0'),
        'description', item.display_name,
        'sku', 'DEMO' || lpad(item.id::text, 6, '0'),
        'hsn', NULL,
        'qty', 1,
        'amount_paise', amounts[line_no]
      );
    END LOOP;
    lines := lines || jsonb_build_object(
      'kind', 'fee',
      'invoice_number', 'DEMO-INV-' || lpad(n::text, 4, '0'),
      'description', 'Delivery and handling',
      'sku', NULL, 'hsn', NULL, 'qty', 1, 'amount_paise', fee
    );

    INSERT INTO evidence (source_type, external_ref, evidence_date, amount_paise, description, payload)
    VALUES (
      'blinkit',
      'DEMO-ORDER-' || lpad(n::text, 4, '0'),
      txn.txn_date,
      txn.amount_paise,                 -- NEGATIVE: an invoice is money leaving
      'blinkit order DEMO-ORDER-' || lpad(n::text, 4, '0'),
      jsonb_build_object(
        'source_type', 'blinkit',
        'external_ref', 'DEMO-ORDER-' || lpad(n::text, 4, '0'),
        'order_date', txn.txn_date,
        'total_paise', -txn.amount_paise,
        'invoices', jsonb_build_array(jsonb_build_object(
          'invoice_number', 'DEMO-INV-' || lpad(n::text, 4, '0'),
          'seller_name', 'Demo Retail Private Limited',
          'invoice_date', txn.txn_date,
          'total_paise', -txn.amount_paise,
          'lines', lines
        )),
        'payment', '[]'::jsonb,
        'warnings', '[]'::jsonb
      )
    )
    RETURNING id INTO ev;

    INSERT INTO evidence_transactions (evidence_id, transaction_id) VALUES (ev, txn.id);

    FOR line_no IN 1..3 LOOP
      INSERT INTO evidence_lines (evidence_id, line_index, item_id, kind, amount_paise)
      VALUES (ev, line_no - 1, picks[line_no], 'goods', amounts[line_no]);
    END LOOP;
    INSERT INTO evidence_lines (evidence_id, line_index, item_id, kind, amount_paise)
    VALUES (ev, 3, NULL, 'fee', fee);

    -- One allocation per CATEGORY, not per line, which is what the real deriver writes. The
    -- sign follows the transaction: writing a positive amount against a debit would say money
    -- came in.
    INSERT INTO allocations (transaction_id, amount_paise, category_id, confidence, source, evidence_id)
    SELECT txn.id, -SUM(l.amount_paise), i.category_id, 1.00, 'evidence', ev
      FROM evidence_lines l
      JOIN items i ON i.id = l.item_id
     WHERE l.evidence_id = ev AND l.kind = 'goods'
     GROUP BY i.category_id;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------
-- The inbox: orders that are PARSED but not on the ledger, waiting for someone to confirm
-- them. `artifacts` is the inbox and `evidence` is the ledger, and nothing crosses without a
-- person, so a demo with an empty inbox cannot show the step that matters most.
--
-- The stored bytes are a stub. Nothing re-reads them here, and shipping a real PDF in a seed
-- file would be shipping someone's invoice.
-- ---------------------------------------------------------------------------------------
INSERT INTO artifacts (content_hash, bytes, byte_size, mime, original_name, source_type,
                       parse_status, external_ref, record, parsed_at)
SELECT
  lpad(to_hex(v.n * 7919), 64, '0'),
  decode('25504446', 'hex'),                        -- "%PDF", enough to be a stub
  4,
  'application/pdf',
  'demo-order-' || lpad(v.n::text, 2, '0') || '.pdf',
  v.source,
  'staged',
  'DEMO-STAGED-' || lpad(v.n::text, 4, '0'),
  jsonb_build_object(
    'source_type', v.source,
    'external_ref', 'DEMO-STAGED-' || lpad(v.n::text, 4, '0'),
    'order_date', v.day,
    'total_paise', v.total,
    'invoices', jsonb_build_array(jsonb_build_object(
      'invoice_number', 'DEMO-INV-S' || lpad(v.n::text, 3, '0'),
      'seller_name', 'Demo Retail Private Limited',
      'invoice_date', v.day,
      'total_paise', v.total,
      'lines', jsonb_build_array(
        jsonb_build_object('kind', 'goods', 'invoice_number', 'DEMO-INV-S' || lpad(v.n::text, 3, '0'),
                           'description', v.first_item, 'sku', v.first_sku, 'hsn', NULL,
                           'qty', 1, 'amount_paise', v.total - v.second_amount - 2500),
        jsonb_build_object('kind', 'goods', 'invoice_number', 'DEMO-INV-S' || lpad(v.n::text, 3, '0'),
                           'description', v.second_item, 'sku', v.second_sku, 'hsn', NULL,
                           'qty', 2, 'amount_paise', v.second_amount),
        jsonb_build_object('kind', 'fee', 'invoice_number', 'DEMO-INV-S' || lpad(v.n::text, 3, '0'),
                           'description', 'Delivery and handling', 'sku', NULL, 'hsn', NULL,
                           'qty', 1, 'amount_paise', 2500)
      )
    )),
    'payment', '[]'::jsonb,
    'warnings', '[]'::jsonb
  ),
  now()
FROM (VALUES
       (1, 'blinkit', DATE '2026-08-24', 128400::bigint, 'Toned Milk 1 L',       'DEMO000001', 'Paneer 200 g',        'DEMO000012', 34000::bigint),
       (2, 'blinkit', DATE '2026-08-26',  96500::bigint, 'Laundry Detergent 2 kg','DEMO000019', 'Floor Cleaner 1 L',  'DEMO000018', 29900::bigint),
       (3, 'amazon',  DATE '2026-08-28', 214900::bigint, 'Vitamin D3 Tablets',   'DEMO000023', 'Antiseptic Liquid 200 ml', 'DEMO000024', 47500::bigint)
     ) AS v(n, source, day, total, first_item, first_sku, second_item, second_sku, second_amount);

-- ---------------------------------------------------------------------------------------
-- Shared expenses: what you consumed without paying for it.
--
-- This is the half of consumption that never touches a bank statement, and it is why "spent"
-- and "consumed" are two different numbers rather than two names for one. The `nets_paise`
-- key is the column name in the export that means you, which is what SPLITWISE_ME tells the
-- app to look for.
-- ---------------------------------------------------------------------------------------
INSERT INTO evidence (source_type, external_ref, evidence_date, amount_paise, description, payload)
SELECT 'splitwise',
       'DEMO-SHARED-' || lpad(v.n::text, 4, '0'),
       v.day,
       -v.share,
       v.what,
       jsonb_build_object(
         'group', 'Flat',
         'kind', 'expense',
         'source_category', v.word,
         'description', v.what,
         'nets_paise', jsonb_build_object('You', -v.share)
       )
  FROM (VALUES
         (1, DATE '2026-07-06', 'Groceries',  'Weekly groceries',      62500::bigint),
         (2, DATE '2026-07-09', 'Utilities',  'Electricity bill',      41200::bigint),
         (3, DATE '2026-07-18', 'Dining out', 'Dinner, four of us',    78000::bigint),
         (4, DATE '2026-07-27', 'General',    'Cleaning help',         50000::bigint),
         (5, DATE '2026-08-04', 'Groceries',  'Weekly groceries',      58800::bigint),
         (6, DATE '2026-08-13', 'Utilities',  'Internet bill',         33000::bigint),
         (7, DATE '2026-08-21', 'Dining out', 'Lunch, three of us',    46500::bigint),
         (8, DATE '2026-08-29', 'General',    'Curtain rods and fitting', 72000::bigint)
       ) AS v(n, day, word, what, share);

-- The consumption itself, filed through the map. Signed like an allocation, because the
-- consumption figure is a UNION of the two and mixing sign conventions inside a UNION is how
-- a report ends up subtracting when it meant to add. Rows whose source word maps to nothing
-- are absent here on purpose: they show up as honestly unclassified.
INSERT INTO consumption (evidence_id, category_id, amount_paise, consumed_on, source)
SELECT ev.id, m.category_id, ev.amount_paise, ev.evidence_date, 'evidence'
  FROM evidence ev
  JOIN source_category_map m
    ON m.source_type = 'splitwise' AND m.source_category = ev.payload->>'source_category'
 WHERE ev.source_type = 'splitwise' AND m.category_id IS NOT NULL;
