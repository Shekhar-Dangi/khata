// Confirmed receipts, as a list you can work through — the same list Splitwise records have.
//
// THE INCONSISTENCY THIS CLOSES (owner report, 2026-09-19). Link a Splitwise record by hand and
// it moves to "Matched to your bank", visible, undoable. Confirm a receipt and it VANISHED: it
// was on the ledger, but nothing on the Sources page listed confirmed receipts, and an order
// with no bank row offered no way to attach one — only a re-match that might never succeed.
//
// So a confirmed receipt gets the SAME four states, the SAME record shape and the SAME routes
// as a Splitwise record, and the screen reuses the Splitwise panel and picker unchanged. The
// states are decided by the same shared functions — `matchToTransaction`, `nearMisses`,
// `resolvePrecedence`, `claimOn` — so the two lists cannot come to disagree about what "near"
// or "conflicted" means.
//
// Kept apart from evidence-detect.ts rather than folded into it: that module's arithmetic is a
// Splitwise split (shares, nets, a shared bucket), and a receipt has none of it. What a receipt
// writes is its LINE ITEMS — `rederiveAndBackfill` — so the writer differs and only the shape
// and the vocabulary are shared. the design: build each source concretely.

import type { PoolClient } from "pg";

import {
  type ExistingAllocation,
  type NearMiss,
  claimOn,
  matchToTransaction,
  nearMisses,
  resolvePrecedence,
} from "./evidence-match.ts";
import type {
  EvidenceRecord,
  ImportBatch,
  LinkResult,
  LinkedTransaction,
  RecordState,
  UnlinkResult,
} from "./evidence-detect.ts";
import { rederiveAndBackfill } from "./line-allocations.ts";
import { applyRules } from "./rules-apply.ts";
import { loadCandidates } from "./staging.ts";
import { dayGap } from "./transfers.ts";

/**
 * The one source that is NOT a receipt. Every other source_type in `evidence` is an order — a
 * parser's, or one the local model read under a slug — and belongs here. Mirrors SOURCE in
 * evidence-detect.ts.
 */
const SPLITWISE = "splitwise";

type Row = {
  id: string;
  source_type: string;
  external_ref: string | null;
  evidence_date: string | null;
  amount_paise: string;
  payload: { invoices?: { lines?: { kind?: string; description?: string }[] }[] } | null;
  created_at: Date | string;
  linked: {
    transactionId: string;
    txnDate: string;
    txnAmountPaise: number | string;
    narration: string | null;
    accountName: string | null;
  }[];
};

