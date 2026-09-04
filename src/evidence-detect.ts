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
  type Candidate,
  type ExistingAllocation,
  type NearMiss,
  expectedCash,
  matchToTransaction,
  nearMisses,
  resolvePrecedence,
  splitProportionally,
} from "./evidence-match.ts";

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
    "SELECT id, txn_date::text, amount_paise, narration FROM transactions",
  );
  return rows.rows.map((c) => ({ ...c, amount_paise: Number(c.amount_paise) }));
}

type ApplyResult = {
  conflict?: string;
  displaced: number;
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
): Promise<ApplyResult> {
  const netPaise = ev.payload.nets_paise[ctx.me] ?? 0;
  const costPaise = Number(ev.amount_paise);
  const expected = expectedCash(ev.payload.kind, costPaise, netPaise);
  if (expected === null) {
    return { conflict: "this record expects no cash of ours", displaced: 0, allocationsWritten: 0, partial: false };
  }
  if (transactionIds.length === 0) {
    return { conflict: "no transaction selected", displaced: 0, allocationsWritten: 0, partial: false };
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
  const decision = resolvePrecedence(existing.rows);

  // Writing on top of an existing allocation DOUBLES the explained amount — a Rs 250 debit
  // ends up carrying Rs 500. So a conflict means write NOTHING and leave the record unlinked,
  // so it stays visible as work to do rather than silently half-applied.
  if (decision.action === "conflict") {
    return { conflict: decision.reason, displaced: 0, allocationsWritten: 0, partial: false };
  }

  // Replace this record's own previous work, then the guesses it outranks.
  await client.query("DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'", [ev.id]);
  await client.query("DELETE FROM evidence_transactions WHERE evidence_id = $1", [ev.id]);

  let displaced = 0;
  if (decision.action === "displace" && decision.allocationIds.length > 0) {
    await client.query("DELETE FROM allocations WHERE id = ANY($1)", [decision.allocationIds]);
    displaced = decision.allocationIds.length;
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

  const categoryId = ctx.map.get(ev.payload.source_category) ?? null;
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

  return {
    displaced,
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
    conflicted: 0, displaced: 0, nearMissed: 0, conflicts: [], pairs: [],
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
    const request = { externalRef: ev.external_ref, date: ev.evidence_date, expectedPaise: expected };
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

    const applied = await applyMatch(client, ev, [outcome.transactionId], ctx);
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
      { externalRef: ev.external_ref, date: ev.evidence_date, expectedPaise: expected },
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
  | { ok: true; displaced: number; allocationsWritten: number; partial: boolean; scaledDown: boolean }
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

  const applied = await applyMatch(client, ev, unique, await loadContext(client, me));
  if (applied.conflict) return { ok: false, error: applied.conflict };
  return {
    ok: true,
    displaced: applied.displaced,
    allocationsWritten: applied.allocationsWritten,
    partial: applied.partial,
    scaledDown: applied.scaledDown ?? false,
  };
}
