import { createHash } from "node:crypto";

import { pool } from "./db.ts";

// Account-level helpers shared by more than one route file.

/** Does this account exist? Used nine times, mostly to turn a bad id into a clean 404. */
export async function accountExists(accountId: number): Promise<boolean> {
  const r = await pool.query("SELECT 1 FROM accounts WHERE id = $1", [accountId]);
  return r.rowCount !== 0;
}

/**
 * Fingerprint a transaction by its identifying fields, for dedup on re-import.
 * Same fields -> same hash, every time (deterministic). Paired with a UNIQUE constraint
 * on `import_hash`, which is what makes re-importing the same statement a no-op rather
 * than a doubled ledger.
 */
export function transactionHash(accountId: number, t: any): string {
  const key = [
    accountId,
    t.txn_date,
    t.txn_time ?? "",
    t.amount_paise,
    t.narration ?? "",
  ].join("|");
  return createHash("sha256").update(key).digest("hex");
}
