import test from "node:test";
import assert from "node:assert/strict";

import { normalise, matches, compareRules, chooseWinner } from "./rules.ts";
import type {
  MatchableRule,
  MatchableTransaction,
  RankableRule,
} from "./rules.ts";

// Fixtures. Narrations are real shapes: three from db/mock.sql, one the noisy
// UPI form a live HDFC statement produces.
function txn(over: Partial<MatchableTransaction> = {}): MatchableTransaction {
  return {
    narration: "UPI-Debit-Amazon India",
    amount_paise: -230000,
    txn_date: "2026-06-03",
    ...over,
  };
}

function rule(over: Partial<MatchableRule> = {}): MatchableRule {
  return { conditions: [], match_mode: "all", ...over };
}

// ── normalise ───────────────────────────────────────────────────────────────

test("normalise lowercases and splits separators", () => {
  assert.equal(normalise("UPI-Debit-Amazon India"), "upi debit amazon india");
  assert.equal(normalise("POS/SWIGGY*ORDER/BANGALORE"), "pos swiggy order bangalore");
  assert.equal(normalise("UPI-Debit-airtel.pay"), "upi debit airtel pay");
  assert.equal(normalise("UPI-Debit-EatClub"), "upi debit eatclub");
});

test("normalise strips reference numbers but keeps short digit runs", () => {
  assert.equal(
    normalise("UPI-Debit-123456789012-BLINKIT-HDFC-blinkit"),
    "upi debit blinkit hdfc blinkit",
  );
  // 4 digits survive — "card ending 1234" is information, not noise.
  assert.equal(normalise("POS card ending 1234"), "pos card ending 1234");
  // Exactly 6 is the floor, so it goes.
  assert.equal(normalise("ref 123456 paid"), "ref paid");
  assert.equal(normalise("ref 12345 paid"), "ref 12345 paid");
});

test("normalise is total — null and empty are not crashes", () => {
  assert.equal(normalise(null), "");
  assert.equal(normalise(""), "");
  assert.equal(normalise("   "), "");
  assert.equal(normalise("---"), "");
});

test("normalise is idempotent", () => {
  // Running it on its own output must change nothing. If this ever fails, some
  // rule authored through the UI will match in testing and miss in production.
  for (const s of [
    "UPI-Debit-123456789012-BLINKIT-HDFC",
    "POS/SWIGGY*ORDER",
    "  spaced   out  ",
    "",
  ]) {
    assert.equal(normalise(normalise(s)), normalise(s), `not idempotent for ${s}`);
  }
});

// ── matches: narration ──────────────────────────────────────────────────────

test("contains matches case-insensitively on BOTH sides", () => {
  const r = rule({
    conditions: [{ field: "narration", op: "contains", value: "AMAZON" }],
  });
  assert.equal(matches(txn(), r), true);
});

test("contains sees through separators and reference numbers", () => {
  const r = rule({
    conditions: [{ field: "narration", op: "contains", value: "blinkit" }],
  });
  const t = txn({ narration: "UPI-Debit-123456789012-BLINKIT-HDFC-blinkit" });
  assert.equal(matches(t, r), true);
});

test("a null narration matches nothing rather than throwing", () => {
  const r = rule({
    conditions: [{ field: "narration", op: "contains", value: "amazon" }],
  });
  assert.equal(matches(txn({ narration: null }), r), false);
});

test("an empty needle does not match everything", () => {
  // "".includes("") is true — the trap this guards.
  const r = rule({
    conditions: [{ field: "narration", op: "contains", value: "   " }],
  });
  assert.equal(matches(txn(), r), false);
});

// ── matches: amount, and the BIGINT-as-string trap ──────────────────────────

test("amount comparisons work when pg hands back a BIGINT string", () => {
  const r = rule({
    conditions: [{ field: "amount_paise", op: "lt", value: 0 }],
  });
  assert.equal(matches(txn({ amount_paise: "-230000" }), r), true);
  assert.equal(matches(txn({ amount_paise: "230000" }), r), false);
});

test("amount comparison is numeric, not lexicographic", () => {
  // The bug this pins down: as strings, "-230000" < "-500000" is TRUE, because
  // "2" < "5" character-wise. Numerically it is FALSE. -230000 is the larger number.
  const r = rule({
    conditions: [{ field: "amount_paise", op: "lt", value: -500000 }],
  });
  assert.equal(matches(txn({ amount_paise: "-230000" }), r), false);
  assert.equal(matches(txn({ amount_paise: "-900000" }), r), true);
});

