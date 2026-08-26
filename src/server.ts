import express, { type ErrorRequestHandler } from "express";
import { createHash } from "node:crypto";

import { pool } from "./db.ts";
import {
  MATCH_MODES,
  OPS_BY_FIELD,
  RULE_FIELDS,
  RULE_OPS,
  decideAllocation,
  isMatchMode,
  isRuleField,
  isRuleOp,
  sameAllocation,
} from "./rules.ts";
import type { ApplicableRule } from "./rules.ts";
import { isSpendOnly, parseFilters, parsePaging } from "./filters.ts";

const PORT = Number(process.env.PORT) || 3000;

const app = express();
// Middleware: parse JSON request bodies into req.body. Replaces our hand-written
// readJSONBody — and it returns 400 automatically if the body is malformed JSON.
app.use(express.json());

// Fingerprint a transaction by its identifying fields, for dedup on re-import.
// Same fields -> same hash, every time (deterministic). Paired with a UNIQUE constraint.
function transactionHash(accountId: number, t: any): string {
  const key = [
    accountId,
    t.txn_date,
    t.txn_time ?? "",
    t.amount_paise,
    t.narration ?? "",
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}

async function accountExists(accountId: number): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM accounts WHERE id = $1", [
    accountId,
  ]);
  return r.rowCount !== 0;
}

async function fetchTransactionsByAccount(accountId: number) {
  const result = await pool.query(
    "SELECT * FROM transactions WHERE account_id = $1 ORDER BY txn_date, statement_id, statement_seq",
    [accountId],
  );
  return result;
}

const ALLOWED_TYPES = ["opening_balance", "transfer", "regular"];
const KEYWORD_KINDS = ["account_number", "upi_handle", "name"];

// What counts as EXPLAINABLE SPEND — the one definition, shared by the rules engine
// and by every number the UI reports. A SQL predicate over `transactions`.
//
//  - `opening_balance` is a ledger seed, not money you spent.
//  - `type = 'transfer'` is how the import classified it; `transfer_status = 'resolved'`
//    is how detection confirmed it. Either way it is your own money moving between your
//    own accounts, so it is neither spend nor income.
//
// Kept in ONE string on purpose. Two copies of a definition drift, and then the headline
// metric and the engine quietly disagree about what "unexplained" means — the same class
// of bug as the duplicated rule vocabulary.
const EXPLAINABLE_SPEND = `type <> 'opening_balance'
   AND type <> 'transfer'
   AND transfer_status IS DISTINCT FROM 'resolved'`;

// ── Rules (auto-explanation) ────────────────────────────────────────────────
// A rule is DATA, not code: a list of {field, op, value} conditions plus the category
// to assign when they match. Validation is deliberately strict HERE, at the write path,
// so the engine that later reads these rows never meets a malformed one.
//
// The vocabulary itself is NOT defined here — it is imported from ./rules.ts, the module
// that interprets it. One source of truth: a word this file accepts is a word the
// matcher is guaranteed (by an exhaustive switch) to handle.

// Returns an error message, or null when the conditions array is well-formed.
function validateConditions(conditions: unknown): string | null {
  if (!Array.isArray(conditions)) return "conditions must be an array";
  // An EMPTY array is rejected ON PURPOSE. Under match_mode 'all' it is vacuously
  // true (same reason [].every() is true), so an empty rule would match every
  // transaction in the ledger and categorise the lot. Refuse to store one.
  if (conditions.length === 0) return "conditions must not be empty";

  for (const [i, c] of conditions.entries()) {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      return `condition ${i}: must be an object`;
    }
    const { field, op, value } = c as Record<string, unknown>;
    // The guards narrow `unknown` to the vocabulary union, so everything below
    // (and the matcher downstream) works with literal types rather than strings.
    if (!isRuleField(field)) {
      return `condition ${i}: field must be one of ${RULE_FIELDS.join(", ")}`;
    }
    if (!isRuleOp(op)) {
      return `condition ${i}: op must be one of ${RULE_OPS.join(", ")}`;
    }
    if (!OPS_BY_FIELD[field].includes(op)) {
      return `condition ${i}: op '${op}' is not valid on field '${field}'`;
    }
    // Exhaustive over RuleField: add a field to the vocabulary and this switch
    // stops compiling until its value contract is written.
    switch (field) {
      case "narration":
        if (typeof value !== "string" || value.trim() === "") {
          return `condition ${i}: value must be a non-empty string`;
        }
        break;
      case "amount_paise":
        // Demand an actual integer, not merely something coercible: Number("") is 0
        // and Number("abc") is NaN — neither throws, both would store a broken rule.
        if (!Number.isInteger(value)) {
          return `condition ${i}: value must be an integer (paise)`;
        }
        break;
      case "txn_date":
        // Same YYYY-MM-DD contract the import path already uses.
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
          return `condition ${i}: value must be a date string (YYYY-MM-DD)`;
        }
        break;
    }
  }
  return null;
}

type Discrepancy = {
  transaction_id: string; // our BIGINT PK — kept as a string to avoid JS precision loss past 2^53
  txn_date: string;
  narration: string;
  expected_paise: number;
  stated_paise: number;
  difference_paise: number;
};

type Allocation = {
  category_id: string;
  amount_paise: number;
};

