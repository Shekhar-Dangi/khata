// The PURE half of rule mining. No DB, no clock, no fetch — same split as `rules.ts` and
// `transfers.ts`, and for the same reason: this is code that decides what gets written
// onto real money, so it belongs on the side of the line that unit tests can reach.
//
// What it does: cluster the narrations of unexplained transactions into candidate rules,
// then score each candidate by what it would actually do to the ledger.
//
// Why it exists at all: a batch of qwen3:4b over all 177 unexplained rows answered
// `Unknown` on 155 of them, while the token histogram showed the tail is ~15 clusters,
// not a flat spread. A concentrated tail is a rules problem, and a rule is deterministic,
// inspectable and re-runnable where a model call is none of those.

import { matches, normalise } from "./rules.ts";

export type MineableTxn = {
  id: string;
  narration: string | null;
  amount_paise: number | string;
  txn_date: string;
  /** Category names already allocated to this row. Empty means unexplained. */
  categories: string[];
};

export type MineableRule = { name: string; conditions: unknown; match_mode: unknown };

export type Candidate = {
  /** The literal `contains` value a rule would carry. */
  value: string;
  words: number;
  unexplainedHits: number;
  ledgerHits: number;
  /** ledgerHits as a fraction of the spend ledger. Reported, never a rejection reason. */
  breadth: number;
  explainedHits: number;
  /**
   * How many DISTINCT categories the already-explained matches carry. This is the honest
   * over-broadness signal: 0 or 1 means the token means one thing, 2+ means a single rule
   * would be lying about some of the rows it claims.
   */
  spread: number;
  spreadDetail: { category: string; count: number }[];
  /** An existing rule that already matches every row this would claim. */
  collidesWith: string | null;
  /** Transaction ids this rule would newly explain. The dry-run's subject. */
  ids: string[];
};

export type MineOptions = {
  minHits?: number;
  /**
   * Reject candidates matching more than this fraction of the ledger.
   *
   * **Defaults to 1, i.e. off.** It was originally 0.15 and it silently discarded the
   * single best candidate in a real ledger — bare `amazon`, about a fifth of all rows. A merchant
   * being a large share of your spending is what makes a rule VALUABLE. `spread` is the
   * honest over-broadness signal and the dry-run is the real guard, so this is kept only
   * as an escape hatch for a caller that wants one.
   */
  maxBreadth?: number;
  limit?: number;
};

// Generic banking vocabulary. Not merchants — a rule on one of these is a rule on
// "you paid somebody".
const STOPWORDS = new Set([
  "upi", "imps", "neft", "rtgs", "debit", "credit", "payment", "paymen", "paid", "pay",
  "paying", "from", "for", "you", "are", "the", "and", "ref", "txn", "trf", "transfer",
  "pos", "xxxxx", "xxxx", "inr", "acct", "account", "bank", "banking", "net", "mob",
  // Corporate boilerplate: part of a registered name, never the thing bought.
  "ltd", "limited", "pvt", "private", "india", "indian", "services", "service", "serv",
  "solutions", "technologies", "enterprises", "retail", "com",
  // NARRATION boilerplate, and the nastiest kind because it reads as meaningful.
  // "UPI REQUEST FROM <merchant> BRANCH ATM SERVICE" is a template some banks stamp onto
  // ordinary UPI merchant payments — verified on dozens of rows in a real ledger, Amazon Pay
  // and otherwise. A `contains: atm` rule fires on all of them and labels Amazon Pay
  // groceries as cash withdrawals. These words describe the FORM of the message.
  // Cost: a genuine cash-withdrawal rule must be written by hand. Right trade on this data.
  "atm", "branch", "request",
  // Bank / PSP handles.
  "ybl", "utib", "yesb", "sbin", "ibl", "kkbk", "hdfc", "hdfcbank", "axl", "axis",
  "axisbank", "okpayaxis", "oksbi", "okaxis", "okhdfcbank", "okicici", "ptybl", "ptmupi",
  "yblupi", "cnrb", "punb", "barb", "ioba", "idib", "ubin", "icic", "icicibank", "sbi",
]);

/**
 * Strings that identify the PAYMENT RAIL rather than the payee.
 *
 * A word list cannot keep up with these; the SHAPE can. `@ybl` says "their UPI handle was
 * issued by Yes Bank" — it describes the plumbing the money moved through, so it can never
 * carry a category honestly. `amazon@yapl` is deliberately kept: its local part is a real
 * merchant.
 */
export function isRailNoise(word: string): boolean {
  if (word.startsWith("@")) return true;
  const at = word.indexOf("@");
  if (at !== -1) {
    const local = word.slice(0, at);
    if (local.length <= 2 || /^\d+$/.test(local)) return true;
  }
  // IFSC-shaped: four letters then a zero (YESB0YBLUPI, SBIN0001234).
  if (/^[a-z]{4}0/.test(word)) return true;
  return false;
}

export const isNoise = (word: string): boolean =>
  STOPWORDS.has(word) || isRailNoise(word);

