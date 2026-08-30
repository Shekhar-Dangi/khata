import { Router } from "express";

import { pool } from "./../db.ts";
import { intParam, notFound, route, withTransaction } from "./../http.ts";
import { accountExists } from "./../accounts.ts";
import { detectTransfers } from "./../detect.ts";
import { parsePaging } from "./../filters.ts";
import { KEYWORD_KINDS, TRANSFER_STATUSES } from "./../spend.ts";

const router = Router();
export { router as transfers };

router.get("/transfers", route(async (req, res) => {
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });

  const rawStatus = req.query.status;
  let status: string | null = null;
  if (rawStatus !== undefined) {
    if (typeof rawStatus !== "string" || !TRANSFER_STATUSES.includes(rawStatus)) {
      return res
        .status(400)
        .json({ error: `status must be one of ${TRANSFER_STATUSES.join(", ")}` });
    }
    status = rawStatus;
  }

  // COALESCE to a text key so a grouped pair and a lone pending leg are the same kind of
  // thing to every query below. '::text' on the bigint is deliberate — mixing the two
  // types in one COALESCE is an error, not a coercion.
  const groupKey = `COALESCE('g:' || t.transfer_group_id::text, 'txn:' || t.id::text)`;
  const statusClause = status === null ? "" : "AND t.transfer_status = $1";
  const statusParams = status === null ? [] : [status];

  const counts = await pool.query(
    `SELECT t.transfer_status AS status,
              COUNT(DISTINCT ${groupKey}) AS groups
         FROM transactions t
        WHERE t.transfer_status IS NOT NULL
        GROUP BY t.transfer_status`,
  );

  // The page of groups. MIN(txn_date) orders a pair by its earlier leg, so the two
  // legs of one transfer can never sort apart; the key breaks ties, because SQL
  // promises nothing about the order of rows that tie and a page whose contents
  // shuffle between identical requests is a paging bug that looks like data loss.
  const groups = await pool.query(
    `SELECT ${groupKey} AS key, MIN(t.txn_date) AS when_at
         FROM transactions t
        WHERE t.transfer_status IS NOT NULL ${statusClause}
        GROUP BY ${groupKey}
        ORDER BY MIN(t.txn_date) DESC, key DESC
        LIMIT $${statusParams.length + 1} OFFSET $${statusParams.length + 2}`,
    [...statusParams, paging.limit, paging.offset],
  );
  const keys = groups.rows.map((r) => r.key);

  const legs =
    keys.length === 0
      ? { rows: [] as any[] }
      : await pool.query(
          `SELECT ${groupKey} AS key, t.id, t.account_id, a.name AS account_name,
                    t.txn_date, t.amount_paise, t.narration, t.type,
                    t.transfer_status, t.transfer_group_id, t.transfer_evidence,
                    t.counterparty_account_id, ca.name AS counterparty_name
               FROM transactions t
               JOIN accounts a ON a.id = t.account_id
               LEFT JOIN accounts ca ON ca.id = t.counterparty_account_id
              WHERE ${groupKey} = ANY($1)
              ORDER BY t.amount_paise, t.id`,
          [keys],
        );

  const byKey = new Map<string, any[]>();
  for (const l of legs.rows) {
    const list = byKey.get(l.key);
    const leg = {
      id: l.id,
      account_id: Number(l.account_id),
      account_name: l.account_name,
      txn_date: l.txn_date,
      amount_paise: Number(l.amount_paise),
      narration: l.narration,
      type: l.type,
      transfer_status: l.transfer_status,
      transfer_evidence: l.transfer_evidence,
      counterparty_account_id:
        l.counterparty_account_id === null ? null : Number(l.counterparty_account_id),
      counterparty_name: l.counterparty_name,
    };
    if (list === undefined) byKey.set(l.key, [leg]);
    else list.push(leg);
  }

  const totalRow = await pool.query(
    `SELECT COUNT(DISTINCT ${groupKey}) AS n
         FROM transactions t
        WHERE t.transfer_status IS NOT NULL ${statusClause}`,
    statusParams,
  );

  res.json({
    groups: groups.rows.map((g) => {
      const groupLegs = byKey.get(g.key) ?? [];
      return {
        key: g.key,
        // Only a real group can be confirmed or rejected — those routes address a
        // group id. A lone pending leg has none, and the UI must not offer buttons
        // that cannot work.
        transfer_group_id: g.key.startsWith("g:") ? Number(g.key.slice(2)) : null,
        status: groupLegs[0]?.transfer_status ?? null,
        // Why this link exists. Both legs always carry the same value, so the group's
        // is the first leg's.
        evidence: groupLegs[0]?.transfer_evidence ?? null,
        txn_date: g.when_at,
        // The magnitude the pair moved. Legs are signed and opposite, so summing them
        // would report every transfer as zero.
        amount_paise: Math.abs(groupLegs[0]?.amount_paise ?? 0),
        legs: groupLegs,
      };
    }),
    total: Number(totalRow.rows[0].n),
    limit: paging.limit,
    offset: paging.offset,
    counts: Object.fromEntries(
      counts.rows.map((r) => [r.status, Number(r.groups)]),
    ) as Record<string, number>,
  });
}));

