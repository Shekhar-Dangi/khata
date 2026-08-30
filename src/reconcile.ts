import { pool } from "./db.ts";

// A single balance disagreement: what our ledger computed vs what the bank stated.
// `transaction_id` stays a STRING — it is a BIGINT, and Number() would silently lose
// precision past 2^53.
export type Discrepancy = {
  transaction_id: string;
  txn_date: string;
  narration: string;
  expected_paise: number;
  stated_paise: number;
  difference_paise: number;
};

// One row as the reconciliation walk needs it. Deliberately narrower than the table:
// the walk only ever reads these six columns.
export type Transaction = {
  id: string;
  txn_date: string;
  amount_paise: number;
  type: string;
  narration: string | null;
  bank_balance_paise: number | null;
};

// Ordering is the whole contract here. The walk accumulates a running balance, so rows
// must arrive in the order the bank produced them — date, then the statement they came
// from, then their position within it.
async function fetchTransactionsByAccount(accountId: number) {
  return pool.query(
    "SELECT * FROM transactions WHERE account_id = $1 ORDER BY txn_date, statement_id, statement_seq",
    [accountId],
  );
}

// Core reconciliation for ONE account: walk ordered txns, compute the running balance,
// compare to the bank's stated balance at each checkpoint (reset to bank per segment).
// Extracted so both /accounts/:id/reconcile and /anomalies reuse it.
export async function reconcileAccount(accountId: number) {
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

