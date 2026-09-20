// Rule matching — the PURE half of the rules engine, and the OWNER of the rule
// vocabulary.
//
// Nothing in here touches the database, the clock, or the network. Given a
// transaction and a rule, `matches` answers one question: do this rule's
// conditions hold? That purity is the point — it makes every gnarly real-world
// narration a one-line unit test instead of a seeded database.
//
// The vocabulary (fields, ops, match modes) lives HERE, not in server.ts, because
// the module that INTERPRETS a language should define it. The write path imports
// these constants to validate against, so there is exactly one source of truth.
//
// Deliberately NOT in here: whether the rule is enabled, which rule wins when
// several match, how much money to allocate, and anything that writes. Those
// belong to the runner.

// `as const` makes these readonly tuples of literal types rather than string[],
// which is what lets us derive the union types below from the values themselves.
// Add a member here and the compiler will hunt down every place that must handle it.
export const RULE_FIELDS = ["narration", "amount_paise", "txn_date"] as const;
export const RULE_OPS = ["contains", "equals", "lt", "gt"] as const;
export const MATCH_MODES = ["all", "any"] as const;

export type RuleField = (typeof RULE_FIELDS)[number];
export type RuleOp = (typeof RULE_OPS)[number];
export type MatchMode = (typeof MATCH_MODES)[number];

// Not every op makes sense on every field — `contains` is meaningless on a number.
export const OPS_BY_FIELD: Record<RuleField, readonly RuleOp[]> = {
  narration: ["contains", "equals"],
  amount_paise: ["equals", "lt", "gt"],
  txn_date: ["equals", "lt", "gt"],
};

// Type guards: the ONE place where an untrusted string becomes a vocabulary word.
// Everything downstream gets a narrowed union type and can be checked exhaustively.
export function isRuleField(value: unknown): value is RuleField {
  return (
    typeof value === "string" && (RULE_FIELDS as readonly string[]).includes(value)
  );
}

export function isRuleOp(value: unknown): value is RuleOp {
  return typeof value === "string" && (RULE_OPS as readonly string[]).includes(value);
}

export function isMatchMode(value: unknown): value is MatchMode {
  return (
    typeof value === "string" && (MATCH_MODES as readonly string[]).includes(value)
  );
}

// We define the shape we need rather than importing a type from server.ts —
// that module calls app.listen() at import time, so depending on it would boot
// a server every time we ran a test. Depend on the shape, not the module.
export type MatchableTransaction = {
  narration: string | null;
  // pg hands BIGINT columns back as STRINGS ("-230000"), but a value that came
  // from JSON is a real number. The type admits both; toNumber() reconciles them.
  amount_paise: number | string;
  txn_date: string;
};

// Every field is typed as it ACTUALLY arrives — straight out of a JSONB column,
// so genuinely unknown. Typing these as RuleField/RuleOp here would be a lie the
// runtime cannot honour; the guards above are what turn them into vocabulary.
export type RuleCondition = {
  field: unknown;
  op: unknown;
  value: unknown;
};

export type MatchableRule = {
  conditions: unknown;
  match_mode: unknown;
};

