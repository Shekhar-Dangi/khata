// Which merchant's invoice is this? Decided from the extracted TEXT, never the filename.
//
// Detection is by content sniffing: filenames are user-controlled and meaningless, and a
// file renamed on the way out of a phone would silently pick the wrong parser. This is that
// rule for PDFs, one level above `sniffMime` in src/artifacts.ts, which
// answers the cruder question of whether the bytes are a PDF at all.
//
// Kept apart from `detectSource` in evidence-import.ts on purpose. That one answers "which
// TEXT-FILE source is this" by reading a CSV header; this one answers "which INVOICE TEMPLATE
// is this" by looking for a legal entity's name in extracted prose. Same idea, different
// evidence, and merging them would give one function two unrelated failure modes.

/** Templates we can recognise. A parser existing is a separate question: PARSERS_AVAILABLE. */
export type ReceiptTemplate = "blinkit" | "amazon";

type TemplateSignature = {
  template: ReceiptTemplate;
  /**
   * Any ONE of these is enough. They are the seller's registered legal name as printed on the
   * invoice — the most stable thing on the page, because it is there for tax reasons rather
   * than for branding, and it survives a redesign.
   */
  markers: string[];
};

const SIGNATURES: TemplateSignature[] = [
  {
    template: "blinkit",
    // Blinkit splits every order between two legal sellers, so BOTH
    // names appear across a single order's invoices and either one identifies the template.
    // "Grofers" is the company's former name and is still printed in its own footer — worth
    // matching, because a template that names itself twice will eventually name itself once.
    markers: [
      "blink commerce private limited",
      "zomato hyperpure private limited",
      "grofers india private limited",
      "blinkit",
    ],
  },
  {
    template: "amazon",
    markers: [
      "amazon retail india private limited",
      "amazon seller services",
      "amazon.in",
    ],
  },
];

/**
 * Which template, or null.
 *
 * **Ambiguity answers null rather than picking a winner.** Two templates matching means the
 * markers are wrong, or a document quotes another merchant, and quietly taking the first match
 * would send a basket to a parser that will misread it. Returning null costs one manual look
 * and is the same rule the matcher follows on money: never silently guess.
 *
 * @param text the LINEARISED page text from the extractor. Good enough for this and only this:
 *             detection needs a name to appear somewhere, not to appear in the right column.
 */
export function detectReceiptTemplate(text: string): ReceiptTemplate | null {
  const haystack = text.toLowerCase();
  const hits = SIGNATURES.filter((sig) => sig.markers.some((m) => haystack.includes(m)));
  if (hits.length !== 1) return null;
  return hits[0].template;
}

/**
 * Do we have a parser that can turn this template into an OrderRecord yet?
 *
 * Separate from detection because they are separate facts, and the gap between them is exactly
 * what the artifact store exists to hold: a file we RECOGNISE but cannot yet READ is stored
 * with its template recorded, and re-parsed for free once a parser lands. Collapsing the two
 * would make a recognised-but-unparseable invoice indistinguishable from an unknown one.
 *
 * Every entry started false, and each flips to true only when its parser lands.
 */
export const PARSERS_AVAILABLE: Record<ReceiptTemplate, boolean> = {
  blinkit: false,
  // Landed 2026-09-06: ingest/receipts/amazon.py, verified on a real corpus of a few hundred
  // invoices, with every file it did not land quarantined for a stated reason (credit notes,
  // a delivery challan, and an invoice Amazon printed with a blank order number).
  amazon: true,
};
