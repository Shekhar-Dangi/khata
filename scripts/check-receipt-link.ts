// Does attaching a receipt by hand, and taking it back, leave the ledger where it started?
//
//   node --env-file=.env scripts/check-receipt-link.ts
//
// SAFE ON REAL DATA: everything runs inside one transaction that ends in ROLLBACK. It needs one
// confirmed receipt that is already matched, and changes nothing that survives the run.

import { pool } from "../src/db.ts";
import { linkReceipt, listReceiptRecords, unlinkReceipt } from "../src/receipt-records.ts";

const ok = (label: string, cond: boolean, extra = "") =>
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);

// The same aggregate /summary reports, so "where it started" means what the owner sees.
async function totals(c: import("pg").PoolClient) {
  const r = await c.query<{ explained: string; evidence: string; rule: string }>(
    `SELECT COALESCE(SUM(ABS(amount_paise)), 0)::text AS explained,
            COALESCE(SUM(ABS(amount_paise)) FILTER (WHERE source = 'evidence'), 0)::text AS evidence,
            COALESCE(SUM(ABS(amount_paise)) FILTER (WHERE source = 'rule'), 0)::text AS rule
       FROM allocations`,
  );
  return { explained: Number(r.rows[0].explained), evidence: Number(r.rows[0].evidence), rule: Number(r.rows[0].rule) };
}

const c = await pool.connect();
try {
  await c.query("BEGIN");

  const matched = (await listReceiptRecords(c, { state: "matched" })).find((r) => r.linked.length === 1);
  if (!matched) throw new Error("need one matched receipt to test with");
  const txnId = matched.linked[0].transactionId;
  console.log(`  using: ${matched.description} (${matched.group}), bank row ${txnId}\n`);

  const start = await totals(c);

  // 1. Take it back.
  const un = await unlinkReceipt(c, matched.evidenceId);
  ok("unlink succeeds", un.ok, JSON.stringify(un));
  const after = (await listReceiptRecords(c, { source: matched.group })).find((r) => r.evidenceId === matched.evidenceId);
  ok("the order is no longer matched", after !== undefined && after.state !== "matched", after?.state);
  const mid = await totals(c);
  ok("its line items left the bank row", mid.evidence <= start.evidence, `${start.evidence} -> ${mid.evidence}`);
  ok("the freed row was REFILLED by the rules, not left bare", mid.rule >= start.rule, `${start.rule} -> ${mid.rule}`);

  // 2. A credit is not a payment for an order.
  const credit = await c.query<{ id: string }>("SELECT id FROM transactions WHERE amount_paise > 0 LIMIT 1");
  const bad = await linkReceipt(c, matched.evidenceId, [credit.rows[0].id]);
  ok("attaching a CREDIT is refused", !bad.ok, bad.ok ? "" : bad.error);

  // 3. Put it back by hand.
  const link = await linkReceipt(c, matched.evidenceId, [txnId]);
  ok("attaching by hand succeeds", link.ok, JSON.stringify(link));
  const back = (await listReceiptRecords(c, { source: matched.group })).find((r) => r.evidenceId === matched.evidenceId);
  ok("the order is matched to the row picked", back?.state === "matched" && back.linked[0]?.transactionId === txnId);

  const end = await totals(c);
  ok("the ledger ends where it started", end.explained === start.explained && end.evidence === start.evidence,
     `explained ${start.explained} -> ${end.explained}, evidence ${start.evidence} -> ${end.evidence}`);

  // 4. The invariant every allocation writer is held to.
  const over = await c.query(
    `SELECT t.id FROM transactions t JOIN allocations a ON a.transaction_id = t.id
      GROUP BY t.id, t.amount_paise HAVING abs(SUM(a.amount_paise)) > abs(t.amount_paise)`,
  );
  ok("no transaction is over-allocated", over.rowCount === 0, `${over.rowCount} over`);

  await c.query("ROLLBACK");
  console.log("\n  rolled back — nothing kept");
} finally {
  c.release();
  await pool.end();
}
