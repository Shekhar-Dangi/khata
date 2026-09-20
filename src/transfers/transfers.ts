// The PURE half of transfer detection — no DB, no clock, no Express.
//
// Same split as rules.ts, for the same reason: the part that decides whether two rows are
// the same money is the part that can silently corrupt every report downstream, so it is
// the part that gets tested exhaustively without a database in the way.

/**
 * A UPI reference (RRN) is exactly 12 digits, and both legs of a real transfer quote the
 * same one — the debit on your bank and the credit on the other account. It is by far the
 * strongest signal available, and unlike `account_keywords` it needs nothing set up.
 *
 * The boundaries are non-alphanumeric on BOTH sides, not merely non-digit. A statement is
 * full of long alphanumeric runs (`BANKN12345678901234567`), and twelve digits sitting
 * inside one of those is not a reference, it is a coincidence with a substring.
 *
 * Verified against 516 real statement rows: 419 tokens, 316 references appearing once
 * (an ordinary merchant payment, no partner), 50 appearing exactly twice (the transfers),
 * and one appearing three times — which is precisely the case that must NOT auto-resolve.
 * The non-digit and non-alphanumeric forms of this pattern extract identically on that
 * data, so the stricter one costs nothing.
 */
const REFERENCE_RE = /(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/g;

/** Every 12-digit reference in a narration, deduped, in the order they appear. */
export function extractReferences(narration: string | null): string[] {
  if (narration === null) return [];
  // A /g regex is stateful (`lastIndex`), so matchAll on a shared literal would resume
  // mid-string on the second call. matchAll clones the regex internally; String.match
  // with /g does not. Do not "simplify" this to REFERENCE_RE.exec in a loop.
  const found = [...narration.matchAll(REFERENCE_RE)].map((m) => m[0]);
  return [...new Set(found)];
}

/** Whole days between two YYYY-MM-DD strings. Both are plain strings (see db.ts). */
export function dayGap(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

/** The minimum a leg needs to be judged. Mirrors the columns the detector selects. */
export type Leg = {
  id: string;
  account_id: number;
  amount_paise: number;
  txn_date: string;
  narration: string | null;
};

export type ReferenceMatch = { partner: Leg; reference: string };

/**
 * Decide whether a leg has an unambiguous partner by shared reference.
 *
 * `sharing` is every OTHER row in the ledger that quotes the same reference. All four
 * tests below are load-bearing, and this function auto-resolves — there is no human after
 * it — so each one fails CLOSED, returning null rather than a best guess:
 *
 *  - **exactly one other row.** Zero means an ordinary payment that happens to have a
 *    reference. More than one is genuinely ambiguous, and a real ledger contains that
 *    case (one reference on three rows). Guessing there
 *    would hide real spending on a coincidence, which is the one failure this product
 *    cannot afford. It falls through to the amount+date pass and becomes a proposal.
 *  - **different accounts.** Two rows in the SAME account sharing a reference is a
 *    statement quirk (it happens in real statements), not money moving.
 *  - **opposite and equal.** A transfer is one debit and one credit of the same size.
 *  - **inside the window.** A shared reference months apart is a recycled number.
 */
export function findReferencePartner(
  leg: Leg,
  /** Other rows quoting each of the leg's references, keyed by reference. */
  sharing: Map<string, Leg[]>,
  windowDays: number,
): ReferenceMatch | null {
  for (const reference of extractReferences(leg.narration)) {
    const others = (sharing.get(reference) ?? []).filter((r) => r.id !== leg.id);
    if (others.length !== 1) continue;
    const partner = others[0]!;
    if (partner.account_id === leg.account_id) continue;
    if (partner.amount_paise !== -leg.amount_paise) continue;
    if (dayGap(partner.txn_date, leg.txn_date) > windowDays) continue;
    return { partner, reference };
  }
  return null;
}

/**
 * Index rows by every reference they quote, so the detector does one pass over the ledger
 * instead of a regex scan per leg.
 *
 * In memory on purpose. The alternative is a per-leg query with a regex predicate, which
 * is N round trips and a sequential scan each time — and unlike the report aggregates,
 * this genuinely needs every candidate row rather than a summary of them. A narration is
 * ~100 bytes; ten thousand of them is a megabyte, and this runs on import, not on render.
 */
export function indexByReference(rows: Leg[]): Map<string, Leg[]> {
  const index = new Map<string, Leg[]>();
  for (const row of rows) {
    for (const reference of extractReferences(row.narration)) {
      const list = index.get(reference);
      if (list === undefined) index.set(reference, [row]);
      else list.push(row);
    }
  }
  return index;
}
