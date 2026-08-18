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
