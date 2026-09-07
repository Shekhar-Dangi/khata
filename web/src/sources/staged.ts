// The shape of the INBOX — what `GET /evidence/staged` returns, and the small pure decisions
// the review screen makes about it. Beside the view that reads it, the way sources.ts,
// rules/rules.ts and reports/reports.ts already are.
//
// Kept apart from sources.ts on purpose. That file is the Splitwise vocabulary: records that
// expected cash, in the state they are in NOW, all of them already on the ledger. This one is
// the vocabulary of things that are NOT on the ledger yet (the design — "artifacts
// is the inbox; evidence is the ledger"). Two piles with two verbs; one file that held both
// would invite a screen that confused "waiting for you to confirm" with "waiting for you to
// match", which is the distinction the two-phase import exists to draw.

/** Everything staged, counted once, so the header does not add up a page and call it a total. */
export type StagedSummary = {
  staged: number;
  held: number;
  /** What confirming the whole inbox would attribute. Positive; the direction is not in doubt. */
  total_paise: number;
  needs_attention: number;
  /**
   * Line items whose PRODUCT has no category. The number that makes its warning concrete:
   * while it is non-zero, confirming writes evidence and produces no allocations at all.
   */
  uncategorised_lines: number;
};

export type StagedTransaction = {
  id: string;
  txn_date: string;
  amount_paise: number;
  narration: string | null;
  account_name: string | null;
};

/**
 * What the order will attach to once confirmed.
 *
 *   matched    one bank row, and the screen names it before the button is pressed
 *   ambiguous  more than one row could be it — confirming picks none of them
 *   none       no bank row yet, which is not a failure (the statement may not be imported)
 */
export type StagedMatch = {
  kind: "matched" | "ambiguous" | "none";
  transaction: StagedTransaction | null;
};

/** A catalogue item the resolver thought of, with how alike the two strings are (0-100). */
export type ItemCandidate = { item_id: string; name: string; similarity: number };

/**
 * What confirming would do about this line's product.
 *
 *   existing   an alias already points at a catalogue item — nothing new is created
 *   link       this sighting will be attached to an existing item, adding an alias
 *   create     a new item, because nothing was close enough to be safe
 *
 * `needs_input` is orthogonal to all three: it means the resolver got far enough to have an
 * opinion and not far enough to act on it alone. See the design — a duplicate item
 * costs one visible merge, a wrong merge silently routes two products' spending into one
 * category forever, so the resolver is biased toward creating and asks rather than guessing.
 */
export type LineResolution = {
  action: "existing" | "link" | "create";
  item_id: string | null;
  item_name: string | null;
  needs_input: boolean;
  candidates: ItemCandidate[];
};

export type StagedLine = {
  index: number;
  kind: "goods" | "fee";
  description: string;
  sku: string | null;
  hsn: string | null;
  qty: number;
  amount_paise: number;
  resolution: LineResolution;
  /**
   * The PRODUCT's category, not the line's. Ids arrive as strings — pg returns BIGINT as a
   * string and the route hands it straight on — so anything that compares or submits one has
   * to say which it means. `CategorySelect` wants a number.
   */
  category: { id: string; name: string } | null;
};

export type StagedOrder = {
  artifact_id: string;
  external_ref: string;
  source_type: string;
  order_date: string;
  total_paise: number;
  /** One order can be several invoices — the design. Worth showing, never summing. */
  invoice_count: number;
  needs_attention: boolean;
  match: StagedMatch;
  lines: StagedLine[];
};

/**
 * A file that parsed as something this app cannot post yet — 29 of the real corpus are credit
 * notes waiting on. A STATE, not a failure: the bytes are in the store and the day the
 * feature lands they are re-read without anyone re-uploading. Drawn in ink, never in red.
 */
export type HeldFile = {
  artifact_id: string;
  original_name: string | null;
  parse_status: "failed" | "unsupported";
  parse_error: string | null;
};

export type StagedResponse = {
  summary: StagedSummary;
  orders: StagedOrder[];
  held: HeldFile[];
};

/** A person's answer for one line: use this item, or make a new one. The WIRE shape. */
export type Override = { item_id: string } | { create_new: true };

/**
 * The same answer, as the screen holds it.
 *
 * `label` is the chosen product's NAME. It is deliberately not on the wire — the server knows
 * an item's name better than the browser does — and the screen cannot do without it:
 * requires the category picker to be labelled with the PRODUCT, and a person who searched the
 * catalogue has picked a product this line's own resolution never mentioned, so nothing in the
 * response can supply the name. Carried in ONE value rather than in a parallel map, because two
 * maps updated in step are two maps that can be read a render apart.
 */
