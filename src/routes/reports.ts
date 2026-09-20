import { Router } from "express";

import { pool } from "../db.ts";
import { intParam, route } from "../http.ts";
import { isIsoDate, isSpendOnly, parseFilters, parsePaging } from "../filters.ts";
import { EXPLAINABLE_SPEND } from "../spend.ts";
import { CONSUMPTION_ROWS, type ConsumptionTerms, unaccounted } from "../consumption.ts";

const router = Router();
export { router as reports };

// GET /reports/by-category — where the money went, split by how much we trust it.
//
// Two queries on purpose. The first groups allocations by category; the second measures
// what the FIRST one structurally cannot see. Unexplained money has no allocation row —
// it is the remainder left after subtracting them from the transaction — so no
// GROUP BY over allocations can ever produce it. Leaving it out would mean a chart whose
// bars do not sum to what actually left the account, which is exactly the quiet lie this
// project exists to avoid.
//
// No compare_from/compare_to. Month-versus-month is the SAME endpoint called twice with
// different periods, and the ~15 rows are merged in the browser. Server aggregates,
// client arranges: the thing worth avoiding is client-side work over thousands of rows,
// not client-side work over fifteen.
router.get("/reports/by-category", route(async (req, res) => {
  const filters = parseFilters(req.query, 1);
  if (!filters.ok) return res.status(400).json({ error: filters.error });
  // Reports are spend analysis, so this is always on — an opening balance is not
  // spending and neither is moving your own money between your own accounts.
  const where = `WHERE ${EXPLAINABLE_SPEND} ${filters.sql}`;

  const byCategory = await pool.query(
    `SELECT c.id, c.name, c.parent_id, p.name AS parent_name,
              COALESCE(SUM(al.amount_paise) FILTER (WHERE al.source = 'user'), 0)     AS confirmed_paise,
              COALESCE(SUM(al.amount_paise) FILTER (WHERE al.source = 'rule'), 0)     AS provisional_paise,
              COALESCE(SUM(al.amount_paise) FILTER (WHERE al.source = 'evidence'), 0) AS evidence_paise,
              COALESCE(SUM(al.amount_paise), 0)                                       AS total_paise,
              COUNT(DISTINCT al.transaction_id)                                       AS transactions
         FROM allocations al
         JOIN transactions t ON t.id = al.transaction_id
         JOIN categories c ON c.id = al.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
         ${where}
        GROUP BY c.id, p.name
        ORDER BY SUM(ABS(al.amount_paise)) DESC`,
    filters.params,
  );

  // Totals over TRANSACTIONS, not allocations — the denominator has to be what left
  // the account, whether or not anything explains it.
  const totals = await pool.query(
    `WITH per_txn AS (
         SELECT t.id, t.amount_paise,
                COALESCE(SUM(al.amount_paise), 0) AS explained
           FROM transactions t
           LEFT JOIN allocations al ON al.transaction_id = t.id
           ${where}
          GROUP BY t.id
       )
       SELECT COALESCE(SUM(amount_paise) FILTER (WHERE amount_paise < 0), 0) AS out_paise,
              COALESCE(SUM(amount_paise) FILTER (WHERE amount_paise > 0), 0) AS in_paise,
              -- ABS per transaction BEFORE summing: an unexplained 500 debit and an
              -- unexplained 500 credit are 1000 unexplained, not zero.
              COALESCE(SUM(ABS(amount_paise - explained)), 0)                AS unexplained_paise,
              -- Split by direction. The summary tiles compare against "money out", and
              -- mixing an unexplained salary credit into that total makes four numbers
              -- that look like they should reconcile and cannot.
              COALESCE(SUM(ABS(amount_paise - explained))
                       FILTER (WHERE amount_paise < 0), 0)                   AS unexplained_out_paise,
              COALESCE(SUM(ABS(amount_paise - explained))
                       FILTER (WHERE amount_paise > 0), 0)                   AS unexplained_in_paise,
              COUNT(*)                                                        AS transactions
         FROM per_txn`,
    filters.params,
  );

  const t = totals.rows[0];
  res.json({
    categories: byCategory.rows.map((r) => ({
      category_id: Number(r.id),
      category_name: r.name,
      parent_id: r.parent_id === null ? null : Number(r.parent_id),
      parent_name: r.parent_name,
      confirmed_paise: Number(r.confirmed_paise),
      provisional_paise: Number(r.provisional_paise),
      evidence_paise: Number(r.evidence_paise),
      total_paise: Number(r.total_paise),
      transactions: Number(r.transactions),
    })),
    out_paise: Number(t.out_paise),
    in_paise: Number(t.in_paise),
    unexplained_paise: Number(t.unexplained_paise),
    unexplained_out_paise: Number(t.unexplained_out_paise),
    unexplained_in_paise: Number(t.unexplained_in_paise),
    transactions: Number(t.transactions),
  });
}));

