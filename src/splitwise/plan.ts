// Turn parsed Splitwise rows into the records that will be written. Pure and DB-free: the
// category map arrives as an argument, so this is testable without a database and a map
// change never requires re-parsing anything.
//
// Two ideas carry it: the net decomposition (a person's net is what they paid minus what they
// owed), and consumption as a second view beside spend.

import type { SplitwiseRow } from "./splitwise.ts";

/**
 * The category map, as the database holds it. Two states, and the difference matters:
 *   - key absent          -> never seen. Belongs in the review queue.
 *   - key present, null   -> deliberately unmappable ('General', 'Payment'). Do not ask.
 */
export type CategoryMap = Map<string, number | null>;

export type PlannedEvidence = {
  /** A composite natural key. There is no expense id in the export to use instead. */
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
  /**
   * The group these rows were actually keyed by, normalised.
   *
   * REPORTED rather than left to the caller to re-derive. Both writers scope their
   * consumption sweep with `payload->>'group' = $n`, and a caller that used its own raw
   * spelling there would delete nothing and then insert — which is how a re-import doubles
   * a group's consumption instead of replacing it.
   */
  group: string;
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
 * How long a group name may be.
 *
 * Not a style rule — `external_ref` is indexed by `evidence_source_ref_uniq`, and a btree
 * entry over roughly 2704 bytes is REFUSED outright ("index row size exceeds maximum"). The
 * group spends part of a budget it shares with the description, so it gets a cap it cannot
 * realistically reach: 64 is comfortably more than any group anyone names, and leaves the
 * rest of the budget to text we do not control.
 */
export const MAX_GROUP_LENGTH = 64;

/**
 * The ONE form of a group name.
 *
 * The group is the first field of the composite natural key AND the key the Sources screen groups
 * imports by. Those were two different strings: `externalRef` lowercased it and `payload.group`
 * kept whatever the caller passed. So "Flat" and "flat" were the same record but two different
 * imports, and an export that dropped a row left it stranded under the old spelling with a
 * batch header of its own.
 *
 * Idempotent, so calling it twice is harmless — which is why both this module's entry points
 * call it rather than trusting a caller to have done it.
 *
 * What it does, and why each part:
 *   NFC        — "ā" as one code point and as "a" + combining macron are the same NAME, and a
 *                key that disagrees about that is a key that silently duplicates.
 *   drop Cc    — control characters. A NUL cannot be stored in a Postgres text column at all,
 *                so this is the difference between a normalised name and a 500.
 *   drop "|"   — the SEPARATOR of the composite key. A group containing one would shift every
 *                field after it, so two different rows could produce the same ref.
 *   collapse   — the same rule the description already gets, so " my  flat " is one name.
 *   lowercase  — the case-insensitivity `externalRef` always applied, now applied ONCE.
 *   cap        — by CODE POINT, not by UTF-16 unit: `slice` can cut a surrogate pair in half
 *                and leave a lone surrogate, which Postgres rejects as invalid UTF-8.
 *
 * Deliberately NOT an ASCII allowlist: this is a local-first tool for a place where a group is
 * as likely to be named in Devanagari as in Latin, and mangling that name would be worse than
 * any of the problems an allowlist solves.
 */
export function normaliseGroup(raw: string): string {
  const cleaned = raw
    .normalize("NFC")
    .replace(/\p{Cc}/gu, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return [...cleaned].slice(0, MAX_GROUP_LENGTH).join("").trim();
}

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
    normaliseGroup(group),
    row.date,
    row.description.trim().toLowerCase().replace(/\s+/g, " "),
    row.costPaise,
  ].join("|");
}

/**
 * @param rows  parsed rows, in file order
 * @param group a stable identifier for the group this export came from. Normalised HERE,
 *              once, and reported back on the plan — see `normaliseGroup`.
 * @param map   source category -> our category id, or null for "deliberately unmappable"
 */
export function planImport(
  rows: SplitwiseRow[],
  group: string,
  map: CategoryMap,
): ImportPlan {
  // Once, at the top, and never the raw argument again below this line. The bug this
  // replaces was exactly a function using two spellings of the same name in two places.
  const key = normaliseGroup(group);
  const plan: ImportPlan = {
    group: key,
    evidence: [],
    consumption: [],
    unclassified: [],
    unmappedCategories: [],
    stats: { paid: 0, owedByMe: 0, notMine: 0, payments: 0 },
  };
  const unmapped = new Set<string>();

  for (const row of rows) {
    const ref = externalRef(key, row);

    // EVERY row becomes evidence, including ones the owner is not part of.
    //
    // A net of zero means "not our expense — create nothing", and that is right
    // about consumption and allocations. It is NOT right about evidence: `evidence` is the
    // external record as it stands, and dropping a fifth of the rows would make the footer
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
        // The SAME string the ref was built from. These were the two that disagreed.
        group: key,
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
