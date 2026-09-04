// The DB half of evidence matching — the counterpart to src/evidence-match.ts, the same way
// src/detect.ts is the DB half of src/transfers.ts.
//
// Finds the bank transaction behind each unmatched Splitwise record and, where it finds one,
// writes the allocations that split it. Design in the design.

import type { PoolClient } from "pg";

import { type Candidate, expectedCash, matchToTransaction } from "./evidence-match.ts";

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
};

type EvidenceRow = {
  id: string;
  external_ref: string;
  evidence_date: string;
  amount_paise: string;
  payload: { kind: "expense" | "payment"; nets_paise: Record<string, number>; source_category: string };
};

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
  };

  const shared = await client.query<{ id: string }>(
    `SELECT c.id FROM categories c
       JOIN categories p ON p.id = c.parent_id
      WHERE c.name = 'Shared' AND p.name = 'Transfers' AND p.parent_id IS NULL`,
  );
  if (shared.rowCount === 0) throw new Error("category Transfers > Shared is missing (migration 005)");
  const sharedId = shared.rows[0].id;

  const map = new Map<string, string | null>(
    (await client.query<{ source_category: string; category_id: string | null }>(
      "SELECT source_category, category_id FROM source_category_map WHERE source_type = $1",
      [SOURCE],
    )).rows.map((r) => [r.source_category, r.category_id]),
  );

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
  const candidates = (await client.query<Candidate>(
    "SELECT id, txn_date::text, amount_paise, narration FROM transactions",
  )).rows.map((c) => ({ ...c, amount_paise: Number(c.amount_paise) }));

  for (const ev of pending.rows) {
    const netPaise = ev.payload.nets_paise[me] ?? 0;
    const costPaise = Number(ev.amount_paise);
    const expected = expectedCash(ev.payload.kind, costPaise, netPaise);

    // null means no cash of ours should have moved — an expense someone else paid for. Its
    // consumption is already recorded in the consumption table; there is nothing to find,
    // and searching anyway is how a coincidence becomes a match.
    if (expected === null) { summary.noCashExpected++; continue; }

    summary.considered++;
    const outcome = matchToTransaction(
      { externalRef: ev.external_ref, date: ev.evidence_date, expectedPaise: expected },
      candidates,
    );

    if (outcome.kind === "none") { summary.noCandidate++; continue; }
    if (outcome.kind === "ambiguous") { summary.ambiguous++; continue; }

    await client.query("UPDATE evidence SET transaction_id = $1 WHERE id = $2",
      [outcome.transactionId, ev.id]);
    summary.matched++;

    // Clear only what THIS evidence produced before, and only machine-made rows. A 'user'
    // allocation is a decision and re-running may never overwrite a decision — the same
    // scoped sweep the rules engine does with `AND source = 'rule'`.
    await client.query(
      "DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'", [ev.id]);

    // Confidence is 1.00 and that is a claim, not a shrug: an evidence allocation is not a
    // guess. The amounts come from a record of something that happened, and the link behind
    // it was an exact amount inside the date window with no competing candidate — anything
    // less certain was queued as ambiguous rather than written. A graded score here would be
    // the constant-0.8 disease from the design, carrying no information.
    if (ev.payload.kind === "payment") {
      // A settlement is entirely a transfer between people. None of it is consumption.
      await client.query(
        `INSERT INTO allocations (transaction_id, amount_paise, category_id, confidence, source, evidence_id, note)
         VALUES ($1, $2, $3, 1.00, 'evidence', $4, $5)`,
        [outcome.transactionId, expected, sharedId, ev.id, `splitwise settlement ${ev.external_ref}`],
      );
      summary.allocationsWritten++;
      continue;
    }

    // An expense we fronted splits in two: our consumption, and the part that was other
    // people's. They sum to the whole debit by construction — (cost - net) + net = cost —
    // so the transaction is left with no unexplained remainder.
    const ourShare = costPaise - netPaise;
    const categoryId = map.get(ev.payload.source_category) ?? null;

    await client.query(
      `INSERT INTO allocations (transaction_id, amount_paise, category_id, confidence, source, evidence_id, note)
       VALUES ($1, $2, $3, 1.00, 'evidence', $4, $5)`,
      [outcome.transactionId, -netPaise, sharedId, ev.id, `others' share of ${ev.external_ref}`],
    );
    summary.allocationsWritten++;

    if (categoryId === null) {
      // Unmapped or deliberately unmappable. Write the shared slice and STOP: our own share
      // stays in the transaction's unexplained remainder, which `allocations` computes rather
      // than stores. A visible remainder is the honest outcome — the alternative is inventing
      // a category, and the remainder is what will prompt the mapping to be filled in.
      summary.partiallyAllocated++;
      continue;
    }

    if (ourShare !== 0) {
      await client.query(
        `INSERT INTO allocations (transaction_id, amount_paise, category_id, confidence, source, evidence_id, note)
         VALUES ($1, $2, $3, 1.00, 'evidence', $4, $5)`,
        [outcome.transactionId, -ourShare, categoryId, ev.id, `our share of ${ev.external_ref}`],
      );
      summary.allocationsWritten++;
    }
  }

  return summary;
}
