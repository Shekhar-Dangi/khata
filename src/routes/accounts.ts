import { Router } from "express";

import { pool } from "./../db.ts";
import { HttpError, intParam, notFound, route, withTransaction } from "./../http.ts";
import { accountExists, transactionHash } from "./../accounts.ts";
import { reconcileAccount } from "./../reconcile.ts";
import { ALLOWED_TYPES } from "./../spend.ts";

const router = Router();
export { router as accounts };

// GET /accounts — list every account with its computed balance in ONE aggregate query.
// LEFT JOIN (not INNER) so accounts with zero transactions still appear, with balance 0.
// GROUP BY a.id is enough because id is the PK — name/bank are functionally dependent on it.
router.get("/accounts", route(async (_req, res) => {
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
}));

// GET /accounts/:id/balance — compute the account's balance from its transactions.
router.get("/accounts/:id/balance", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id"); // Express extracts :id into req.params
  if (!(await accountExists(accountId))) throw notFound("account id does not exist");

  const result = await pool.query(
    "SELECT COALESCE(SUM(amount_paise), 0) AS balance_paise FROM transactions WHERE account_id = $1",
    [accountId],
  );
  res.json({
    account_id: accountId,
    balance_paise: Number(result.rows[0].balance_paise),
  });
}));

// GET /accounts/:id/transactions — an account's transactions, oldest first (drill-in view).
router.get("/accounts/:id/transactions", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
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
}));

// POST /accounts/:id/transactions — batch import: validated, all-or-nothing, idempotent.
router.post("/accounts/:id/transactions", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  const body = req.body; // already parsed by express.json()

  if (!(await accountExists(accountId))) throw notFound("account id does not exist");

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
  // `import failed` rather than the usual `internal error`: this is the one endpoint the
  // Python ingest driver calls, and its operator needs to know the IMPORT is what broke
  // rather than some unrelated request. An HttpError carries that through the same
  // central handler as everything else.
  const imported = await withTransaction(async (client) => {
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
    return {
      statement_id: statementId,
      inserted,
      skipped: body.transactions.length - inserted,
    };
  }).catch((err) => {
    console.error("import failed:", err);
    throw new HttpError(500, "import failed");
  });

  res.status(201).json(imported);
}));

router.get("/accounts/:id/reconcile", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  if (!(await accountExists(accountId))) {
    return res.status(404).json({ error: "account does not exist" });
  }
  return res.status(200).json(await reconcileAccount(accountId));
}));

// GET /anomalies — reconcile every account, return only the ones with discrepancies.
router.get("/anomalies", route(async (_req, res) => {
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
}));

