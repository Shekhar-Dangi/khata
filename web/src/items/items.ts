// The product catalogue, as the Products page reads it. Beside the view, the way
// rules/rules.ts and reports/reports.ts already are.
//
// This is the OTHER half of the item story. `sources/stagedItems.ts` describes products in an
// inbox — a bounded pile someone is working through, fetched whole and filtered in the browser.
// This describes the catalogue, which grows one row per product you ever buy and is therefore
// filtered and paged on the SERVER, in SQL, against indexed columns. Two files because they are
// two different problems that happen to be about the same noun.

/** One product. `category_id` arrives as a string: pg renders BIGINT as one. */
export type Item = {
  id: string;
  /** The normalised key — quantity and pack form stripped. What the page leads with. */
  canonical_name: string;
  /** The fullest raw string ever seen for it, kept verbatim. Null before one is recorded. */
  display_name: string | null;
  category_id: string | null;
  category_name: string | null;
  /** 'user' is the decision a classifier may never overwrite. */
  category_source: string | null;
  /** How many merchant spellings point here — the grouping this catalogue exists to do. */
  alias_count: number;
  /** How many invoice lines across the ledger resolve here. Derived; zero is a real answer. */
  times_seen: number;
  updated_at: string;
};

export type ItemsResponse = { items: Item[]; total: number; limit: number; offset: number };

export type ItemStats = {
  total: number;
  unclassified: number;
  aliases: number;
  open_proposals: number;
};

/**
 * The three views of the catalogue, in the order they are worked.
 *
 * A PARTITION here, unlike the inbox's overlapping chips: a product either has a category or it
 * does not, and "All" is the two together. So these counts do add up, and the server can answer
 * each with one predicate rather than the page counting rows it has not fetched.
 */
export type ItemFilter = "unclassified" | "classified" | "all";

export const ITEM_FILTERS: { id: ItemFilter; label: string }[] = [
  { id: "unclassified", label: "No category" },
  { id: "classified", label: "Filed" },
  { id: "all", label: "All" },
];

/** How many rows each view holds, from the stats call — never counted off a page. */
export function countFor(filter: ItemFilter, stats: ItemStats | null): number | null {
  if (stats === null) return null;
  if (filter === "unclassified") return stats.unclassified;
  if (filter === "classified") return stats.total - stats.unclassified;
  return stats.total;
}