// ── Account identifiers ──────────────────────────────────────────────────────
// The strings that let one account be recognised inside another account's narration.
// Detection's strong pass is entirely powered by these, and it is a no-op while the
// table is empty — which is the state every fresh install starts in.

// GET /keywords — every account's identifiers in one request.
// The per-account route still exists; this one keeps the settings screen from firing
// one request per account just to draw a list.
router.get("/keywords", route(async (_req, res) => {
  const result = await pool.query(
    `SELECT k.id, k.account_id, a.name AS account_name, k.keyword, k.kind
         FROM account_keywords k
         JOIN accounts a ON a.id = k.account_id
        ORDER BY k.account_id, k.id`,
  );
  res.json({
    keywords: result.rows.map((r) => ({
      id: Number(r.id),
      account_id: Number(r.account_id),
      account_name: r.account_name,
      keyword: r.keyword,
      kind: r.kind,
    })),
  });
}));

// DELETE /accounts/:id/keywords/:keywordId — remove an identifier.
//
// This does NOT un-resolve the transfers it helped find. A resolved pair is a decision
// that has already been made about two specific rows; re-deciding it silently because a
// string was deleted would rewrite history behind the user's back. Undo is
// POST /transactions/:id/unlink-transfer, which is explicit and per-transfer.
router.delete("/accounts/:id/keywords/:keywordId", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  const keywordId = intParam(req.params.keywordId, "keyword id");
  const result = await pool.query(
    "DELETE FROM account_keywords WHERE id = $1 AND account_id = $2",
    [keywordId, accountId],
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: "no keyword found on that account" });
  }
  return res.json({ deleted: keywordId });
}));

// POST /accounts/:id/keywords — register an identifier used to recognize this account
// in another account's narration (account number, UPI handle, or name).
router.post("/accounts/:id/keywords", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  const { keyword, kind } = req.body ?? {};

  if (!(await accountExists(accountId))) throw notFound("account id does not exist");

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
}));

// GET /accounts/:id/keywords — list an account's registered identifiers.
router.get("/accounts/:id/keywords", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  if (!(await accountExists(accountId))) {
    return res.status(404).json({ error: "account id does not exist" });
  }
  const result = await pool.query(
    "SELECT id, keyword, kind FROM account_keywords WHERE account_id = $1 ORDER BY id",
    [accountId],
  );
  res.json({ account_id: accountId, keywords: result.rows });
}));

/// ── Internal-transfer detection ─────────────────────────────────────────────
//
// THREE passes, strongest evidence first, because the three kinds of evidence deserve
// three different verdicts.
//
//  1. REFERENCE — both legs quote the same 12-digit UPI reference (RRN). This is the
//     bank's own idea that the two rows are one payment, so it auto-resolves with no
//     human in the loop. It also needs nothing set up, which is what makes it the pass
//     that actually fires on a fresh install.
//  2. KEYWORD — the leg's narration names another account of yours (its account number or
//     UPI handle). That plus a matching opposite leg auto-resolves too, but it is dead
//     until somebody fills in `account_keywords`.
//  3. AMOUNT + DATE — no identifier at all, only "a debit here and a credit of exactly
//     the same size over there, a day or two apart". That is a PROPOSAL, never a verdict:
//     written as `suspected`, still counted as spending, waiting for the user.
//
// The order is not cosmetic — it is the whole safety argument. Each pass claims legs
// before the weaker ones see them, so a pair the bank itself identified can never be
// taken first by a coincidence of amount and date.
//
// v1 shipped only pass 2, and pass 2 does nothing until `account_keywords` has rows —
// which, on a fresh install, it never does. Detection silently found zero transfers and
// every rupee moved between your own accounts was counted as spending on BOTH
// legs — a large share of the reported "money out" on real statements.
//
// A rejected proposal has to be REMEMBERED or the next run proposes it again, which is
// why 'rejected' is a state rather than a return to NULL.

// POST /accounts/:id/detect-transfers — run detection over one account's legs.
// Idempotent: resolved and rejected legs are never touched, and a proposal already
// written as `suspected` is not proposed a second time.
router.post("/accounts/:id/detect-transfers", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");

    if (!(await accountExists(accountId))) throw notFound("account id does not exist");

  const result = await withTransaction(async (client) => {
    const counts = await detectTransfers(client, [accountId], new Set());
    return { account_id: accountId, ...counts };
  });

  return res.json(result);
}));

