// Turn parsed Splitwise rows into the records that will be written. Pure and DB-free: the
// category map arrives as an argument, so this is testable without a database and a map
// change never requires re-parsing anything.
//
// Design in the design (the net decomposition) and (consumption).

import type { SplitwiseRow } from "./splitwise.ts";

/**
 * The category map, as the database holds it. Two states, and the difference matters:
 *   - key absent          -> never seen. Belongs in the review queue.
 *   - key present, null   -> deliberately unmappable ('General', 'Payment'). Do not ask.
 */
export type CategoryMap = Map<string, number | null>;

export type PlannedEvidence = {
  /** its composite natural key. There is no expense id in the export to use instead. */
  externalRef: string;
  date: string;
  description: string;
  sourceCategory: string;
  costPaise: number;
  /** The owner's net. Positive = gave value. */
  netPaise: number;
  kind: "expense" | "payment";
  payload: Record<string, unknown>;
};

export type PlannedConsumption = {
  externalRef: string;
  categoryId: number;
  /** Signed like allocations: negative is consumed. */
  amountPaise: number;
  consumedOn: string;
};

export type ImportPlan = {
  evidence: PlannedEvidence[];
  consumption: PlannedConsumption[];
  /**
   * Consumption we know happened but cannot categorise, because the source category has no
   * mapping. NOT written, and NOT silently dropped either: the amount is real and the
   * consumption total understates by exactly this much until the map learns the category.
   * Surfacing it is what stops the number quietly lying.
   */
  unclassified: { externalRef: string; sourceCategory: string; amountPaise: number }[];
  /** Source categories with no row in the map at all — the review queue. */
  unmappedCategories: string[];
  /** Counts, for the import summary. */
  stats: { paid: number; owedByMe: number; notMine: number; payments: number };
};

/**
 * Build the natural key for one row.
 *
 * Readable rather than hashed, deliberately: this value ends up in `evidence.external_ref`
 * and the first thing anyone does with a suspected duplicate is look at it. A hash would
 * make that a lookup instead of a glance, and it buys nothing — collisions come from the
 * data being genuinely identical, not from the encoding.
 *
 * `group` comes from the caller (the export is per-group but does not name the group
 * inside the file, only in its filename), so two groups can hold the same expense on the
 * same day without colliding.
 */
export function externalRef(group: string, row: SplitwiseRow): string {
  return [
    group.trim().toLowerCase(),
    row.date,
    row.description.trim().toLowerCase().replace(/\s+/g, " "),
    row.costPaise,
  ].join("|");
}

/**
 * @param rows  parsed rows, in file order
 * @param group a stable identifier for the group this export came from
 * @param map   source category -> our category id, or null for "deliberately unmappable"
 */
export function planImport(
  rows: SplitwiseRow[],
  group: string,
  map: CategoryMap,
): ImportPlan {
  const plan: ImportPlan = {
    evidence: [],
    consumption: [],
    unclassified: [],
    unmappedCategories: [],
    stats: { paid: 0, owedByMe: 0, notMine: 0, payments: 0 },
  };
  const unmapped = new Set<string>();

  for (const row of rows) {
    const ref = externalRef(group, row);

    // EVERY row becomes evidence, including ones the owner is not part of.
    //
    // the design says a net of zero means "not our expense — create nothing", and that is right
    // about consumption and allocations. It is NOT right about evidence: `evidence` is the
    // external record as it stands, and dropping 20 of 93 rows would make the footer
    // balances impossible to re-derive from the database, throwing away the one integrity
    // check this format has.
    plan.evidence.push({
      externalRef: ref,
      date: row.date,
      description: row.description,
      sourceCategory: row.category,
      costPaise: row.costPaise,
      netPaise: row.netPaise,
      kind: row.kind,
      payload: {
        cost_paise: row.costPaise,
        nets_paise: row.netsPaise,
        currency: row.currency,
        source_category: row.category,
        kind: row.kind,
        group,
      },
    });

    // A settlement moves money between people; it records no consumption. Its cash leg is
    // matched to a bank row and allocated to Transfers > Shared later. Counting one
    // here would double-count, because the consumption was already recorded when the
    // underlying expenses happened.
    if (row.kind === "payment") {
      plan.stats.payments++;
      continue;
    }

    // net > 0: we fronted the cash. The consumption comes from ALLOCATIONS once the bank
    // row is matched — writing a consumption row here as a stopgap would survive the match
    // and count the amount twice. See the invariant in src/consumption.ts.
    if (row.netPaise > 0) {
      plan.stats.paid++;
      continue;
    }

    // net === 0: someone else's expense entirely. Evidence only.
    if (row.netPaise === 0) {
      plan.stats.notMine++;
      continue;
    }

    // net < 0: someone else paid, and we consumed |net|. This is the case with no
    // transaction behind it — the reason the consumption table exists.
    plan.stats.owedByMe++;

    if (!map.has(row.category)) unmapped.add(row.category);

    const categoryId = map.get(row.category) ?? null;
    if (categoryId === null) {
      // Covers both "never seen" and "deliberately unmappable". Either way the amount is
      // real and uncategorised, so it is reported rather than written or dropped.
      plan.unclassified.push({
        externalRef: ref,
        sourceCategory: row.category,
        amountPaise: row.netPaise,
      });
      continue;
    }

    plan.consumption.push({
      externalRef: ref,
      categoryId,
      amountPaise: row.netPaise, // already negative: consumed
      consumedOn: row.date,
    });
  }

  plan.unmappedCategories = [...unmapped].sort();
  return plan;
}
