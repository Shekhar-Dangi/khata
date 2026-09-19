// The DB half of evidence matching — the counterpart to src/evidence-match.ts, the same way
// src/detect.ts is the DB half of src/transfers.ts.
//
// Finds the bank transactions behind each unmatched record and, where it finds them, writes
// the allocations that split them. Design in the design.
//
// A record can be paid by SEVERAL transactions (migration 010), so every link goes through
// `evidence_transactions` rather than a column on `evidence`.

import type { PoolClient } from "pg";

import {
  type Authority,
  type Candidate,
  type ExistingAllocation,
  type NearMiss,
  claimOn,
  expectedCash,
  matchToTransaction,
  nearMisses,
  resolvePrecedence,
  splitProportionally,
} from "./evidence-match.ts";
import { dayGap } from "./transfers.ts";
import { applyRules } from "./rules-apply.ts";

const SOURCE = "splitwise";

/** One record linked to one transaction, for the preview to show what it actually did. */
export type MatchedPair = {
  evidenceId: string;
  externalRef: string;
  description: string | null;
  evidenceDate: string;
  amountPaise: number;
  transactionId: string;
  txnDate: string;
  txnAmountPaise: number;
  narration: string | null;
  dayGap: number;
};

export type MatchSummary = {
  considered: number;
  matched: number;
  ambiguous: number;
  noCandidate: number;
  /** Rows that should leave no trace in our account at all — nothing to look for. */
  noCashExpected: number;
  allocationsWritten: number;
  /** Matched, but the source category has no mapping, so only the shared slice was written. */
  partiallyAllocated: number;
  /** A bank row was found, but something we may not overrule already explains it. */
  conflicted: number;
  /** Rule guesses (including bulk-confirmed ones) this evidence outranked and removed. */
  displaced: number;
  /**
   * Rule allocations the engine wrote back over the remainder the displacement left.
   *
   * The other half of `displaced`, and the reason displacing is no longer a net loss:
   * the design. Reported so a preview can show the WHOLE trade rather
   * than only its cost — "removed 32, refilled 30" is a different sentence from "removed 32".
   */
  backfilled: number;
  /** Held back only by the date rule — waiting for a human (see listNearMisses). */
  nearMissed: number;
  conflicts: { externalRef: string; transactionId: string; reason: string }[];
  /** Every pair this run created, so a preview can show WHAT matched, not just how many. */
  pairs: MatchedPair[];
};

type EvidenceRow = {
  id: string;
  external_ref: string;
  description: string | null;
  evidence_date: string;
  amount_paise: string;
  payload: {
    kind: "expense" | "payment";
    nets_paise: Record<string, number>;
    source_category: string;
    /** The import this record belongs to — see `listImports` for why it is the batch key. */
    group: string;
  };
};

const EVIDENCE_COLUMNS = `id, external_ref, description, evidence_date::text, amount_paise, payload`;

/** Records with no transaction linked yet. */
const UNLINKED = `NOT EXISTS (
  SELECT 1 FROM evidence_transactions et WHERE et.evidence_id = evidence.id
)`;

/** Everything the writer needs that is the same for every record in a run. */
type WriteContext = { sharedId: string; map: Map<string, string | null>; me: string };

async function loadContext(client: PoolClient, me: string): Promise<WriteContext> {
  const shared = await client.query<{ id: string }>(
    `SELECT c.id FROM categories c
       JOIN categories p ON p.id = c.parent_id
      WHERE c.name = 'Shared' AND p.name = 'Transfers' AND p.parent_id IS NULL`,
  );
  if (shared.rowCount === 0) {
    throw new Error("category Transfers > Shared is missing (migration 005)");
  }
  const map = new Map<string, string | null>(
    (
      await client.query<{ source_category: string; category_id: string | null }>(
        "SELECT source_category, category_id FROM source_category_map WHERE source_type = $1",
        [SOURCE],
      )
    ).rows.map((r) => [r.source_category, r.category_id]),
  );
  return { sharedId: shared.rows[0].id, map, me };
}

/** The whole ledger, once — see the note in matchSplitwiseEvidence. */
async function loadCandidates(client: PoolClient): Promise<Candidate[]> {
  const rows = await client.query<Candidate>(
    `SELECT t.id, t.txn_date::text, t.amount_paise, t.narration, acc.name AS account_name
       FROM transactions t JOIN accounts acc ON acc.id = t.account_id`,
  );
  return rows.rows.map((c) => ({ ...c, amount_paise: Number(c.amount_paise) }));
}

type ApplyResult = {
  conflict?: string;
  displaced: number;
  /** Rule rows the engine refilled the remainder with afterwards. See the design. */
  backfilled: number;
  /** Of those, how many a PERSON had authored. Only ever non-zero on a manual link. */
  displacedAuthored: number;
  allocationsWritten: number;
  partial: boolean;
  /** The selected transactions totalled LESS than the record, so the split was capped. */
  scaledDown?: boolean;
};

/**
 * Link one record to one or more transactions and write the allocations that split them.
 *
 * ONE writer, used by the automatic matcher, by accepting a near miss, and by a manual
 * multi-transaction link. The DATE rule is the only thing that differs between those paths and
 * it is already decided by the time we get here — so precedence, displacement and the split
 * itself cannot drift apart. A second copy of "what accepting a match means" is exactly the
 * duplicate definition src/spend.ts warns about.
 */
