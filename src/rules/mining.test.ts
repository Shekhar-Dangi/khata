import test from "node:test";
import assert from "node:assert/strict";

import {
  candidateTokens,
  isNoise,
  isRailNoise,
  merchantHint,
  mineCandidates,
} from "./mining.ts";
import type { MineableRule, MineableTxn } from "./mining.ts";

// A transaction, minimally. `categories` empty means unexplained.
const txn = (id: string, narration: string, categories: string[] = []): MineableTxn => ({
  id,
  narration,
  amount_paise: -10000,
  txn_date: "2026-08-01",
  categories,
});

const rule = (name: string, value: string): MineableRule => ({
  name,
  conditions: [{ field: "narration", op: "contains", value }],
  match_mode: "all",
});

// ── rail noise ────────────────────────────────────────────────────────────────
// The shape test, not a word list. These are the strings that say which bank issued a
// UPI handle, which is the plumbing rather than the payee.

test("isRailNoise rejects bare handle suffixes", () => {
  assert.equal(isRailNoise("@ybl"), true);
  assert.equal(isRailNoise("@axl"), true);
});

test("isRailNoise rejects handles whose local part is a stub or a number", () => {
  assert.equal(isRailNoise("2@ybl"), true);
  assert.equal(isRailNoise("bd@axisbank"), true);
});

test("isRailNoise rejects IFSC-shaped tokens", () => {
  assert.equal(isRailNoise("yesb0yblupi"), true);
  assert.equal(isRailNoise("sbin0001234"), true);
});

test("isRailNoise KEEPS a handle whose local part is a real merchant", () => {
  // The whole point of the shape test: amazon@yapl is a merchant, @ybl is a bank.
  assert.equal(isRailNoise("amazon@yapl"), false);
  assert.equal(isRailNoise("eatclub@ptybl"), false);
});

test("narration boilerplate is noise", () => {
  // "UPI REQUEST FROM <merchant> BRANCH ATM SERVICE" is a bank's template. A rule on
  // `atm` labels Amazon Pay groceries as cash withdrawals.
  for (const word of ["atm", "branch", "request", "ltd", "pvt", "india"]) {
    assert.equal(isNoise(word), true, `${word} should be noise`);
  }
  assert.equal(isNoise("eatclub"), false);
  assert.equal(isNoise("euronet"), false);
});

// ── tokenisation ──────────────────────────────────────────────────────────────

test("candidateTokens normalises before splitting", () => {
  // normalise() lowercases, turns separators into spaces and strips 6+ digit runs, so the
  // miner sees exactly what the matcher will see.
  const tokens = candidateTokens("UPI-Debit-123456789012-EATCLUB-HDFC");
  assert.ok(tokens.includes("eatclub"));
  assert.ok(!tokens.some((t) => t.includes("123456789012")));
});

test("candidateTokens drops pure noise unigrams but keeps a mixed bigram", () => {
  const tokens = candidateTokens("AMAZON INDIA RETAIL");
  assert.ok(!tokens.includes("india"), "india alone is boilerplate");
  assert.ok(tokens.includes("amazon"));
  assert.ok(tokens.includes("amazon india"), "one content word keeps the pair");
});

test("candidateTokens drops a bigram of two rail tokens", () => {
  const tokens = candidateTokens("PAY @ybl @axl HERE");
  assert.ok(!tokens.includes("@ybl @axl"));
});

test("candidateTokens ignores words of two characters or fewer", () => {
  assert.deepEqual(candidateTokens("a bc"), []);
});

// ── mining ────────────────────────────────────────────────────────────────────

test("mineCandidates finds a merchant cluster and counts its hits", () => {
  const unexplained = [
    txn("1", "UPI-DEBIT-EATCLUB-HDFC"),
    txn("2", "UPI-DEBIT-EATCLUB-AXIS"),
    txn("3", "POS/EATCLUB/ORDER"),
  ];
  const got = mineCandidates(unexplained, unexplained, [], { minHits: 3 });
  const eatclub = got.find((c) => c.value === "eatclub");
  assert.ok(eatclub, "expected an eatclub candidate");
  assert.equal(eatclub.unexplainedHits, 3);
  assert.deepEqual(eatclub.ids.sort(), ["1", "2", "3"]);
});

test("minHits suppresses a cluster that is too small to be a rule", () => {
  const unexplained = [txn("1", "ZOMATO ORDER"), txn("2", "ZOMATO ORDER")];
  const got = mineCandidates(unexplained, unexplained, [], { minHits: 3 });
  assert.equal(got.find((c) => c.value === "zomato"), undefined);
});

test("spread counts DISTINCT categories on rows the rule would also touch", () => {
  // This is the over-broadness signal. `paytm` here is a payment rail: the rows it
  // already touches mean three different things, so no single category is honest.
  const unexplained = [
    txn("1", "PAYTM PAYMENT"),
    txn("2", "PAYTM PAYMENT"),
    txn("3", "PAYTM PAYMENT"),
  ];
  const ledger = [
    ...unexplained,
    txn("4", "PAYTM PAYMENT", ["Groceries"]),
    txn("5", "PAYTM PAYMENT", ["Friends"]),
    txn("6", "PAYTM PAYMENT", ["Food & Dining"]),
  ];
  const paytm = mineCandidates(unexplained, ledger, [], { minHits: 3 })
    .find((c) => c.value === "paytm");
  assert.ok(paytm);
  assert.equal(paytm.spread, 3);
  assert.equal(paytm.explainedHits, 3);
});

