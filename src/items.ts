// The PURE half of the product catalogue: turning a merchant's line into a comparable name,
// and deciding what to do with the candidates that come back. No DB, no clock.
//
// Same split as rules.ts / transfers.ts / evidence-match.ts, and for the same reason: this is
// code that decides whether two things a person bought are the SAME thing, and getting that
// wrong misroutes every future purchase of both, silently.
//
// THE ASYMMETRY THAT DRIVES EVERYTHING HERE:
//
//   a DUPLICATE item costs a split frequency count and one manual merge — visible, recoverable
//   a WRONG MERGE  routes every future purchase of both into one category — silent, forever
//
// Un-merging is harder than merging. So the resolver is biased toward CREATING, and a merge is
// never automatic.

/** Merchant identifiers we understand. Both are exact and stable; names are neither. */
export type SkuKind = "asin" | "upc";

export type RawLine = {
  sourceType: string;
  /** The merchant's own product id, when the template exposes one. */
  sku?: { kind: SkuKind; value: string } | null;
  /** The description exactly as printed. Never cleaned before it gets here. */
  description: string;
};

/**
 * Strip the merchant noise a description carries, leaving the product.
 *
 * Measured against a real invoice corpus. Amazon prints
 *
 *     Example Dairy Pouch Curd, 400 G | B0XXXXXXX1 ( B0XXXXXXX1 )\nHSN:04039090
 *
 * and Blinkit prints
 *
 *     Coca-Cola Zero Sugar Soft Drink(PET Bottle) (HSN-22029990)
 *
 * so the ASIN, the HSN and the pack form are template furniture rather than product identity,
 * and every one of them is removable by rule rather than by guess.
 */
