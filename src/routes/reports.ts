import { Router } from "express";

import { pool } from "./../db.ts";
import { route } from "./../http.ts";
import { isSpendOnly, parseFilters } from "./../filters.ts";
import { EXPLAINABLE_SPEND } from "./../spend.ts";

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
              MIN(x.txn_date)                              AS first_seen,
              MAX(x.txn_date)                              AS last_seen
         FROM rules r
         LEFT JOIN categories c ON c.id = r.category_id
         LEFT JOIN (
           SELECT al.id AS allocation_id, al.rule_id, al.amount_paise,
                  al.transaction_id, t.txn_date
             FROM allocations al
             JOIN transactions t ON t.id = al.transaction_id
            WHERE al.source = 'rule' ${spendClause} ${filters.sql}
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