async function applyMatch(
  client: PoolClient,
  ev: EvidenceRow,
  transactionIds: string[],
  ctx: WriteContext,
  /**
   * Who is asking. The ONLY thing that differs between the automatic sweep and a person
   * ticking one transaction, and it changes exactly one decision — see `Authority`.
   */
  authority: Authority,
  /**
   * A category for the owner's share, chosen by the person doing this.
   *
   * Used INSTEAD OF the source-category map, and only ever supplied by a human. It exists
   * because two of the map's rows are NULL on purpose: Splitwise's `General` is a catch-all
   * holding anything from an appliance to a repair visit, so no single mapping is right for all of it.
   * The map cannot answer, and before this nothing could — the owner's share of every such
   * expense stayed an unexplained remainder with no way to resolve it in the app.
   *
   * NOT stored anywhere of its own. The category lives on the allocation, which is the one
   * place this codebase already keeps "what is this money", and a second home for it would be
   * a second answer to the same question.
   */
  categoryOverride: string | null = null,
): Promise<ApplyResult> {
  const netPaise = ev.payload.nets_paise[ctx.me] ?? 0;
  const costPaise = Number(ev.amount_paise);
  const expected = expectedCash(ev.payload.kind, costPaise, netPaise);
  if (expected === null) {
    return { conflict: "this record expects no cash of ours", displaced: 0, displacedAuthored: 0, backfilled: 0, allocationsWritten: 0, partial: false };
  }
  if (transactionIds.length === 0) {
    return { conflict: "no transaction selected", displaced: 0, displacedAuthored: 0, backfilled: 0, allocationsWritten: 0, partial: false };
  }

  // Precedence is judged per transaction, and ANY refusal refuses the whole link. A partial
  // link would leave the record explaining some of its payments and not others, which is a
  // state nothing downstream knows how to read.
  const existing = await client.query<ExistingAllocation>(
    `SELECT id, source, confirmed_from_rule_id
       FROM allocations
      WHERE transaction_id = ANY($1) AND (evidence_id IS DISTINCT FROM $2)`,
    [transactionIds, ev.id],
  );
  const decision = resolvePrecedence(existing.rows, authority);

  // Writing on top of an existing allocation DOUBLES the explained amount — a Rs 250 debit
  // ends up carrying Rs 500. So a conflict means write NOTHING and leave the record unlinked,
  // so it stays visible as work to do rather than silently half-applied.
  if (decision.action === "conflict") {
    return { conflict: decision.reason, displaced: 0, displacedAuthored: 0, backfilled: 0, allocationsWritten: 0, partial: false };
  }

  // Replace this record's own previous work, then the guesses it outranks.
  await client.query("DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'", [ev.id]);
  await client.query("DELETE FROM evidence_transactions WHERE evidence_id = $1", [ev.id]);

  let displaced = 0;
  let displacedAuthored = 0;
  if (decision.action === "displace" && decision.allocationIds.length > 0) {
    await client.query("DELETE FROM allocations WHERE id = ANY($1)", [decision.allocationIds]);
    displaced = decision.allocationIds.length;
    // Counted apart, because it is the half that cannot be regenerated. A displaced rule
    // guess comes back from POST /rules/apply; something a person wrote is simply gone, and
    // the screen that offered the choice has to be able to say so.
    displacedAuthored = decision.authoredIds.length;
  }

  const amounts = await client.query<{ id: string; amount_paise: string }>(
    "SELECT id, amount_paise FROM transactions WHERE id = ANY($1)",
    [transactionIds],
  );
  const ordered = amounts.rows.map((r) => ({ id: r.id, amount: Number(r.amount_paise) }));

  for (const t of ordered) {
    await client.query(
      "INSERT INTO evidence_transactions (evidence_id, transaction_id) VALUES ($1, $2)",
      [ev.id, t.id],
    );
  }

  const weights = ordered.map((t) => t.amount);
  const linkedTotal = weights.reduce((a, w) => a + Math.abs(w), 0);
  const recordTotal = Math.abs(ev.payload.kind === "payment" ? expected : costPaise);

  // THE INVARIANT: never allocate more than a transaction actually holds. You cannot have
  // spent more on a payment than left the account, and a negative remainder is a number that
  // cannot be true.
  //
  // It bites the moment mismatched totals are allowed. Selecting Rs 438 of payments for a
  // Rs 1,368 expense is legitimate — the rest may have come from another account or in cash —
  // but allocating the full Rs 1,368 across them over-claims both.
  //
  // So the allocatable amount is CAPPED at what was actually selected. Under-selecting scales
  // the split down proportionally; over-selecting (paid 2,745, entered 2,700) does not scale
  // at all, and the extra stays as the transaction's unexplained remainder, which is where
  // the design says uncertainty belongs.
  const cap = Math.min(recordTotal, linkedTotal);
  const scaledDown = cap < recordTotal;

  // Split PER TRANSACTION first, then split each transaction's share between the categories.
  // The other order — spreading each category across the transactions independently — lets
  // two roundings land on the same transaction and push it a paise over its own amount.
  const perTxn = splitProportionally(-cap, weights);

  const write = (transactionId: string, amount: number, categoryId: string, note: string) =>
    client.query(
      `INSERT INTO allocations
         (transaction_id, amount_paise, category_id, confidence, source, evidence_id, note)
       VALUES ($1, $2, $3, 1.00, 'evidence', $4, $5)`,
      [transactionId, amount, categoryId, ev.id, note],
    );

  // The person's choice first, then the source map. Only this way round: a map that has
  // already said it cannot answer must not overrule someone who could.
  const categoryId = categoryOverride ?? ctx.map.get(ev.payload.source_category) ?? null;
  const ourShare = costPaise - netPaise;
  let written = 0;

  // Confidence is 1.00 and that is a claim, not a shrug: an evidence allocation is not a
  // guess. The amounts come from a record of something that happened. A graded score here
  // would be the constant-0.8 disease from the design, carrying no information.
  for (const [i, share] of perTxn.entries()) {
    // A zero-paise allocation is rejected by the CHECK on `allocations`, and rightly so — it
    // would claim a slice of a transaction while saying nothing about it.
    if (share === 0) continue;
    const txnId = ordered[i].id;

    if (ev.payload.kind === "payment") {
      // A settlement is entirely a transfer between people. None of it is consumption.
      await write(txnId, share, ctx.sharedId, `splitwise settlement ${ev.external_ref}`);
      written++;
      continue;
    }

    // Divide THIS transaction's share between other people's part and ours, in the ratio the
    // record states. `trunc` then remainder, so the two always sum back to `share` exactly.
    const othersPart = recordTotal === 0 ? 0 : Math.trunc((share * netPaise) / recordTotal);
    const ourPart = share - othersPart;

    if (othersPart !== 0) {
      await write(txnId, othersPart, ctx.sharedId, `others' share of ${ev.external_ref}`);
      written++;
    }
    // Unmapped or deliberately unmappable: our own share stays in the remainder. A visible
    // remainder is the honest outcome; the alternative is inventing a category.
    if (categoryId !== null && ourPart !== 0) {
      await write(txnId, ourPart, categoryId, `our share of ${ev.external_ref}`);
      written++;
    }
  }

  // REFILL WHAT THE DISPLACEMENT LEFT, in this same transaction.
  //
  // The symmetric half of the invoice path's `rederiveAndBackfill`. A settlement explains the
  // shared slice and, where the source map can answer, our own — never necessarily the whole
  // bank row. Whatever is left was explained by the rule this link just deleted, and without
  // this it goes back to reading as unexplained until somebody runs the engine by hand.
  //
  // Evidence rows count against the engine's remainder budget, so it can only take what is
  // genuinely spare. the design.
  const backfilled = (await applyRules(client, null, transactionIds)).created;

  return {
    displaced,
    displacedAuthored,
    backfilled,
    allocationsWritten: written,
    partial: ev.payload.kind === "expense" && categoryId === null && ourShare !== 0,
    scaledDown,
  };
}