// GET /reports/by-rule — every rule with what it actually did.
//
// Answers the questions a bare rule list cannot: is this rule dead, is it too broad,
// and how much money is riding on its guess. Accepts the shared filter vocabulary, so
// "what did my rules do in June" is the same endpoint with from/to.
//
// LEFT JOIN from `rules` on purpose: a rule that matched NOTHING must still appear,
// because zero is the most actionable number here — a typo, or a merchant you stopped
// using. The filters live inside the subquery rather than in a WHERE, since a WHERE on
// the joined table would silently turn the LEFT JOIN back into an inner one and hide
// exactly the rules we most want to see.
router.get("/reports/by-rule", route(async (req, res) => {
  const filters = parseFilters(req.query, 1);
  if (!filters.ok) return res.status(400).json({ error: filters.error });
  const spendClause = isSpendOnly(req.query) ? `AND ${EXPLAINABLE_SPEND}` : "";

  const result = await pool.query(
    `SELECT r.id, r.name, r.conditions, r.match_mode, r.category_id,
              c.name AS category_name, r.priority, r.enabled,
              COUNT(x.allocation_id)                       AS allocations,
              COUNT(DISTINCT x.transaction_id)             AS transactions,
              COALESCE(SUM(ABS(x.amount_paise)), 0)        AS money_paise,
              COALESCE(SUM(x.amount_paise), 0)             AS net_paise,
              -- Split so a rule can say how much of its work is still a guess and how much
              -- you have claimed. Same total, two states — the whole point of the model.
              COUNT(x.allocation_id) FILTER (WHERE x.source = 'rule') AS provisional_allocations,
              COUNT(x.allocation_id) FILTER (WHERE x.source = 'user') AS confirmed_allocations,
              MIN(x.txn_date)                              AS first_seen,
              MAX(x.txn_date)                              AS last_seen
         FROM rules r
         LEFT JOIN categories c ON c.id = r.category_id
         LEFT JOIN (
           -- A rule's impact is everything it EXPLAINED, whether or not you have since
           -- claimed it. Counting only source='rule' made a heavily-confirmed ledger
           -- report every rule as dead: confirming nulls rule_id, so 253 confirmations in
           -- one action took all 20 rules to zero. The work happened; it was just claimed.
           --
           -- COALESCE picks whichever link the row carries — rule_id while the engine owns
           -- it, confirmed_from_rule_id once a human has. The two are mutually exclusive by
           -- CHECK, so no row is ever counted twice.
           SELECT al.id AS allocation_id,
                  COALESCE(al.rule_id, al.confirmed_from_rule_id) AS rule_id,
                  al.source, al.amount_paise, al.transaction_id, t.txn_date
             FROM allocations al
             JOIN transactions t ON t.id = al.transaction_id
            WHERE (al.source = 'rule' OR al.confirmed_from_rule_id IS NOT NULL)
                  ${spendClause} ${filters.sql}
         ) x ON x.rule_id = r.id
        GROUP BY r.id, c.name
        ORDER BY COALESCE(SUM(ABS(x.amount_paise)), 0) DESC, r.id ASC`,
    filters.params,
  );

  const rules = result.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    conditions: r.conditions,
    match_mode: r.match_mode,
    category_id: r.category_id === null ? null : Number(r.category_id),
    category_name: r.category_name,
    priority: Number(r.priority),
    enabled: r.enabled,
    // COUNT returns BIGINT, so these arrive as strings like every other BIGINT.
    allocations: Number(r.allocations),
    transactions: Number(r.transactions),
    provisional_allocations: Number(r.provisional_allocations),
    confirmed_allocations: Number(r.confirmed_allocations),
    money_paise: Number(r.money_paise), // magnitude — "how much did this touch"
    net_paise: Number(r.net_paise), // signed — separates an income rule from a spend one
    first_seen: r.first_seen,
    last_seen: r.last_seen,
  }));
  res.json({ rules });
}));

