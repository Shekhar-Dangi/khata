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
 * Measured against the 252-invoice corpus. Amazon prints
 *
 *     Milky Mist Pouch Curd, 400 G | B0BG6CT9ZV ( B0BG6CT9ZV )\nHSN:04039090
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
    // "| B0BG6CT9ZV ( B0BG6CT9ZV )" and its truncated forms — the 22% of ASINs that appeared
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
 * Removed from the identity key by an OWNER DECISION (2026-09-06), which settles the open
 * question the design raised and left unanswered: *is "Amul Toned Milk
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
   * FOUND BY MEASUREMENT, not by reasoning. Feeding the real 507-line corpus through an
   * earlier version of this function produced three wrong merges, all the same shape — long
   * marketing descriptions where trigram similarity is dominated by shared boilerplate:
   *
   *   93%  "...coffee powder 150g pouch 70% coffee 30% chicory..."   B07MJGXCLW
   *        "...coffee powder  50gm pouch 70% coffee 30% chicory..."  B0D7ZT6149
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
): Resolution {
  // Tier 1 and 2: an alias exists. Exact, deterministic, no model and no fuzz. On the real
  // corpus this is where 221 of 221 repeat Amazon products land, for free.
  if (aliasHit !== null) {
    return { action: "existing", itemId: aliasHit.itemId, confidence: 100, via: aliasHit.via };
  }

  const ranked = [...candidates].sort((a, b) => b.similarity - a.similarity);
  // A candidate the merchant has already given a DIFFERENT id to is not eligible for an
  // automatic link, however similar the text. Size and pack no longer reach here — they
  // canonicalise away and meet as an exact alias hit — so a conflicting SKU that still looks
  // alike is most likely two genuinely different products sharing marketing boilerplate. It
  // becomes a proposal instead, which costs one click and cannot corrupt a category.
  const strong = ranked.filter(
    (c) => c.similarity >= AUTO_LINK_SIMILARITY && c.hasConflictingSku !== true,
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