export type LineAnswer = { answer: Override; label: string };

export type ConfirmResponse = {
  landed: { artifact_id: string; external_ref: string; evidence_id: string }[];
  /** Already on the ledger — the idempotent half, and not an error. */
  skipped: { artifact_id: string; reason: string }[];
  errors: { artifact_id: string; error: string }[];
};

/**
 * The key an override travels under: `"<artifact_id>:<line_index>"`, exactly as spells
 * it. One function so the writer and the reader cannot disagree about the separator.
 */
export function overrideKey(artifactId: string, index: number): string {
  return `${artifactId}:${index}`;
}

/**
 * Which order an override key belongs to.
 *
 * `lastIndexOf`, not `split(":")[0]`: an id is a BIGINT rendered as a string today, but a key
 * format is a contract and the line index is the part guaranteed to be last. Splitting on the
 * first colon would quietly attribute an override to the wrong order the day an id contains one.
 */
export function artifactOfKey(key: string): string {
  return key.slice(0, key.lastIndexOf(":"));
}

/**
 * A date as a row shows it when the year is already obvious from the column beside it: "06 Aug".
 *
 * Parsed as UTC midnight, like `shortDate` in sources.ts and `dayGap` on the server: the
 * local-time constructor shifts the day either side of Greenwich, so the same ISO string would
 * render as two different days on two machines.
 */
export function dayMonth(iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" });
}

/** What a line will do, in the three words the design asks for. */
export type Verdict = "existing" | "new" | "input";

/**
 * The verdict, with the person's answer taking precedence over the resolver's.
 *
 * The ORDER of these tests is the whole content of the function: an override is checked before
 * `needs_input`, because an override IS the input. Testing `needs_input` first would leave a
 * line the person has already answered still showing as a question, and the confirm bar would
 * go on counting it as work.
 */
export function verdictOf(line: StagedLine, answer: LineAnswer | undefined): Verdict {
  if (answer !== undefined) return "item_id" in answer.answer ? "existing" : "new";
  if (line.resolution.needs_input) return "input";
  return line.resolution.action === "create" ? "new" : "existing";
}

/**
 * The catalogue item this line will land on, or null where there is not one yet.
 *
 * Null is the reason the category picker is not offered on every line: a product that will be
 * CREATED on confirm has no id to PATCH, so there is nothing to file it under until it exists.
 */
export function itemIdOf(line: StagedLine, answer: LineAnswer | undefined): string | null {
  if (answer !== undefined) return "item_id" in answer.answer ? answer.answer.item_id : null;
  return line.resolution.item_id;
}

/**
 * The likeliest catalogue item the resolver thought of, for a collapsed line to name without
 * anyone opening the picker.
 *
 * The server returns candidates in similarity order, so this is `[0]` rather than a scan — and
 * it lives here rather than in ItemPicker because a component file that also exports helpers
 * loses fast refresh, and because this is a fact about the data, not about the control.
 */
export function bestCandidate(candidates: ItemCandidate[]): ItemCandidate | null {
  return candidates.length === 0 ? null : candidates[0];
}

/** How many lines of this order are still a question, with the person's answers applied. */
export function openLines(order: StagedOrder, answers: Map<string, LineAnswer>): number {
  return order.lines.filter(
    (l) => verdictOf(l, answers.get(overrideKey(order.artifact_id, l.index))) === "input",
  ).length;
}

/**
 * The views the orders list offers, in the order they are worked.
 *
 * VIEWS, not states: "Needs you" spans an uncertain product and an ambiguous bank match, which
 * are different problems with the same answer ("look at this one"). A row belongs to as many as
 * it satisfies, so the counts do not add up to the total — deliberately.
 */
export type OrderFilter = "needs" | "matched" | "ambiguous" | "unmatched" | "all";

export const ORDER_FILTERS: { id: OrderFilter; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "matched", label: "Attaches to a bank row" },
  { id: "ambiguous", label: "More than one match" },
  { id: "unmatched", label: "No bank row found" },
  { id: "all", label: "All" },
];

/** Whether an order belongs in a view. ONE definition, so a chip's count and its list agree. */
export function inOrderFilter(order: StagedOrder, filter: OrderFilter): boolean {
  if (filter === "all") return true;
  if (filter === "needs") return order.needs_attention;
  if (filter === "matched") return order.match.kind === "matched";
  if (filter === "ambiguous") return order.match.kind === "ambiguous";
  return order.match.kind === "none";
}
