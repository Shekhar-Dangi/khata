// Shapes returned by the evidence routes. Kept beside the view that reads them, the way
// rules/rules.ts and reports/reports.ts already are.

export type NearMissCandidate = {
  transactionId: string;
  txnDate: string;
  dayGap: number;
  narration: string | null;
  accountName: string | null;
  /**
   * What a MANUAL link to this candidate would do to what already explains it. Same four
   * answers the finder computes for a searched row; absent only where the server did not
   * load allocations — the finder treats absent as unknown, never as "free".
   */
  claim?: Claim;
};

/**
 * What linking would do to a transaction that already carries an explanation — the
 * client's mirror of `resolvePrecedence`'s tiers, as `claimOn` answers them on the server.
 *
 *   free      nothing there yet
 *   yours     a person wrote it; linking REMOVES it, and no undo brings it back
 *   replaces  a rule's guess; linking removes it, a rules re-run regenerates it
 *   refused   another record's evidence; the server refuses even a person
 */
export type Claim = "free" | "yours" | "replaces" | "refused";

/** What POST /evidence/:id/match answers on success — see `linkEvidence` on the server. */
export type LinkResult = {
  /** Everything this link removed from the transactions it claimed. */
  displaced: number;
  /** Of those, the rows a PERSON authored — the half no undo or re-run restores. */
  displacedAuthored: number;
  allocationsWritten: number;
  /** Linked, but the source category has no mapping, so only others' share was written. */
  partial: boolean;
  /** The transactions picked totalled less than the record, so the split was capped. */
  scaledDown: boolean;
};

export type NearMiss = {
  evidenceId: string;
  externalRef: string;
  description: string | null;
  evidenceDate: string;
  amountPaise: number;
  /** What the bank should show, signed: negative means cash should have left. */
  expectedPaise: number;
  sourceCategory: string;
  candidates: NearMissCandidate[];
};

/** One record linked to one transaction — what the preview shows as "matched". */
export type MatchedPair = {
  evidenceId: string;
  externalRef: string;
  description: string | null;
  evidenceDate: string;
  amountPaise: number;
  transactionId: string;
  txnDate: string;
  txnAmountPaise: number;
  narration: string | null;
  dayGap: number;
};

export type ImportResponse = {
  /** false for a dry run — the server did the work and rolled it back. */
  committed: boolean;
  imported: {
    source: string;
    group: string;
    warnings: string[];
    rows: number;
    stats: { paid: number; owedByMe: number; notMine: number; payments: number };
    evidenceWritten: number;
    consumptionWritten: number;
    consumptionReplaced: number;
    unclassified: { count: number; amountPaise: number };
    unmappedCategories: string[];
  };
  match: {
    considered: number;
    matched: number;
    ambiguous: number;
    noCandidate: number;
    noCashExpected: number;
    allocationsWritten: number;
    partiallyAllocated: number;
    conflicted: number;
    displaced: number;
    nearMissed: number;
    conflicts: { externalRef: string; transactionId: string; reason: string }[];
    pairs: MatchedPair[];
  };
  near_misses: NearMiss[];
};

// ── the worklist ────────────────────────────────────────────────────────────────────────
//
// The import response above describes an EVENT. Everything below describes the STATE the
// ledger is in now, which is what the review screen is actually built from: reload the page
// and the event is gone, but the work is still there.

/** Where a record stands. The four segments of the review screen, in decision order. */
export type RecordState = "matched" | "near" | "conflicted" | "unmatched";

export type LinkedTransaction = {
  transactionId: string;
  txnDate: string;
  txnAmountPaise: number;
  narration: string | null;
  accountName: string | null;
  dayGap: number;
};

