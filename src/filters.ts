// The one filter vocabulary, shared by every list and report endpoint.
//
// A CLOSED set of named filters, deliberately — not a generic field/op/value query
// language. We built a tiny language once, for rules, and it earned its complexity
// because users author rules. Nobody authors a report URL, so the same design here
// would be all cost, no payoff, and an injection surface. Add filters one at a time,
// by name, when a real question needs one.
//
// Every value reaches SQL as a PARAMETER ($1, $2 …). No user input is ever concatenated
// into the statement — the only strings this module builds are its own fixed fragments.

export const ALLOCATION_SOURCES = ["user", "rule", "evidence"] as const;

export type FilterResult =
  | { ok: true; sql: string; params: unknown[] }
  | { ok: false; error: string };

// YYYY-MM-DD only. Date.parse accepts a great deal more ("March 3", "2026"), and being
// liberal here would mean two callers disagreeing about what a date range covers.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date that is well-formed AND real.
 *
 * The shape test is not enough and neither is Date.parse. **Date.parse accepts impossible
 * days**: `Date.parse("2026-06-31")` is not NaN — V8 rolls it forward to 1 July and hands
 * back a perfectly good timestamp. So do "2026-02-30" and "2025-02-29". The regex passes
 * them, `Date.parse` passes them, and the first thing that notices is Postgres, which
 * answers `date/time field value out of range` — a 500 on user input, for a value we had
 * every means to reject at the door.
 *
 * The round-trip is the check: build the date in UTC, read the three fields back, and
 * require them to be what was asked for. A rolled-over day fails because June has no 31st
 * to read back. UTC throughout for the same reason as reports.ts — the local-time
 * constructor shifts the day either side of Greenwich.
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d!));
  return (
    at.getUTCFullYear() === y && at.getUTCMonth() === m! - 1 && at.getUTCDate() === d
  );
}

