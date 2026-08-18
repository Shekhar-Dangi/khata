// Rule matching — the PURE half of the rules engine.
//
// Nothing in here touches the database, the clock, or the network. Given a
// transaction and a rule, `matches` answers one question: do this rule's
// conditions hold? That purity is the point — it makes every gnarly real-world
// narration a one-line unit test instead of a seeded database.
//
// Deliberately NOT in here: whether the rule is enabled, which rule wins when
// several match, how much money to allocate, and anything that writes. Those
// belong to the runner.

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

export type RuleCondition = {
  field: string;
  op: string;
  // Straight out of JSONB, so genuinely unknown at compile time. Every read of
  // it below is guarded by a typeof check — that is the price of `unknown`, and
  // it is exactly the price we want to pay here.
  value: unknown;
};

export type MatchableRule = {
  conditions: RuleCondition[];
  match_mode: string;
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

// Coerce to a real number, or null when the value simply isn't one.
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

  if (field === "narration") {
    if (typeof value !== "string") return false;
    // BOTH sides go through normalise. Normalising only the haystack is the
    // classic bug: a rule saved as "Blinkit" would never match "blinkit".
    const haystack = normalise(txn.narration);
    const needle = normalise(value);
    // An empty needle would make `includes` vacuously true and match everything.
    if (needle === "") return false;
    if (op === "contains") return haystack.includes(needle);
    if (op === "equals") return haystack === needle;
    return false;
  }

  if (field === "amount_paise") {
    const left = toNumber(txn.amount_paise);
    const right = toNumber(value);
    if (left === null || right === null) return false;
    if (op === "equals") return left === right;
    if (op === "lt") return left < right;
    if (op === "gt") return left > right;
    return false;
  }

  if (field === "txn_date") {
    if (typeof value !== "string" || typeof txn.txn_date !== "string") {
      return false;
    }
    // ISO YYYY-MM-DD sorts lexicographically exactly as it sorts chronologically,
    // so a plain string compare is CORRECT — and sidesteps every timezone bug that
    // parsing into Date would invite. This is why db.ts keeps DATE as a string.
    if (op === "equals") return txn.txn_date === value;
    if (op === "lt") return txn.txn_date < value;
    if (op === "gt") return txn.txn_date > value;
    return false;
  }

  return false;
}

// Does this rule fire on this transaction?
//
// Two layers, kept apart on purpose: evaluateCondition answers "is this ONE
// condition true", and match_mode combines the answers. 'all' is AND, 'any' is OR.
export function matches(txn: MatchableTransaction, rule: MatchableRule): boolean {
  const conditions = rule.conditions;
  if (!Array.isArray(conditions)) return false;

  // THE EMPTY-ARRAY DECISION. [].every() is true — vacuous truth, and
  // mathematically the right answer to "are all zero conditions satisfied?".
  // We return false anyway, because the mathematically correct answer here means
  // "this rule matches every transaction you own" and would categorise the entire
  // ledger from one empty rule. Fail closed, and let the CRUD layer reject the
  // row as well. Two independent guards, because the cost of being wrong is high.
  if (conditions.length === 0) return false;

  // every/some short-circuit, so a failing first condition skips the rest.
  if (rule.match_mode === "all") {
    return conditions.every((c) => evaluateCondition(txn, c));
  }
  if (rule.match_mode === "any") {
    return conditions.some((c) => evaluateCondition(txn, c));
  }
  // Unknown mode — fail closed, same reasoning as above.
  return false;
}