test("a large but UNAMBIGUOUS cluster is kept — breadth is not over-broadness", () => {
  // The miner originally capped breadth at 15% and that silently discarded bare `amazon`
  // (81 of 410 rows). A merchant being a large share of spending is what makes a rule
  // valuable; spread is what says whether it is honest.
  const unexplained = [txn("1", "AMAZON"), txn("2", "AMAZON"), txn("3", "AMAZON")];
  const ledger = [
    ...unexplained,
    ...Array.from({ length: 60 }, (_, i) => txn(`e${i}`, "AMAZON", ["Groceries"])),
    ...Array.from({ length: 20 }, (_, i) => txn(`o${i}`, "SOMETHING ELSE", ["Rent"])),
  ];
  const amazon = mineCandidates(unexplained, ledger, [], { minHits: 3 })
    .find((c) => c.value === "amazon");
  assert.ok(amazon, "a high-breadth candidate must survive when spread is 1");
  assert.equal(amazon.spread, 1);
  assert.ok(
    amazon.breadth > 0.5,
    `expected a deliberately broad candidate, got breadth ${amazon.breadth}`,
  );
});

test("collidesWith names an existing rule that already claims every row", () => {
  const unexplained = [
    txn("1", "SWIGGY ORDER"),
    txn("2", "SWIGGY ORDER"),
    txn("3", "SWIGGY ORDER"),
  ];
  const got = mineCandidates(unexplained, unexplained, [rule("Swiggy", "swiggy")], {
    minHits: 3,
  });
  const swiggy = got.find((c) => c.value === "swiggy");
  assert.ok(swiggy);
  assert.equal(swiggy.collidesWith, "Swiggy");
});

test("results are sorted safe-first: spread ascending, then reach", () => {
  const unexplained = [
    ...Array.from({ length: 5 }, (_, i) => txn(`p${i}`, "PAYTM PAYMENT")),
    ...Array.from({ length: 3 }, (_, i) => txn(`e${i}`, "EATCLUB ORDER")),
  ];
  const ledger = [
    ...unexplained,
    txn("x1", "PAYTM PAYMENT", ["Groceries"]),
    txn("x2", "PAYTM PAYMENT", ["Friends"]),
  ];
  const got = mineCandidates(unexplained, ledger, [], { minHits: 3 });
  const eat = got.findIndex((c) => c.value === "eatclub");
  const paytm = got.findIndex((c) => c.value === "paytm");
  assert.ok(eat >= 0 && paytm >= 0);
  assert.ok(
    eat < paytm,
    "a clean 3-hit cluster must outrank an ambiguous 5-hit one",
  );
});

test("a bigram claiming exactly its unigram's rows is dropped as redundant", () => {
  const unexplained = [
    txn("1", "EATCLUB ORDER"),
    txn("2", "EATCLUB ORDER"),
    txn("3", "EATCLUB ORDER"),
  ];
  const got = mineCandidates(unexplained, unexplained, [], { minHits: 3 });
  const values = got.map((c) => c.value);
  assert.ok(values.includes("eatclub"));
  assert.ok(
    !values.includes("eatclub order"),
    "the extra word buys nothing when the row set is identical",
  );
});

test("never proposes a rule that cannot fire", () => {
  // normalise strips runs of 6+ digits, so a numeric candidate reduces to "" and hits the
  // empty-needle guard in `matches` — it would save fine and silently never match.
  const unexplained = [
    txn("1", "REF 123456789012 PAID"),
    txn("2", "REF 123456789012 PAID"),
    txn("3", "REF 123456789012 PAID"),
  ];
  const got = mineCandidates(unexplained, unexplained, [], { minHits: 3 });
  for (const c of got) {
    assert.notEqual(c.value.trim(), "", "empty candidate proposed");
    assert.ok(
      c.unexplainedHits > 0,
      `candidate "${c.value}" matches nothing — it could never fire`,
    );
  }
});

test("handles an empty ledger without dividing by zero", () => {
  const got = mineCandidates([], [], [], { minHits: 3 });
  assert.deepEqual(got, []);
});

// ── merchantHint ──────────────────────────────────────────────────────────────
// What gets sent to a model instead of the raw narration.

test("merchantHint keeps the merchant and drops the rail", () => {
  const hint = merchantHint("UPI-Debit-987654321098-SPICE GARDEN MAIN RD-PYTM-@ptybl");
  assert.ok(hint.includes("spice"), `expected the merchant, got "${hint}"`);
  assert.ok(!hint.includes("@ptybl"), "handle suffix should be gone");
  assert.ok(!hint.includes("987654321098"), "reference number should be gone");
});

test("merchantHint drops the word that made the model pick a category named `debit`", () => {
  // The narration contains "debit" and the tree contains a category literally named
  // `debit`, so the model matched a string rather than a meaning. Removing banking
  // vocabulary removes the trap at the source.
  assert.ok(!merchantHint("UPI-Debit-SNITCH APPARELS").includes("debit"));
});

test("merchantHint returns unigrams only, in narration order", () => {
  // Bigrams are for matching a rule. A model reads a phrase, and "amazon amazon india"
  // is noise.
  assert.equal(merchantHint("AMAZON INDIA RETAIL PVT"), "amazon");
});

test("merchantHint is empty when a narration is nothing but rail", () => {
  // Empty is the honest answer, and the caller must treat it as "nothing to ask about"
  // rather than sending an empty prompt to the model.
  assert.equal(merchantHint("UPI-DEBIT-PAYMENT-FROM-@ybl"), "");
});