/** Is this evidence row a receipt? The routes dispatch on it. */
export async function isReceipt(client: PoolClient, evidenceId: string): Promise<boolean> {
  const r = await client.query(
    "SELECT 1 FROM evidence WHERE id = $1 AND source_type <> $2",
    [evidenceId, SPLITWISE],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * What was bought, in the words a person will recognise the order by.
 *
 * The stored description is "amazon order 404-…", which identifies nothing in a list of sixty.
 * The first thing on the order does — "Heritage Toned Milk + 2 more" — and it is already in the
 * payload, so nothing new is stored.
 */
function whatWasBought(row: Row): string {
  const goods = (row.payload?.invoices ?? [])
    .flatMap((i) => i.lines ?? [])
    .filter((l) => l.kind !== "fee" && typeof l.description === "string");
  if (goods.length === 0) return `${row.source_type} order ${row.external_ref ?? ""}`.trim();
  const first = (goods[0].description as string).split(/[|(\n]/)[0].trim().slice(0, 60);
  return goods.length === 1 ? first : `${first} + ${goods.length - 1} more`;
}

/**
 * Every confirmed receipt, in the state it is in now. Same contract as `listRecords`.
 *
 * Computed in one pass over the whole ledger, for the reason `listRecords` gives: the near-miss
 * rule lives in TypeScript, and splitting it across two languages is how a count and the list
 * under it start disagreeing. The route slices.
 */
export async function listReceiptRecords(
  client: PoolClient,
  filter: { source?: string; state?: RecordState } = {},
): Promise<EvidenceRecord[]> {
  const rows = await client.query<Row>(
    `SELECT ev.id, ev.source_type, ev.external_ref, ev.evidence_date::text,
            ev.amount_paise, ev.payload, ev.created_at,
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
      WHERE ev.source_type <> $1
        AND ($2::text IS NULL OR ev.source_type = $2)
      GROUP BY ev.id
      ORDER BY ev.evidence_date DESC NULLS LAST, ev.id DESC`,
    [SPLITWISE, filter.source ?? null],
  );

  const candidates = await loadCandidates(client);
  const byId = new Map(candidates.map((c) => [c.id, c]));

  // What already explains each transaction, once for the whole pass — the difference between
  // "nothing of this amount exists" and "it exists and you already explained it".
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
  const withClaims = (list: NearMiss[]): NearMiss[] =>
    list.map((m) => ({ ...m, claim: claimOn(claims.get(m.transactionId) ?? []) }));

  const out: EvidenceRecord[] = [];
  for (const ev of rows.rows) {
    // created_at arrives as a Date OBJECT (see lastImportedAt below) — `.slice` on it throws.
    // Only reached for an order whose invoice printed no date.
    const date = ev.evidence_date ?? new Date(ev.created_at).toISOString().slice(0, 10);
    // Stored NEGATIVE already: an order is money leaving.
    const expected = Number(ev.amount_paise);

    const linked: LinkedTransaction[] = ev.linked.map((l) => ({
      transactionId: l.transactionId,
      txnDate: l.txnDate,
      txnAmountPaise: Number(l.txnAmountPaise),
      narration: l.narration,
      accountName: l.accountName,
      dayGap: dayGap(l.txnDate, date),
    }));

    let state: RecordState = "matched";
    let offer: NearMiss[] = [];
    let conflict: string | null = null;

    if (linked.length === 0) {
      // The same question the confirm path asked, with the merchant as the hard filter it was
      // there — an Amazon order must not be offered a Swiggy debit of the same amount.
      const request = {
        externalRef: ev.external_ref ?? "",
        date,
        expectedPaise: expected,
        sourceType: ev.source_type,
      };
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

    out.push({
      evidenceId: ev.id,
      externalRef: ev.external_ref ?? "",
      description: whatWasBought(ev),
      evidenceDate: date,
      amountPaise: Number(ev.amount_paise),
      expectedPaise: expected,
      sourceCategory: "",
      group: ev.source_type,
      state,
      linked,
      candidates: offer,
      conflict,
      // A receipt's categories are PER LINE, filed on the Products page. There is no one
      // category for the order to pick, so the record-level picker never appears.
      categoryName: null,
      categoryId: null,
      canChoose: false,
      needsCategory: false,
    });
  }
  return out;
}

/** One entry per receipt source, in the shape the Splitwise imports already use. */
export async function listReceiptImports(client: PoolClient): Promise<ImportBatch[]> {
  const records = await listReceiptRecords(client);
  const bySource = new Map<string, EvidenceRecord[]>();
  for (const r of records) {
    const held = bySource.get(r.group);
    if (held === undefined) bySource.set(r.group, [r]);
    else held.push(r);
  }
  const last = await client.query<{ source_type: string; last: string }>(
    `SELECT source_type, MAX(created_at) AS last FROM evidence
      WHERE source_type <> $1 GROUP BY source_type`,
    [SPLITWISE],
  );
  // ISO, not String(): pg hands the aggregate back as a Date, and String(date) is
  // "Sat Sep 19 2026 …", which sorts as text in no useful order.
  const lastBy = new Map(last.rows.map((r) => [r.source_type, new Date(r.last).toISOString()]));

  return [...bySource.entries()].map(([source, mine]) => {
    const count = (state: RecordState) => mine.filter((r) => r.state === state).length;
    return {
      source,
      group: source,
      records: mine.length,
      matched: count("matched"),
      near: count("near"),
      conflicted: count("conflicted"),
      unmatched: count("unmatched"),
      // Every order expected cash of ours. Nothing is consumption-only here.
      noCashExpected: 0,
      lastImportedAt: lastBy.get(source) ?? "",
    };
  });
}

/**
 * Attach a receipt to the bank row — or rows — a PERSON picked.
 *
 * Replaces whatever it was attached to before, because the pick is the person's answer to
 * "which payment was this", and an answer replaces the previous one rather than adding to it.
 *
 * NEVER DELETES AN EXPLANATION YOU WROTE — and that is deliberately NOT the Splitwise rule.
 * A Splitwise link runs with a person's authority and may replace what they wrote, because it
 * always writes a split in its place. A receipt may write NOTHING: its line items explain only
 * the products already filed, and an order whose products are not filed yet explains Rs 0.
 * Found by scripts/check-receipt-link.ts on the real ledger (2026-09-19): re-attaching an Amazon
 * order with a person's authority deleted a hand-written explanation and put nothing
 * in its place — the exact shape of the 2026-09-09 incident. So the derive runs as `auto`: the
 * LINK records which payment it was, and a row you explained keeps your explanation. That is
 * the same state confirming already produces.
 *
 * BOTH SETS OF ROWS ARE REFILLED: the new ones by `rederiveAndBackfill`, and the ones this order
 * USED to be attached to by the engine — its line items just left them, and without a refill
 * that money would read as unexplained until someone ran the rules by hand. Same transaction as
 * the link, so there is no window in which the move is half done.
 */
export async function linkReceipt(
  client: PoolClient,
  evidenceId: string,
  transactionIds: string[],
): Promise<LinkResult> {
  if (!(await isReceipt(client, evidenceId))) return { ok: false, error: "no such receipt" };
  if (transactionIds.length === 0) return { ok: false, error: "no transaction selected" };

  // An order is money LEAVING. Refused here as well as filtered in the picker, because the
  // picker is a convenience and this is the write.
  const txns = await client.query<{ id: string; amount_paise: string }>(
    "SELECT id, amount_paise FROM transactions WHERE id = ANY($1::bigint[])",
    [transactionIds],
  );
  if (txns.rowCount !== new Set(transactionIds).size) {
    return { ok: false, error: "one of those bank rows does not exist" };
  }
  if (txns.rows.some((t) => Number(t.amount_paise) >= 0)) {
    return { ok: false, error: "an order is money leaving — pick debits, not credits" };
  }

  const before = await client.query<{ transaction_id: string }>(
    "SELECT transaction_id FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId],
  );
  const previous = before.rows.map((r) => r.transaction_id);

  await client.query("DELETE FROM evidence_transactions WHERE evidence_id = $1", [evidenceId]);
  for (const id of new Set(transactionIds)) {
    await client.query(
      "INSERT INTO evidence_transactions (evidence_id, transaction_id) VALUES ($1, $2)",
      [evidenceId, id],
    );
  }

  const derived = await rederiveAndBackfill(client, evidenceId);
  // Refused for one of two reasons, and they are opposite outcomes:
  //
  //   you explained that row yourself  the link STANDS and your explanation stays — a known
  //                                    payment, explained your way. Nothing to refuse.
  //   another ORDER already explains it  two orders cannot both claim one row's money. Rolled
  //                                    back by the route's transaction, with the way out.
  if (derived.refused > 0) {
    const other = await client.query(
      `SELECT 1 FROM allocations
        WHERE transaction_id = ANY($1::bigint[]) AND source = 'evidence'
          AND evidence_id <> $2
        LIMIT 1`,
      [transactionIds, evidenceId],
    );
    if ((other.rowCount ?? 0) > 0) {
      throw new ReceiptLinkRefused(
        "another order already explains that bank row — unlink it there first",
      );
    }
  }

  const freed = previous.filter((id) => !transactionIds.includes(id));
  const refilled = freed.length > 0 ? (await applyRules(client, null, freed)).created : 0;

  return {
    ok: true,
    displaced: derived.displaced,
    displacedAuthored: 0,
    backfilled: derived.backfilled + refilled,
    allocationsWritten: derived.allocationsWritten,
    partial: false,
    scaledDown: false,
  };
}

/** Thrown to roll the link back; the route turns it into a 409 with this message. */
export class ReceiptLinkRefused extends Error {}

/**
 * Take a receipt off its bank rows. The counterpart to `linkReceipt`.
 *
 * Removes the order's line-item allocations and REFILLS the rows it leaves from the rules, in
 * the same transaction — the backfill `unlinkEvidence` never had, which is why an unlinked
 * Splitwise record leaves its rows unexplained until `POST /rules/apply`.
 */
export async function unlinkReceipt(
  client: PoolClient,
  evidenceId: string,
): Promise<UnlinkResult> {
  if (!(await isReceipt(client, evidenceId))) return { ok: false, error: "no such record" };

  const links = await client.query<{ transaction_id: string }>(
    "DELETE FROM evidence_transactions WHERE evidence_id = $1 RETURNING transaction_id",
    [evidenceId],
  );
  if ((links.rowCount ?? 0) === 0) {
    return { ok: false, error: "this record is not linked to anything" };
  }
  const allocations = await client.query(
    "DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'",
    [evidenceId],
  );
  await applyRules(client, null, links.rows.map((r) => r.transaction_id));

  return {
    ok: true,
    transactionsUnlinked: links.rowCount ?? 0,
    allocationsRemoved: allocations.rowCount ?? 0,
  };
}