// GET /summary — the numbers the header strip reports, as SQL aggregates.
// Deliberately an endpoint rather than something the client derives: the alternative
// is shipping the entire ledger to the browser to add up two figures, which stops
// being reasonable the moment real statements land.
//
// `unexplained` counts EXPLAINABLE SPEND only (see EXPLAINABLE_SPEND) — the same
// definition the rules engine uses, so the headline number and the engine can never
// disagree about what they are talking about.
router.get("/summary", route(async (_req, res) => {
  const result = await pool.query(
    `WITH per_txn AS (
         SELECT t.id, t.amount_paise, t.type, t.transfer_status,
                COALESCE(SUM(al.amount_paise), 0) AS explained,
                COALESCE(
                  SUM(al.amount_paise) FILTER (WHERE al.source = 'rule'), 0
                ) AS provisional
           FROM transactions t
           LEFT JOIN allocations al ON al.transaction_id = t.id
          GROUP BY t.id
       )
       SELECT
         (SELECT COALESCE(SUM(amount_paise), 0) FROM transactions) AS net_paise,
         -- ABS per transaction, THEN sum: a ₹500 unexplained debit and a ₹500
         -- unexplained credit are ₹1000 of unexplained money, not zero.
         COALESCE(SUM(ABS(amount_paise - explained))
                  FILTER (WHERE ${EXPLAINABLE_SPEND}), 0) AS unexplained_paise,
         -- Same EXPLAINABLE_SPEND gate as the unexplained figure above. It was missing
         -- here, so a
         -- rule allocation left on an opening balance or a confirmed transfer kept
         -- counting after the engine had stopped considering that row at all — two
         -- tiles on one strip disagreeing about what money is.
         COALESCE(SUM(ABS(provisional))
                  FILTER (WHERE ${EXPLAINABLE_SPEND}), 0) AS provisional_paise
       FROM per_txn`,
  );
  const row = result.rows[0];
  res.json({
    net_paise: Number(row.net_paise),
    unexplained_paise: Number(row.unexplained_paise),
    provisional_paise: Number(row.provisional_paise),
  });
}));


