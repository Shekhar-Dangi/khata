// The PURE half of the parse queue: what an error means, and what a set of counts means.
//
// No database, no clock, no model. Same split as rules.ts / transfers.ts / items.ts, and for
// the same reason those have it: this decides whether a document gets another hour of the
// machine's attention or is set aside, and both ways of being wrong cost something real —
// a retried deterministic failure burns minutes to reach the same answer, and a transient
// hiccup treated as terminal abandons a document that was never actually unreadable.
//
// The vocabulary lives HERE and the queue imports it, the way rules.ts owns the rule
// vocabulary and routes/rules.ts imports it. It is deliberately not a CHECK constraint in the
// database: `retryPolicy`'s exhaustive switch plus its declared return type means adding a
// member without deciding its policy FAILS TO COMPILE, which a CHECK cannot do.

/**
 * Every way parsing a document can end badly. the design.
 *
 * Named rather than numbered, and closed rather than free text, because a worker that reports
 * "failed" is a worker nobody trusts — and because the retry decision below dispatches on it.
 */
export const ERROR_KINDS = [
  // -- reading the file at all
  "empty",
  "too_large",
  "unreadable_mime",
  "encrypted",
  "corrupt",
  "too_many_pages",
  // -- the extractor
  "models_missing",
  "extract_timeout",
  "extract_crashed",
  // -- the model
  "llm_unavailable",
  "llm_timeout",
  "llm_truncated",
  "schema_violation",
  // -- the answer was well-formed and wrong
  "hallucinated_lines",
  "does_not_reconcile",
  "wrong_merchant",
  "not_an_invoice",
  "credit_note",
  // -- the machinery
  "duplicate_order",
  "worker_died",
  "db_error",
  "unknown",
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

export function isErrorKind(v: unknown): v is ErrorKind {
  return typeof v === "string" && (ERROR_KINDS as readonly string[]).includes(v);
}

/**
 * Does trying again have any chance of a different answer?
 *
 * THE DISTINCTION THAT MATTERS: a transient failure is about the MACHINE's state at a moment —
 * Ollama was not running, the process was killed, a query timed out — and the same bytes fed
 * in again may well succeed. A permanent failure is about the DOCUMENT, and the document does
 * not change between attempts: an invoice whose lines do not sum to its stated total will not
 * start summing on the third try. Retrying it spends three minutes of a scarce local model to
 * be told exactly what it was told the first time, while everything behind it waits.
 *
 * Fails CLOSED for anything unrecognised — `unknown` is permanent. A failure nobody has
 * classified is a failure nobody understands, and looping on it is how a queue eats an
 * afternoon. It is cheap to be wrong in this direction: the bytes survive, the reason is
 * recorded, and `/reparse` re-runs it deliberately.
 *
 * The exhaustive switch is load-bearing. Adding a member to ERROR_KINDS without adding it here
 * is a compile error, which is precisely the guard that stops a new failure mode silently
 * inheriting somebody else's policy.
 */
export function retryPolicy(kind: ErrorKind): "transient" | "permanent" {
  switch (kind) {
    // The machine, not the document.
    case "llm_unavailable":   // Ollama was not running. Start it and this succeeds.
    case "llm_timeout":       // it was busy or cold; the next attempt may be warm.
    case "extract_timeout":
    case "extract_crashed":   // a native crash in a C extension is not reproducible by rule.
    case "worker_died":       // `node --watch` restarted mid-call. Most Tuesdays.
    case "db_error":
      return "transient";

    // The document, or a settled fact about it.
    case "empty":
    case "too_large":         // never truncate. A bigger window fixes it, a retry does not.
    case "unreadable_mime":
    case "encrypted":         // no password will appear between attempts.
    case "corrupt":
    case "too_many_pages":
    case "llm_truncated":     // the budget was wrong; re-running spends it again to prove it.
    case "schema_violation":
    case "hallucinated_lines":
    case "does_not_reconcile":
    case "wrong_merchant":
    case "not_an_invoice":
    case "credit_note":       // held for the refund feature, not a failure to fix by retrying.
    case "duplicate_order":   // it is already in the ledger. Succeeding would be the bug.
      return "permanent";

    // A setup step, not a retry. Docling downloads hundreds of megabytes on first run, and
    // spinning on that three times makes one missing install look like three broken documents.
    case "models_missing":
      return "permanent";

    case "unknown":
      return "permanent";
  }
}

export function isTransient(kind: ErrorKind): boolean {
  return retryPolicy(kind) === "transient";
}

/**
 * What a person should be told about a failure, in their own terms.
 *
 * Separate from the kind because the kind is a key the code dispatches on and this is a
 * sentence someone reads. Keeping them apart is why the vocabulary can be renamed without
 * rewriting the UI, and why the UI can be rewritten without anything being re-classified.
 */
export function explain(kind: ErrorKind): string {
  switch (kind) {
    case "empty": return "the file had no content";
    case "too_large": return "this document is too big to read in one pass, and splitting it found no invoice boundary";
    case "unreadable_mime": return "nothing here reads that kind of file";
    case "encrypted": return "the PDF is password-protected";
    case "corrupt": return "the PDF could not be opened";
    case "too_many_pages": return "too many pages for an invoice — this looks like a different kind of document";
    case "models_missing": return "the document reader's models are not installed yet — run the setup step once";
    case "extract_timeout": return "reading the document took too long";
    case "extract_crashed": return "the document reader stopped unexpectedly";
    case "llm_unavailable": return "the local model is not running — is Ollama started?";
    case "llm_timeout": return "the local model took too long to answer";
    case "llm_truncated": return "the model's answer was cut off before it finished";
    case "schema_violation": return "the model's answer was not in the shape we asked for";
    case "hallucinated_lines": return "the model listed items that do not appear in the document";
    case "does_not_reconcile": return "the line items do not add up to the total the invoice states";
    case "wrong_merchant": return "the merchant on the document does not match the one expected";
    case "not_an_invoice": return "this does not look like an invoice";
    case "credit_note": return "this is a credit note — held until refunds are supported";
    case "duplicate_order": return "this order is already in your ledger";
    case "worker_died": return "the app restarted while this was being read";
    case "db_error": return "the database refused the write";
    case "unknown": return "something went wrong that nobody has named yet";
  }
}

export type Counts = {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
};

/**
 * Seconds remaining, or null when there is nothing honest to say.
 *
 * Null on the FIRST batch is the important case: with no completed job there is no rate, and
 * inventing one produces a countdown that is confidently wrong for the first ten minutes.
 * A bar with no estimate is better than a bar with a lie — the same argument
 * `reconcile()` makes about tolerances, applied to time.
 *
 * @param medianSeconds median observed seconds per finished job, or null if none finished yet
 */
export function estimateRemaining(counts: Counts, medianSeconds: number | null): number | null {
  if (medianSeconds === null || medianSeconds <= 0) return null;
  const outstanding = counts.queued + counts.running;
  if (outstanding === 0) return 0;
  return Math.round(outstanding * medianSeconds);
}

/**
 * Is this batch finished, judged from the counts alone?
 *
 * Deliberately NOT "done + failed === total". A batch whose total was corrected at enqueue
 * time (documents already queued elsewhere are skipped) would never satisfy that equality, and
 * a progress bar that cannot reach its own end is a bug people report as a hang.
 */
export function isSettled(counts: Counts): boolean {
  return counts.queued === 0 && counts.running === 0;
}

/** Fraction complete in [0,1]. Guards the empty batch, which would divide by zero. */
export function fractionDone(counts: Counts): number {
  const finished = counts.done + counts.failed;
  const denominator = Math.max(counts.total, finished, 1);
  return Math.min(1, finished / denominator);
}