export function stripMerchantNoise(description: string): string {
  return description
    .replace(/\r/g, "")
    // Amazon puts HSN on its own line; Blinkit puts it in trailing parentheses.
    .replace(/\bHSN\s*[:\-]\s*\d{4,8}\b/gi, " ")
    .replace(/\(\s*HSN[-:\s]*\d{4,8}\s*\)/gi, " ")
    // "| B0XXXXXXX1 ( B0XXXXXXX1 )" and its truncated forms — the 22% of ASINs that appeared
    // under several names differed mostly HERE, where the column was cut at different widths.
    .replace(/\|\s*B0[A-Z0-9]{8}\s*\(?[^)]*\)?\s*$/i, " ")
    .replace(/\bB0[A-Z0-9]{8}\b/g, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Quantity, pack size and pack form — the things that make a VARIANT, not a product.
 *
 * Removed from the identity key by an OWNER DECISION (2026-09-06), which settles an open
 * design question: *is "Amul Toned Milk
 * 500ml" the same item as "Amul Toned Milk 1L"?* The answer here is yes — 150 g and 50 g of
 * the same coffee are one product bought in two sizes.
 *
 * This is what makes the grouping DETERMINISTIC rather than fuzzy. Before this, two sizes of
 * one coffee differed by four characters inside a hundred of shared marketing copy, and only
 * a 93%-similarity guess connected them. With size stripped they produce the SAME canonical
 * name, so they meet as an exact alias hit — no threshold, no model, no review.
 *
 * Nothing is lost, because the variant survives on its own alias row: the SKU is still
 * recorded, still distinct, and still carries its own label (migration 013). Grouping here is
 * a VIEW over variants, not a destruction of them — which is what makes it safe to do
 * automatically, and reversible if the decision ever changes.
 */
const VARIANT_TOKENS = [
  // 150g · 50 gm · 1kg · 300ml · 1 ltr · 500 mg
  /\b\d+(\.\d+)?\s*(g|gm|gms|gram|grams|kg|kgs|mg|ml|l|ltr|ltrs|litre|litres|liter|liters)\b/g,
  // pack of 4 · set of 2 · combo of 3
  /\b(pack|set|combo|pair)\s+of\s+\d+\b/g,
  // 4 x 100g style multipacks, and bare counts
  /\b\d+\s*[x×]\s*\d+(\.\d+)?\s*(g|gm|ml|kg|l)\b/g,
  /\b\d+\s*(pcs|pc|pieces|count|units?|tablets?|capsules?|sachets?)\b/g,
  // the container itself: Blinkit prints "(PET Bottle)", "(Pouch)", "(Can)"
  /\b(pet bottle|tetra pak|tetrapak|bottle|pouch|can|jar|tin|box|carton|sachet|packet|refill)\b/g,
];

/**
 * The comparison key for a product name.
 *
 * Lowercased, merchant furniture removed, variant tokens removed, punctuation reduced to
 * spaces. Two lines that canonicalise alike are the same PRODUCT; which size or flavour was
 * bought is recorded on the alias, not here.
 */
export function canonicalName(description: string): string {
  let s = stripMerchantNoise(description)
    .toLowerCase()
    // Zero-width characters: the same trap that hides inside bank narrations (src/merchants.ts)
    // and would silently split one product into two here.
    .replace(/[​-‍﻿]/g, "");
  for (const re of VARIANT_TOKENS) s = s.replace(re, " ");
  return s
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Structured facts about WHICH variant was bought. Open-ended on purpose — see migration 014. */
export type VariantAttributes = Record<string, string>;

/**
 * Pull the variant out of a description instead of discarding it.
 *
 * `canonicalName` already MATCHES quantity and pack form in order to strip them; this keeps
 * what it matched. Same regexes, same determinism, no extra inference — the information was
 * being thrown away, and throwing it away is what forced a person to read a 200-character
 * marketing string to find out whether they bought the 750 ml or the 300 ml.
 *
 * Deliberately shallow. It reports what it can prove from a closed set of units and container
 * words, and reports nothing at all rather than guessing at flavour or colour — those are
 * open sets, and `variantDiff` below derives them from siblings instead.
 */
export function extractVariantAttributes(description: string): VariantAttributes {
  const text = stripMerchantNoise(description).toLowerCase();
  const attrs: VariantAttributes = {};

  // The LAST measurement, not the first.
  //
  // Marketing copy puts ingredient quantities before the pack size: "Acme Hydration+ ... | 3g
  // Glucose Monohydrate + Sodium ... | 50g | Cola" means a 50 g tub containing 3 g doses, and
  // taking the first match labelled every flavour "3 g". The pack size is what the merchant
  // is selling, so it lands at the end, next to the flavour.
  //
  // A HEURISTIC, and a shallow one — it is right on this corpus and will be wrong on a
  // template that trails an ingredient. It is safe to be wrong here in a way it is not safe to
  // be wrong about identity: an attribute is a label shown beside a variant, and a person can
  // see at a glance that it is off. Nothing routes money on it.
  const sizes = [
    ...text.matchAll(
      /\b(\d+(?:\.\d+)?)\s*(kg|kgs|g|gm|gms|gram|grams|mg|ml|l|ltr|ltrs|litre|litres|liter|liters)\b/g,
    ),
  ];
  const size = sizes.at(-1);
  if (size) attrs.size = `${size[1]} ${size[2]}`;

  const pack = text.match(
    /\b(pet bottle|tetra ?pak|bottle|pouch|can|jar|tin|box|carton|sachet|packet|refill)\b/,
  );
  if (pack) attrs.pack = pack[1].replace(/\s+/g, " ");

  const multi = text.match(/\b(?:pack|set|combo|pair)\s+of\s+(\d+)\b/);
  if (multi) attrs.pack_of = multi[1];

  return attrs;
}

/**
 * The most tokens that may differ, in EITHER direction, for two names to be one product.
 *
 * One is enough for the real cases — flavour, colour, a size word. Two would start swallowing
 * genuinely different products that share a brand and a category.
 */
export const MAX_DIFFERING_TOKENS = 1;

/**
 * How much the two names must have IN COMMON before a difference is read as a variant.
 *
 * This is the guard that stops the obvious disaster. "amul butter" and "amul cheese" differ by
 * one token too — but they share only one, so a single differing token is HALF the name. In
 * "acme hydration electrolytes ... zero sugar 100 veg cola" versus "... lemon" it is one token in
 * twenty. A difference is a variant when it is a detail, and a detail is something small
 * relative to what surrounds it.
 */
export const MIN_SHARED_TOKENS = 5;

const BARE_NUMBER = /^\d+$/;

export type VariantVerdict =
  | { sameProduct: true; differing: string[] }
  | { sameProduct: false; reason: string; differing: string[] };

/**
 * Are these two canonical names the same product in different variants?
 *
 * Compared as token SETS rather than as strings, which is what makes the real Coca-Cola case
 * work: Amazon prints one as "...Soft Drink PET Bottle, 750ml" and the other as "...Soft Drink
 * Can, 300 Ml - Cola". After size and pack are stripped, the second still carries a trailing
 * "cola" — but "cola" already appears in "coca cola", so as SETS the two are identical and the
 * pair needs no decision from anyone.
 *
 * Where they genuinely differ by one word — cola / lemon / orange / unflavoured — that word IS
 * the variant axis. It is derived from the siblings rather than guessed at, so no model and no
 * vocabulary of flavours is involved.
 *
 * TWO GUARDS, both there for a specific failure:
 *
 *   bare numbers      "iphone 15" and "iphone 16" differ by one token and are NOT one product.
 *                     A number with no unit is a model, not a measurement — anything that was
 *                     a measurement has already been stripped by canonicalName.
 *   shared-token floor see MIN_SHARED_TOKENS.
 */
export function variantDiff(canonA: string, canonB: string): VariantVerdict {
  const a = new Set(canonA.split(" ").filter(Boolean));
  const b = new Set(canonB.split(" ").filter(Boolean));
  const onlyA = [...a].filter((t) => !b.has(t));
  const onlyB = [...b].filter((t) => !a.has(t));
  const differing = [...onlyA, ...onlyB];
  const shared = [...a].filter((t) => b.has(t)).length;

  if (onlyA.length === 0 && onlyB.length === 0) {
    return { sameProduct: true, differing: [] };
  }
  if (onlyA.length > MAX_DIFFERING_TOKENS || onlyB.length > MAX_DIFFERING_TOKENS) {
    return { sameProduct: false, reason: "too many differing words", differing };
  }
  if (shared < MIN_SHARED_TOKENS) {
    return { sameProduct: false, reason: "the names have too little in common", differing };
  }
  if (differing.some((t) => BARE_NUMBER.test(t))) {
    return { sameProduct: false, reason: "differs by a bare number, which reads as a model", differing };
  }
  return { sameProduct: true, differing };
}

/**
 * Similarity above which a single candidate is linked automatically (as PROVISIONAL, and
 * queued for review), and below which nothing is even proposed.
 *
 * **These are placeholders and are documented as such.** `DEFAULT_WINDOW_DAYS` in
 * evidence-match.ts carries a measurement table because it was measured; these carry no such
 * table because they have not been. Calibrate them on the real catalogue once it is populated,
 * against the pairs the corpus already provides: the two Pepsi Zeros should merge, the two
 * Coke Zeros must not.
 */
export const AUTO_LINK_SIMILARITY = 88;
export const PROPOSE_SIMILARITY = 55;

export type Candidate = {
  itemId: string;
  canonicalName: string;
  similarity: number;
  /**
   * This candidate already carries a DIFFERENT SKU from the same merchant.
   *
   * Positive evidence that it is a different product, and it outranks any similarity score:
   * the merchant has issued two ids, which is the merchant saying these are two things.
   *
   * FOUND BY MEASUREMENT, not by reasoning. Feeding a real corpus of a few hundred lines through an
   * earlier version of this function produced three wrong merges, all the same shape — long
   * marketing descriptions where trigram similarity is dominated by shared boilerplate:
   *
   *   93%  "...coffee powder 150g pouch 70% coffee 30% chicory..."   B0XXXXXXXA
   *        "...coffee powder  50gm pouch 70% coffee 30% chicory..."  B0XXXXXXXB
   *
   * A 4-character difference in a 100-character string barely moves the score, so raising the
   * threshold does not fix this — it only moves the line. Refusing to overrule a merchant's
   * own identifier does.
   */
  hasConflictingSku?: boolean;
};

export type Resolution =
  /** An alias already points at this item. No fuzz was involved. */
  | { action: "existing"; itemId: string; confidence: 100; via: "sku" | "name" }
  /** One strong candidate. Linked, but marked provisional and queued for a human. */
  | { action: "link"; itemId: string; confidence: number; needsReview: true }
  /** Create, and ask about the near-misses. NEVER an automatic merge. */
  | { action: "create"; confidence: number; propose: Candidate[] };

/**
 * What to do with a raw line, given whatever the store found.
 *
 * Pure so the policy is testable without a database, and so the thresholds above are the only
 * thing anyone has to argue about.
 *
 * @param aliasHit an item an existing alias already points at, or null
 * @param candidates trigram matches, best first
 */
export function resolveLine(
  aliasHit: { itemId: string; via: "sku" | "name" } | null,
  candidates: Candidate[],
  /** This line's canonical name, needed to compare token sets against a candidate's. */
  canon?: string,
): Resolution {
  // Tier 1 and 2: an alias exists. Exact, deterministic, no model and no fuzz. On the real
  // corpus this is where every repeat Amazon product lands, for free.
  if (aliasHit !== null) {
    return { action: "existing", itemId: aliasHit.itemId, confidence: 100, via: aliasHit.via };
  }

  const ranked = [...candidates].sort((a, b) => b.similarity - a.similarity);

  // A candidate the merchant gave a DIFFERENT id is a VARIANT, not necessarily a different
  // product — and the difference between the two names says which. `variantDiff` decides it
  // from token sets, which is explainable and deterministic where a similarity score is
  // neither: 93% told us nothing useful about whether two coffees were the same thing.
  //
  // The safety here does not come from refusing to group. It comes from grouping being
  // VISIBLE and REVERSIBLE — each variant keeps its own alias row, its own label and its own
  // attributes, so a wrong grouping shows up on the item as an obvious odd-one-out and undoing
  // it re-points a row. Nothing is destroyed, so a question a person can answer at a glance
  // afterwards is not worth stopping them for beforehand.
  // Fails CLOSED when `canon` is absent. A caller that cannot supply the name cannot have the
  // difference explained to it, and "we could not check" must never take the permissive branch
  // on a decision that routes future money. The store always passes it.
  const explainable = (c: Candidate): boolean =>
    canon !== undefined && variantDiff(canon, c.canonicalName).sameProduct;

  const strong = ranked.filter(
    (c) =>
      c.similarity >= AUTO_LINK_SIMILARITY &&
      (c.hasConflictingSku !== true || explainable(c)),
  );

  // EXACTLY ONE strong candidate, or none. Two strong candidates is not "pick the better
  // one" — it is the catalogue telling us it already contains a duplicate, and adding a third
  // guess on top is how that becomes permanent. Both get proposed instead.
  if (strong.length === 1) {
    return { action: "link", itemId: strong[0].itemId, confidence: strong[0].similarity, needsReview: true };
  }

  const propose = ranked.filter((c) => c.similarity >= PROPOSE_SIMILARITY);
  return {
    action: "create",
    // How confident we are that CREATING is right: with no near-miss at all, completely; with
    // a close one, much less. This is what a review screen sorts by.
    confidence: propose.length === 0 ? 100 : Math.max(0, 100 - propose[0].similarity),
    propose,
  };
}