// GET /reports/by-month — the soul metric over TIME.
//
// Every other number in this app is a snapshot, which makes the one question the product
// exists to answer unanswerable: is unexplained money going down? A metric whose entire
// meaning is directional needs a direction.
//
// Same per-transaction CTE as /summary, for the same reason: ABS is taken PER TRANSACTION
// before summing, so an unexplained 500 debit and an unexplained 500 credit are 1000
// unexplained rather than zero. Aggregating first and taking ABS after would net them out
// and report a month with two mistakes in it as a clean one.
//
// Months with no transactions are absent rather than zero-filled. A gap in a bank
// statement is missing data, not a month you spent nothing — and drawing it as zero would
// invent a dip that never happened. The chart joins across gaps; it does not fabricate.
router.get("/reports/by-month", route(async (req, res) => {
  const filters = parseFilters(req.query, 1);
  if (!filters.ok) return res.status(400).json({ error: filters.error });

  const result = await pool.query(
    `WITH per_txn AS (
         SELECT t.id,
                t.txn_date,
                t.amount_paise,
                COALESCE(SUM(al.amount_paise), 0) AS explained,
                COALESCE(SUM(al.amount_paise) FILTER (WHERE al.source = 'rule'), 0) AS provisional,
                COALESCE(SUM(al.amount_paise) FILTER (WHERE al.source = 'user'), 0) AS confirmed
           FROM transactions t
           LEFT JOIN allocations al ON al.transaction_id = t.id
          WHERE ${EXPLAINABLE_SPEND} ${filters.sql}
          GROUP BY t.id
       )
       SELECT to_char(txn_date, 'YYYY-MM')                                  AS month,
              COALESCE(SUM(ABS(amount_paise)) FILTER (WHERE amount_paise < 0), 0) AS out_paise,
              COALESCE(SUM(ABS(provisional)) FILTER (WHERE amount_paise < 0), 0)  AS provisional_paise,
              COALESCE(SUM(ABS(confirmed))   FILTER (WHERE amount_paise < 0), 0)  AS confirmed_paise,
              COALESCE(SUM(ABS(amount_paise - explained))
                       FILTER (WHERE amount_paise < 0), 0)                        AS unexplained_paise,
              COUNT(*) FILTER (WHERE amount_paise < 0)                            AS transactions
         FROM per_txn
        GROUP BY 1
        HAVING COUNT(*) FILTER (WHERE amount_paise < 0) > 0
        ORDER BY 1`,
    filters.params,
  );

  // pg returns BIGINT as a STRING. Every one of these is compared and charted, and
  // "-230000" < "-500000" is true as strings, so they are coerced here once rather than
  // hopefully somewhere in the browser.
  return res.json({
    months: result.rows.map((r) => ({
      month: r.month,
      out_paise: Number(r.out_paise),
      provisional_paise: Number(r.provisional_paise),
      confirmed_paise: Number(r.confirmed_paise),
      unexplained_paise: Number(r.unexplained_paise),
      transactions: Number(r.transactions),
    })),
  });
}));

