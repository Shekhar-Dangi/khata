import { Router } from "express";

import { pool } from "./../db.ts";
import { badRequest, intParam, notFound, route, withTransaction } from "./../http.ts";
import { isSpendOnly, parseFilters, parsePaging } from "./../filters.ts";
import { EXPLAINABLE_SPEND } from "./../spend.ts";

const router = Router();
export { router as transactions };

// One slice of a transaction's amount, as the write path receives it.
type Allocation = {
  category_id: string;
  amount_paise: number;
};

// POST /transactions/:id/allocations — REPLACE this transaction's allocations with the body
// (sweep + insert; the body is the full desired set). Semantically a PUT — kept POST for now.
router.post("/transactions/:id/allocations", route(async (req, res) => {
  const txnId = intParam(req.params.id, "transaction id");
  const allocations: Allocation[] = req.body?.allocations;

  // Phase 1 — cheap shape validation (no DB): reject before we ever open a connection.
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return res
      .status(400)
      .json({ error: "`allocations` must be a non-empty array" });
  }
  for (const a of allocations) {
    if (a === null || typeof a !== "object") {
      return res
        .status(400)
        .json({ error: "each allocation must be an object" });
    }
    if (!Number.isInteger(a.amount_paise) || a.amount_paise === 0) {
      return res
        .status(400)
        .json({ error: "amount_paise must be a non-zero integer" });
    }
    if (a.category_id == null) {
      return res.status(400).json({ error: "category_id is required" });
    }
  }
  const newSum = allocations.reduce((s, a) => s + a.amount_paise, 0);

  // Phase 2 — one DB transaction. FOR UPDATE serializes concurrent explains of this txn;
  // delete+insert is atomic, so a failed insert rolls back to the old allocations.
  const result = await withTransaction(async (client) => {

    // Lock + fetch the transaction. 0 rows => it doesn't exist.
    const txnResult = await client.query(
      "SELECT amount_paise FROM transactions WHERE id = $1 FOR UPDATE",
      [txnId],
    );
    if (txnResult.rowCount === 0) {
      throw notFound("no transaction found");
    }
    const txnAmount = Number(txnResult.rows[0].amount_paise);

    // All referenced categories must exist (else the INSERT FK would 500, not 400).
    const categoryIds = allocations.map((a) => a.category_id);
    const catResult = await client.query(
      "SELECT id FROM categories WHERE id = ANY($1)",
      [categoryIds],
    );
    if (catResult.rowCount !== new Set(categoryIds).size) {
      throw badRequest("one or more category_id do not exist");
    }

    // Sign rule: each slice must move money the same direction as the transaction.
    for (const a of allocations) {
      if (Math.sign(a.amount_paise) !== Math.sign(txnAmount)) {
        throw badRequest("allocation sign must match the transaction");
      }
    }

    // Invariant: can't explain more than the transaction is worth.
    if (Math.abs(newSum) > Math.abs(txnAmount)) {
      throw badRequest("allocations exceed the transaction amount");
    }

    // Replace: sweep the old set, insert the new one.
    await client.query("DELETE FROM allocations WHERE transaction_id = $1", [
      txnId,
    ]);
    for (const a of allocations) {
      await client.query(
        `INSERT INTO allocations (transaction_id, amount_paise, category_id, confidence, source)
         VALUES ($1, $2, $3, $4, 'user')`,
        [txnId, a.amount_paise, a.category_id, 1],
      );
    }
    return {
      transaction_id: String(txnId),
      inserted: allocations.length,
      unexplained_paise: txnAmount - newSum,
    };
  });

  return res.status(200).json(result);
}));

