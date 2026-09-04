// The DB half of evidence matching — the counterpart to src/evidence-match.ts, the same way
// src/detect.ts is the DB half of src/transfers.ts.
//
// Finds the bank transaction behind each unmatched Splitwise record and, where it finds one,
// writes the allocations that split it. Design in the design.

import type { PoolClient } from "pg";

import {
  type Candidate,
  type ExistingAllocation,
  type NearMiss,
  expectedCash,
  matchToTransaction,
  nearMisses,
  resolvePrecedence,
} from "./evidence-match.ts";

const SOURCE = "splitwise";

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
};

type EvidenceRow = {
  id: string;
  external_ref: string;
  evidence_date: string;
  amount_paise: string;
  payload: {
    kind: "expense" | "payment";
    nets_paise: Record<string, number>;
    source_category: string;
  };
};

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
};

/**
 * Link one record to one transaction and write the allocations that split it.
 *
 * ONE writer, used both by the automatic matcher and by a human accepting a near miss. The
 * date rule is the only thing that differs between those two paths, and it has already been
 * decided by the time we get here — so precedence, displacement and the split itself cannot
 * drift apart. A second copy of "what accepting a match means" is exactly the kind of
 * duplicate definition src/spend.ts warns about.
 */
async function applyMatch(
  client: PoolClient,
  ev: EvidenceRow,
  transactionId: string,
  ctx: WriteContext,
): Promise<ApplyResult> {
  const netPaise = ev.payload.nets_paise[ctx.me] ?? 0;
  const costPaise = Number(ev.amount_paise);
  const expected = expectedCash(ev.payload.kind, costPaise, netPaise);
  if (expected === null) {
    return { conflict: "this record expects no cash of ours", displaced: 0, allocationsWritten: 0, partial: false };
  }

  // What already explains this transaction? Rows produced by THIS evidence are excluded:
  // they are our own previous run, replaced rather than competed with.
  const existing = await client.query<ExistingAllocation>(
    `SELECT id, source, confirmed_from_rule_id
       FROM allocations
      WHERE transaction_id = $1 AND (evidence_id IS DISTINCT FROM $2)`,
    [transactionId, ev.id],
  );
  const decision = resolvePrecedence(existing.rows);

  // Writing on top of an existing allocation DOUBLES the explained amount — a Rs 250 debit
  // ends up carrying Rs 500 of allocations. So a conflict means write NOTHING and leave the
  // link unset, so the row stays visible as work to do rather than silently half-applied.
  if (decision.action === "conflict") {
    return { conflict: decision.reason, displaced: 0, allocationsWritten: 0, partial: false };
  }

  await client.query("UPDATE evidence SET transaction_id = $1 WHERE id = $2", [transactionId, ev.id]);
  await client.query("DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'", [ev.id]);

  let displaced = 0;
  if (decision.action === "displace" && decision.allocationIds.length > 0) {
    await client.query("DELETE FROM allocations WHERE id = ANY($1)", [decision.allocationIds]);
    displaced = decision.allocationIds.length;
  }

  const write = (amount: number, categoryId: string, note: string) =>
    client.query(
      `INSERT INTO allocations
         (transaction_id, amount_paise, category_id, confidence, source, evidence_id, note)
       VALUES ($1, $2, $3, 1.00, 'evidence', $4, $5)`,
      [transactionId, amount, categoryId, ev.id, note],
    );

  // Confidence is 1.00 and that is a claim, not a shrug: an evidence allocation is not a
  // guess. The amounts come from a record of something that happened. A graded score here
  // would be the constant-0.8 disease from the design, carrying no information.
  if (ev.payload.kind === "payment") {
    // A settlement is entirely a transfer between people. None of it is consumption.
    await write(expected, ctx.sharedId, `splitwise settlement ${ev.external_ref}`);
    return { displaced, allocationsWritten: 1, partial: false };
  }

  // An expense we fronted splits in two: our consumption, and the part that was other
  // people's. They sum to the whole debit by construction — (cost - net) + net = cost — so
  // the transaction is left with no unexplained remainder.
  const ourShare = costPaise - netPaise;
  const categoryId = ctx.map.get(ev.payload.source_category) ?? null;
  await write(-netPaise, ctx.sharedId, `others' share of ${ev.external_ref}`);

  if (categoryId === null) {
    // Unmapped or deliberately unmappable. Our own share stays in the transaction's
    // unexplained remainder, which `allocations` computes rather than stores. A visible
    // remainder is the honest outcome; the alternative is inventing a category.
    return { displaced, allocationsWritten: 1, partial: true };
  }
  if (ourShare === 0) return { displaced, allocationsWritten: 1, partial: false };

  await write(-ourShare, categoryId, `our share of ${ev.external_ref}`);
  return { displaced, allocationsWritten: 2, partial: false };
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
    conflicted: 0, displaced: 0, nearMissed: 0, conflicts: [],
  };

  const ctx = await loadContext(client, me);

  // Only rows not yet linked. A matched row is left alone: re-deciding a link on every run
  // would fight any correction a human has made to it.
  const pending = await client.query<EvidenceRow>(
    `SELECT id, external_ref, evidence_date::text, amount_paise, payload
       FROM evidence
      WHERE source_type = $1 AND transaction_id IS NULL
      ORDER BY evidence_date, id`,
    [SOURCE],
  );

  // The whole ledger, once. At this size (hundreds of rows) filtering in the pure matcher is
  // cheaper than a query per record, and it keeps the amount/date/direction rules in exactly
  // ONE place instead of half in SQL and half in TypeScript. Push the filter into SQL when
  // the ledger makes that necessary, not before.
  const candidates = await loadCandidates(client);

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
      // Nothing inside the accept window — but an exact amount just outside it is not
      // "no candidate", it is a question for a human. Counted separately so the two are
      // never conflated in a summary.
      if (nearMisses(request, candidates).length > 0) summary.nearMissed++;
      else summary.noCandidate++;
      continue;
    }

    const applied = await applyMatch(client, ev, outcome.transactionId, ctx);
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
  }

  return summary;
}