/**
 * Unigrams and bigrams over the NORMALISED narration, so every candidate is by
 * construction something `matches` can actually see. Normalising here and nowhere else is
 * what keeps the miner and the matcher from disagreeing about what a token is.
 */
export function candidateTokens(narration: string | null): string[] {
  const words = normalise(narration)
    .split(" ")
    .filter((w) => w.length > 2 && !/^\d+$/.test(w));
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const uni = words[i]!;
    if (!isNoise(uni)) out.add(uni);
    if (i + 1 < words.length) {
      const next = words[i + 1]!;
      // A pair of rail tokens is noise however you combine them.
      if (isRailNoise(uni) && isRailNoise(next)) continue;
      if (!isNoise(uni) || !isNoise(next)) out.add(uni + " " + next);
    }
  }
  return [...out];
}

/**
 * The merchant-ish part of a narration: the content words, with the payment rail and the
 * banking boilerplate stripped out.
 *
 * This is what gets sent to a model instead of the raw narration, and it earned its place
 * twice on real data. Given the whole string the 4B model latched onto the RAIL — it
 * answered "paytm" for a restaurant, and picked a category NAMED "debit" for a row
 * whose narration contained the word "debit". Given only the content words it does
 * neither, and the prompt is short enough that a classification costs ~1.6s instead of ~4s.
 *
 * Unigrams only: a bigram is for matching a rule, but a model reads a phrase, and the
 * duplicated words that bigrams introduce ("amazon amazon india") only add noise.
 */
export function merchantHint(narration: string | null): string {
  return candidateTokens(narration)
    .filter((token) => !token.includes(" "))
    .join(" ");
}

const asRule = (value: string) => ({
  conditions: [{ field: "narration", op: "contains", value }],
  match_mode: "all",
});

/**
 * Mine candidate rules.
 *
 * `unexplained` must be a subset of `ledger` — the first is what we want to explain, the
 * second is what a proposed rule would collide with.
 */
export function mineCandidates(
  unexplained: MineableTxn[],
  ledger: MineableTxn[],
  existingRules: MineableRule[],
  options: MineOptions = {},
): Candidate[] {
  const minHits = options.minHits ?? 3;
  const maxBreadth = options.maxBreadth ?? 1;
  const limit = options.limit ?? 40;

  const freq = new Map<string, Set<string>>();
  for (const t of unexplained) {
    for (const token of candidateTokens(t.narration)) {
      let bucket = freq.get(token);
      if (!bucket) freq.set(token, (bucket = new Set()));
      bucket.add(t.id);
    }
  }

  const candidates: Candidate[] = [];
  for (const [value, ids] of freq) {
    if (ids.size < minHits) continue;

    // A value that normalises to "" hits the empty-needle guard in `matches` and silently
    // never fires — fails closed, saves fine, reports "never fired". Never propose one.
    if (normalise(value) === "") continue;

    const rule = asRule(value);

    // Verify against the REAL matcher rather than the tokenizer's belief about itself.
    // If these two disagree, the tokenizer is wrong and the proposal would be a lie.
    const realHits = unexplained.filter((t) => matches(t, rule));
    if (realHits.length < minHits) continue;

    const ledgerHits = ledger.filter((t) => matches(t, rule));
    const breadth = ledger.length === 0 ? 0 : ledgerHits.length / ledger.length;
    if (breadth > maxBreadth) continue;

    const explained = ledgerHits.filter((t) => t.categories.length > 0);
    const counts = new Map<string, number>();
    for (const t of explained) {
      for (const c of t.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const spreadDetail = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => ({ category, count }));

    const collision = existingRules.find(
      (r) => realHits.length > 0 && realHits.every((t) => matches(t, r)),
    );

    candidates.push({
      value,
      words: value.split(" ").length,
      unexplainedHits: realHits.length,
      ledgerHits: ledgerHits.length,
      breadth: Number(breadth.toFixed(3)),
      explainedHits: explained.length,
      spread: spreadDetail.length,
      spreadDetail: spreadDetail.slice(0, 4),
      collidesWith: collision ? collision.name : null,
      ids: realHits.map((t) => t.id),
    });
  }

  // Prefer the SHORTER candidate when a bigram claims exactly the rows its unigram already
  // claims — the extra word buys nothing. When the bigram is genuinely narrower both
  // survive, and the reviewer chooses how tight a net to cast.
  const bySignature = new Map<string, Candidate>();
  for (const c of candidates.sort((a, b) => a.words - b.words)) {
    const signature = [...c.ids].sort().join(",");
    if (!bySignature.has(signature)) bySignature.set(signature, c);
  }

  // Safe candidates first: spread ascending, then reach. A sort by hits alone puts a
  // payment rail like `paytm` (spread 3) above a clean merchant cluster.
  return [...bySignature.values()]
    .sort(
      (a, b) =>
        a.spread - b.spread ||
        b.unexplainedHits - a.unexplainedHits ||
        a.value.localeCompare(b.value),
    )
    .slice(0, limit);
}
