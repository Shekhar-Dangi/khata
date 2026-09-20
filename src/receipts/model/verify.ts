// The four checks that decide whether a model's reading of a document is believed.
//
// Confidence is DERIVED here, never asked for. PURE — no model, no database, no clock — which is
// the whole point: the thing standing between a confident wrong answer and the ledger must be
// testable without either of the two heavy dependencies that produced the answer.
//
// WHY NOT A CONFIDENCE SCORE. An earlier experiment measured self-reported confidence on
// this project: 0.95 on a correct answer, 0.95 on "Unknown", 0.80 on a wrong one. A threshold
// over that is a threshold over noise. So nothing here asks the model anything — every check
// compares the ANSWER against the DOCUMENT, and what comes out is a named reason a person can
// act on rather than a number nobody can interpret.

import type { ErrorKind } from "./queue-policy.ts";
import type { LlmRecord } from "./read.ts";

export type Verdict =
  | { ok: true; warnings: string[] }
  | { ok: false; kind: ErrorKind; reason: string; warnings: string[] };

/**
 * Below this fraction of the document's money-shaped tokens being claimed by some line, the
 * record is FLAGGED — never failed.
 *
 * A soft check on purpose: an invoice quotes its own GSTIN, a delivery address has digits, and
 * a tax table prints percentages, so perfect coverage is not achievable and demanding it would
 * reject correct documents. **This threshold is a placeholder and is documented as such**, the
 * way `AUTO_LINK_SIMILARITY` is: calibrate it against the corpus before trusting the number.
 */
export const COVERAGE_FLOOR = 0.3;

/** Normalised the way `canonicalName` normalises, so whitespace and case raise no false alarm. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    // Zero-width characters hide inside merchant names in real narrations — `merchants.ts`
    // documents the trap — and they would make a verbatim description fail to match
    // its own source.
    .replace(/[​-‍﻿]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Check every claim in the record against the document it came from.
 *
 * Order matters: the cheapest and most decisive checks run first, so the reason reported is
 * the earliest one that can be decided. That is the same rule `routes/` follows when it
 * validates an id before a body — the first failure should be the informative one.
 */
export function verify(record: LlmRecord, markdown: string): Verdict {
  const warnings: string[] = [];
  const fail = (kind: ErrorKind, reason: string): Verdict => ({ ok: false, kind, reason, warnings });

  // 1. IS THIS EVEN AN INVOICE. Asked first because every check below is meaningless
  //    otherwise, and because a warranty card that reconciles to zero would pass them all.
  if (!record.is_invoice) {
    return fail("not_an_invoice", "the document does not appear to be an invoice");
  }
  // A refund is a real document and a correct reading; it is just not something the ledger can
  // represent yet. Held rather than failed-as-broken — 29 of the corpus are credit notes.
  if (record.is_credit_note) {
    return fail("credit_note", "this is a credit note — held until refunds are supported");
  }

  // 2. COMPLETENESS. A truncated generation usually fails here first, and it is cheap.
  if (record.external_ref.trim() === "") {
    return fail("schema_violation", "no order reference was found on the document");
  }
  if (record.invoices.length === 0) {
    return fail("schema_violation", "the document produced no invoices");
  }
  const allLines = record.invoices.flatMap((i) => i.lines);
  if (allLines.length === 0) {
    return fail("schema_violation", "the document produced no line items");
  }
  if (record.total_paise === 0) {
    return fail("schema_violation", "the order total is zero");
  }

  // 3. ARITHMETIC — the strongest signal available, and the one already trusted by the
  //    deterministic path. EXACT, to the paise, no tolerance: every original sample reconciled
  //    exactly, so drift means a mis-read row, and a mis-read row is money in the wrong
  //    category. A tolerance would convert a loud bug into a quiet one.
  for (const inv of record.invoices) {
    const lineSum = inv.lines.reduce((a, l) => a + l.amount_paise, 0);
    if (lineSum !== inv.total_paise) {
      return fail(
        "does_not_reconcile",
        `invoice ${inv.invoice_number}: the lines sum to ${paise(lineSum)} ` +
          `but the invoice states ${paise(inv.total_paise)}`,
      );
    }
  }
  const invoiceSum = record.invoices.reduce((a, i) => a + i.total_paise, 0);
  if (invoiceSum !== record.total_paise) {
    return fail(
      "does_not_reconcile",
      `order ${record.external_ref}: the invoices sum to ${paise(invoiceSum)} ` +
        `but the order total is ${paise(record.total_paise)}`,
    );
  }

  // 4. GROUNDEDNESS — the failure a model has that a parser does not.
  //
  //    A parser can only report what it read off the page; a model can produce a plausible row
  //    that was never there. Nothing else in this list catches that: an invented line that
  //    happens to make the arithmetic work is INDISTINGUISHABLE from a correct one to every
  //    check above. So each description has to be findable in the source.
  const haystack = normalise(markdown);
  const ungrounded = allLines.filter((l) => {
    const needle = normalise(l.description);
    if (needle === "") return true;
    if (haystack.includes(needle)) return false;
    // A long description may be re-flowed by the converter — a line break becomes a space
    // somewhere we did not predict — so a run of its leading words is enough. Short ones must
    // match whole, because two or three words match far too easily by accident.
    const words = needle.split(" ");
    if (words.length < 4) return true;
    return !haystack.includes(words.slice(0, 4).join(" "));
  });
  if (ungrounded.length > 0) {
    return fail(
      "hallucinated_lines",
      `${ungrounded.length} item(s) do not appear in the document, starting with ` +
        `"${ungrounded[0].description.slice(0, 60)}"`,
    );
  }

  // 5. COVERAGE (soft). How much of the document's money was claimed by some line? Flags only.
  const coverage = coverageOf(record, markdown);
  if (coverage !== null && coverage < COVERAGE_FLOOR) {
    warnings.push(
      `only ${Math.round(coverage * 100)}% of the amounts printed on this document were ` +
        "claimed by a line — it may be missing rows",
    );
  }

  // Every line having a quantity of zero is not wrong enough to refuse, and is odd enough to
  // mention. Same class as the coverage flag: worth an eye, not worth a rejection.
  if (allLines.every((l) => l.qty === 0)) {
    warnings.push("no line states a quantity");
  }

  return { ok: true, warnings };
}

/** Fraction of money-shaped tokens in the document that some line's amount accounts for. */
export function coverageOf(record: LlmRecord, markdown: string): number | null {
  const printed = [...markdown.matchAll(/\b\d{1,3}(?:,\d{2,3})*\.\d{2}\b|\b\d+\.\d{2}\b/g)]
    .map((m) => Math.round(Number(m[0].replace(/,/g, "")) * 100))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (printed.length === 0) return null;

  const claimed = new Set<number>();
  for (const inv of record.invoices) {
    claimed.add(Math.abs(inv.total_paise));
    for (const l of inv.lines) claimed.add(Math.abs(l.amount_paise));
  }
  claimed.add(Math.abs(record.total_paise));

  const matched = printed.filter((p) => claimed.has(p)).length;
  return matched / printed.length;
}

/** Rupees, for a message a person reads. Never used for arithmetic. */
function paise(n: number): string {
  return "Rs " + (n / 100).toFixed(2);
}