// GET /transactions — consolidated ledger: every account's transactions in one view.
router.get("/transactions", route(async (req, res) => {
  // Filtering happens HERE, not in the browser. At 10,000 rows the unfiltered payload is
  // several megabytes, and the client would download and parse all of it before it could
  // hide a single row. Postgres has indexes for this; Array.filter does not.
  const filters = parseFilters(req.query, 1);
  if (!filters.ok) return res.status(400).json({ error: filters.error });
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });

  const spendClause = isSpendOnly(req.query) ? `AND ${EXPLAINABLE_SPEND}` : "";

  // Total BEFORE paging, so the UI can say "showing 100 of 1,432" and size its pager.
  // Same predicate, no grouping — the count is of transactions, not allocation rows.
  const countResult = await pool.query(
    `SELECT COUNT(*) AS total
         FROM transactions t
        WHERE 1=1 ${spendClause} ${filters.sql}`,
    filters.params,
  );

  const result = await pool.query(
    // Lighter than the drill-in: just the explained total per txn (no nested allocations).
    // LEFT JOIN allocations + GROUP BY t.id, a.id (both PKs → other columns are free).
    `SELECT t.id, t.account_id, a.name AS account_name, a.bank,
              t.txn_date, t.txn_time, t.amount_paise, t.type, t.narration,
              t.transfer_status, t.counterparty_account_id, t.bank_balance_paise,
              COALESCE(SUM(al.amount_paise), 0) AS explained_paise,
              -- Split the explained total by provenance so the ledger can show the
              -- three states apart. FILTER is the aggregate-level WHERE: it feeds
              -- only matching rows to THIS sum, without a second pass over the join.
              COALESCE(
                SUM(al.amount_paise) FILTER (WHERE al.source = 'rule'), 0
              ) AS provisional_paise,
              -- Nested slices, so a row in the ledger can be expanded and explained
              -- without a second request. FILTER + COALESCE turns "no children" into an
              -- empty array rather than [null].
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', al.id::text, 'amount_paise', al.amount_paise,
                    'category_id', al.category_id, 'category_name', c.name,
                    'confidence', al.confidence, 'source', al.source
                  ) ORDER BY al.id
                ) FILTER (WHERE al.id IS NOT NULL),
                '[]'
              ) AS allocations
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN allocations al ON al.transaction_id = t.id
         LEFT JOIN categories c ON c.id = al.category_id
        WHERE 1=1 ${spendClause} ${filters.sql}
        GROUP BY t.id, a.id
        -- NEWEST FIRST. It was ascending, which put the pager's "Newer" button on the
        -- side that walks towards older rows and made page 1 of a three-month import the
        -- three months you least wanted to see. Every tiebreak after the date is still
        -- there and still total, so the ordering is a function of the data — a page whose
        -- contents shuffle between identical requests looks exactly like data loss.
        ORDER BY t.txn_date DESC, t.account_id, t.statement_id, t.statement_seq, t.id
        LIMIT $${filters.params.length + 1} OFFSET $${filters.params.length + 2}`,
    [...filters.params, paging.limit, paging.offset],
  );
  const transactions = result.rows.map((r) => {
    const amount = Number(r.amount_paise);
    const explained = Number(r.explained_paise);
    return {
      id: r.id, // BIGINT PK — keep as string
      account_id: Number(r.account_id),
      account_name: r.account_name,
      bank: r.bank,
      txn_date: r.txn_date,
      txn_time: r.txn_time,
      amount_paise: amount,
      type: r.type,
      narration: r.narration,
      transfer_status: r.transfer_status,
      counterparty_account_id: r.counterparty_account_id,
      bank_balance_paise:
        r.bank_balance_paise == null ? null : Number(r.bank_balance_paise),
      explained_paise: explained,
      provisional_paise: Number(r.provisional_paise),
      allocations: r.allocations, // pg parses json_agg into a JS array
      unexplained_paise: amount - explained, // derived
    };
  });
  res.json({
    transactions,
    total: Number(countResult.rows[0].total),
    limit: paging.limit,
    offset: paging.offset,
  });
}));

// GET /transfers — transfers and transfer PROPOSALS, paged BY GROUP.
//
// The unit here is the pair, not the row. A page of legs could split a pair across a
// page boundary and show you one half of a transfer with nothing to confirm it against,
// so the LIMIT is applied to groups and the legs of those groups are fetched second.
//
// A `pending` leg has no partner and therefore no group; it is its own group of one,
// keyed 'txn:<id>' so the client has a single stable key for every row it renders.
//
// ?status= filters to one state. The counts for ALL states come back regardless, so the
// UI can label its tabs without four extra requests.
const TRANSFER_STATUSES = ["pending", "resolved", "suspected", "rejected"];

