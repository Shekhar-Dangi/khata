import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ERROR_KINDS,
  type Counts,
  estimateRemaining,
  explain,
  fractionDone,
  isErrorKind,
  isSettled,
  isTransient,
  retryPolicy,
} from "./parse-queue-policy.ts";

const counts = (o: Partial<Counts>): Counts => ({
  total: 0, queued: 0, running: 0, done: 0, failed: 0, ...o,
});

describe("retryPolicy", () => {
  it("classifies every declared kind", () => {
    // The guard that matters: a member added to ERROR_KINDS without a case in the switch is a
    // compile error, and this asserts the runtime half — nothing falls through to undefined.
    for (const kind of ERROR_KINDS) {
      const policy = retryPolicy(kind);
      assert.ok(policy === "transient" || policy === "permanent", `${kind} -> ${policy}`);
    }
  });

  it("retries a machine failure", () => {
    assert.equal(retryPolicy("llm_unavailable"), "transient");
    assert.equal(retryPolicy("worker_died"), "transient");
    assert.equal(retryPolicy("extract_crashed"), "transient");
  });

  it("does NOT retry a settled fact about the document", () => {
    // The whole point of the classification: the arithmetic gate is deterministic, so a
    // second attempt spends the model to reach the same answer.
    assert.equal(retryPolicy("does_not_reconcile"), "permanent");
    assert.equal(retryPolicy("encrypted"), "permanent");
    assert.equal(retryPolicy("too_large"), "permanent");
  });

  it("does not retry a document already in the ledger", () => {
    // Succeeding here would be the bug, not the fix.
    assert.equal(retryPolicy("duplicate_order"), "permanent");
  });

  it("treats a missing install as setup, not as a retry", () => {
    // Spinning three times makes one missing install look like three broken documents.
    assert.equal(retryPolicy("models_missing"), "permanent");
  });

  it("fails closed on the unnamed", () => {
    assert.equal(retryPolicy("unknown"), "permanent");
  });

  it("isTransient agrees with retryPolicy", () => {
    for (const kind of ERROR_KINDS) {
      assert.equal(isTransient(kind), retryPolicy(kind) === "transient", kind);
    }
  });
});

describe("isErrorKind", () => {
  it("accepts the vocabulary and nothing else", () => {
    assert.ok(isErrorKind("does_not_reconcile"));
    assert.ok(!isErrorKind("DOES_NOT_RECONCILE"));
    assert.ok(!isErrorKind("made up"));
    assert.ok(!isErrorKind(""));
    assert.ok(!isErrorKind(null));
    assert.ok(!isErrorKind(7));
  });
});

describe("explain", () => {
  it("has a sentence for every kind, and none of them is the kind itself", () => {
    for (const kind of ERROR_KINDS) {
      const text = explain(kind);
      assert.ok(text.length > 10, kind);
      assert.notEqual(text, kind);
      // A message a person reads should not leak the key the code dispatches on.
      assert.ok(!text.includes("_"), `${kind}: ${text}`);
    }
  });
});

describe("estimateRemaining", () => {
  it("is null before anything has finished", () => {
    // The first batch has no rate. Inventing one produces a countdown that is confidently
    // wrong for ten minutes, which is worse than showing nothing.
    assert.equal(estimateRemaining(counts({ total: 80, queued: 80 }), null), null);
  });

  it("is null rather than infinite when the median is nonsense", () => {
    assert.equal(estimateRemaining(counts({ queued: 5 }), 0), null);
    assert.equal(estimateRemaining(counts({ queued: 5 }), -3), null);
  });

  it("counts running jobs as outstanding", () => {
    assert.equal(estimateRemaining(counts({ queued: 9, running: 1 }), 30), 300);
  });

  it("is zero when nothing is outstanding", () => {
    assert.equal(estimateRemaining(counts({ total: 5, done: 5 }), 30), 0);
  });
});

describe("isSettled", () => {
  it("is true when nothing is queued or running", () => {
    assert.ok(isSettled(counts({ total: 3, done: 2, failed: 1 })));
  });

  it("does not require done + failed to equal total", () => {
    // Enqueue skips documents already outstanding elsewhere, so the total is corrected and
    // an equality test would leave the bar unable to reach its own end.
    assert.ok(isSettled(counts({ total: 10, done: 4, failed: 1 })));
  });

  it("is false while work remains", () => {
    assert.ok(!isSettled(counts({ total: 3, queued: 1, done: 2 })));
    assert.ok(!isSettled(counts({ total: 3, running: 1, done: 2 })));
  });
});

describe("fractionDone", () => {
  it("never divides by zero", () => {
    assert.equal(fractionDone(counts({})), 0);
  });

  it("counts failures as finished", () => {
    // A failed document is not still being worked on. Leaving it out of the numerator makes
    // a batch with three bad files sit at 97% forever.
    assert.equal(fractionDone(counts({ total: 4, done: 2, failed: 2 })), 1);
  });

  it("is clamped to 1 when more finished than the total claimed", () => {
    assert.equal(fractionDone(counts({ total: 2, done: 5 })), 1);
  });

  it("reports partial progress", () => {
    assert.equal(fractionDone(counts({ total: 10, done: 3, queued: 7 })), 0.3);
  });
});
