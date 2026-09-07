// The shape of `GET /evidence/staged/items` — every PRODUCT the staged set will touch, once.
//
// Beside `staged.ts` rather than inside it, and the split is the same one that put staged.ts
// beside sources.ts: that file is the vocabulary of ORDERS waiting to be confirmed, this one is
// the vocabulary of the products inside them. The two are read on different tabs, at different
// rates, and a file holding both would invite a screen that confuses "this order needs a bank
// row" with "this product needs a category".
//
// WHY A PRODUCT LIST EXISTS AT ALL. 365 goods lines in the real corpus resolve to 234 products.
// A category is a property of the product, so filing per line means answering the same question
// up to a dozen times — and getting a different answer on the twelfth. The server groups before
// it resolves, for that reason and one more: resolving per line would let one product get two
// different answers inside a single response, since each resolution sees the catalogue as the
// previous one left it.

/** A catalogue item the resolver thought of, with how alike the two strings are (0-100). */
export type ItemCandidate = { item_id: string; name: string; similarity: number };

/**
 * One product, as the staged set sees it.
 *
 * `action` is what confirming would do — `existing` (an alias already points at an item),
 * `link` (this sighting attaches to one, adding an alias), `create` (a new item, because
 * nothing was close enough to be safe). `needs_input` is orthogonal: the resolver got far
 * enough to have an opinion and not far enough to act on it alone.
 */
export type StagedItem = {
  /** Stable across a reload: the merchant's own id, or the canonical name. */
  key: string;
  source_type: string;
  sku: string | null;
  /** The fullest description seen for this product across the staged set. */
  description: string;
  line_count: number;
  total_paise: number;
  order_refs: string[];
  action: "existing" | "link" | "create";
  /** Null where the product does not exist yet — there is nothing to PATCH until it does. */
  item_id: string | null;
  item_name: string | null;
  /** Ids arrive as strings: pg renders BIGINT as one and the route hands it straight on. */
  category: { id: string; name: string } | null;
  needs_input: boolean;
  candidates: ItemCandidate[];
};

export type StagedItemsResponse = {
  items: StagedItem[];
  /** Every product the staged set touches, before any filter. What the tab counts. */
  total: number;
  /** What the search and filter leave — what the pager counts, and what "select all" means. */
  matching: number;
  needs_input: number;
  limit: number;
  offset: number;
};

/**
 * The views this screen offers, in the order they are worked.
 *
 * They are VIEWS, not states: "Needs you" spans two of the resolver's three actions, and
 * "Will be created" spans a product nobody has answered and one somebody has. A row belongs to
 * as many as it satisfies, which is why these are filters rather than a partition — and why the
 * counts do not add up to the total, deliberately.
 */
export type ItemFilter = "needs" | "existing" | "create" | "nocat" | "all";

export const ITEM_FILTERS: { id: ItemFilter; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "existing", label: "Already in your catalogue" },
  { id: "create", label: "Will be created" },
  { id: "nocat", label: "No category yet" },
  { id: "all", label: "All" },
];

/** Whether a product belongs in a view. One definition, so a chip's count and its list agree. */
export function inFilter(item: StagedItem, filter: ItemFilter): boolean {
  if (filter === "all") return true;
  if (filter === "needs") return item.needs_input || item.category === null;
  if (filter === "existing") return item.action === "existing";
  if (filter === "create") return item.action === "create";
  return item.category === null;
}

/** What a row will do, in one word. The same three the line rows use, so they cannot diverge. */
export function itemVerdict(item: StagedItem): "existing" | "new" | "input" {
  if (item.needs_input) return "input";
  return item.action === "create" ? "new" : "existing";
}
