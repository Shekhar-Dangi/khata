import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { type Candidate, matchToTransaction, nearMisses } from "./match.ts";
import { normaliseNarration, narrationIdentifies } from "./merchants.ts";

// Narration shapes below are the REAL formats in the ledger with the digits changed. All 11
// Blinkit token variants seen across four payment processors are represented.
const txn = (over: Partial<Candidate> = {}): Candidate => ({
  id: "1",
  txn_date: "2026-08-08",
  amount_paise: -12000,
  narration: "UPI-Debit-000000000000-Blinkit-HDFC0MERUPI-blinkit.rzp@hdfcbank",
  ...over,
});

describe("normaliseNarration", () => {
  it("strips zero-width characters that hide inside merchant names", () => {
    // Real bank narrations contain these. `f​lipkart` renders as "flipkart" in
    // every view you would debug in, and `includes("flipkart")` is false. This is the whole
    // reason normalisation exists rather than a bare toLowerCase().
    assert.equal(normaliseNarration("f​lipkartpayment"), "flipkartpayment");
    assert.equal(normaliseNarration("BLINK﻿IT"), "blinkit");
  });

  it("folds case and collapses whitespace", () => {
    assert.equal(normaliseNarration("UPI-BLINKIT   COMMERCE  PRI"), "upi-blinkit commerce pri");
  });

  it("keeps punctuation, which carries identity", () => {
    assert.equal(normaliseNarration("blinkit.payu@hdfcbank"), "blinkit.payu@hdfcbank");
  });

  it("treats null as empty rather than throwing", () => {
    assert.equal(normaliseNarration(null), "");
  });
});

describe("narrationIdentifies", () => {
  it("recognises every Blinkit processor variant in the ledger", () => {
    for (const n of [
      "UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-000000000000-PA",
      "UPI-BLINKIT-BLINKIT.PAYU@HDFCBANK-HDFC0MERUPI-000000000000-U",
      "UPI-Debit-000000000000-Blinkit-PYTM0123456-paytm-blinkit@ptybl",
      "UPI-Debit-000000000000-Blinkit-HDFC0MERUPI-blinkit.rzp@hdfc",
    ]) {
      assert.ok(narrationIdentifies(n, "blinkit"), n);
    }
  });

  it("recognises the FORMER company name still used by one processor", () => {
    // Paytm routes Blinkit under Grofers, the old name. A token list built from the current
    // brand alone would miss these rows entirely.
    assert.ok(
      narrationIdentifies("UPI-BLINKIT COMMERCE PRI-GROFERS1PAYTM@HDFCBANK", "blinkit"),
    );
  });

  it("rejects a different merchant", () => {
    assert.equal(narrationIdentifies("UPI-Debit-000-flipkartpayment-utib", "blinkit"), false);
    assert.equal(narrationIdentifies("UPI-Debit-000-Swiggy Ltd-UTIB", "amazon"), false);
  });

  it("returns TRUE for a source with no merchant signal", () => {
    // Splitwise settlements name a PERSON. Requiring a merchant token would reject every
    // genuine match, so the filter must not apply at all.
    assert.ok(narrationIdentifies("UPI-Credit-000-SOME PERSON-HDFC", "splitwise"));
  });

  it("returns TRUE for a source it has never heard of", () => {
    // The safe direction for a hard filter: an unknown source must not silently reject
    // everything and turn a working matcher into one that finds nothing.
    assert.ok(narrationIdentifies("anything at all", "zepto"));
  });

  it("rejects an empty narration for a source that HAS a signal", () => {
    assert.equal(narrationIdentifies(null, "blinkit"), false);
    assert.equal(narrationIdentifies("   ", "amazon"), false);
  });
});

describe("the Flipkart defect, reproduced and fixed", () => {
  // Found on real data: an Amazon order had exactly ONE in-window candidate — a FLIPKART
  // debit of the same amount, two days earlier. The values below are synthetic.
  const flipkart = txn({
    id: "403",
    txn_date: "2026-08-06",
    narration: "UPI-Debit-000000000000-f​lipkartpayment-utib0000100-f​lipkart.payu@axisbank",
  });
  const request = { externalRef: "ORDER0001", date: "2026-08-08", expectedPaise: -12000 };

  it("AUTO-ACCEPTED the wrong transaction before the filter existed", () => {
    // Exactly the old behaviour: no sourceType, so no merchant filter.
    const outcome = matchToTransaction(request, [flipkart]);
    assert.equal(outcome.kind, "matched");
    assert.equal(outcome.kind === "matched" && outcome.transactionId, "403");
  });

  it("finds nothing once the merchant is a hard filter", () => {
    const outcome = matchToTransaction({ ...request, sourceType: "amazon" }, [flipkart]);
    assert.equal(outcome.kind, "none");
  });

  it("still matches the RIGHT transaction", () => {
    const amazon = txn({
      id: "500",
      txn_date: "2026-08-08",
      narration: "POS 000000XXXXXX0000 000000000000 08AUG26 WWW AMAZON",
    });
    const outcome = matchToTransaction({ ...request, sourceType: "amazon" }, [flipkart, amazon]);
    assert.equal(outcome.kind, "matched");
    assert.equal(outcome.kind === "matched" && outcome.transactionId, "500");
  });

  it("disqualifies BEFORE the 1:1 test, so a wrong row cannot create ambiguity either", () => {
    // Two same-amount rows in window, one of them the right merchant. Filtering after the
    // count would report `ambiguous` and send a decided record to a human for no reason.
    const amazon = txn({ id: "500", narration: "POS 000000 08AUG26 WWW AMAZON" });
    const outcome = matchToTransaction({ ...request, sourceType: "amazon" }, [flipkart, amazon]);
    assert.equal(outcome.kind, "matched");
  });

  it("keeps Splitwise behaviour byte-for-byte unchanged", () => {
    const person = txn({ id: "9", narration: "UPI-Credit-000000000000-A PERSON-HDFC0000000" });
    const withSource = matchToTransaction({ ...request, sourceType: "splitwise" }, [person]);
    const without = matchToTransaction(request, [person]);
    assert.deepEqual(withSource, without);
    assert.equal(withSource.kind, "matched");
  });
});

describe("near misses obey the same filter", () => {
  it("does not offer a Flipkart row as a near miss for an Amazon order", () => {
    const flipkart = txn({
      id: "403",
      txn_date: "2026-07-29",
      narration: "UPI-Debit-000000000000-FLIPKART PAYMENTS-HDFC0MERUPI",
    });
    const request = { externalRef: "ORDER0001", date: "2026-08-05", expectedPaise: -12000 };
    assert.equal(nearMisses(request, [flipkart]).length, 1, "7 days out, so it IS a near miss");
    assert.equal(nearMisses({ ...request, sourceType: "amazon" }, [flipkart]).length, 0);
  });
});
