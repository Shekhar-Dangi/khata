// The rules engine's RUN, lifted out of its route so something other than a request can
// start it.
//
// It lived inside `POST /rules/apply` until 2026-09-19 and the logic is unchanged — this is a
// move, not a rewrite, and `scripts/snapshot.sh` is what proves that. What forced the move is how
// an invoice and a rule share one transaction: an evidence write displaces a rule's guess and the
// remainder it leaves has to be refilled, or the ledger is left reporting money as unexplained
// that a rule could explain perfectly well. Before this, the refill was a person remembering to
// press a button — and the one time nobody did, dozens of confirmed allocations worth a large sum
// read as unexplained until someone ran the engine by hand.
//
// TWO THINGS THE CALLER MUST KNOW.
//
// It takes an EXISTING client rather than opening its own transaction. A backfill has to commit
// with the write that made it necessary: two transactions means a window where the ledger has
// the displacement and not the refill, and a crash in that window leaves it there permanently.
//
// It takes `FOR UPDATE` on every row it examines, so a caller already holding locks must take
// them in the same order (`ORDER BY id`) or the two deadlock. Every current caller reaches this
// through one statement, so nothing does today.
//
// The invariants are unchanged and are the whole design; understand all of them before
// touching any of them:
//
//   - it CONVERGES, it does not append. Run it twice, the second reports created: 0, removed: 0
//   - every DELETE carries `AND source = 'rule'`. It may only delete rows it could have written
//   - any `source='user'` row locks the WHOLE transaction, not just the explained part
//   - the remainder excludes the engine's own rows and INCLUDES evidence rows — that shared
//     budget is exactly what lets an invoice and a rule sit on one transaction

import type { PoolClient } from "pg";

import { EXPLAINABLE_SPEND } from "./spend.ts";
import { decideAllocation, sameAllocation } from "./rules.ts";
import type { ApplicableRule } from "./rules.ts";

export type ApplyResult = {
  account_id: number | null;
  examined: number;
  matched: number;
  created: number;
  removed: number;
  unchanged: number;
  skipped_user_locked: number;
};

/**
 * Converge the `source='rule'` allocations on everything in scope.
 *
 * @param accountId      one account, or null for the whole ledger
 * @param transactionIds these rows and no others, or null for "whatever `accountId` selects".
 *                       An empty array examines nothing.
 */
export async function applyRules(
  client: PoolClient,
  accountId: number | null,
  transactionIds: string[] | null = null,
): Promise<ApplyResult> {
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
        -- THE SCOPE THE BACKFILL NEEDS. Null means the whole ledger, exactly as before;
        -- a list means these rows and no others. An EMPTY list therefore examines
        -- nothing, which is the honest reading of "backfill these zero transactions"
        -- and is why no caller has to special-case it.
        AND ($2::bigint[] IS NULL OR id = ANY($2))
        AND ${EXPLAINABLE_SPEND}
      ORDER BY id
      FOR UPDATE`,
    [accountId, transactionIds],
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

  return {
    account_id: accountId,
    examined: txns.length,
    matched,
    created,
    removed,
    unchanged,
    skipped_user_locked: skippedUserLocked,
  };
}