// Bank narrations carry three kinds of noise that break naive matching:
// inconsistent case, arbitrary separators, and a per-transaction reference
// number that makes every string unique. Strip all three, in that order.
//
//   "UPI-Debit-123456789012-BLINKIT-HDFC"  ->  "upi debit blinkit hdfc"
//
// Lossy and dumb ON PURPOSE: you can read the output and predict what a rule
// will do to it. Takes `string | null` because narration IS nullable in the
// schema — a null narration is a real row, not a bug, and pushing that guard
// in here means no caller can forget it.
export function normalise(narration: string | null): string {
  if (typeof narration !== "string") return "";
  return narration
    .toLowerCase()
    // Separators vary by bank and carry no meaning: UPI-Debit, POS/SWIGGY, SWIGGY*ORDER.
    .replace(/[-/*_.:,#|]+/g, " ")
    // Reference numbers only. The 6-digit floor is deliberate: shorter runs are
    // usually meaningful ("card ending 1234", "airtel.pay" style suffixes).
    .replace(/\d{6,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Coerce to a real number, or null when the value simply is not one.
// Number() is treacherous here and this is the one place we contain it:
// Number("") is 0, Number(null) is 0, Number("abc") is NaN — and NONE of them
// throw. Returning null forces the caller to handle "not a number" explicitly
// instead of silently comparing against a 0 that was never in the data.
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Evaluate ONE condition against a transaction.
//
// Every unrecognised or ill-typed input returns false — the engine FAILS CLOSED.
// A rule that cannot be understood must never fire, because firing means writing
// a category onto someone's money. Silence is the safe failure here; the CRUD
// layer is what stops a malformed rule from being stored in the first place.
function evaluateCondition(
  txn: MatchableTransaction,
  condition: RuleCondition,
): boolean {
  const { field, op, value } = condition;

  // Untrusted strings become vocabulary words here, once, or we bail.
  if (!isRuleField(field) || !isRuleOp(op)) return false;
  // An op the field does not support (contains on a number) never fires.
  if (!OPS_BY_FIELD[field].includes(op)) return false;

  // Both switches below are EXHAUSTIVE over their union, and the function is
  // declared `: boolean`. Under strictNullChecks that combination is the
  // enforcement: add a field or an op to the vocabulary without handling it
  // here, and this function stops compiling. The interpreter cannot silently
  // fall out of step with the language it interprets.
  switch (field) {
    case "narration": {
      if (typeof value !== "string") return false;
      // BOTH sides go through normalise. Normalising only the haystack is the
      // classic bug: a rule saved as "Blinkit" would never match "blinkit".
      const haystack = normalise(txn.narration);
      const needle = normalise(value);
      // An empty needle would make `includes` vacuously true and match everything.
      if (needle === "") return false;
      switch (op) {
        case "contains":
          return haystack.includes(needle);
        case "equals":
          return haystack === needle;
        case "lt":
        case "gt":
          return false; // excluded by OPS_BY_FIELD; listed to stay exhaustive
      }
    }

    case "amount_paise": {
      const left = toNumber(txn.amount_paise);
      const right = toNumber(value);
      if (left === null || right === null) return false;
      switch (op) {
        case "equals":
          return left === right;
        case "lt":
          return left < right;
        case "gt":
          return left > right;
        case "contains":
          return false;
      }
    }

    case "txn_date": {
      if (typeof value !== "string") return false;
      // ISO YYYY-MM-DD sorts lexicographically exactly as it sorts chronologically,
      // so a plain string compare is CORRECT — and sidesteps every timezone bug that
      // parsing into Date would invite. This is why db.ts keeps DATE as a string.
      switch (op) {
        case "equals":
          return txn.txn_date === value;
        case "lt":
          return txn.txn_date < value;
        case "gt":
          return txn.txn_date > value;
        case "contains":
          return false;
      }
    }
  }
}

// Does this rule fire on this transaction?
//
// Two layers, kept apart on purpose: evaluateCondition answers "is this ONE
// condition true", and match_mode combines the answers. 'all' is AND, 'any' is OR.
export function matches(
  txn: MatchableTransaction,
  rule: MatchableRule,
): boolean {
  const { conditions, match_mode } = rule;
  // `conditions` is typed unknown because that is what a JSONB column really is.
  if (!Array.isArray(conditions)) return false;
  if (!isMatchMode(match_mode)) return false;

  // THE EMPTY-ARRAY DECISION. [].every() is true — vacuous truth, and
  // mathematically the right answer to "are all zero conditions satisfied?".
  // We return false anyway, because the mathematically correct answer here means
  // "this rule matches every transaction you own" and would categorise the entire
  // ledger from one empty rule. Fail closed, and let the CRUD layer reject the
  // row as well. Two independent guards, because the cost of being wrong is high.
  if (conditions.length === 0) return false;

  // every/some short-circuit, so a failing first condition skips the rest.
  // Safe precisely because evaluateCondition is pure — no side effect gets skipped.
  switch (match_mode) {
    case "all":
      return conditions.every((c) => evaluateCondition(txn, c));
    case "any":
      return conditions.some((c) => evaluateCondition(txn, c));
  }
}

// ── Conflict resolution ─────────────────────────────────────────────────────
// Several rules can match one transaction. Exactly one must win, and the same
// one must win every single time — a winner that varies between runs makes the
// engine's output stop being a function of its inputs, which is idempotency gone.

// A rule that can be ranked. `id` is a number, not the BIGINT string pg hands
// back: the caller converts (GET /rules already does). It matters because the
// tiebreak below is numeric — as strings, "10" sorts before "2".
export type RankableRule = MatchableRule & {
  id: number;
  priority: number;
  enabled: boolean;
};

// How specific is this rule — how much had to be true for it to fire?
//
// For 'all', every condition had to hold, so more conditions means a narrower
// rule: "blinkit AND over ₹2000" should beat plain "blinkit".
//
// For 'any', the count means the OPPOSITE. One condition was enough, so extra
// conditions only make the rule match MORE transactions. An 'any' rule is only
// ever as specific as the single condition that happened to fire, so it scores 1
// no matter how long its list is.
function specificity(rule: RankableRule): number {
  if (!Array.isArray(rule.conditions)) return 0;
  if (rule.match_mode === "any") return 1;
  return rule.conditions.length;
}

// Rank two rules, most-preferred first — the comparator IS the precedence policy,
// which is why it is exported and tested on its own.
//
// This is a TOTAL order: for any two DISTINCT rules it returns a definite answer,
// never 0. That is the whole point. Stopping at `priority` would leave ties, and
// SQL guarantees nothing about the order of tied rows — the plan can change as the
// table grows, as statistics update, as a row is updated and moves. Run 1 picks
// rule A, run 2 picks rule B, and nothing you can see has changed.
export function compareRules(a: RankableRule, b: RankableRule): number {
  // 1. Explicit user ranking. Higher priority wins.
  if (a.priority !== b.priority) return b.priority - a.priority;
  // 2. The more specific rule wins — buys "narrower rule beats broader" for free,
  //    without asking anyone to hand-rank every pair.
  const specificityA = specificity(a);
  const specificityB = specificity(b);
  if (specificityA !== specificityB) return specificityB - specificityA;
  // 3. Arbitrary, but STABLE — and stable is the entire job. Distinct rules have
  //    distinct ids, so this can never return 0 and never leave a tie unbroken.
  return a.id - b.id;
}

// Which rule explains this transaction? Null when none does.
//
// Unlike `matches`, this DOES skip disabled rules — the two functions answer
// different questions. `matches` asks "do these conditions hold?", a pure
// predicate about conditions. `chooseWinner` asks "which rule applies here?",
// and a disabled rule does not apply, by definition. Eligibility belongs to
// selection. The runner filters on `enabled` in SQL as well; this is the second,
// independent guard, because a disabled rule that still categorises money is
// exactly the kind of bug nobody notices for months.
//
// Single pass, no sorting and no copying: we only ever need the best element, not
// the whole ranking. Note the result does NOT depend on the order rules arrive in —
// that independence is what makes the engine deterministic, and it is tested.
// Generic in T so the caller gets its own richer row type back, not a widened one.
export function chooseWinner<T extends RankableRule>(
  txn: MatchableTransaction,
  rules: readonly T[],
): T | null {
  let winner: T | null = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matches(txn, rule)) continue;
    // Strictly-better only. On a tie compareRules cannot return 0 for distinct
    // rules, so "first one seen wins" never silently decides anything.
    if (winner === null || compareRules(rule, winner) < 0) winner = rule;
  }
  return winner;
}

// ── Deciding what to write ──────────────────────────────────────────────────
// Still pure. This produces the DESIRED state for one transaction; making the
// database match it is the runner's job (src/rules-apply.ts).

// How much we trust a rule's guess. Below 1 on purpose: a rule knows the merchant,
// not the basket, so its allocation is provisional until a human or itemised
// evidence confirms it. Belongs on the `rules` row eventually, so a user can say
// how much they trust a given rule — that is a schema change, deferred.
export const RULE_CONFIDENCE = 0.8;

// A rule that can actually be applied — it carries the category it assigns.
export type ApplicableRule = RankableRule & {
  category_id: number | null;
};

export type DesiredAllocation = {
  category_id: number;
  amount_paise: number;
  rule_id: number;
  confidence: number;
};

// What SHOULD this transaction's rule-allocations be?
//
// `remaining` is supplied by the caller and must be computed EXCLUDING existing
// source='rule' rows. Counting our own previous output
// makes the desired state depend on the last run, and the engine oscillates:
// full allocation -> remainder 0 -> desired empty -> swept -> rewritten next run.
//
// Returns at most ONE allocation. A rule assigns a single category and cannot
// split; that is the honest boundary between rules and itemised evidence.
export function decideAllocation(
  txn: MatchableTransaction,
  remaining: number,
  rules: readonly ApplicableRule[],
): DesiredAllocation | null {
  // Nothing left to explain. Also a hard guard: allocations has
  // CHECK (amount_paise <> 0), so a zero row is a constraint violation, not a no-op.
  if (remaining === 0) return null;

  const winner = chooseWinner(txn, rules);
  if (winner === null) return null;
  // A rule with no category assigns nothing, so it explains nothing. `== null`
  // would also catch undefined here, but the column is a real nullable BIGINT —
  // be explicit about which absence we mean.
  if (winner.category_id === null) return null;

  return {
    category_id: winner.category_id,
    amount_paise: remaining,
    rule_id: winner.id,
    confidence: RULE_CONFIDENCE,
  };
}

// Is an existing allocation already exactly what we want?
//
// Used to detect the no-op case. Without it the runner would delete and re-insert
// an identical row on every run: the STATE would still converge, but allocation
// ids would churn, created_at would mean "when the job last ran", and
// `created: 0, removed: 0` would stop being a usable signal that the engine
// converged at all.
export function sameAllocation(
  existing: {
    category_id: number;
    amount_paise: number;
    rule_id: number | null;
    confidence: number;
  },
  desired: DesiredAllocation,
): boolean {
  return (
    existing.category_id === desired.category_id &&
    existing.amount_paise === desired.amount_paise &&
    existing.rule_id === desired.rule_id &&
    existing.confidence === desired.confidence
  );
}
