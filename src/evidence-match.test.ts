import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type Candidate,
  DEFAULT_WINDOW_DAYS,
  type ExistingAllocation,
  expectedCash,
  matchToTransaction,
  resolvePrecedence,
} from "./evidence-match.ts";

const txn = (id: string, txn_date: string, amount_paise: number, narration = ""): Candidate =>
  ({ id, txn_date, amount_paise, narration });

const request = (expectedPaise: number, date = "2026-01-15") =>
  ({ externalRef: "flat|2026-01-15|dinner|400000", date, expectedPaise });

describe("expectedCash", () => {
  it("expects a debit of the WHOLE cost when we fronted a shared bill", () => {
    // 4,000 bill, our share 2,000, so net +2,000 — but the bank saw all 4,000 leave.
    assert.equal(expectedCash("expense", 400000, 200000), -400000);
  });

  it("expects NOTHING when someone else paid for us", () => {
    // The consumption case. No bank row exists, and hunting for one is how a coincidence
    // becomes a match.
    assert.equal(expectedCash("expense", 300000, -150000), null);
  });

  it("expects nothing for an expense we have no share in", () => {
    assert.equal(expectedCash("expense", 90000, 0), null);
  });

  it("expects a DEBIT when we pay a settlement", () => {
    // positive net = we gave value, so cash left the account
    assert.equal(expectedCash("payment", 50000, 50000), -50000);
  });

  it("expects a CREDIT when we receive a settlement", () => {
    assert.equal(expectedCash("payment", 50000, -50000), 50000);
  });

  it("treats a zero-value settlement as nothing to find", () => {
    assert.equal(expectedCash("payment", 0, 0), null);
  });
});

describe("matchToTransaction", () => {
  it("matches an exact amount on the same day", () => {
    const result = matchToTransaction(request(-400000), [txn("1", "2026-01-15", -400000)]);
    assert.deepEqual(result, { kind: "matched", transactionId: "1", dayGap: 0 });
  });

  it("matches inside the date window and reports the gap", () => {
    const result = matchToTransaction(request(-400000), [txn("1", "2026-01-17", -400000)]);
    assert.deepEqual(result, { kind: "matched", transactionId: "1", dayGap: 2 });
  });

  it("accepts a candidate exactly at the window edge", () => {
    const at = matchToTransaction(request(-400000), [
      txn("1", `2026-01-${15 + DEFAULT_WINDOW_DAYS}`, -400000),
    ]);
    assert.equal(at.kind, "matched");
  });

  it("refuses a candidate one day outside the window", () => {
    const outside = matchToTransaction(request(-400000), [
      txn("1", `2026-01-${16 + DEFAULT_WINDOW_DAYS}`, -400000),
    ]);
    assert.deepEqual(outside, { kind: "none" });
  });

  it("refuses an amount that is merely close", () => {
    // One paise out is a different payment. An approximate match on money attaches the
    // receipt to the wrong row, and both then look consistent.
    assert.deepEqual(
      matchToTransaction(request(-400000), [txn("1", "2026-01-15", -400001)]),
      { kind: "none" },
    );
  });

  it("refuses a credit when a debit is expected, however well it matches", () => {
    assert.deepEqual(
      matchToTransaction(request(-400000), [txn("1", "2026-01-15", 400000)]),
      { kind: "none" },
    );
  });

  it("queues rather than guessing when two rows both qualify", () => {
    // Two identical payments on one day are indistinguishable here, and a tiebreak would be
    // a coin flip recorded as a fact.
    const result = matchToTransaction(request(-50000), [
      txn("1", "2026-01-15", -50000),
      txn("2", "2026-01-16", -50000),
    ]);
    assert.deepEqual(result, { kind: "ambiguous", transactionIds: ["1", "2"] });
  });

  it("is not confused by non-matching rows around a single good one", () => {
    const result = matchToTransaction(request(-50000), [
      txn("1", "2026-01-15", -50001),
      txn("2", "2026-01-15", -50000),
      txn("3", "2026-01-15", 50000),
      txn("4", "2026-02-15", -50000),
    ]);
    assert.deepEqual(result, { kind: "matched", transactionId: "2", dayGap: 0 });
  });

  it("finds nothing in an empty candidate set", () => {
    assert.deepEqual(matchToTransaction(request(-400000), []), { kind: "none" });
  });

  it("keeps transaction ids as strings, never narrowing a BIGINT", () => {
    const big = "9007199254740993"; // beyond Number.MAX_SAFE_INTEGER
    const result = matchToTransaction(request(-400000), [txn(big, "2026-01-15", -400000)]);
    assert.equal(result.kind === "matched" && result.transactionId, big);
  });
});

describe("resolvePrecedence", () => {
  const alloc = (
    id: string,
    source: "rule" | "user" | "evidence",
    confirmed_from_rule_id: string | null = null,
  ): ExistingAllocation => ({ id, source, confirmed_from_rule_id });

  it("writes freely when nothing explains the transaction yet", () => {
    assert.deepEqual(resolvePrecedence([]), { action: "write" });
  });

  it("displaces a rule's guess", () => {
    assert.deepEqual(resolvePrecedence([alloc("1", "rule")]), {
      action: "displace",
      allocationIds: ["1"],
    });
  });

  it("displaces a BULK-CONFIRMED rule guess", () => {
    // The case that motivated this: 254 rows were accepted in one action and recorded with
    // the same authority as a deliberate decision. An order receipt outranks a nod.
    const decision = resolvePrecedence([alloc("1", "user", "42")]);
    assert.deepEqual(decision, { action: "displace", allocationIds: ["1"] });
  });

  it("REFUSES to displace an allocation a human authored directly", () => {
    const decision = resolvePrecedence([alloc("1", "user", null)]);
    assert.equal(decision.action, "conflict");
    assert.match(decision.action === "conflict" ? decision.reason : "", /authored/);
  });

  it("lets one authored row veto a whole set of displaceable ones", () => {
    // Mixed: the deliberate decision wins, and nothing is touched.
    const decision = resolvePrecedence([
      alloc("1", "rule"),
      alloc("2", "user", "42"),
      alloc("3", "user", null),
    ]);
    assert.equal(decision.action, "conflict");
    assert.deepEqual(decision.action === "conflict" ? decision.allocationIds : [], ["3"]);
  });

  it("queues when another external record already explains the transaction", () => {
    // One debit covering two orders — the design says queue, never pick.
    const decision = resolvePrecedence([alloc("1", "evidence")]);
    assert.equal(decision.action, "conflict");
    assert.match(decision.action === "conflict" ? decision.reason : "", /another external record/);
  });

  it("prefers the authored-row conflict message over the evidence one", () => {
    const decision = resolvePrecedence([alloc("1", "evidence"), alloc("2", "user", null)]);
    assert.match(decision.action === "conflict" ? decision.reason : "", /authored/);
  });
});
