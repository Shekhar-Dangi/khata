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

const ALLOWED_TYPES = ["opening_balance", "transfer", "regular"];

// Health check.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
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

// POST /accounts/:id/transactions — batch import: validated, all-or-nothing, idempotent.
app.post("/accounts/:id/transactions", async (req, res) => {
  const accountId = Number(req.params.id);
  const body = req.body; // already parsed by express.json()

  try {
    if (!(await accountExists(accountId))) {
      return res.status(404).json({ error: "account id does not exist" });
    }
  } catch (error) {
    console.error("balance query failed:", error);
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
    if (t.bank_balance_paise != null && !Number.isInteger(t.bank_balance_paise)) {
      errors.push(`row ${i}: bank_balance_paise must be an integer if provided`);
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