// POST /transfers/detect — the same sweep across every account, in ONE transaction.
//
// Per-account is the wrong unit for the button a person actually presses: they mean
// "find my transfers". Running the accounts in separate transactions also lets two runs
// claim the same partner leg, which the shared `claimed` set prevents here. Accounts are
// visited in id order so two concurrent sweeps take their row locks in the same order
// and cannot deadlock against each other.
router.post("/transfers/detect", route(async (_req, res) => {
  const result = await withTransaction(async (client) => {
    const accounts = (await client.query("SELECT id FROM accounts ORDER BY id")).rows;
    const ids = accounts.map((a) => Number(a.id));
    const totals = await detectTransfers(client, ids, new Set());
    return { accounts: ids.length, ...totals };
  });

  return res.json(result);
}));

// POST /transfers/:groupId/confirm — "yes, those two are the same money".
//
// Confirming moves both legs OUT of EXPLAINABLE_SPEND, which means the rules engine will
// never consider them again. An allocation a rule had already written on them would then
// sit there forever, uncollectable by the engine's own converging sweep — so we sweep it
// here, carrying the same `source = 'rule'` scope every other sweep in this codebase
// carries. Hand-written (`source = 'user'`) allocations are left alone and reported
// back: deleting a person's work to tidy up a state change is the one thing this
// codebase must never do.
router.post("/transfers/:groupId/confirm", route(async (req, res) => {
  const groupId = intParam(req.params.groupId, "group id");

  const result = await withTransaction(async (client) => {
    const legs = (
      await client.query(
        `SELECT id FROM transactions
          WHERE transfer_group_id = $1 AND transfer_status = 'suspected'
          ORDER BY id FOR UPDATE`,
        [groupId],
      )
    ).rows;
    if (legs.length === 0) {
      throw notFound("no suspected transfer with that group id");
    }
    const ids = legs.map((l) => l.id);
    const swept = await client.query(
      "DELETE FROM allocations WHERE transaction_id = ANY($1) AND source = 'rule'",
      [ids],
    );
    const userHeld = await client.query(
      "SELECT COUNT(*) AS n FROM allocations WHERE transaction_id = ANY($1)",
      [ids],
    );
    // The evidence becomes the USER, not the coincidence that raised the question. A
    // pair that still said 'amount+date' after a person confirmed it would misreport why
    // this money left the spend column, which is the one thing the column is for.
    await client.query(
      `UPDATE transactions SET transfer_status = 'resolved', transfer_evidence = 'confirmed'
        WHERE id = ANY($1)`,
      [ids],
    );
    return {
      transfer_group_id: groupId,
      legs: legs.length,
      rule_allocations_removed: swept.rowCount ?? 0,
      user_allocations_kept: Number(userHeld.rows[0].n),
    };
  });

  return res.json(result);
}));

// POST /transfers/:groupId/reject — "no, those are two separate payments".
//
// The legs go to 'rejected', not back to NULL. NULL means "never looked at", and the
// next detection run would propose the very same pair again — the user would answer the
// same question every time they pressed the button. 'rejected' is still inside
// EXPLAINABLE_SPEND: saying it is not a transfer is saying it IS spend.
router.post("/transfers/:groupId/reject", route(async (req, res) => {
  const groupId = intParam(req.params.groupId, "group id");

  const result = await pool.query(
    `UPDATE transactions
          SET transfer_status = 'rejected', transfer_group_id = NULL,
              counterparty_account_id = NULL, transfer_evidence = NULL
        WHERE transfer_group_id = $1 AND transfer_status = 'suspected'`,
    [groupId],
  );
  if (result.rowCount === 0) {
    return res
      .status(404)
      .json({ error: "no suspected transfer with that group id" });
  }
  return res.json({ transfer_group_id: groupId, legs: result.rowCount });
}));

// POST /transactions/:id/unlink-transfer — undo, for a leg that is already resolved,
// pending or rejected. Auto-resolution has to be reversible; an auto-classification
// nobody can take back quietly corrupts every report downstream of it.
// Clears the WHOLE group, because half a transfer is not a state.
router.post("/transactions/:id/unlink-transfer", route(async (req, res) => {
  const txnId = intParam(req.params.id, "transaction id");

  const result = await withTransaction(async (client) => {
    const row = (
      await client.query(
        "SELECT transfer_group_id FROM transactions WHERE id = $1 FOR UPDATE",
        [txnId],
      )
    ).rows[0];
    if (row === undefined) {
      throw notFound("no transaction found");
    }
    // `WHERE transfer_group_id = NULL` matches nothing in SQL, so a leg with no group
    // has to be updated as itself rather than folded into the group update.
    const result =
      row.transfer_group_id === null
        ? await client.query(
            `UPDATE transactions SET transfer_status = NULL,
               counterparty_account_id = NULL, transfer_evidence = NULL WHERE id = $1`,
            [txnId],
          )
        : await client.query(
            `UPDATE transactions SET transfer_status = NULL, transfer_group_id = NULL,
               counterparty_account_id = NULL, transfer_evidence = NULL
             WHERE transfer_group_id = $1`,
            [row.transfer_group_id],
          );
    return { cleared: result.rowCount ?? 0 };
  });

  return res.json(result);
}));