export type EvidenceRecord = {
  evidenceId: string;
  externalRef: string;
  description: string | null;
  evidenceDate: string;
  amountPaise: number;
  expectedPaise: number;
  sourceCategory: string;
  group: string;
  state: RecordState;
  /** What pays for it. Empty unless `state` is "matched". */
  linked: LinkedTransaction[];
  /**
   * The transactions worth offering: near misses when `state` is "near", the single
   * already-explained match when it is "conflicted".
   */
  candidates: NearMissCandidate[];
  /** Why the matcher would not take the candidate. Only set when `state` is "conflicted". */
  conflict: string | null;
  /**
   * What the owner's share is filed under — read off the ALLOCATIONS once the record is
   * linked, and off the source map before that. Two sources because they answer two different
   * questions ("what IS it" vs "what WOULD it be"), and only one can be true at a time.
   */
  categoryName: string | null;
  /** The same, as an id, so the picker opens on what is already chosen. */
  categoryId: string | null;
  /**
   * The source's category has no answer and this record has a share to file, so the screen may
   * ask. Stays true after a choice is made — a category picked by hand must stay correctable.
   * False where the map DOES answer: a re-link re-derives from the map, so an override there
   * would be quietly undone, and the place to change that answer is the map.
   */
  canChoose: boolean;
  /**
   * The owner's share is real money and nothing can say what it was: an expense, with a
   * non-zero share, whose source category the map maps to NULL on purpose. This is the
   * remainder sitting unexplained on the transaction — and the only case where the screen
   * offers a category, because anywhere else a re-link would silently undo the choice.
   */
  needsCategory: boolean;
};

export type RecordsResponse = {
  records: EvidenceRecord[];
  total: number;
  limit: number;
  offset: number;
};

/** One import, as its collapsed header summarises it. */
export type ImportBatch = {
  source: string;
  group: string;
  records: number;
  matched: number;
  near: number;
  conflicted: number;
  unmatched: number;
  /** Someone else paid — consumption only, nothing to look for. */
  noCashExpected: number;
  lastImportedAt: string;
};

/** How much of an import is still work. Drives the header, and whether it opens by default. */
export function outstanding(batch: ImportBatch): number {
  return batch.near + batch.conflicted + batch.unmatched;
}

/**
 * The label for one segment, in the ledger's own vocabulary.
 *
 * A lookup rather than a prop passed down three times: the same three words appear in the
 * section header, the empty state and the pager unit, and three literals in three files is how
 * a screen ends up calling the same pile of rows two different things.
 */
export const SEGMENTS: { state: RecordState; title: string; unit: string; blurb: string }[] = [
  {
    state: "matched",
    title: "Matched to your bank",
    unit: "records",
    blurb: "Same amount, within a few days. Any can be unlinked.",
  },
  {
    state: "near",
    title: "Same amount, different day",
    unit: "records",
    blurb: "Right amount, but outside the date window.",
  },
  {
    state: "conflicted",
    title: "Found it — but you explained that row",
    unit: "records",
    // The one warning kept whole: linking here destroys something, and cannot be undone.
    blurb: "Matches a row you explained yourself. Linking replaces that, and can't be undone.",
  },
  {
    state: "unmatched",
    title: "Still looking for a payment",
    unit: "records",
    blurb: "No bank row nearby. Pick the payment — or payments.",
  },
];

/**
 * Whole days between two ISO dates, unsigned.
 *
 * The client's copy of `dayGap` from src/transfers.ts. Duplicated rather than shared because
 * the two live either side of the wire and nothing here imports server code — but they must
 * agree, so both parse as UTC midnight: the local-time constructor shifts the day either side
 * of Greenwich and would make the same pair of dates 2 days apart on one machine and 3 on
 * another.
 */
export function daysApart(a: string, b: string): number {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 86_400_000);
}

/** A date as this screen writes it: short, and never ambiguous about the year. */
export function shortDate(iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A group name for the import, derived from the filename.
 *
 * The export does not name its group anywhere inside the file — only the filename carries it,
 * and the group is part of a record's identity. Derived rather than
 * asked for, because a person renaming their download should not silently create a second
 * group; shown in the form so it can be corrected when it matters.
 */
export function groupFromFilename(name: string): string {
  return (
    name
      .replace(/\.[a-z]+$/i, "")
      // Splitwise names exports "<group>_<date>_export" — strip the parts that change every
      // time, or every download would key its rows to a different group.
      .replace(/_\d{4}-\d{2}-\d{2}.*$/, "")
      .replace(/_export$/i, "")
      .trim() || "default"
  );
}
