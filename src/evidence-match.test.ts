import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type Candidate,
  type Claim,
  DEFAULT_WINDOW_DAYS,
  type ExistingAllocation,
  claimOn,
  expectedCash,
  matchToTransaction,
  nearMisses,
  resolvePrecedence,
  splitProportionally,
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
      authoredIds: [],
    });
  });

  it("displaces a BULK-CONFIRMED rule guess", () => {
    // The case that motivated this: hundreds of rows were accepted in one action and recorded with
    // the same authority as a deliberate decision. An order receipt outranks a nod.
    const decision = resolvePrecedence([alloc("1", "user", "42")]);
    assert.deepEqual(decision, { action: "displace", allocationIds: ["1"], authoredIds: [] });
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
    // One debit covering two orders — queue it, never pick one.
    const decision = resolvePrecedence([alloc("1", "evidence")]);
    assert.equal(decision.action, "conflict");
    assert.match(decision.action === "conflict" ? decision.reason : "", /another external record/);
  });

  it("prefers the authored-row conflict message over the evidence one", () => {
    const decision = resolvePrecedence([alloc("1", "evidence"), alloc("2", "user", null)]);
    assert.match(decision.action === "conflict" ? decision.reason : "", /authored/);
  });

  // ── authority ────────────────────────────────────────────────────────────────────────
  // Tier 1 protects a person from a MACHINE, not from themselves. Refusing someone who
  // ticked this exact transaction on this exact record is not protection — it is a dead end
  // whose only exit is SQL.

  it("still refuses the automatic matcher, which is the default", () => {
    assert.equal(resolvePrecedence([alloc("1", "user", null)]).action, "conflict");
    assert.equal(resolvePrecedence([alloc("1", "user", null)], "auto").action, "conflict");
  });

  it("lets a PERSON displace what they authored, and names what it destroys", () => {
    const decision = resolvePrecedence([alloc("1", "user", null), alloc("2", "rule")], "user");
    assert.equal(decision.action, "displace");
    if (decision.action !== "displace") return;
    assert.deepEqual([...decision.allocationIds].sort(), ["1", "2"]);
    // The destructive subset, separately: "replaced a rule's guess" and "replaced something
    // you wrote" are not the same warning, and the second one has to be earned.
    assert.deepEqual(decision.authoredIds, ["1"]);
  });

  // Refused for BOTH authorities, and not out of caution: displacing the other record's
  // allocations would leave it LINKED but explaining nothing — reading as "matched" in the
  // worklist while carrying no money. Unlinking that record first is the way to say
  // "this one, not that one", and it leaves both rows meaning what they say.
  it("refuses a second external record even when a person asks", () => {
    const decision = resolvePrecedence([alloc("1", "evidence")], "user");
    assert.equal(decision.action, "conflict");
    assert.match(decision.action === "conflict" ? decision.reason : "", /another external record/);
  });
});

describe("claimOn", () => {
  const alloc = (
    id: string,
    source: "rule" | "user" | "evidence",
    confirmed_from_rule_id: string | null = null,
  ): ExistingAllocation => ({ id, source, confirmed_from_rule_id });

  const claim = (existing: ExistingAllocation[]): Claim => claimOn(existing);

  // The four answers are what the manual matcher SAYS before the button; the tiers behind
  // them are resolvePrecedence's, which is why this function delegates rather than
  // restating them. A test per answer, plus the one ordering that is easy to get wrong.
  it("says free when nothing explains the transaction", () => {
    assert.equal(claim([]), "free");
  });

  it("says yours when a person wrote the explanation — a manual link may remove it", () => {
    assert.equal(claim([alloc("1", "user", null)]), "yours");
  });

  it("says replaces when only a rule's guess — or a bulk-confirmed one — stands there", () => {
    assert.equal(claim([alloc("1", "rule")]), "replaces");
    assert.equal(claim([alloc("1", "user", "42")]), "replaces");
  });

  it("says refused where the server would refuse even a person — another record's evidence", () => {
    assert.equal(claim([alloc("1", "evidence")]), "refused");
  });

  it("refusal outranks yours: a person's row AND another record's is refused", () => {
    // resolvePrecedence turns back for the second record whoever is asking, and the screen
    // must not promise a link that will 409. Unlink that record first.
    assert.equal(claim([alloc("1", "user", null), alloc("2", "evidence")]), "refused");
  });
});

