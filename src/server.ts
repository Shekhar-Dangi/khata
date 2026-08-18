import express, { type ErrorRequestHandler } from "express";
import { createHash } from "node:crypto";

import { pool } from "./db.ts";

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

// ── Rules (auto-explanation) ────────────────────────────────────────────────
// A rule is DATA, not code: a list of {field, op, value} conditions plus the category
// to assign when they match. Validation is deliberately strict HERE, at the write path,
// so the engine that later reads these rows never meets a malformed one.
const RULE_FIELDS = ["narration", "amount_paise", "txn_date"];
const RULE_OPS = ["contains", "equals", "lt", "gt"];
const MATCH_MODES = ["all", "any"];
// Not every op makes sense on every field — `contains` is meaningless on a number.
const OPS_BY_FIELD: Record<string, string[]> = {
  narration: ["contains", "equals"],
  amount_paise: ["equals", "lt", "gt"],
  txn_date: ["equals", "lt", "gt"],
};

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
    if (typeof field !== "string" || !RULE_FIELDS.includes(field)) {
      return `condition ${i}: field must be one of ${RULE_FIELDS.join(", ")}`;
    }
    if (typeof op !== "string" || !RULE_OPS.includes(op)) {
      return `condition ${i}: op must be one of ${RULE_OPS.join(", ")}`;
    }
    if (!OPS_BY_FIELD[field]!.includes(op)) {
      return `condition ${i}: op '${op}' is not valid on field '${field}'`;
    }
    if (field === "narration") {
      if (typeof value !== "string" || value.trim() === "") {
        return `condition ${i}: value must be a non-empty string`;
      }
    } else if (field === "amount_paise") {
      // Demand an actual integer, not merely something coercible: Number("") is 0
      // and Number("abc") is NaN — neither throws, both would store a broken rule.
      if (!Number.isInteger(value)) {
        return `condition ${i}: value must be an integer (paise)`;
      }
    } else {
      // txn_date — same YYYY-MM-DD contract the import path already uses.
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        return `condition ${i}: value must be a date string (YYYY-MM-DD)`;
      }
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

  const response = {
    account_id: accountId,
    reconciled: true,
    checkpoints_checked: 0,
    transactions_considered: result.rowCount,
    ledger_balance_paise: Number(ledgerSum.rows[0].total),
    bank_last_stated_paise: null as number | null,
    total_difference_paise: null as number | null,
    discrepancies: [] as Discrepancy[],
  };

  let computed = 0;
  for (const t of result.rows) {
    computed += Number(t.amount_paise);

    // Only rows carrying the bank's balance are checkpoints we can verify.
    // Guard on the RAW value: Number(null) is 0, which would treat a real 0 as "no checkpoint".
    if (t.bank_balance_paise != null) {
      const stated = Number(t.bank_balance_paise);
      response.checkpoints_checked += 1;
      response.bank_last_stated_paise = stated; // the bank's most recent stated balance

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
    }
  }

  if (response.bank_last_stated_paise != null) {
    response.total_difference_paise =
      response.bank_last_stated_paise - response.ledger_balance_paise;
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
      if (!r.reconciled) accounts.push({ account_name: row.name, ...r });
    }
    res.json({ accounts });
  } catch (error) {
    console.error("anomalies failed:", error);
    res.status(500).json({ error: "internal error" });
  }
});

// GET /transactions — consolidated ledger: every account's transactions in one view.
app.get("/transactions", async (_req, res) => {
  try {
    const result = await pool.query(
      // Lighter than the drill-in: just the explained total per txn (no nested allocations).
      // LEFT JOIN allocations + GROUP BY t.id, a.id (both PKs → other columns are free).
      `SELECT t.id, t.account_id, a.name AS account_name, a.bank,
              t.txn_date, t.txn_time, t.amount_paise, t.type, t.narration,
              t.transfer_status, t.counterparty_account_id, t.bank_balance_paise,
              COALESCE(SUM(al.amount_paise), 0) AS explained_paise
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN allocations al ON al.transaction_id = t.id
        GROUP BY t.id, a.id
        ORDER BY t.txn_date, t.account_id, t.statement_id, t.statement_seq`,
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
        unexplained_paise: amount - explained, // derived
      };
    });
    res.json({ transactions });
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
  if (!MATCH_MODES.includes(mode)) {
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
    console.error("rule insert failed:", error);
    return res.status(500).json({ error: "internal error" });
  }
});

// GET /rules — every rule with its target category name, in the ORDER THE ENGINE WILL
// CONSIDER THEM: priority DESC, then id ASC. The id tiebreak is not cosmetic. Two rules
// at the same priority are a tie, SQL promises nothing about the order of tied rows, and
// a winner that changes between runs destroys the engine's idempotency. Same ORDER BY
// must appear in the runner.
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