/**
 * @param me the person column in the export that is the ledger owner's — the same value the
 *           importer was given. Passed in rather than inferred: picking the wrong column
 *           would silently attribute a flatmate's shares.
 */
export async function matchSplitwiseEvidence(
  client: PoolClient,
  me: string,
): Promise<MatchSummary> {
  const summary: MatchSummary = {
    considered: 0, matched: 0, ambiguous: 0, noCandidate: 0,
    noCashExpected: 0, allocationsWritten: 0, partiallyAllocated: 0,
    conflicted: 0, displaced: 0, backfilled: 0, nearMissed: 0, conflicts: [], pairs: [],
  };

  const ctx = await loadContext(client, me);

  // Only records not yet linked. A linked record is left alone: re-deciding a link on every
  // run would fight any correction a human has made to it.
  const pending = await client.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence
      WHERE source_type = $1 AND ${UNLINKED}
      ORDER BY evidence_date, id`,
    [SOURCE],
  );

  // The whole ledger, once. At this size (hundreds of rows) filtering in the pure matcher is
  // cheaper than a query per record, and it keeps the amount/date/direction rules in exactly
  // ONE place instead of half in SQL and half in TypeScript. Push the filter into SQL when
  // the ledger makes that necessary, not before.
  const candidates = await loadCandidates(client);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  for (const ev of pending.rows) {
    const netPaise = ev.payload.nets_paise[me] ?? 0;
    const expected = expectedCash(ev.payload.kind, Number(ev.amount_paise), netPaise);

    // null means no cash of ours should have moved — an expense someone else paid for. Its
    // consumption is already recorded in the consumption table; there is nothing to find,
    // and searching anyway is how a coincidence becomes a match.
    if (expected === null) { summary.noCashExpected++; continue; }

    summary.considered++;
    const request = { externalRef: ev.external_ref, date: ev.evidence_date, expectedPaise: expected, sourceType: SOURCE };
    const outcome = matchToTransaction(request, candidates);

    if (outcome.kind === "ambiguous") { summary.ambiguous++; continue; }
    if (outcome.kind === "none") {
      // Nothing inside the accept window — but an exact amount just outside it is not "no
      // candidate", it is a question for a human. Counted separately so a summary never
      // conflates the two.
      if (nearMisses(request, candidates).length > 0) summary.nearMissed++;
      else summary.noCandidate++;
      continue;
    }

    const applied = await applyMatch(client, ev, [outcome.transactionId], ctx, "auto");
    if (applied.conflict) {
      summary.conflicted++;
      summary.conflicts.push({
        externalRef: ev.external_ref,
        transactionId: outcome.transactionId,
        reason: applied.conflict,
      });
      continue;
    }
    summary.matched++;
    summary.displaced += applied.displaced;
    summary.backfilled += applied.backfilled;
    summary.allocationsWritten += applied.allocationsWritten;
    if (applied.partial) summary.partiallyAllocated++;

    const txn = byId.get(outcome.transactionId);
    summary.pairs.push({
      evidenceId: ev.id,
      externalRef: ev.external_ref,
      description: ev.description,
      evidenceDate: ev.evidence_date,
      amountPaise: Number(ev.amount_paise),
      transactionId: outcome.transactionId,
      txnDate: txn?.txn_date ?? "",
      txnAmountPaise: txn?.amount_paise ?? 0,
      narration: txn?.narration ?? null,
      dayGap: outcome.dayGap,
    });
  }

  return summary;
}

export type NearMissRow = {
  evidenceId: string;
  externalRef: string;
  description: string | null;
  evidenceDate: string;
  amountPaise: number;
  /** What the bank should show, signed: negative means cash should have left. */
  expectedPaise: number;
  sourceCategory: string;
  candidates: NearMiss[];
};

/**
 * Every record still waiting for a transaction, with any near-miss candidates attached.
 *
 * `nearOnly` splits two audiences that want the same query. The import preview shows only the
 * ones with a candidate — those are a quick yes/no. The manual queue shows ALL of them,
 * including the ones nothing plausible was found for, because those are exactly the records a
 * person has to go and find a transaction for themselves.
 */
export async function listUnmatched(
  client: PoolClient,
  me: string,
  nearOnly = true,
): Promise<NearMissRow[]> {
  const pending = await client.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence
      WHERE source_type = $1 AND ${UNLINKED}
      ORDER BY evidence_date, id`,
    [SOURCE],
  );
  const candidates = await loadCandidates(client);

  const out: NearMissRow[] = [];
  for (const ev of pending.rows) {
    const netPaise = ev.payload.nets_paise[me] ?? 0;
    const expected = expectedCash(ev.payload.kind, Number(ev.amount_paise), netPaise);
    if (expected === null) continue;

    const near = nearMisses(
      { externalRef: ev.external_ref, date: ev.evidence_date, expectedPaise: expected, sourceType: SOURCE },
      candidates,
    );
    if (nearOnly && near.length === 0) continue;

    out.push({
      evidenceId: ev.id,
      externalRef: ev.external_ref,
      description: ev.description,
      evidenceDate: ev.evidence_date,
      amountPaise: Number(ev.amount_paise),
      expectedPaise: expected,
      sourceCategory: ev.payload.source_category,
      candidates: near,
    });
  }
  return out;
}