type Transaction = {
  id: string;
  txn_date: string;
  amount_paise: number;
  type: string;
  narration: string | null;
  bank_balance_paise: number | null;
};

// Health check.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// GET /categories — the category hierarchy (flat list + each row's parent name for display).
// Self-join: categories LEFT JOIN itself on parent_id to resolve the parent's name.
app.get("/categories", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.parent_id, p.name AS parent_name
         FROM categories c
         LEFT JOIN categories p ON p.id = c.parent_id
        ORDER BY COALESCE(p.name, c.name), c.parent_id NULLS FIRST, c.name`,
    );
    const categories = result.rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      parent_id: r.parent_id == null ? null : Number(r.parent_id),
      parent_name: r.parent_name, // null for top-level rows
    }));
    res.json({ categories });
  } catch (error) {
    console.error("categories list failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// GET /accounts — list every account with its computed balance in ONE aggregate query.
// LEFT JOIN (not INNER) so accounts with zero transactions still appear, with balance 0.
// GROUP BY a.id is enough because id is the PK — name/bank are functionally dependent on it.
app.get("/accounts", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.name, a.bank,
              COALESCE(SUM(t.amount_paise), 0) AS balance_paise
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
        GROUP BY a.id
        ORDER BY a.id`,
    );
    const accounts = result.rows.map((r) => ({
      id: Number(r.id), // pg returns BIGINT as a string; account ids are small, safe to Number()
      name: r.name,
      bank: r.bank,
      balance_paise: Number(r.balance_paise),
    }));
    res.json({ accounts });
  } catch (error) {
    console.error("accounts list failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// GET /accounts/:id/balance — compute the account's balance from its transactions.
app.get("/accounts/:id/balance", async (req, res) => {
  const accountId = Number(req.params.id); // Express extracts :id into req.params
  try {
    if (!(await accountExists(accountId))) {
      return res.status(404).json({ error: "account id does not exist" });
    }
  } catch (error) {
    console.error("balance query failed:", error);
    return res.status(500).json({ error: "internal error" });
  }

  try {
    const result = await pool.query(
      "SELECT COALESCE(SUM(amount_paise), 0) AS balance_paise FROM transactions WHERE account_id = $1",
      [accountId],
    );
    res.json({
      account_id: accountId,
      balance_paise: Number(result.rows[0].balance_paise),
    });
  } catch (err) {
    console.error("balance query failed:", err);
    res.status(500).json({ error: "internal error" });
  }
});

// POST /transactions/:id/allocations — REPLACE this transaction's allocations with the body
// (sweep + insert; the body is the full desired set). Semantically a PUT — kept POST for now.
app.post("/transactions/:id/allocations", async (req, res) => {
  const txnId = Number(req.params.id);
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock + fetch the transaction. 0 rows => it doesn't exist.
    const txnResult = await client.query(
      "SELECT amount_paise FROM transactions WHERE id = $1 FOR UPDATE",
      [txnId],
    );
    if (txnResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "no transaction found" });
    }
    const txnAmount = Number(txnResult.rows[0].amount_paise);

    // All referenced categories must exist (else the INSERT FK would 500, not 400).
    const categoryIds = allocations.map((a) => a.category_id);
    const catResult = await client.query(
      "SELECT id FROM categories WHERE id = ANY($1)",
      [categoryIds],
    );
    if (catResult.rowCount !== new Set(categoryIds).size) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "one or more category_id do not exist" });
    }

    // Sign rule: each slice must move money the same direction as the transaction.
    for (const a of allocations) {
      if (Math.sign(a.amount_paise) !== Math.sign(txnAmount)) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "allocation sign must match the transaction" });
      }
    }

    // Invariant: can't explain more than the transaction is worth.
    if (Math.abs(newSum) > Math.abs(txnAmount)) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "allocations exceed the transaction amount" });
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
    await client.query("COMMIT");

    return res.status(200).json({
      transaction_id: String(txnId),
      inserted: allocations.length,
      unexplained_paise: txnAmount - newSum,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("allocation write failed:", error);
    return res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// GET /accounts/:id/transactions — an account's transactions, oldest first (drill-in view).
app.get("/accounts/:id/transactions", async (req, res) => {
  const accountId = Number(req.params.id);
  try {
    if (!(await accountExists(accountId))) {
      return res.status(404).json({ error: "account id does not exist" });
    }
    // Each transaction with its allocations nested (json_agg) + explained total — ONE query,
    // no N+1. LEFT JOIN so txns with zero allocations still appear; the FILTER + COALESCE('[]')
    // turns "no children" into an empty array instead of [null].
    const result = await pool.query(
      `SELECT t.id, t.txn_date, t.txn_time, t.amount_paise, t.type, t.narration,
              t.transfer_status, t.counterparty_account_id, t.bank_balance_paise,
              COALESCE(SUM(al.amount_paise), 0) AS explained_paise,
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
         LEFT JOIN allocations al ON al.transaction_id = t.id
         LEFT JOIN categories c ON c.id = al.category_id
        WHERE t.account_id = $1
        GROUP BY t.id
        ORDER BY t.txn_date, t.statement_id, t.statement_seq`,
      [accountId],
    );
    const transactions = result.rows.map((r) => {
      const amount = Number(r.amount_paise);
      const explained = Number(r.explained_paise);
      return {
        id: r.id, // BIGINT PK — keep as STRING (JS loses precision past 2^53)
        txn_date: r.txn_date,
        txn_time: r.txn_time,
        amount_paise: amount, // safe: one txn won't exceed 2^53 paise
        type: r.type,
        narration: r.narration,
        transfer_status: r.transfer_status,
        counterparty_account_id: r.counterparty_account_id, // BIGINT|null — leave as string|null
        bank_balance_paise:
          r.bank_balance_paise == null ? null : Number(r.bank_balance_paise),
        explained_paise: explained,
        unexplained_paise: amount - explained, // derived, not stored
        allocations: r.allocations, // pg parses json_agg into a JS array
      };
    });
    res.json({ account_id: accountId, transactions });
  } catch (error) {
    console.error("transactions list failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// POST /accounts/:id/transactions — batch import: validated, all-or-nothing, idempotent.
app.post("/accounts/:id/transactions", async (req, res) => {
  const accountId = Number(req.params.id);
  const body = req.body; // already parsed by express.json()

  try {
    if (!(await accountExists(accountId))) {
      return res.status(404).json({ error: "account id does not exist" });
    }
  } catch (error) {
    console.error("transactions query failed:", error);
    return res.status(500).json({ error: "internal error" });
  }

  // Validate the WHOLE batch before touching the DB (all-or-nothing).
  if (!Array.isArray(body?.transactions) || body.transactions.length === 0) {
    res.status(400).json({ error: "`transactions` must be a non-empty array" });
    return;
  }

  const errors: string[] = [];
  body.transactions.forEach((t: any, i: number) => {
    if (t === null || typeof t !== "object") {
      errors.push(`row ${i}: must be an object`);
      return;
    }
    if (!Number.isInteger(t.amount_paise)) {
      errors.push(`row ${i}: amount_paise must be an integer (paise, signed)`);
    } else if (t.amount_paise === 0) {
      errors.push(`row ${i}: amount_paise must not be zero`);
    }
    if (
      typeof t.txn_date !== "string" ||
      Number.isNaN(Date.parse(t.txn_date))
    ) {
      errors.push(
        `row ${i}: txn_date must be a valid date string (YYYY-MM-DD)`,
      );
    }
    if (!ALLOWED_TYPES.includes(t.type)) {
      errors.push(`row ${i}: type must be one of ${ALLOWED_TYPES.join(", ")}`);
    }
    // bank_balance_paise is optional, but if present it must be an integer (paise).
    if (
      t.bank_balance_paise != null &&
      !Number.isInteger(t.bank_balance_paise)
    ) {
      errors.push(
        `row ${i}: bank_balance_paise must be an integer if provided`,
      );
    }
  });
  if (errors.length > 0) {
    res.status(400).json({ errors });
    return;
  }

  // Insert the whole batch in ONE transaction. ON CONFLICT DO NOTHING makes it idempotent.
  const stmt = body.statement ?? {}; // optional import metadata
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Record this import as a statement — carries the ordering/coverage metadata.
    const stmtResult = await client.query(
      `INSERT INTO statements (account_id, source, period_start, period_end, declared_count)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        accountId,
        stmt.source ?? null,
        stmt.period_start ?? null,
        stmt.period_end ?? null,
        stmt.declared_count ?? null,
      ],
    );
    const statementId = stmtResult.rows[0].id;

    let inserted = 0;
    for (const [i, t] of body.transactions.entries()) {
      const result = await client.query(
        `INSERT INTO transactions
           (account_id, statement_id, statement_seq, txn_date, txn_time,
            amount_paise, type, narration, bank_balance_paise, import_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (import_hash) DO NOTHING`,
        [
          accountId,
          statementId,
          i, // statement_seq = row position within this import (parse order)
          t.txn_date,
          t.txn_time ?? null,
          t.amount_paise,
          t.type,
          t.narration ?? null,
          t.bank_balance_paise ?? null,
          transactionHash(accountId, t),
        ],
      );
      if (result.rowCount && result.rowCount > 0) inserted++;
    }
    await client.query("COMMIT");
    res.status(201).json({
      statement_id: statementId,
      inserted,
      skipped: body.transactions.length - inserted,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("import failed:", err);
    res.status(500).json({ error: "import failed" });
  } finally {
    client.release();
  }
});

// Core reconciliation for ONE account: walk ordered txns, compute the running balance,
// compare to the bank's stated balance at each checkpoint (reset to bank per segment).
// Extracted so both /accounts/:id/reconcile and /anomalies reuse it.
async function reconcileAccount(accountId: number) {
  const result = await fetchTransactionsByAccount(accountId);

  // Independent ledger total (sum of amounts) — computed separately so it
  // cross-checks the walk rather than being derived from it.
  const ledgerSum = await pool.query(
    "SELECT COALESCE(SUM(amount_paise), 0) AS total FROM transactions WHERE account_id = $1",
    [accountId],
  );

  // An account whose data starts mid-history has no opening_balance row: we hold a slice
  // of a statement, and money existed in the account before our first transaction. The
  // bank's FIRST stated balance is then the anchor, not evidence of a fault.
  const hasOpeningRow = result.rows.some((t) => t.type === "opening_balance");

  const response = {
    account_id: accountId,
    reconciled: true,
    // `reconciled: true` after zero comparisons is vacuous — the same way [].every() is
    // true. Unverifiable and verified are different claims, so say which one this is.
    verifiable: false,
    // Where the walk started from: an explicit opening_balance row, the bank's first
    // stated balance, or nowhere (no anchor and no checkpoints).
    opening_anchor: hasOpeningRow ? "opening_balance_row" : "none",
    // Money that existed before our earliest row, derived from the bank's first stated
    // balance. Null when an explicit opening row already accounts for it.
    implied_opening_paise: null as number | null,
    checkpoints_checked: 0,
    transactions_considered: result.rowCount,
    ledger_balance_paise: Number(ledgerSum.rows[0].total),
    bank_last_stated_paise: null as number | null,
    total_difference_paise: null as number | null,
    discrepancies: [] as Discrepancy[],
  };

  // Two running totals on purpose:
  //   `computed` is RESET to the bank's figure at every mismatch, so each reported
  //             discrepancy is a new fault rather than the first one echoing forever.
  //   `running`  is never reset, so it stays an honest cumulative sum. Its value at the
  //             LAST checkpoint is the only thing comparable to bank_last_stated_paise.
  let computed = 0;
  let running = 0;
  let runningAtLastCheckpoint = 0;
  let anchored = hasOpeningRow;

  for (const t of result.rows) {
    const amount = Number(t.amount_paise);
    computed += amount;
    running += amount;

    // Only rows carrying the bank's balance are checkpoints we can verify.
    // Guard on the RAW value: Number(null) is 0, which would treat a real 0 as "no checkpoint".
    if (t.bank_balance_paise != null) {
      const stated = Number(t.bank_balance_paise);
      response.checkpoints_checked += 1;
      response.bank_last_stated_paise = stated; // the bank's most recent stated balance

      if (!anchored) {
        // First checkpoint on a mid-history account. The gap here is the balance the
        // account already held, which is a FACT the bank just told us — not a
        // discrepancy. Adopt it as the starting point and verify everything after it.
        const implied = stated - computed;
        response.opening_anchor = "first_stated_balance";
        response.implied_opening_paise = implied;
        computed = stated;
        running += implied; // put the honest sum on the same footing as the bank's
        anchored = true;
        runningAtLastCheckpoint = running;
        continue;
      }

      if (computed !== stated) {
        response.reconciled = false;
        response.discrepancies.push({
          transaction_id: t.id,
          txn_date: t.txn_date,
          narration: t.narration,
          expected_paise: computed,
          stated_paise: stated,
          difference_paise: stated - computed, // per-segment error
        });
        computed = stated; // reset to the bank's truth, then keep walking
      }
      runningAtLastCheckpoint = running;
    }
  }

  response.verifiable = response.checkpoints_checked > 0;

  if (response.bank_last_stated_paise != null) {
    // Compare like with like. The old version subtracted a WHOLE-ACCOUNT sum from a
    // balance that only covers rows up to the last checkpoint, so any transaction after
    // that checkpoint was counted on one side of the subtraction and not the other —
    // and a perfectly healthy account reported a non-zero difference.
    response.total_difference_paise =
      response.bank_last_stated_paise - runningAtLastCheckpoint;
  }

  return response;
}

app.get("/accounts/:id/reconcile", async (req, res) => {
  const accountId = Number(req.params.id);
  try {
    if (!(await accountExists(accountId))) {
      return res.status(404).json({ error: "account does not exist" });
    }
    return res.status(200).json(await reconcileAccount(accountId));
  } catch (error) {
    console.error("error reconciling transactions:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// GET /anomalies — reconcile every account, return only the ones with discrepancies.
app.get("/anomalies", async (_req, res) => {
  try {
    const accts = await pool.query("SELECT id, name FROM accounts ORDER BY id");
    const accounts = [];
    for (const row of accts.rows) {
      const r = await reconcileAccount(Number(row.id));
      // `verifiable` matters here: an account with no stated balances performed zero
      // comparisons, so "not reconciled" was never established. Flagging it as an
      // anomaly would report a fault we have no evidence for.
      if (r.verifiable && !r.reconciled) {
        accounts.push({ account_name: row.name, ...r });
      }
    }
    res.json({ accounts });
  } catch (error) {
    console.error("anomalies failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// GET /transactions — consolidated ledger: every account's transactions in one view.
app.get("/transactions", async (req, res) => {
  // Filtering happens HERE, not in the browser. At 10,000 rows the unfiltered payload is
  // several megabytes, and the client would download and parse all of it before it could
  // hide a single row. Postgres has indexes for this; Array.filter does not.
  const filters = parseFilters(req.query, 1);
  if (!filters.ok) return res.status(400).json({ error: filters.error });
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });

  const spendClause = isSpendOnly(req.query) ? `AND ${EXPLAINABLE_SPEND}` : "";

  try {
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
              ) AS provisional_paise
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN allocations al ON al.transaction_id = t.id
        WHERE 1=1 ${spendClause} ${filters.sql}
        GROUP BY t.id, a.id
        ORDER BY t.txn_date, t.account_id, t.statement_id, t.statement_seq
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
        unexplained_paise: amount - explained, // derived
      };
    });
    res.json({
      transactions,
      total: Number(countResult.rows[0].total),
      limit: paging.limit,
      offset: paging.offset,
    });
  } catch (error) {
    console.error("consolidated transactions failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// GET /transfers — internal transfers (both legs), with counterparty account names.
app.get("/transfers", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.account_id, a.name AS account_name,
              t.txn_date, t.amount_paise, t.narration, t.type,
              t.transfer_status, t.transfer_group_id,
              t.counterparty_account_id, ca.name AS counterparty_name
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN accounts ca ON ca.id = t.counterparty_account_id
        WHERE t.transfer_status IS NOT NULL
           OR t.counterparty_account_id IS NOT NULL
           OR t.type = 'transfer'
        ORDER BY t.transfer_group_id NULLS LAST, t.txn_date, t.account_id`,
    );
    const transfers = result.rows.map((r) => ({
      id: r.id,
      account_id: Number(r.account_id),
      account_name: r.account_name,
      txn_date: r.txn_date,
      amount_paise: Number(r.amount_paise),
      narration: r.narration,
      type: r.type,
      transfer_status: r.transfer_status,
      transfer_group_id: r.transfer_group_id,
      counterparty_account_id: r.counterparty_account_id,
      counterparty_name: r.counterparty_name,
    }));
    res.json({ transfers });
  } catch (error) {
    console.error("transfers failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// POST /accounts/:id/keywords — register an identifier used to recognize this account
// in another account's narration (account number, UPI handle, or name).
app.post("/accounts/:id/keywords", async (req, res) => {
  const accountId = Number(req.params.id);
  const { keyword, kind } = req.body ?? {};

  try {
    if (!(await accountExists(accountId))) {
      return res.status(404).json({ error: "account id does not exist" });
    }
  } catch (error) {
    console.error("keyword insert failed:", error);
    return res.status(500).json({ error: "internal error" });
  }

  // Validate before touching the DB — clear 400s instead of a raw constraint error.
  if (typeof keyword !== "string" || keyword.trim() === "") {
    return res
      .status(400)
      .json({ error: "keyword must be a non-empty string" });
  }
  if (!KEYWORD_KINDS.includes(kind)) {
    return res
      .status(400)
      .json({ error: `kind must be one of ${KEYWORD_KINDS.join(", ")}` });
  }

  try {
    const result = await pool.query(
      `INSERT INTO account_keywords (account_id, keyword, kind)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id, keyword) DO NOTHING
       RETURNING id`,
      [accountId, keyword.trim(), kind],
    );
    if (result.rowCount === 0) {
      return res.status(200).json({ status: "already exists" });
    }
    return res.status(201).json({ id: result.rows[0].id });
  } catch (error) {
    console.error("keyword insert failed:", error);
    return res.status(500).json({ error: "internal error" });
  }
});

// GET /accounts/:id/keywords — list an account's registered identifiers.
app.get("/accounts/:id/keywords", async (req, res) => {
  const accountId = Number(req.params.id);
  try {
    if (!(await accountExists(accountId))) {
      return res.status(404).json({ error: "account id does not exist" });
    }
    const result = await pool.query(
      "SELECT id, keyword, kind FROM account_keywords WHERE account_id = $1 ORDER BY id",
      [accountId],
    );
    res.json({ account_id: accountId, keywords: result.rows });
  } catch (error) {
    console.error("keyword fetch failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// POST /accounts/:id/detect-transfers — find internal transfers FROM this account's legs
// to your other accounts. Idempotent and re-runnable (only non-resolved legs are touched).
app.post("/accounts/:id/detect-transfers", async (req, res) => {
  const accountId = Number(req.params.id);

  try {
    if (!(await accountExists(accountId))) {
      return res.status(404).json({ error: "account id does not exist" });
    }
  } catch (error) {
    console.error("detect-transfers failed:", error);
    return res.status(500).json({ error: "internal error" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // This account's candidate legs (anything not already resolved, with a narration to scan).
    // IS DISTINCT FROM handles NULL correctly: null/pending/suspected are all re-evaluated.
    const legs = (
      await client.query(
        `SELECT id, amount_paise, txn_date, narration
           FROM transactions
          WHERE account_id = $1 AND narration IS NOT NULL
            AND transfer_status IS DISTINCT FROM 'resolved'`,
        [accountId],
      )
    ).rows;

    // STRONG identifiers of your OTHER accounts (account number / UPI handle), lowercased
    // once so the narration scan is a cheap case-insensitive substring check.
    const keywords = (
      await client.query(
        `SELECT account_id, lower(keyword) AS keyword
           FROM account_keywords
          WHERE account_id <> $1 AND kind IN ('account_number', 'upi_handle')`,
        [accountId],
      )
    ).rows;

    let resolved = 0;
    let pending = 0;
    let suspected = 0;

    for (const leg of legs) {
      const narration = String(leg.narration).toLowerCase();
      // Which other account does this leg strongly identify? (first strong keyword found)
      const match = keywords.find((k) => narration.includes(k.keyword));
      if (!match) continue; // v1: act only on legs with a strong identifier (high precision)

      const counterpartyId = match.account_id;

      // Same-day, opposite-sign, equal-magnitude partner in that account, not already resolved.
      const partners = (
        await client.query(
          `SELECT id FROM transactions
            WHERE account_id = $1 AND txn_date = $2 AND amount_paise = $3
              AND transfer_status IS DISTINCT FROM 'resolved'`,
          [counterpartyId, leg.txn_date, -Number(leg.amount_paise)],
        )
      ).rows;

      if (partners.length === 1) {
        // Confident pair → resolve BOTH legs together with a shared group id.
        const groupId = (
          await client.query("SELECT nextval('transfer_group_seq') AS g")
        ).rows[0].g;
        await client.query(
          `UPDATE transactions SET transfer_status = 'resolved',
             transfer_group_id = $1, counterparty_account_id = $2 WHERE id = $3`,
          [groupId, counterpartyId, leg.id],
        );
        await client.query(
          `UPDATE transactions SET transfer_status = 'resolved',
             transfer_group_id = $1, counterparty_account_id = $2 WHERE id = $3`,
          [groupId, accountId, partners[0].id],
        );
        resolved++;
      } else if (partners.length === 0) {
        // Strong identifier but no partner yet (other sheet not imported) → pending.
        await client.query(
          `UPDATE transactions SET transfer_status = 'pending',
             counterparty_account_id = $1 WHERE id = $2`,
          [counterpartyId, leg.id],
        );
        pending++;
      } else {
        // Multiple candidates → ambiguous which one → flag for the user, don't guess.
        await client.query(
          `UPDATE transactions SET transfer_status = 'suspected',
             counterparty_account_id = $1 WHERE id = $2`,
          [counterpartyId, leg.id],
        );
        suspected++;
      }
    }

    await client.query("COMMIT");
    res.json({ account_id: accountId, resolved, pending, suspected });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("detect-transfers failed:", error);
    res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

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
app.get("/reports/by-category", async (req, res) => {
  const filters = parseFilters(req.query, 1);
  if (!filters.ok) return res.status(400).json({ error: filters.error });
  // Reports are spend analysis, so this is always on — an opening balance is not
  // spending and neither is moving your own money between your own accounts.
  const where = `WHERE ${EXPLAINABLE_SPEND} ${filters.sql}`;

  try {
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
      transactions: Number(t.transactions),
    });
  } catch (error) {
    console.error("by-category report failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

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
app.get("/reports/by-rule", async (req, res) => {
  const filters = parseFilters(req.query, 1);
  if (!filters.ok) return res.status(400).json({ error: filters.error });
  const spendClause = isSpendOnly(req.query) ? `AND ${EXPLAINABLE_SPEND}` : "";

  try {
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
  } catch (error) {
    console.error("by-rule report failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// GET /rules/vocabulary — the fields, ops and legal combinations a rule may use.
// The rule builder in the UI renders itself from this rather than hardcoding a copy:
// add an op to rules.ts and the form offers it, with no second place to update.
// Same reason server.ts imports the vocabulary instead of declaring its own.
app.get("/rules/vocabulary", (_req, res) => {
  res.json({
    fields: RULE_FIELDS,
    ops: RULE_OPS,
    match_modes: MATCH_MODES,
    ops_by_field: OPS_BY_FIELD,
  });
});

// POST /rules — create an auto-explanation rule. Validates the whole shape before
// touching the DB, so the engine can trust every field/op/value it later reads.
app.post("/rules", async (req, res) => {
  const { name, conditions, match_mode, category_id, priority, enabled } =
    req.body ?? {};

  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "name must be a non-empty string" });
  }
  const conditionError = validateConditions(conditions);
  if (conditionError !== null) {
    return res.status(400).json({ error: conditionError });
  }
  // `??` (not `||`) so a deliberate `false`/`0` survives — only null/undefined default.
  const mode = match_mode ?? "all";
  if (!isMatchMode(mode)) {
    return res
      .status(400)
      .json({ error: `match_mode must be one of ${MATCH_MODES.join(", ")}` });
  }
  // The action. Nullable in the schema, but a rule that assigns nothing does nothing.
  if (!Number.isInteger(category_id)) {
    return res.status(400).json({ error: "category_id must be an integer" });
  }
  const rulePriority = priority ?? 0;
  if (!Number.isInteger(rulePriority)) {
    return res.status(400).json({ error: "priority must be an integer" });
  }
  const isEnabled = enabled ?? true;
  if (typeof isEnabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }

  try {
    // Check the FK ourselves so a bad id is a clean 400, not a constraint-violation 500.
    const cat = await pool.query("SELECT 1 FROM categories WHERE id = $1", [
      category_id,
    ]);
    if (cat.rowCount === 0) {
      return res.status(400).json({ error: "category_id does not exist" });
    }
    const result = await pool.query(
      `INSERT INTO rules (name, conditions, match_mode, category_id, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        name.trim(),
        JSON.stringify(conditions),
        mode,
        category_id,
        rulePriority,
        isEnabled,
      ],
    );
    return res.status(201).json({ id: Number(result.rows[0].id) });
  } catch (error) {
    // 23505 = unique_violation. rules.name is UNIQUE, so a retried POST after a dropped
    // response lands here instead of silently creating a second identical rule.
    if ((error as { code?: string }).code === "23505") {
      return res.status(409).json({ error: "a rule with that name already exists" });
    }
    console.error("rule insert failed:", error);
    return res.status(500).json({ error: "internal error" });
  }
});

// DELETE /rules/:id — remove a rule and the allocations it produced.
//
// allocations.rule_id is a FK, so those rows have to go first or the delete fails. That
// is the correct semantic anyway: a rule allocation is a machine guess whose entire
// justification was the rule. Remove the justification and the guess should go with it.
//
// This CANNOT touch human work. The schema's CHECK allows rule_id to be non-null only
// when source = 'rule', so a user or evidence allocation is unreachable from here.
app.delete("/rules/:id", async (req, res) => {
  const ruleId = Number(req.params.id);
  if (!Number.isInteger(ruleId)) {
    return res.status(400).json({ error: "rule id must be an integer" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      "SELECT 1 FROM rules WHERE id = $1 FOR UPDATE",
      [ruleId],
    );
    if (found.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "no rule found" });
    }
    const swept = await client.query(
      "DELETE FROM allocations WHERE rule_id = $1",
      [ruleId],
    );
    await client.query("DELETE FROM rules WHERE id = $1", [ruleId]);
    await client.query("COMMIT");
    return res.json({
      deleted: ruleId,
      allocations_removed: swept.rowCount ?? 0,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("rule delete failed:", error);
    return res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// GET /rules — every rule with its target category name, roughly in precedence order:
// priority DESC, then id ASC. The id tiebreak is not cosmetic even here — SQL promises
// nothing about the order of tied rows, so without it this list could shuffle between
// identical requests.
//
// "Roughly" is deliberate. The AUTHORITATIVE precedence is compareRules() in rules.ts,
// which also ranks by specificity — and that stays in TypeScript rather than being
// mirrored into this ORDER BY. Precedence is policy, and policy belongs in exactly one
// place; duplicating it into SQL is the same mistake we just removed from the vocabulary.
app.get("/rules", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.name, r.conditions, r.match_mode, r.category_id,
              c.name AS category_name, r.priority, r.enabled
         FROM rules r
         LEFT JOIN categories c ON c.id = r.category_id
        ORDER BY r.priority DESC, r.id ASC`,
    );
    const rules = result.rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      conditions: r.conditions, // pg parses JSONB into a JS value already
      match_mode: r.match_mode,
      category_id: r.category_id == null ? null : Number(r.category_id),
      category_name: r.category_name, // null if the rule assigns no category
      priority: r.priority,
      enabled: r.enabled,
    }));
    res.json({ rules });
  } catch (error) {
    console.error("rules list failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// GET /summary — the numbers the header strip reports, as SQL aggregates.
// Deliberately an endpoint rather than something the client derives: the alternative
// is shipping the entire ledger to the browser to add up two figures, which stops
// being reasonable the moment real statements land.
//
// `unexplained` counts EXPLAINABLE SPEND only (see EXPLAINABLE_SPEND) — the same
// definition the rules engine uses, so the headline number and the engine can never
// disagree about what they are talking about.
app.get("/summary", async (_req, res) => {
  try {
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
         COALESCE(SUM(ABS(provisional)), 0) AS provisional_paise
       FROM per_txn`,
    );
    const row = result.rows[0];
    res.json({
      net_paise: Number(row.net_paise),
      unexplained_paise: Number(row.unexplained_paise),
      provisional_paise: Number(row.provisional_paise),
    });
  } catch (error) {
    console.error("summary failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// POST /rules/apply — run every enabled rule over the ledger and make the
// source='rule' allocations match what the rules currently say.
// Optional ?account_id=N scopes the run. Design: the design.
//
// This CONVERGES, it does not append: it computes the desired rule-allocations and
// makes the table match, so running it ten times equals running it once. Run it
// twice and the second run must report created: 0, removed: 0.
app.post("/rules/apply", async (req, res) => {
  // Absent = whole ledger. Present-but-junk is a 400, not a silent full run:
  // Number(undefined) is NaN and Number("") is 0, and neither throws.
  const rawAccountId = req.query.account_id;
  let accountId: number | null = null;
  if (rawAccountId !== undefined) {
    if (typeof rawAccountId !== "string" || !Number.isInteger(Number(rawAccountId))) {
      return res.status(400).json({ error: "account_id must be an integer" });
    }
    accountId = Number(rawAccountId);
  }

  const client = await pool.connect();
  try {
    if (accountId !== null && !(await accountExists(accountId))) {
      return res.status(404).json({ error: "account id does not exist" });
    }

    await client.query("BEGIN");

    // Only enabled rules are even considered. chooseWinner checks `enabled` too —
    // two independent guards, because a disabled rule that still categorises money
    // is the kind of bug nobody notices for months.
    const ruleResult = await client.query(
      `SELECT id, conditions, match_mode, category_id, priority, enabled
         FROM rules
        WHERE enabled = true AND category_id IS NOT NULL`,
    );
    const rules: ApplicableRule[] = ruleResult.rows.map((r) => ({
      id: Number(r.id), // BIGINT arrives as a string; the id tiebreak is numeric
      conditions: r.conditions,
      match_mode: r.match_mode,
      category_id: r.category_id === null ? null : Number(r.category_id),
      priority: Number(r.priority),
      enabled: r.enabled,
    }));

    // Candidates. The user-lock is NOT filtered here — we want to count what it
    // skipped, so it is applied below. ORDER BY id gives every concurrent run the
    // same lock order, which is what stops two runs deadlocking against each other.
    //
    // FOR UPDATE is load-bearing: without it the engine can read a transaction as
    // unlocked, a user can save allocations on it, and we then write a rule
    // allocation onto a transaction that now has user allocations. The allocations
    // endpoint takes FOR UPDATE on the same row, so the two serialise.
    const txnResult = await client.query(
      `SELECT id, amount_paise, narration, txn_date
         FROM transactions
        WHERE ($1::bigint IS NULL OR account_id = $1)
          AND ${EXPLAINABLE_SPEND}
        ORDER BY id
        FOR UPDATE`,
      [accountId],
    );
    const txns = txnResult.rows;

    // Every allocation for those transactions, in one query — not one per txn.
    const txnIds = txns.map((t) => t.id);
    const allocResult =
      txnIds.length === 0
        ? { rows: [] as any[] }
        : await client.query(
            `SELECT id, transaction_id, category_id, amount_paise, confidence, source, rule_id
               FROM allocations
              WHERE transaction_id = ANY($1)`,
            [txnIds],
          );

    // Group allocations by transaction. String keys: transaction_id is a BIGINT
    // and arrives as a string, so it is already a safe Map key with no precision loss.
    const allocationsByTxn = new Map<string, any[]>();
    for (const a of allocResult.rows) {
      const key = String(a.transaction_id);
      const list = allocationsByTxn.get(key);
      if (list === undefined) allocationsByTxn.set(key, [a]);
      else list.push(a);
    }

    let matched = 0;
    let created = 0;
    let removed = 0;
    let unchanged = 0;
    let skippedUserLocked = 0;

    for (const t of txns) {
      const existing = allocationsByTxn.get(String(t.id)) ?? [];

      // THE TRANSACTION-LEVEL LOCK. Any user allocation and the engine leaves the
      // whole transaction alone — not just the explained part. Filling the
      // remainder instead would mean you can never deliberately leave money
      // unexplained, and that is the product's whole point.
      if (existing.some((a) => a.source === "user")) {
        skippedUserLocked++;
        continue;
      }

      // The remainder EXCLUDES our own rule rows: they are what we are recomputing.
      // Counting them would make the desired state depend on the previous run.
      // Evidence rows DO count — the |Σ| ≤ |txn| budget is shared across sources.
      const nonRuleExplained = existing
        .filter((a) => a.source !== "rule")
        .reduce((sum, a) => sum + Number(a.amount_paise), 0);
      const remaining = Number(t.amount_paise) - nonRuleExplained;

      const desired = decideAllocation(
        {
          narration: t.narration,
          amount_paise: t.amount_paise,
          txn_date: t.txn_date,
        },
        remaining,
        rules,
      );
      if (desired !== null) matched++;

      const actual = existing.filter((a) => a.source === "rule");

      // The no-op case, detected rather than merely tolerated. Blind delete+insert
      // would still converge the state, but it churns allocation ids every run and
      // makes `created: 0, removed: 0` useless as a signal that we converged.
      if (
        desired !== null &&
        actual.length === 1 &&
        sameAllocation(
          {
            category_id: Number(actual[0].category_id),
            amount_paise: Number(actual[0].amount_paise),
            rule_id: actual[0].rule_id === null ? null : Number(actual[0].rule_id),
            confidence: Number(actual[0].confidence), // NUMERIC comes back as a string
          },
          desired,
        )
      ) {
        unchanged++;
        continue;
      }
      if (desired === null && actual.length === 0) continue;

      // THE SCOPED SWEEP. `AND source = 'rule'` is the entire override guarantee:
      // the engine may only delete rows it could have written. The allocations
      // endpoint deletes unscoped — correct there, fatal here.
      if (actual.length > 0) {
        const del = await client.query(
          "DELETE FROM allocations WHERE transaction_id = $1 AND source = 'rule'",
          [t.id],
        );
        removed += del.rowCount ?? 0;
      }
      if (desired !== null) {
        await client.query(
          `INSERT INTO allocations
             (transaction_id, amount_paise, category_id, confidence, source, rule_id)
           VALUES ($1, $2, $3, $4, 'rule', $5)`,
          [
            t.id,
            desired.amount_paise,
            desired.category_id,
            desired.confidence,
            desired.rule_id,
          ],
        );
        created++;
      }
    }

    await client.query("COMMIT");
    return res.json({
      account_id: accountId,
      examined: txns.length,
      matched,
      created,
      removed,
      unchanged,
      skipped_user_locked: skippedUserLocked,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("rules apply failed:", error);
    return res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

// Fallback: anything unmatched -> 404.
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

// Central error handler (4 args = Express treats it as an error handler).
// Catches errors thrown in handlers OR passed by middleware (e.g. malformed JSON from
// express.json()). Returns clean JSON and NEVER leaks the error/stack to the client.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "request body is not valid JSON" });
    return;
  }
  console.error("unhandled error:", err); // real detail stays in OUR logs only
  res.status(500).json({ error: "internal error" });
};
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
});
