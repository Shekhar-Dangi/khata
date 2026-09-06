// Recognising a merchant in a bank narration. Pure, no DB, no clock.
//
// WHY THIS EXISTS — a confirmed defect, found on real data.
// `matchToTransaction` filters candidates on exact amount, sign and a 3-day gap and NOTHING
// else, and `loadCandidates` hands it the whole ledger. For an Amazon order of some amount X,
// exactly one candidate fell in that window:
//
//     txn N | a card account | two days earlier | -X | UPI-Debit-...-flipkartpayment-...
//
// One hit, so the matcher returns `{ kind: "matched" }` and AUTO-ACCEPTS it. An Amazon
// grocery basket would be allocated against a Flipkart payment.
//
// This is NOT a bug in the Splitwise matcher. A Splitwise expense has no merchant string to
// compare against, so amount and date genuinely are all the signal there is. An invoice is
// different: **we know the merchant**, and discarding that is what creates the error. So the
// merchant becomes a HARD FILTER — a disqualifier applied BEFORE the 1:1 test, so a
// mismatched candidate can never be the unique hit that triggers an auto-accept.

/**
 * Bank narrations, made comparable.
 *
 * Two things happen here and both are load-bearing:
 *
 *  - **Zero-width characters are stripped.** Real bank narrations contain them, and
 *    they land INSIDE merchant names — a narration reads `flipkart` and is actually
 *    `f​lipkart`, so `includes("flipkart")` is false. An invisible character silently
 *    defeating a substring test is the worst kind of bug: the data looks correct in every
 *    view you would use to debug it.
 *  - **Case is folded and whitespace collapsed**, because the same merchant arrives as
 *    `BLINKIT`, `Blinkit` and `blinkit.rzp` across three payment processors.
 *
 * Deliberately NOT stripping punctuation: `blinkit.payu@hdfcbank` is more identifying with its
 * separators than without, and removing them would let unrelated words fuse into a false hit.
 */
export function normaliseNarration(narration: string | null): string {
  if (narration === null) return "";
  return narration
    // U+200B..U+200D zero-width space/non-joiner/joiner, U+FEFF byte-order mark.
    .replace(/[​-‍﻿]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokens that identify a source in a narration. ANY one of them is enough.
 *
 * Measured against the live ledger rather than imagined: Blinkit appears under 11 distinct
 * token shapes across four payment processors and two company names —
 * `blinkit.rzp@hdfcbank` (Razorpay), `blinkit.payu@hdfcbank` (PayU),
 * `grofers1paytm@hdfcbank` (Paytm, under the FORMER company name) and `paytm-blinkit@ptybl` —
 * and every one of them contains the substring `blinkit` except the Grofers ones. Two tokens
 * therefore cover all 25 Blinkit rows in the ledger.
 *
 * `null` means the source has NO merchant signal and the filter does not apply. Splitwise is
 * that case and it is not an omission: a shared expense is settled by a person-to-person
 * transfer whose narration names a PERSON, so requiring a merchant token would reject every
 * genuine match.
 */
export const MERCHANT_TOKENS: Record<string, string[] | null> = {
  splitwise: null,
  blinkit: ["blinkit", "grofers"],
  // Amazon marketplace invoices are issued by the SELLER, not by Amazon — a real invoice
  // corpus names Amazon Retail, Amazon Seller Services and a dozen third-party sellers.
  // But the BANK never sees any of them: the payment goes to Amazon, so the narration says
  // Amazon. The tokens belong to the payer-facing name.
  amazon: ["amazon", "amzn"],
};

/**
 * Could this narration be a payment to this source?
 *
 * **Returns true when we have no signal**, which is the safe direction for a hard filter: an
 * unknown source must not silently reject every candidate and turn a working matcher into one
 * that finds nothing. The filter can only ever REMOVE candidates it is confident about.
 */
export function narrationIdentifies(narration: string | null, sourceType: string): boolean {
  const tokens = MERCHANT_TOKENS[sourceType];
  if (tokens === null || tokens === undefined) return true;
  const text = normaliseNarration(narration);
  if (text === "") return false; // a source WITH a signal cannot match a row that has no words
  return tokens.some((t) => text.includes(t));
}