describe("nearMisses", () => {
  it("surfaces an exact-amount candidate just outside the accept window", () => {
    // The shape of a real case: "weekly veg" against "Sharma Traders", 7 days apart.
    const found = nearMisses(request(-174100), [txn("186", "2026-01-22", -174100, "Sharma Traders")]);
    assert.equal(found.length, 1);
    assert.equal(found[0].dayGap, 7);
    assert.equal(found[0].narration, "Sharma Traders");
  });

  it("excludes anything already inside the accept window", () => {
    // Those are matched outright; a near miss is only what the date rule held back.
    assert.deepEqual(nearMisses(request(-50000), [txn("1", "2026-01-16", -50000)]), []);
  });

  it("excludes anything past the near bound", () => {
    assert.deepEqual(nearMisses(request(-50000), [txn("1", "2026-02-20", -50000)]), []);
  });

  it("still demands an exact amount and the right direction", () => {
    const found = nearMisses(request(-50000), [
      txn("1", "2026-01-23", -50001),  // a paise out
      txn("2", "2026-01-23", 50000),   // a credit
    ]);
    assert.deepEqual(found, []);
  });

  it("returns every candidate, nearest first, rather than choosing one", () => {
    // Two qualifying rows is information for the human, not a tiebreak for us.
    const found = nearMisses(request(-50000), [
      txn("1", "2026-01-24", -50000, "later"),
      txn("2", "2026-01-20", -50000, "nearer"),
    ]);
    assert.deepEqual(found.map((f) => f.narration), ["nearer", "later"]);
    assert.deepEqual(found.map((f) => f.dayGap), [5, 9]);
  });

  it("looks backwards as well as forwards", () => {
    // The real cases were both BEFORE the Splitwise date — paid at the shop, entered later.
    const found = nearMisses(request(-50000), [txn("1", "2026-01-08", -50000)]);
    assert.equal(found[0]?.dayGap, 7);
  });
});

describe("splitProportionally", () => {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it("splits a 6,000 expense across a 1,000 and a 5,000 payment", () => {
    // The case that motivated the link table: one record, two bank rows.
    assert.deepEqual(splitProportionally(-600000, [-100000, -500000]), [-100000, -500000]);
  });

  it("splits a share proportionally, not evenly", () => {
    // Your Rs 3,000 half of that expense follows the same 1:5 shape.
    assert.deepEqual(splitProportionally(-300000, [-100000, -500000]), [-50000, -250000]);
  });

  it("ALWAYS sums to the total, whatever the rounding", () => {
    // Three-way splits are where naive rounding invents or destroys a paise. 1000/3 is
    // 33333.33 each; three independent Math.rounds give 100,001 or 99,999.
    const parts = splitProportionally(-100000, [-1, -1, -1]);
    assert.equal(sum(parts), -100000);
    assert.equal(parts.length, 3);
  });

  it("keeps the total exact across many awkward divisions", () => {
    for (const total of [-100000, -1, -7, -999999, 123457]) {
      for (const n of [2, 3, 7, 11]) {
        const weights = Array.from({ length: n }, (_, i) => -(i + 1));
        assert.equal(sum(splitProportionally(total, weights)), total, `${total} over ${n}`);
      }
    }
  });

  it("gives a single transaction the whole amount", () => {
    assert.deepEqual(splitProportionally(-274500, [-274500]), [-274500]);
  });

  it("returns nothing for no transactions", () => {
    assert.deepEqual(splitProportionally(-1000, []), []);
  });

  it("falls back to an even split rather than NaN when every weight is zero", () => {
    const parts = splitProportionally(-1000, [0, 0]);
    assert.equal(sum(parts), -1000);
  });

  it("does not care that the selected total differs from the amount being split", () => {
    // Paid 2,745 but entered 2,700: the record's own 2,700 is what gets allocated, and the
    // 45 difference becomes the transaction's unexplained remainder, never scaled away.
    assert.deepEqual(splitProportionally(-270000, [-274500]), [-270000]);
  });
});
