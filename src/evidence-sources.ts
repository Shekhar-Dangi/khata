// The registry of evidence sources, and the re-match sweep that runs over them.
//
// WHY THIS EXISTS. the design requires that matching be re-runnable and be re-run
// after every statement import, because the most common reason a record is unmatched is that
// its month has not been imported yet — "not orphaned, early". the design measured
// exactly that on real data: two September orders sitting outside a ledger that ends in
// August. Nothing resolves them until matching runs again.
//
// That re-run had no way to happen. `matchSplitwiseEvidence` is reachable only from
// `scripts/match-splitwise.ts` and from inside the import route, so the sweep ran when a
// SOURCE file arrived and never when a STATEMENT did — which is the wrong way round for the
// case that matters.
//
// WHY A REGISTRY RATHER THAN A GENERALISED MATCHER. The tempting move is to abstract the
// sweep itself: a strategy interface over "what cash do we expect" and "how do we allocate".
// the design explicitly rules that out — "Do not extract a shared matcher yet. Two
// instances is not a pattern... Build the third concretely, then extract with three real cases
// in hand." The generic parts (`matchToTransaction`, `nearMisses`, the candidate load) are
// ALREADY shared, and they are the parts that carry the money rules. What differs per source
// is genuinely different: a Splitwise expense splits between people, an invoice splits between
// categories. So the seam is a LIST — adding a source is one entry — and the sweep behind each
// entry stays concrete until there are three of them to generalise from.

import type { PoolClient } from "pg";

import { type MatchSummary, matchSplitwiseEvidence } from "./evidence-detect.ts";

export type EvidenceSource = {
  /** Matches `evidence.source_type`. */
  sourceType: string;
  label: string;
  /**
   * Why this source cannot run right now, or null if it can.
   *
   * Separate from `sweep` so an unconfigured source is REPORTED rather than thrown past. A
   * ledger with no Splitwise data should still be able to re-match its invoices.
   */
  unavailable(): string | null;
  /** Re-run matching over every still-unlinked record of this source. */
  sweep(client: PoolClient): Promise<MatchSummary>;
};

const splitwise: EvidenceSource = {
  sourceType: "splitwise",
  label: "Splitwise",
  unavailable() {
    // Same value the import route demands, and for the same reason: it names which person
    // column in the export is the owner's, and guessing it would attribute a flatmate's
    // shares. Absent means "this source is not set up here", not "fail the request".
    return process.env.SPLITWISE_ME
      ? null
      : "SPLITWISE_ME is not set — it names your column in the export";
  },
  sweep(client) {
    return matchSplitwiseEvidence(client, process.env.SPLITWISE_ME as string);
  },
};

/**
 * Every source that can be re-matched. **This is the extension point.**
 *
 * An invoice parser adds one entry here and changes nothing else — not the route, not the
 * response shape, not the statement-import path that will call this.
 */
export const EVIDENCE_SOURCES: EvidenceSource[] = [splitwise];

export type SweepResult =
  | { sourceType: string; label: string; ran: true; summary: MatchSummary }
  | { sourceType: string; label: string; ran: false; skipped: string };

/**
 * Re-run matching across the registered sources.
 *
 * Idempotent by construction rather than by care: every sweep considers only records with no
 * transaction linked yet (`UNLINKED` in evidence-detect.ts), so running this twice does the
 * same work as running it once, and a link a person made by hand is never re-decided. That is
 * the invariant the design asks for, and it is what makes this safe to call
 * unconditionally after an import.
 *
 * @param sourceType run just one source, or every registered one when omitted.
 */
export async function rematchEvidence(
  client: PoolClient,
  sourceType?: string,
): Promise<SweepResult[]> {
  const sources = sourceType
    ? EVIDENCE_SOURCES.filter((s) => s.sourceType === sourceType)
    : EVIDENCE_SOURCES;

  const results: SweepResult[] = [];
  for (const source of sources) {
    const skipped = source.unavailable();
    if (skipped !== null) {
      results.push({ sourceType: source.sourceType, label: source.label, ran: false, skipped });
      continue;
    }
    results.push({
      sourceType: source.sourceType,
      label: source.label,
      ran: true,
      summary: await source.sweep(client),
    });
  }
  return results;
}

/** Is this a source we know how to re-match? Lets a route 400 on a typo instead of no-opping. */
export function isKnownSource(sourceType: string): boolean {
  return EVIDENCE_SOURCES.some((s) => s.sourceType === sourceType);
}
