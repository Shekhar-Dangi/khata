// Shapes returned by the evidence routes. Kept beside the view that reads them, the way
// rules/rules.ts and reports/reports.ts already are.

export type NearMissCandidate = {
  transactionId: string;
  txnDate: string;
  dayGap: number;
  narration: string | null;
};

export type NearMiss = {
  evidenceId: string;
  externalRef: string;
  description: string | null;
  evidenceDate: string;
  amountPaise: number;
  sourceCategory: string;
  candidates: NearMissCandidate[];
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
  };
  near_misses: NearMiss[];
};

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