/** Kept for callers that only want the quick yes/no list. */
export const listNearMisses = (client: PoolClient, me: string) => listUnmatched(client, me, true);

export type LinkResult =
  | {
      ok: true;
      displaced: number;
      /** Of those, how many the person had written themselves — the irreversible part. */
      displacedAuthored: number;
      /** What the engine refilled the leftover remainder with. See the design. */
      backfilled: number;
      allocationsWritten: number;
      partial: boolean;
      scaledDown: boolean;
    }
  | { ok: false; error: string };

/**
 * Link a record to one or more transactions, because a person decided they are the same event.
 *
 * Goes through the SAME writer as an automatic match, so precedence still applies: this may
 * displace a rule's guess, and is still refused where a human authored the allocation already.
 * Deciding the date, or which payments a bill went out as, is not overruling another person's
 * decision.
 *
 * The selected transactions need NOT sum to the record's amount. Paid 2,745 and entered 2,700
 * is ordinary, and the 45 becomes the transaction's unexplained remainder rather than a reason
 * to refuse.
 */
export async function linkEvidence(
  client: PoolClient,
  evidenceId: string,
  transactionIds: string[],
  me: string,
  /** A category for the owner's share, where the source map has none. See `applyMatch`. */
  categoryId: string | null = null,
): Promise<LinkResult> {
  if (transactionIds.length === 0) return { ok: false, error: "select at least one transaction" };
  // A repeated id would double that transaction's weight in the proportional split and write
  // two allocations onto it.
  const unique = [...new Set(transactionIds)];

  const found = await client.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE id = $1 AND source_type = $2`,
    [evidenceId, SOURCE],
  );
  const ev = found.rows[0];
  if (ev === undefined) return { ok: false, error: "no such record" };

  const already = await client.query(
    "SELECT 1 FROM evidence_transactions WHERE evidence_id = $1", [evidenceId]);
  // Linking an already-linked record would write a second set of allocations while the first
  // set still stands.
  if ((already.rowCount ?? 0) > 0) return { ok: false, error: "this record is already linked" };

  const txns = await client.query("SELECT id FROM transactions WHERE id = ANY($1)", [unique]);
  if (txns.rowCount !== unique.length) return { ok: false, error: "no such transaction" };

  // "user": this link is a person's decision about one record, so it may overrule one of
  // their own earlier decisions. The automatic sweep never may. See `Authority`.
  const applied = await applyMatch(
    client,
    ev,
    unique,
    await loadContext(client, me),
    "user",
    categoryId,
  );
  if (applied.conflict) return { ok: false, error: applied.conflict };
  return {
    ok: true,
    displaced: applied.displaced,
    displacedAuthored: applied.displacedAuthored,
    backfilled: applied.backfilled,
    allocationsWritten: applied.allocationsWritten,
    partial: applied.partial,
    scaledDown: applied.scaledDown ?? false,
  };
}

// ── the worklist ────────────────────────────────────────────────────────────────────────
//
// Everything above answers "what happened during an import". This answers "what is the state
// of my records now", which is a different question and the one the Sources screen is built
// around: a record is MATCHED, a NEAR miss, or waiting with nothing found — and all three
// belong on screen together, because deciding one often means changing another.
//
// `matchSplitwiseEvidence` could report the first of those, but only for the run that just
// happened. Reload the page and what matched was unknowable, which made "review what matched"
// something you could do for ten seconds after an import and never again.

/**
 * Where a record stands. The four segments of the review screen, in decision order.
 *
 * `conflicted` was the pile with nowhere to go. A record whose exact match sits INSIDE the
 * accept window but whose transaction a person had already explained was refused by the
 * matcher and then fell through to "unmatched" — a section headed "Nothing of this amount was
 * found", about a row where something of exactly this amount had been found and named. The
 * one state where the screen was actively wrong is now the one where it has the most to say.
 */
export type RecordState = "matched" | "near" | "conflicted" | "unmatched";

/** One bank row that pays for a record. */
export type LinkedTransaction = {
  transactionId: string;
  txnDate: string;
  txnAmountPaise: number;
  narration: string | null;
  accountName: string | null;
  /** Days between the record's date and the bank row's — the thing you check a match by. */
  dayGap: number;
};

export type EvidenceRecord = {
  evidenceId: string;
  externalRef: string;
  description: string | null;
  evidenceDate: string;
  amountPaise: number;
  /** What the bank should show, signed: negative means cash should have left. */
  expectedPaise: number;
  sourceCategory: string;
  /** Which import this came from. Part of the natural key, so it is never null here. */
  group: string;
  state: RecordState;
  /** What pays for it. Empty unless `state` is "matched". */
  linked: LinkedTransaction[];
  /**
   * The transactions worth offering. Near misses when `state` is "near"; the single
   * already-explained match when it is "conflicted". Empty otherwise.
   */
  candidates: NearMiss[];
  /** Why the matcher would not take the candidate. Only set when `state` is "conflicted". */
  conflict: string | null;
  /**
   * What the owner's share of this record is filed under — READ OFF THE ALLOCATIONS for a
   * linked record, and off the source map for one that is not yet linked. Two sources because
   * they answer two different questions ("what is it" vs "what would it be"), and only one of
   * them can be true at a time.
   */
  categoryName: string | null;
  /** The same, as an id, so a picker can open on what is already chosen. */
  categoryId: string | null;
  /**
   * The source's category has no answer and this record has a share to file — so the person
   * is the only one who can say, and the screen may ask.
   *
   * The condition for OFFERING the choice, and it stays true after one is made: a category
   * picked by hand has to remain correctable, and hiding the picker once it is filled would
   * make a typo permanent.
   *
   * False where the map DOES answer, and that is not timidity. A record's allocations are
   * re-derived from the map every time it is linked again, so an override there would be
   * quietly undone by the next unlink — a decision reversed by a machine, which
   * the design forbids. Where the map has an answer, the place to change
   * the answer is the map.
   */
  canChoose: boolean;
  /** `canChoose`, and nothing is filed yet. The amber remainder the review screen counts. */
  needsCategory: boolean;
};

type WorklistRow = EvidenceRow & {
  linked: {
    transactionId: string;
    txnDate: string;
    txnAmountPaise: number | string;
    narration: string | null;
    accountName: string | null;
  }[];
};

/**
 * Every record that needs a person, with the state it is currently in.
 *
 * Records expecting no cash of ours are LEFT OUT — 63 of 93 in the real export. Someone else
 * paid, their consumption is already recorded, and there is nothing to look for. Listing them
 * would bury the 30 rows that are work under twice as many that are not. The batch header
 * counts them, so the number stays visible; it just is not a queue.
 *
 * Computed in one pass over the whole ledger rather than paged in SQL, for the reason
 * `matchSplitwiseEvidence` gives: the near-miss rule lives in TypeScript, and splitting it
 * across two languages is how a count and the list under it start disagreeing. The caller
 * slices. Push it into SQL when the ledger makes that necessary, not before.
 */
export async function listRecords(
  client: PoolClient,
  me: string,
  filter: { group?: string; state?: RecordState } = {},
): Promise<EvidenceRecord[]> {
  const rows = await client.query<WorklistRow>(
    `SELECT ev.id, ev.external_ref, ev.description, ev.evidence_date::text,
            ev.amount_paise, ev.payload,
            COALESCE(
              json_agg(
                json_build_object(
                  'transactionId',  t.id::text,
                  'txnDate',        t.txn_date::text,
                  'txnAmountPaise', t.amount_paise,
                  'narration',      t.narration,
                  'accountName',    acc.name
                ) ORDER BY t.txn_date, t.id
              ) FILTER (WHERE t.id IS NOT NULL),
              '[]'
            ) AS linked
       FROM evidence ev
       LEFT JOIN evidence_transactions et ON et.evidence_id = ev.id
       LEFT JOIN transactions t          ON t.id = et.transaction_id
       LEFT JOIN accounts acc            ON acc.id = t.account_id
      WHERE ev.source_type = $1
        AND ($2::text IS NULL OR ev.payload->>'group' = $2)
      GROUP BY ev.id
      ORDER BY ev.evidence_date DESC, ev.id DESC`,
    [SOURCE, filter.group ?? null],
  );

  const candidates = await loadCandidates(client);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  const ctx = await loadContext(client, me);
  const categoryNames = new Map(
    (await client.query<{ id: string; name: string }>("SELECT id, name FROM categories")).rows.map(
      (c) => [c.id, c.name],
    ),
  );

  // What each record's OWN share is filed under. The shared bucket is excluded deliberately:
  // that slice is other people's money and is written for EVERY record, so counting it would
  // report every uncategorised expense as categorised.
  const filed = new Map<string, { id: string; name: string }>();
  for (const a of (
    await client.query<{ evidence_id: string; id: string; name: string }>(
      `SELECT al.evidence_id, c.id, c.name
         FROM allocations al JOIN categories c ON c.id = al.category_id
        WHERE al.source = 'evidence' AND al.evidence_id IS NOT NULL AND al.category_id <> $1`,
      [ctx.sharedId],
    )
  ).rows) {
    filed.set(a.evidence_id, { id: a.id, name: a.name });
  }

  // What already explains each transaction, once for the whole pass. Needed to tell "nothing
  // of this amount exists" apart from "it exists and you already explained it" — two answers
  // the screen used to give the same section and the same sentence.
  const claims = new Map<string, ExistingAllocation[]>();
  for (const a of (
    await client.query<ExistingAllocation & { transaction_id: string }>(
      "SELECT transaction_id, id, source, confirmed_from_rule_id FROM allocations",
    )
  ).rows) {
    const held = claims.get(a.transaction_id);
    if (held === undefined) claims.set(a.transaction_id, [a]);
    else held.push(a);
  }

  const out: EvidenceRecord[] = [];

  for (const ev of rows.rows) {
    const netPaise = ev.payload.nets_paise[me] ?? 0;
    const expected = expectedCash(ev.payload.kind, Number(ev.amount_paise), netPaise);
    if (expected === null) continue;

    const linked: LinkedTransaction[] = ev.linked.map((l) => ({
      transactionId: l.transactionId,
      txnDate: l.txnDate,
      // json_build_object emits a BIGINT as a JSON number and pg hands it back parsed, but
      // narrowing once here keeps the rule the rest of this file follows: an amount is a
      // number by the time it leaves the module.
      txnAmountPaise: Number(l.txnAmountPaise),
      narration: l.narration,
      accountName: l.accountName,
      dayGap: dayGap(l.txnDate, ev.evidence_date),
    }));

    // Only unlinked records have candidates worth computing: a linked one already has its
    // answer, and offering alternatives beside a decision is noise.
    const request = {
      externalRef: ev.external_ref,
      date: ev.evidence_date,
      expectedPaise: expected,
      sourceType: SOURCE,
    };

    let state: RecordState = "matched";
    let offer: NearMiss[] = [];
    let conflict: string | null = null;

    // Every candidate a person can tick carries the CLAIM its transaction holds, so the
    // screen can say what linking would remove before the button is pressed. A lookup, not
    // a query — the allocations were loaded one pass above for the conflicted state, and
    // `claimOn` answers from the same tiers `resolvePrecedence` decides on.
    const withClaims = (list: NearMiss[]): NearMiss[] =>
      list.map((m) => ({ ...m, claim: claimOn(claims.get(m.transactionId) ?? []) }));

    if (linked.length === 0) {
      // An exact match INSIDE the window that is nonetheless unlinked means the matcher was
      // refused. Ask the same function it asked, under the same authority, so the worklist and
      // the matcher can never disagree about what counts as a conflict.
      const outcome = matchToTransaction(request, candidates);
      const blocked =
        outcome.kind === "matched"
          ? resolvePrecedence(claims.get(outcome.transactionId) ?? [], "auto")
          : null;

      if (outcome.kind === "matched" && blocked?.action === "conflict") {
        const txn = byId.get(outcome.transactionId);
        state = "conflicted";
        conflict = blocked.reason;
        offer = withClaims([
          {
            transactionId: outcome.transactionId,
            txnDate: txn?.txn_date ?? "",
            dayGap: outcome.dayGap,
            narration: txn?.narration ?? null,
            accountName: txn?.account_name ?? null,
          },
        ]);
      } else {
        offer = withClaims(nearMisses(request, candidates));
        state = offer.length > 0 ? "near" : "unmatched";
      }
    }

    if (filter.state !== undefined && filter.state !== state) continue;

    // A linked record's category is a FACT on the ledger; an unlinked one's is a prediction.
    // Each is read from the place that actually knows.
    const mapped = ctx.map.get(ev.payload.source_category) ?? null;
    const filedHere = linked.length > 0 ? (filed.get(ev.id) ?? null) : null;
    const categoryId = filedHere?.id ?? (linked.length > 0 ? null : mapped);
    const categoryName =
      filedHere?.name ?? (linked.length > 0 || mapped === null ? null : (categoryNames.get(mapped) ?? null));

    // A share to file at all: a settlement is a transfer between people and has no category,
    // and a record someone else paid for leaves nothing of ours to categorise.
    const ourShare = Number(ev.amount_paise) - netPaise;
    const hasShare = ev.payload.kind === "expense" && ourShare !== 0;
    const canChoose = hasShare && mapped === null;
    const needsCategory = canChoose && categoryName === null;

    out.push({
      evidenceId: ev.id,
      externalRef: ev.external_ref,
      description: ev.description,
      evidenceDate: ev.evidence_date,
      amountPaise: Number(ev.amount_paise),
      expectedPaise: expected,
      sourceCategory: ev.payload.source_category,
      group: ev.payload.group,
      state,
      linked,
      candidates: offer,
      conflict,
      categoryName,
      categoryId,
      canChoose,
      needsCategory,
    });
  }
  return out;
}

/** One import's worth of records, as its collapsed header summarises it. */
export type ImportBatch = {
  source: string;
  group: string;
  /** Every record the export produced, including the ones that are not work. */
  records: number;
  matched: number;
  near: number;
  conflicted: number;
  unmatched: number;
  /** Someone else paid — consumption only, nothing to look for. */
  noCashExpected: number;
  lastImportedAt: string;
};

/**
 * The imports this ledger holds, newest first.
 *
 * Keyed by GROUP, not by upload. Re-importing the same export is the SAME import: the writer
 * upserts on the natural key, so a second upload updates 93 rows rather than adding 93 more,
 * and a screen that showed it as a second batch would be describing an event rather than the
 * state of the ledger. Two different groups are two batches, which is the distinction that
 * actually separates one pile of work from another.
 */
export async function listImports(client: PoolClient, me: string): Promise<ImportBatch[]> {
  const totals = await client.query<{ group: string; records: string; last: string }>(
    `SELECT payload->>'group' AS group, COUNT(*) AS records, MAX(created_at) AS last
       FROM evidence
      WHERE source_type = $1 AND payload->>'group' IS NOT NULL
      GROUP BY 1`,
    [SOURCE],
  );

  const records = await listRecords(client, me);
  const byGroup = new Map<string, EvidenceRecord[]>();
  for (const r of records) {
    const held = byGroup.get(r.group);
    if (held === undefined) byGroup.set(r.group, [r]);
    else held.push(r);
  }

  return totals.rows
    .map((t) => {
      const mine = byGroup.get(t.group) ?? [];
      const count = (state: RecordState) => mine.filter((r) => r.state === state).length;
      return {
        source: SOURCE,
        group: t.group,
        records: Number(t.records),
        matched: count("matched"),
        near: count("near"),
        conflicted: count("conflicted"),
        unmatched: count("unmatched"),
        // Everything the worklist skipped, which is exactly what it left out.
        noCashExpected: Number(t.records) - mine.length,
        lastImportedAt: t.last,
      };
    })
    .sort((a, b) => b.lastImportedAt.localeCompare(a.lastImportedAt));
}

export type UnlinkResult =
  | { ok: true; transactionsUnlinked: number; allocationsRemoved: number }
  | { ok: false; error: string };

/**
 * Undo a link: forget which transactions paid for a record, and remove the money it wrote.
 *
 * The counterpart `applyMatch` never had. Linking was one-way, so a wrong link was a permanent
 * wrong answer fixable only in SQL — and a control you cannot take back is one people hesitate
 * over, which is the worst instinct to train on a queue whose whole job is to be worked
 * through quickly.
 *
 * Deletes the two things `applyMatch` deletes before it writes, and nothing else. In
 * particular `source = 'evidence'` is not optional: a person may have written their own
 * allocation on one of these transactions since, and that is a decision, not our row.
 *
 * WHAT IT CANNOT UNDO, said here rather than left to be discovered: matching DISPLACES the
 * rule guesses it outranks by deleting them. Those rows are gone and
 * nothing here brings them back — `POST /rules/apply` regenerates them, as provisional. The
 * same caveat the purge script carries, for the same reason.
 */
export async function unlinkEvidence(
  client: PoolClient,
  evidenceId: string,
): Promise<UnlinkResult> {
  const found = await client.query(
    "SELECT 1 FROM evidence WHERE id = $1 AND source_type = $2",
    [evidenceId, SOURCE],
  );
  if (found.rowCount === 0) return { ok: false, error: "no such record" };

  const links = await client.query(
    "DELETE FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId],
  );
  if (links.rowCount === 0) {
    return { ok: false, error: "this record is not linked to anything" };
  }

  const allocations = await client.query(
    "DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'",
    [evidenceId],
  );
  return {
    ok: true,
    transactionsUnlinked: links.rowCount ?? 0,
    allocationsRemoved: allocations.rowCount ?? 0,
  };
}

export type CategoryResult =
  | { ok: true; relinked: boolean; allocationsWritten: number }
  | { ok: false; error: string };

/**
 * Give one record a category, when the source's own category cannot answer for it.
 *
 * The case this exists for: Splitwise's `General` is mapped to NULL on purpose (a catch-all
 * holding anything from an appliance to a repair visit — no single category is right for all of it), so
 * `applyMatch` writes only the shared slice and the owner's share stays as an unexplained
 * remainder. Before this there was no way to resolve that inside the app.
 *
 * Two steps, and the second is the one that matters. Writing the column alone would change
 * what a FUTURE link derives while leaving the money already on the ledger untouched — so the
 * screen would say "Groceries" over a transaction whose remainder was still unexplained. So a
 * record that is already linked is re-derived immediately, through `applyMatch` itself rather
 * than through a second copy of the split arithmetic.
 *
 * Authority is "user" for that re-derivation, and deliberately: the person is choosing a
 * category for their own record, and if they had previously explained one of these
 * transactions by hand, that is theirs to overrule. The automatic sweep still never may.
 */
export async function setEvidenceCategory(
  client: PoolClient,
  evidenceId: string,
  categoryId: string | null,
  me: string,
): Promise<CategoryResult> {
  const found = await client.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE id = $1 AND source_type = $2`,
    [evidenceId, SOURCE],
  );
  const ev = found.rows[0];
  if (ev === undefined) return { ok: false, error: "no such record" };

  // A settlement is entirely a transfer between people; none of it is consumption, so it has
  // no category to choose and offering one would invite a wrong answer. Refused rather than
  // ignored — silently accepting a value nothing will ever read is worse.
  if (ev.payload.kind === "payment") {
    return { ok: false, error: "a settlement has no category — it is a transfer, not spending" };
  }

  if (categoryId !== null) {
    const category = await client.query("SELECT 1 FROM categories WHERE id = $1", [categoryId]);
    // Checked here rather than left to the FK: a violation surfaces as an internal error,
    // which blames us for what is a caller's typo.
    if (category.rowCount === 0) return { ok: false, error: "no such category" };
  }

  await client.query("UPDATE evidence SET category_id = $2 WHERE id = $1", [
    evidenceId,
    categoryId,
  ]);

  const linked = await client.query<{ transaction_id: string }>(
    "SELECT transaction_id FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId],
  );
  if (linked.rowCount === 0) {
    // Nothing to re-derive. Setting a category BEFORE a record is matched is legitimate — the
    // category of an expense is a fact about the expense, not about the row that paid for it.
    return { ok: true, relinked: false, allocationsWritten: 0 };
  }

  // Re-read: the row we hold was fetched before the UPDATE and still carries the old value.
  const fresh = await client.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE id = $1`,
    [evidenceId],
  );
  const applied = await applyMatch(
    client,
    fresh.rows[0]!,
    linked.rows.map((r) => r.transaction_id),
    await loadContext(client, me),
    "user",
  );
  if (applied.conflict) return { ok: false, error: applied.conflict };
  return { ok: true, relinked: true, allocationsWritten: applied.allocationsWritten };
}

/**
 * File a record's own share under a category, on a record that is already linked.
 *
 * The gap this closes: `source_category_map` maps `General` and `Payment` to NULL on purpose
 * — Splitwise's `General` is a catch-all holding anything from an appliance to a repair visit, and any
 * single mapping would be wrong for most of it. So `applyMatch` writes only the shared slice
 * and the owner's share stays an unexplained remainder. That rule was decided about IMPORT
 * time, where the question is asked in bulk about rows nobody is looking at; at REVIEW time,
 * with the description and the amount on screen, it is an easy question. The rule was right
 * and its scope was too wide.
 *
 * Re-derived through `applyMatch` rather than by writing an allocation here, so the split
 * arithmetic — proportional across transactions, capped at what each one holds, our part and
 * theirs in the ratio the record states — exists once. A second copy is how the two start
 * disagreeing about a number that is money.
 *
 * Authority is "user": the person is choosing a category for their own record, and if they
 * had previously explained one of these transactions by hand that is theirs to overrule. The
 * automatic sweep still never may.
 */
export async function categoriseEvidence(
  client: PoolClient,
  evidenceId: string,
  categoryId: string,
  me: string,
): Promise<LinkResult> {
  const found = await client.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE id = $1 AND source_type = $2`,
    [evidenceId, SOURCE],
  );
  const ev = found.rows[0];
  if (ev === undefined) return { ok: false, error: "no such record" };

  // A settlement is entirely a transfer between people; none of it is consumption, so there is
  // no category to choose. Refused rather than ignored — quietly accepting a value that
  // nothing will ever read is the worse failure.
  if (ev.payload.kind === "payment") {
    return { ok: false, error: "a settlement has no category — it is a transfer, not spending" };
  }

  // Checked here rather than left to the foreign key: a violation surfaces to the caller as an
  // internal error, which blames us for what is their typo.
  const category = await client.query("SELECT 1 FROM categories WHERE id = $1", [categoryId]);
  if (category.rowCount === 0) return { ok: false, error: "no such category" };

  const linked = await client.query<{ transaction_id: string }>(
    "SELECT transaction_id FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId],
  );
  // Nothing to write against. A category is only money once there is a transaction to take a
  // slice of, so this is a state to report rather than a value to remember for later.
  if (linked.rowCount === 0) {
    return { ok: false, error: "link this record to a payment first" };
  }

  const applied = await applyMatch(
    client,
    ev,
    linked.rows.map((r) => r.transaction_id),
    await loadContext(client, me),
    "user",
    categoryId,
  );
  if (applied.conflict) return { ok: false, error: applied.conflict };
  return {
    ok: true,
    displaced: applied.displaced,
    displacedAuthored: applied.displacedAuthored,
    backfilled: applied.backfilled,
    allocationsWritten: applied.allocationsWritten,
    partial: applied.partial,
    scaledDown: applied.scaledDown ?? false,
  };
}