export type NearMissRow = {
  evidenceId: string;
  externalRef: string;
  description: string | null;
  evidenceDate: string;
  amountPaise: number;
  sourceCategory: string;
  candidates: NearMiss[];
};

/**
 * Records the matcher believes in on every axis it can measure, held back only by the date.
 *
 * Never auto-accepted, by design — see the note on DEFAULT_NEAR_DAYS. This is the queue where
 * a human supplies the one judgement the matcher structurally cannot: whether a bank narration
 * and a free-text description are the same event.
 */
export async function listNearMisses(client: PoolClient, me: string): Promise<NearMissRow[]> {
  const pending = await client.query<EvidenceRow & { description: string | null }>(
    `SELECT id, external_ref, description, evidence_date::text, amount_paise, payload
       FROM evidence
      WHERE source_type = $1 AND transaction_id IS NULL
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
    if (near.length === 0) continue;

    out.push({
      evidenceId: ev.id,
      externalRef: ev.external_ref,
      description: ev.description,
      evidenceDate: ev.evidence_date,
      amountPaise: Number(ev.amount_paise),
      sourceCategory: ev.payload.source_category,
      candidates: near,
    });
  }
  return out;
}

export type AcceptResult =
  | { ok: true; displaced: number; allocationsWritten: number; partial: boolean }
  | { ok: false; error: string };

/**
 * Accept one near miss: a human has decided this record and this transaction are the same
 * event. Goes through the SAME writer as an automatic match, so precedence still applies —
 * accepting may displace a rule's guess, and is still refused when a human authored the
 * allocation already. A human deciding the DATE is not a human overruling another human.
 */
export async function acceptNearMiss(
  client: PoolClient,
  evidenceId: string,
  transactionId: string,
  me: string,
): Promise<AcceptResult> {
  const found = await client.query<EvidenceRow & { transaction_id: string | null }>(
    `SELECT id, external_ref, evidence_date::text, amount_paise, payload, transaction_id
       FROM evidence WHERE id = $1 AND source_type = $2`,
    [evidenceId, SOURCE],
  );
  const ev = found.rows[0];
  if (ev === undefined) return { ok: false, error: "no such record" };
  // Not merely tidy: linking an already-linked record would write a second set of
  // allocations onto a different transaction and leave the first one explained by a record
  // that no longer points at it.
  if (ev.transaction_id !== null) return { ok: false, error: "this record is already linked" };

  const txn = await client.query("SELECT 1 FROM transactions WHERE id = $1", [transactionId]);
  if (txn.rowCount === 0) return { ok: false, error: "no such transaction" };

  const applied = await applyMatch(client, ev, transactionId, await loadContext(client, me));
  if (applied.conflict) return { ok: false, error: applied.conflict };
  return {
    ok: true,
    displaced: applied.displaced,
    allocationsWritten: applied.allocationsWritten,
    partial: applied.partial,
  };
}