test("a non-numeric amount fails closed instead of coercing to 0", () => {
  const r = rule({ conditions: [{ field: "amount_paise", op: "lt", value: 0 }] });
  assert.equal(matches(txn({ amount_paise: "" }), r), false);
  assert.equal(matches(txn({ amount_paise: "abc" }), r), false);
});

// ── matches: dates ──────────────────────────────────────────────────────────

test("date comparison uses ISO string ordering", () => {
  const t = txn({ txn_date: "2026-06-03" });
  assert.equal(
    matches(t, rule({ conditions: [{ field: "txn_date", op: "gt", value: "2026-05-31" }] })),
    true,
  );
  assert.equal(
    matches(t, rule({ conditions: [{ field: "txn_date", op: "lt", value: "2026-01-01" }] })),
    false,
  );
  assert.equal(
    matches(t, rule({ conditions: [{ field: "txn_date", op: "equals", value: "2026-06-03" }] })),
    true,
  );
});

// ── matches: match_mode ─────────────────────────────────────────────────────

const blinkitDebit = [
  { field: "narration", op: "contains", value: "amazon" },
  { field: "amount_paise", op: "lt", value: 0 },
];

test("'all' requires every condition", () => {
  assert.equal(matches(txn(), rule({ conditions: blinkitDebit, match_mode: "all" })), true);
  // Same rule, but the transaction is a credit — the second condition fails.
  assert.equal(
    matches(txn({ amount_paise: 5000 }), rule({ conditions: blinkitDebit, match_mode: "all" })),
    false,
  );
});

test("'any' needs only one condition", () => {
  // Narration misses, but it is still a debit — 'any' fires, 'all' does not.
  const t = txn({ narration: "UPI-Debit-EatClub" });
  assert.equal(matches(t, rule({ conditions: blinkitDebit, match_mode: "any" })), true);
  assert.equal(matches(t, rule({ conditions: blinkitDebit, match_mode: "all" })), false);
});

// ── matches: failing closed ─────────────────────────────────────────────────

test("empty conditions match NOTHING, in either mode", () => {
  // [].every() is true, so the vacuously-correct answer would make this rule
  // match every transaction in the ledger. We choose false in both modes.
  assert.equal(matches(txn(), rule({ conditions: [], match_mode: "all" })), false);
  assert.equal(matches(txn(), rule({ conditions: [], match_mode: "any" })), false);
});

test("unknown field, op, or match_mode never fires a rule", () => {
  assert.equal(
    matches(txn(), rule({ conditions: [{ field: "merchant", op: "contains", value: "amazon" }] })),
    false,
  );
  assert.equal(
    matches(txn(), rule({ conditions: [{ field: "narration", op: "regex", value: "amazon" }] })),
    false,
  );
  assert.equal(
    matches(
      txn(),
      rule({ conditions: [{ field: "narration", op: "contains", value: "amazon" }], match_mode: "some" }),
    ),
    false,
  );
});

test("a wrongly-typed value fails closed", () => {
  // A number where a narration pattern belongs — rejected by the CRUD layer, but
  // the evaluator must not trust that.
  assert.equal(
    matches(txn(), rule({ conditions: [{ field: "narration", op: "contains", value: 42 }] })),
    false,
  );
});

// ── chooseWinner ────────────────────────────────────────────────────────────

// Every rule below matches the default txn ("UPI-Debit-Amazon India", -230000),
// so the ONLY thing under test is which one wins.
function ranked(over: Partial<RankableRule> = {}): RankableRule {
  return {
    id: 1,
    priority: 0,
    enabled: true,
    match_mode: "all",
    conditions: [{ field: "narration", op: "contains", value: "amazon" }],
    ...over,
  };
}

test("no rules, or no matching rule, yields null", () => {
  assert.equal(chooseWinner(txn(), []), null);
  const miss = ranked({
    conditions: [{ field: "narration", op: "contains", value: "blinkit" }],
  });
  assert.equal(chooseWinner(txn(), [miss]), null);
});

test("higher priority wins", () => {
  const low = ranked({ id: 1, priority: 0 });
  const high = ranked({ id: 2, priority: 10 });
  assert.equal(chooseWinner(txn(), [low, high])?.id, 2);
  // Same answer with the array the other way round — order must not matter.
  assert.equal(chooseWinner(txn(), [high, low])?.id, 2);
});