// What you actually CONSUMED, by category — the second view beside spend, and deliberately a
// sibling of /reports/by-category rather than a replacement.
//
// Spend and consumption answer different questions and are allowed to disagree: a shared
// bill you fronted for three people is all spend and a third of it consumption, while a bill
// a flatmate paid for you is none of the first and all of the second. The GAP between the
// two is the meaningful number, which is why they belong side by side and not merged.
//
// The union itself lives in src/consumption.ts, for the reason src/spend.ts already argues:
// two copies of a definition drift, and then the headline metric and the engine quietly
// disagree about what they are talking about.
router.get("/reports/consumption", route(async (req, res) => {
  // THE PAGE'S FILTERS NOW APPLY (owner, 2026-09-19: "it doesn't seem to be updating with
  // date"). This read all-time regardless, deliberately, because half a filter is worse than
  // none. Both arms carry a date — the bank row's day, and the day the thing was consumed for
  // what a flatmate paid — so the period is applied to both, here and in the SQL together.
  const f = consumptionFilters(req.query);
  if (!f.ok) return res.status(400).json({ error: f.error });
  const params = [f.from, f.to, f.accountId];

  const byCategory = await pool.query(
    `WITH rows AS (${CONSUMPTION_ROWS})
     SELECT c.id, c.name, c.parent_id, p.name AS parent_name,
            COALESCE(SUM(-rows.amount_paise), 0) AS consumed_paise,
            COUNT(*)                             AS entries
       FROM rows
       JOIN categories c ON c.id = rows.category_id
       LEFT JOIN categories p ON p.id = c.parent_id
      WHERE ${ROWS_IN_SCOPE}
      GROUP BY c.id, p.name
      ORDER BY SUM(-rows.amount_paise) DESC`,
    params,
  );

  // The consumption side of the formula, from the SAME rows as the categories above.
  const side = await pool.query(
    `WITH rows AS (${CONSUMPTION_ROWS})
     SELECT COALESCE(SUM(-amount_paise) FILTER (WHERE kind = 'paid_for_you'), 0)         AS paid_for_you,
            COALESCE(SUM(amount_paise)  FILTER (WHERE kind = 'bank' AND amount_paise > 0), 0) AS received,
            COALESCE(SUM(-amount_paise), 0)                                             AS consumed
       FROM rows
      WHERE ${ROWS_IN_SCOPE}`,
    params,
  );

  // The money side: what left your accounts, and the two parts of it that are NOT consumption.
  // Computed per TRANSACTION first, like /summary, so a partly explained debit contributes its
  // unexplained remainder rather than all or nothing. Same EXPLAINABLE_SPEND and the same period
  // and account as the "Money out" tile, so the first line of the formula IS that tile.
  const money = await pool.query(
    `WITH per_txn AS (
         SELECT t.id, t.amount_paise,
                COALESCE(SUM(al.amount_paise), 0) AS explained,
                COALESCE(SUM(al.amount_paise) FILTER (
                  WHERE cat.excluded_from_spend OR COALESCE(par.excluded_from_spend, false)
                ), 0) AS fronted
           FROM transactions t
           LEFT JOIN allocations al ON al.transaction_id = t.id
           LEFT JOIN categories cat ON cat.id = al.category_id
           LEFT JOIN categories par ON par.id = cat.parent_id
          WHERE ${EXPLAINABLE_SPEND} AND t.amount_paise < 0
            AND ($1::date IS NULL OR t.txn_date >= $1::date)
            AND ($2::date IS NULL OR t.txn_date <= $2::date)
            AND ($3::bigint IS NULL OR t.account_id = $3::bigint)
          GROUP BY t.id
       )
     SELECT COALESCE(SUM(-amount_paise), 0)                  AS money_out,
            COALESCE(SUM(ABS(amount_paise - explained)), 0) AS unexplained,
            COALESCE(SUM(-fronted), 0)                      AS fronted
       FROM per_txn`,
    params,
  );

  // Consumption we know happened and cannot categorise: a flatmate paid, and the source
  // category has no mapping yet. Not in the total — said beside it. Not tied to any account,
  // so it is only counted when no account is picked.
  const unclassified = await pool.query(
    `SELECT COALESCE(SUM(ABS((ev.payload->'nets_paise'->>$4)::bigint)), 0) AS paise
       FROM evidence ev
      WHERE ev.source_type = 'splitwise'
        AND ev.payload->>'kind' = 'expense'
        AND (ev.payload->'nets_paise'->>$4)::bigint < 0
        AND (SELECT m.category_id FROM source_category_map m
              WHERE m.source_type = 'splitwise'
                AND m.source_category = ev.payload->>'source_category') IS NULL
        AND ($1::date IS NULL OR ev.evidence_date >= $1::date)
        AND ($2::date IS NULL OR ev.evidence_date <= $2::date)
        AND $3::bigint IS NULL`,
    [...params, process.env.SPLITWISE_ME ?? ""],
  );

  // pg returns BIGINT as a STRING; coerced once here rather than hopefully in the browser.
  const terms: ConsumptionTerms = {
    money_out_paise: Number(money.rows[0].money_out),
    unexplained_paise: Number(money.rows[0].unexplained),
    fronted_paise: Number(money.rows[0].fronted),
    paid_for_you_paise: Number(side.rows[0].paid_for_you),
    received_paise: Number(side.rows[0].received),
    consumed_paise: Number(side.rows[0].consumed),
  };

  return res.json({
    categories: byCategory.rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      parent_id: r.parent_id === null ? null : Number(r.parent_id),
      parent_name: r.parent_name,
      consumed_paise: Number(r.consumed_paise),
      entries: Number(r.entries),
    })),
    terms,
    // Non-zero only if the ledger breaks an invariant the formula relies on. Shown, never
    // rounded away: a formula that "adds up" by fiat is the thing this view exists to replace.
    unaccounted_paise: unaccounted(terms),
    unclassified_paise: Number(unclassified.rows[0].paise),
  });
}));