/**
 * Re-derive one record's allocations from the CURRENT category map, keeping its links.
 *
 * Exists for `source_category_map` changes: learning that Splitwise's `Car` means Transport
 * has to reach the records already carrying `Car`, or the mapping would be a setting that
 * only affects the next import rather than a decision that applies backwards.
 *
 * Goes through `applyMatch` with the same authority the importer uses, so the split arithmetic
 * and the precedence rules exist once. `"auto"` is deliberate and is the protection: under it,
 * precedence REFUSES a transaction someone explained themselves rather than warning and
 * proceeding. A record whose allocations were authored by hand is filtered out before it gets
 * here (see `evidenceNeedingRederive`), and if one slipped through, this is what stops a map
 * change from quietly replacing a person's answer.
 */
export async function rederiveEvidence(
  client: PoolClient,
  evidenceId: string,
  me: string,
): Promise<LinkResult> {
  const found = await client.query<EvidenceRow>(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE id = $1 AND source_type = $2`,
    [evidenceId, SOURCE],
  );
  const ev = found.rows[0];
  if (ev === undefined) return { ok: false, error: "no such record" };

  const linked = await client.query<{ transaction_id: string }>(
    "SELECT transaction_id FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId],
  );
  // Not an error: an unlinked record has no allocations to re-derive, and its consumption was
  // already rebuilt from the map by the caller.
  if (linked.rowCount === 0) {
    return { ok: true, displaced: 0, displacedAuthored: 0, backfilled: 0, allocationsWritten: 0, partial: false, scaledDown: false };
  }

  const applied = await applyMatch(
    client,
    ev,
    linked.rows.map((r) => r.transaction_id),
    await loadContext(client, me),
    "auto",
  );
  if (applied.conflict) return { ok: false, error: applied.conflict };
  return {
    ok: true,
    displaced: applied.displaced,
    displacedAuthored: applied.displacedAuthored,
    backfilled: applied.backfilled,
    allocationsWritten: applied.allocationsWritten,
    partial: applied.partial,
    scaledDown: applied.scaledDown ?? false,
  };
}