test("at equal priority the more specific rule wins", () => {
  const broad = ranked({
    id: 1,
    conditions: [{ field: "narration", op: "contains", value: "amazon" }],
  });
  const narrow = ranked({
    id: 2,
    conditions: [
      { field: "narration", op: "contains", value: "amazon" },
      { field: "amount_paise", op: "lt", value: 0 },
    ],
  });
  assert.equal(chooseWinner(txn(), [broad, narrow])?.id, 2);
  assert.equal(chooseWinner(txn(), [narrow, broad])?.id, 2);
});

test("extra conditions do NOT make an 'any' rule more specific", () => {
  // 'any' fires on ONE condition, so a longer list makes it broader, not narrower.
  // It must not out-rank a two-condition 'all' rule at the same priority.
  const anyRule = ranked({
    id: 1,
    match_mode: "any",
    conditions: [
      { field: "narration", op: "contains", value: "amazon" },
      { field: "narration", op: "contains", value: "swiggy" },
      { field: "amount_paise", op: "lt", value: 0 },
    ],
  });
  const allRule = ranked({
    id: 2,
    match_mode: "all",
    conditions: [
      { field: "narration", op: "contains", value: "amazon" },
      { field: "amount_paise", op: "lt", value: 0 },
    ],
  });
  assert.equal(chooseWinner(txn(), [anyRule, allRule])?.id, 2);
  assert.equal(chooseWinner(txn(), [allRule, anyRule])?.id, 2);
});

test("the id tiebreak is numeric, not lexicographic", () => {
  // As strings "10" < "2", so a lexicographic tiebreak would pick 10. The lowest
  // id must win: 2.
  const two = ranked({ id: 2 });
  const ten = ranked({ id: 10 });
  assert.equal(chooseWinner(txn(), [ten, two])?.id, 2);
  assert.equal(compareRules(two, ten) < 0, true);
});

test("disabled rules never win, and never block an enabled one", () => {
  const disabledButBetter = ranked({ id: 1, priority: 99, enabled: false });
  const enabledButWorse = ranked({ id: 2, priority: 0, enabled: true });
  assert.equal(chooseWinner(txn(), [disabledButBetter, enabledButWorse])?.id, 2);
  assert.equal(chooseWinner(txn(), [disabledButBetter]), null);
});

test("compareRules is a total order — never 0 for distinct rules", () => {
  // If any pair compared equal, which one won would depend on array order, and
  // the engine would stop being deterministic.
  const rules = [
    ranked({ id: 1, priority: 0 }),
    ranked({ id: 2, priority: 0 }),
    ranked({ id: 3, priority: 5 }),
    ranked({ id: 4, priority: 5, conditions: [
      { field: "narration", op: "contains", value: "amazon" },
      { field: "amount_paise", op: "lt", value: 0 },
    ] }),
    ranked({ id: 5, priority: 5, match_mode: "any" }),
  ];
  for (const a of rules) {
    for (const b of rules) {
      if (a.id === b.id) continue;
      assert.notEqual(compareRules(a, b), 0, `rules ${a.id} and ${b.id} tied`);
      // Antisymmetry: if a beats b then b must lose to a.
      assert.equal(
        Math.sign(compareRules(a, b)),
        -Math.sign(compareRules(b, a)),
        `compare(${a.id},${b.id}) is not antisymmetric`,
      );
    }
  }
});

test("the winner does not depend on the order rules arrive in", () => {
  // The property that actually matters. Every permutation must agree, or the
  // engine's output depends on however Postgres happened to return the rows.
  const rules = [
    ranked({ id: 1, priority: 0 }),
    ranked({ id: 2, priority: 5 }),
    ranked({ id: 3, priority: 5, conditions: [
      { field: "narration", op: "contains", value: "amazon" },
      { field: "amount_paise", op: "lt", value: 0 },
    ] }),
    ranked({ id: 4, priority: 5, enabled: false }),
  ];

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, i) =>
      permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
        item,
        ...rest,
      ]),
    );
  }

  const winners = new Set(
    permutations(rules).map((order) => chooseWinner(txn(), order)?.id),
  );
  assert.equal(winners.size, 1, `permutations disagreed: ${[...winners]}`);
  assert.equal([...winners][0], 3); // priority 5, and the most specific of those
});