// Express gives query values as string | string[] | ParsedQs. Anything that is not a
// plain scalar string is a caller error rather than something to coerce.
function scalar(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function positiveInt(value: string): number | null {
  // Number("") is 0 and Number("abc") is NaN, and neither throws — so test the shape
  // rather than trusting the coercion.
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Build a SQL predicate over `transactions t` from request query params.
 *
 * Returns a fragment that always starts with `AND` (or is empty), so callers write:
 *   `SELECT … FROM transactions t WHERE 1=1 ${sql}`
 *
 * `startIndex` is the next free placeholder number, so a caller that already has
 * $1 and $2 in its statement passes 3.
 */
export function parseFilters(
  query: Record<string, unknown>,
  startIndex = 1,
): FilterResult {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let n = startIndex;
  const add = (fragment: string, ...values: unknown[]) => {
    clauses.push(fragment);
    params.push(...values);
  };

  // ── period ───────────────────────────────────────────────────────────────
  // Inclusive on both ends: `from` and `to` name days you want included, which is what
  // a person picking "1 March to 31 March" means. txn_date is a DATE, so there is no
  // time-of-day edge to get wrong.
  const from = scalar(query.from);
  if (from !== null) {
    if (!isIsoDate(from)) return { ok: false, error: "from must be YYYY-MM-DD" };
    add(`AND t.txn_date >= $${n++}`, from);
  }
  const to = scalar(query.to);
  if (to !== null) {
    if (!isIsoDate(to)) return { ok: false, error: "to must be YYYY-MM-DD" };
    add(`AND t.txn_date <= $${n++}`, to);
  }
  if (from !== null && to !== null && from > to) {
    // ISO dates compare correctly as strings, which is why the format is pinned above.
    return { ok: false, error: "from must not be after to" };
  }

  // ── account ──────────────────────────────────────────────────────────────
  const accountId = scalar(query.account_id);
  if (accountId !== null) {
    const id = positiveInt(accountId);
    if (id === null) {
      return { ok: false, error: "account_id must be a positive integer" };
    }
    add(`AND t.account_id = $${n++}`, id);
  }

  // ── category ─────────────────────────────────────────────────────────────
  // Matches the category OR any of its children, so clicking a parent in a report
  // ("Food & Dining") includes Groceries and Food delivery rather than showing the
  // near-empty total of transactions filed directly against the parent.
  const categoryId = scalar(query.category_id);
  if (categoryId !== null) {
    const id = positiveInt(categoryId);
    if (id === null) {
      return { ok: false, error: "category_id must be a positive integer" };
    }
    add(
      `AND EXISTS (
           SELECT 1 FROM allocations al
             JOIN categories c ON c.id = al.category_id
            WHERE al.transaction_id = t.id
              AND (c.id = $${n} OR c.parent_id = $${n})
         )`,
      id,
    );
    n++;
  }

  // ── rule ─────────────────────────────────────────────────────────────────
  // "Show me everything this rule touched."
  const ruleId = scalar(query.rule_id);
  if (ruleId !== null) {
    const id = positiveInt(ruleId);
    if (id === null) {
      return { ok: false, error: "rule_id must be a positive integer" };
    }
    add(
      `AND EXISTS (
           SELECT 1 FROM allocations al
            WHERE al.transaction_id = t.id AND al.rule_id = $${n++}
         )`,
      id,
    );
  }

  // ── provenance ───────────────────────────────────────────────────────────
  // 'user' | 'rule' | 'evidence' ask "does an allocation of this kind exist?".
  // 'unexplained' is a DIFFERENT shape: it is the absence of enough allocation, which
  // no EXISTS can express — it has to compare the transaction against the sum.
  const source = scalar(query.source);
  if (source !== null) {
    if (source === "unexplained") {
      add(
        `AND t.amount_paise <> COALESCE(
             (SELECT SUM(al.amount_paise) FROM allocations al
               WHERE al.transaction_id = t.id), 0)`,
      );
    } else if ((ALLOCATION_SOURCES as readonly string[]).includes(source)) {
      add(
        `AND EXISTS (
             SELECT 1 FROM allocations al
              WHERE al.transaction_id = t.id AND al.source = $${n++}
           )`,
        source,
      );
    } else {
      return {
        ok: false,
        error: `source must be one of ${ALLOCATION_SOURCES.join(", ")}, unexplained`,
      };
    }
  }

  // ── narration search ─────────────────────────────────────────────────────
  // ILIKE is case-insensitive without needing lower() on both sides. The wildcards are
  // added to the PARAMETER, never to the SQL, and % and _ inside the user's text are
  // escaped so a search for "50%" looks for "50%" rather than "50 anything".
  const q = scalar(query.q);
  if (q !== null) {
    const escaped = q.replace(/([\\%_])/g, "\\$1");
    add(`AND t.narration ILIKE $${n++}`, `%${escaped}%`);
  }

  // ── direction ────────────────────────────────────────────────────────────
  // Which way the money went. A named pair rather than a raw sign, because "out" is what a
  // person means and `amount_sign=-1` is what a database means.
  //
  // Exists for the manual matcher. `matchToTransaction` treats the sign as a HARD filter —
  // a credit can never satisfy a debit, however close the amount — and the screen where a
  // person picks the transaction themselves should obey the same rule the automatic path
  // does, rather than offering a list half of which is structurally impossible.
  const direction = scalar(query.direction);
  if (direction !== null) {
    if (direction === "out") add("AND t.amount_paise < 0");
    else if (direction === "in") add("AND t.amount_paise > 0");
    else return { ok: false, error: "direction must be out or in" };
  }

  // ── spend only ───────────────────────────────────────────────────────────
  // Opt-IN, not automatic. /transactions is the ledger and should be able to show you a
  // transfer or an opening balance; the reports are spend analysis and always set it.
  // The predicate itself lives in server.ts as EXPLAINABLE_SPEND — one definition.
  const spendOnly = scalar(query.spend_only);
  if (spendOnly !== null && spendOnly !== "true" && spendOnly !== "false") {
    return { ok: false, error: "spend_only must be true or false" };
  }

  return {
    ok: true,
    sql: clauses.length === 0 ? "" : "\n  " + clauses.join("\n  "),
    params,
  };
}

// Pagination, parsed separately because reports never paginate — they aggregate.
export type PageResult =
  | { ok: true; limit: number; offset: number }
  | { ok: false; error: string };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function parsePaging(query: Record<string, unknown>): PageResult {
  let limit = DEFAULT_LIMIT;
  let offset = 0;

  const rawLimit = scalar(query.limit);
  if (rawLimit !== null) {
    const parsed = positiveInt(rawLimit);
    if (parsed === null || parsed > MAX_LIMIT) {
      return { ok: false, error: `limit must be a positive integer <= ${MAX_LIMIT}` };
    }
    limit = parsed;
  }

  const rawOffset = scalar(query.offset);
  if (rawOffset !== null) {
    // 0 is legal here, so positiveInt (which rejects it) is the wrong tool.
    if (!/^\d+$/.test(rawOffset)) {
      return { ok: false, error: "offset must be a non-negative integer" };
    }
    const parsed = Number(rawOffset);
    if (!Number.isSafeInteger(parsed)) {
      return { ok: false, error: "offset must be a non-negative integer" };
    }
    offset = parsed;
  }

  return { ok: true, limit, offset };
}

export function isSpendOnly(query: Record<string, unknown>): boolean {
  return scalar(query.spend_only) === "true";
}
