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

async function fetchTransactions(accountId: number) {
  const result = await pool.query(
    "SELECT * FROM transactions WHERE account_id = $1 ORDER BY txn_date, statement_id, statement_seq",
    [accountId],
  );
  return result;
}

const ALLOWED_TYPES = ["opening_balance", "transfer", "regular"];
const KEYWORD_KINDS = ["account_number", "upi_handle", "name"];

type Discrepancy = {
  transaction_id: string; // our BIGINT PK — kept as a string to avoid JS precision loss past 2^53
  txn_date: string;
  narration: string;
  expected_paise: number;
  stated_paise: number;
  difference_paise: number;
};

// Health check.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
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

// GET /accounts/:id/transactions — an account's transactions, oldest first (drill-in view).
app.get("/accounts/:id/transactions", async (req, res) => {
  const accountId = Number(req.params.id);
  try {
    if (!(await accountExists(accountId))) {
      return res.status(404).json({ error: "account id does not exist" });
    }
    const result = await pool.query(
      `SELECT id, txn_date, txn_time, amount_paise, type, narration,
              transfer_status, counterparty_account_id, bank_balance_paise
         FROM transactions
        WHERE account_id = $1
        ORDER BY txn_date, statement_id, statement_seq`,
      [accountId],
    );
    const transactions = result.rows.map((r) => ({
      id: r.id, // BIGINT PK — keep as STRING (JS loses precision past 2^53)
      txn_date: r.txn_date,
      txn_time: r.txn_time,
      amount_paise: Number(r.amount_paise), // safe: one txn won't exceed 2^53 paise
      type: r.type,
      narration: r.narration,
      transfer_status: r.transfer_status,
      counterparty_account_id: r.counterparty_account_id, // BIGINT|null — leave as string|null
      bank_balance_paise:
        r.bank_balance_paise == null ? null : Number(r.bank_balance_paise),
    }));
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
  const result = await fetchTransactions(accountId);

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
    const accts = await pool.query("SELECT id FROM accounts ORDER BY id");
    const accounts = [];
    for (const row of accts.rows) {
      const r = await reconcileAccount(Number(row.id));
      if (!r.reconciled) accounts.push(r);
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
      `SELECT t.id, t.account_id, a.name AS account_name, a.bank,
              t.txn_date, t.txn_time, t.amount_paise, t.type, t.narration,
              t.transfer_status, t.counterparty_account_id, t.bank_balance_paise
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        ORDER BY t.txn_date, t.account_id, t.statement_id, t.statement_seq`,
    );
    const transactions = result.rows.map((r) => ({
      id: r.id, // BIGINT PK — keep as string
      account_id: Number(r.account_id),
      account_name: r.account_name,
      bank: r.bank,
      txn_date: r.txn_date,
      txn_time: r.txn_time,
      amount_paise: Number(r.amount_paise),
      type: r.type,
      narration: r.narration,
      transfer_status: r.transfer_status,
      counterparty_account_id: r.counterparty_account_id,
      bank_balance_paise:
        r.bank_balance_paise == null ? null : Number(r.bank_balance_paise),
    }));
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
    return res.status(400).json({ error: "keyword must be a non-empty string" });
  }
  if (!KEYWORD_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of ${KEYWORD_KINDS.join(", ")}` });
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