/**
 * GET /reports/consumption/entries?category_id=&from=&to=&account_id=&limit=&offset=
 *
 * What is inside one category's consumed figure: bank rows AND what a flatmate paid, from the
 * same CONSUMPTION_ROWS the total came from — so the list always adds up to the bar above it.
 */
router.get("/reports/consumption/entries", route(async (req, res) => {
  const f = consumptionFilters(req.query);
  if (!f.ok) return res.status(400).json({ error: f.error });
  const categoryId = intParam(req.query.category_id, "category_id");
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });

  const params = [f.from, f.to, f.accountId, categoryId];
  const rows = await pool.query(
    `WITH rows AS (${CONSUMPTION_ROWS})
     SELECT rows.consumed_on, rows.kind, rows.detail, rows.source, -rows.amount_paise AS consumed_paise,
            acc.name AS account_name, rows.transaction_id, rows.evidence_id,
            COUNT(*) OVER () AS total
       FROM rows
       LEFT JOIN accounts acc ON acc.id = rows.account_id
      WHERE ${ROWS_IN_SCOPE} AND rows.category_id = $4
      ORDER BY rows.consumed_on DESC, rows.transaction_id DESC NULLS LAST, rows.evidence_id DESC
      LIMIT $5 OFFSET $6`,
    [...params, paging.limit, paging.offset],
  );

  return res.json({
    entries: rows.rows.map((r) => ({
      date: r.consumed_on,
      kind: r.kind,
      detail: r.detail,
      source: r.source,
      consumed_paise: Number(r.consumed_paise),
      account_name: r.account_name,
      transaction_id: r.transaction_id === null ? null : String(r.transaction_id),
      evidence_id: r.evidence_id === null ? null : String(r.evidence_id),
    })),
    total: rows.rows.length === 0 ? 0 : Number(rows.rows[0].total),
    limit: paging.limit,
    offset: paging.offset,
  });
}));

/** The rows of CONSUMPTION_ROWS inside the period and account. $1 from, $2 to, $3 account. */
const ROWS_IN_SCOPE = `
  ($1::date IS NULL OR rows.consumed_on >= $1::date)
  AND ($2::date IS NULL OR rows.consumed_on <= $2::date)
  -- What a flatmate paid touched no account of yours, so picking an account leaves it out.
  AND ($3::bigint IS NULL OR rows.account_id = $3::bigint)`;

/**
 * The three filters the Consumed view honours, validated the way `parseFilters` validates them.
 *
 * Not `parseFilters` itself: it writes clauses against `t.txn_date`, and half of consumption —
 * what a flatmate paid — has no bank transaction to hang them on.
 */
function consumptionFilters(
  query: Record<string, unknown>,
):
  | { ok: true; from: string | null; to: string | null; accountId: number | null }
  | { ok: false; error: string } {
  const one = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const from = one(query.from);
  const to = one(query.to);
  if (from !== null && !isIsoDate(from)) return { ok: false, error: "from must be YYYY-MM-DD" };
  if (to !== null && !isIsoDate(to)) return { ok: false, error: "to must be YYYY-MM-DD" };
  if (from !== null && to !== null && from > to) {
    return { ok: false, error: "from must not be after to" };
  }
  const rawAccount = one(query.account_id);
  if (rawAccount !== null && !/^\d+$/.test(rawAccount)) {
    return { ok: false, error: "account_id must be a positive integer" };
  }
  return { ok: true, from, to, accountId: rawAccount === null ? null : Number(rawAccount) };
}
