// Turning a confirmed invoice's LINES into allocations, and keeping them true afterwards.
//
// The mechanism: look each line's item up, group by category, sum, write one allocation per
// category with `source='evidence'`. And the other half, which is the harder
// one: **re-running is required, not optional.** Classify "rolled oats" today and every basket
// that already contains it has to update, or the catalogue's whole economic argument — file a
// product once, cover every future purchase — is only true going forwards.
//
// WHAT THIS DELIBERATELY DOES NOT DO.
//
// It never scales lines to fit the bank debit. An order's lines routinely sum to
// less than the transaction: post-order discounts, wallet part-payment, tips, packaging. Scaling
// them would fabricate per-item amounts that were never charged, and the itemisation is only
// worth having because it records what actually happened. The difference stays as the
// transaction's computed remainder, which is where uncertainty belongs.
//
// It never invents a category for an unclassified item. Such a line simply produces no
// allocation and its amount lands in the remainder — partial itemisation is a first-class
// outcome, so an 80%-classified basket yields 80% of its allocations
// and an honest gap. An "Uncategorised" bucket would be a fake explanation, and would make the
// one number this product exists to report quietly wrong.
//
// PRECEDENCE IS NOT REIMPLEMENTED HERE. `resolvePrecedence` already answers it, and answers it
// the way it was settled for Splitwise: a row a person authored directly is never displaced; a
// rule's guess, or one confirmed FROM a rule, is; another evidence record on the same
// transaction refuses both. A second copy of that decision is how two paths come to disagree
// about whose money it is.

import type { PoolClient } from "pg";

import { type ExistingAllocation, resolvePrecedence } from "./evidence-match.ts";
import { applyRules } from "./rules-apply.ts";

/** What one re-derivation did, so a route can say it rather than leaving it to be guessed. */
export type DeriveResult = {
  /** Orders whose allocations were rewritten. */
  orders: number;
  allocationsWritten: number;
  /** Orders left alone because a person's own allocation stood in the way. */
  refused: number;
  /**
   * Rule-made and rule-confirmed allocations this derivation DELETED.
   *
   * THE FIELD THE 2026-09-09 INCIDENT EXISTED FOR. A sweep displaced dozens of confirmed rows
   * worth a large sum and wrote a small fraction of it back in their place, and the dry run that
   * preceded it could not say so — it reported `conflicted: 2`, which was true and was not the
   * news. A preview that
   * cannot show what it would destroy is worse than no preview, because it is trusted.
   *
   * Counted and summed BEFORE the delete, which is the only moment the rows still exist.
   */
  displaced: number;
  /** What those displaced rows explained, in paise. A MAGNITUDE — sign carries no meaning here. */
  displacedPaise: number;
  /** What this order's categorised lines explain, in paise. Also a magnitude. */
  explainedPaise: number;
  /**
   * Orders that displaced MORE than they went on to explain.
   *
   * Until 2026-09-19 this was a refusal (see the note in `deriveForEvidence`). It is now a
   * reported fact: the cycle completes with a rules backfill, so trading down is temporary —
   * but it is still the shape of the incident, and a sweep that does it should have to say so.
   */
  tradedDown: number;
  /**
   * Rule allocations the backfill wrote over the remainder this derivation left behind.
   *
   * Zero from `deriveForEvidence` itself, which does not run the engine. Non-zero only from
   * `rederiveAndBackfill` and `rederiveForItems`, and it is the number that closes the loop:
   * `displaced` went out, `explainedPaise` came back as detail, and this is the rest.
   */
  backfilled: number;
};

type LineRow = { category_id: string | null; amount_paise: string };

/**
 * Rewrite one confirmed order's allocations from its stored lines.
 *
 * Idempotent by construction: it deletes this record's own `source='evidence'` rows first, so
 * running it twice writes the same thing once. That is the property that lets a category edit
 * re-run it over an order that already had allocations.
 */
export async function deriveForEvidence(
  client: PoolClient,
  evidenceId: string,
): Promise<DeriveResult> {
  const none: DeriveResult = {
    orders: 0,
    allocationsWritten: 0,
    refused: 0,
    displaced: 0,
    displacedPaise: 0,
    explainedPaise: 0,
    tradedDown: 0,
    backfilled: 0,
  };

  // The transactions this order is paid by. Read from `evidence_transactions` and NOT from the
  // allocations, because the whole case this feature exists for is an order that is matched and
  // allocates nothing — migration 010 says exactly that, and reading the pairing off allocations
  // would report such an order as unmatched.
  const linked = await client.query<{ transaction_id: string }>(
    "SELECT transaction_id FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId],
  );
  if (linked.rowCount === 0) return none;
  const transactionIds = linked.rows.map((r) => r.transaction_id);

  const existing = await client.query<ExistingAllocation>(
    `SELECT id, source, confirmed_from_rule_id
       FROM allocations
      WHERE transaction_id = ANY($1) AND (evidence_id IS DISTINCT FROM $2)`,
    [transactionIds, evidenceId],
  );
  const decision = resolvePrecedence(existing.rows, "auto");
  // Writing on top of what is already there DOUBLES the explained amount. A refusal means
  // leave the order alone entirely — it stays matched, explaining nothing, which is visible
  // and correctable, where a half-applied write is neither.
  if (decision.action === "conflict") return { ...none, refused: 1 };

  // WHAT THIS ORDER CAN ACTUALLY EXPLAIN, computed BEFORE anything is deleted.
  //
  // Only goods reach the catalogue, and only a CATEGORISED item produces money with a meaning.
  // A fee has no item by construction (see migration 016); an uncategorised item is the
  // ordinary early state and simply does not appear here.
  const lines = await client.query<LineRow>(
    `SELECT i.category_id, l.amount_paise
       FROM evidence_lines l
       JOIN items i ON i.id = l.item_id
      WHERE l.evidence_id = $1 AND l.kind = 'goods' AND i.category_id IS NOT NULL`,
    [evidenceId],
  );

  const wouldExplain = lines.rows.reduce((a, l) => a + Math.abs(Number(l.amount_paise)), 0);

  // WHAT THIS DISPLACES, MEASURED BEFORE IT IS DELETED.
  //
  // There used to be a REFUSAL here: if this order would explain less than it displaced, it
  // wrote nothing. That guard was added the day of the 32-row incident and removed on
  // 2026-09-19, because it was the wrong fix for what actually went wrong.
  //
  // What actually went wrong was that the CYCLE WAS INCOMPLETE, not that the precedence was
  // wrong. Two facts the guard was written without:
  //
  //   - a rules re-run never deletes an evidence allocation; every DELETE the engine issues
  //     carries `AND source = 'rule'`
  //   - the engine fills only the REMAINDER, and evidence rows already count against that
  //     budget
  //
  // So evidence and rules were always meant to COEXIST on one transaction rather than compete
  // for it. Displace, then backfill, and the transaction ends up explained more precisely than
  // the rule alone explained it — Rs 207 of milk plus Rs 1,312 of rule-guessed Groceries, in
  // place of Rs 1,519 of rule-guessed Groceries. The backfill is what makes that true, and it
  // is no longer anybody's job to remember: see `rederiveAndBackfill`.
  //
  // The measurement stays, because the preview still has to be able to say what it would take
  // away. Trading down is now REPORTED, not refused. Owner decision, 2026-09-19.
  let displaced = 0;
  let displacedPaise = 0;
  if (decision.action === "displace" && decision.allocationIds.length > 0) {
    const held = await client.query<{ total: string }>(
      "SELECT COALESCE(sum(abs(amount_paise)), 0)::text AS total FROM allocations WHERE id = ANY($1)",
      [decision.allocationIds],
    );
    displaced = decision.allocationIds.length;
    displacedPaise = Number(held.rows[0].total);
  }
  const measured = {
    displaced,
    displacedPaise,
    explainedPaise: wouldExplain,
    tradedDown: wouldExplain < displacedPaise ? 1 : 0,
    // `deriveForEvidence` does not run the engine. `rederiveAndBackfill` overwrites this.
    backfilled: 0,
  };

  await client.query(
    "DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'",
    [evidenceId],
  );
  if (decision.action === "displace" && decision.allocationIds.length > 0) {
    await client.query("DELETE FROM allocations WHERE id = ANY($1)", [decision.allocationIds]);
  }

  // Carries `measured` like every other exit past this point. An order with nothing
  // categorised still DELETED whatever stood on its transaction a few lines above, and
  // returning zeroes here is precisely how the incident stayed invisible: the case that
  // displaces everything and explains nothing was the case that reported nothing.
  if (lines.rowCount === 0) {
    return { orders: 1, allocationsWritten: 0, refused: 0, ...measured };
  }

  const byCategory = new Map<string, number>();
  for (const l of lines.rows) {
    const key = l.category_id as string;
    byCategory.set(key, (byCategory.get(key) ?? 0) + Math.abs(Number(l.amount_paise)));
  }

  const amounts = await client.query<{ id: string; amount_paise: string }>(
    "SELECT id, amount_paise FROM transactions WHERE id = ANY($1)",
    [transactionIds],
  );

  let written = 0;
  // SPLIT PER TRANSACTION FIRST, then by category — never the other way round. Splitting by
  // category and spreading each across the transactions let two roundings push one transaction
  // past its own amount, which is the bug the multi-transaction work ran into.
  // Draining a per-category remainder across transactions in turn cannot do that: a
  // transaction is filled to its capacity and no further.
  const remaining = new Map(byCategory);
  for (const t of amounts.rows) {
    // Never allocate more than a transaction holds: you cannot have spent more than left the
    // account, and a negative remainder is a number that cannot be true. The arithmetic runs on
    // MAGNITUDES so the capping reads plainly...
    let room = Math.abs(Number(t.amount_paise));
    if (room <= 0) continue;

    // ...and the written row carries the TRANSACTION'S OWN SIGN. An invoice is money leaving,
    // so its allocations are negative, exactly as every rule and Splitwise allocation in the
    // ledger already is. Writing magnitudes made each one read as INCOME: the amounts were
    // right and the direction was inverted, so they summed into no spend bar and the products
    // filed on the Products page appeared to have changed nothing.
    const sign = Number(t.amount_paise) < 0 ? -1 : 1;

    for (const categoryId of [...remaining.keys()]) {
      if (room <= 0) break;
      const left = remaining.get(categoryId) ?? 0;
      if (left <= 0) continue;
      const give = Math.min(left, room);
      await client.query(
        // `confidence` is NOT NULL and 1.00 is what every other evidence allocation carries:
        // this is a recorded fact from a document, not an estimate. A `note` says where the
        // number came from, since an evidence row on a transaction is otherwise unexplained.
        `INSERT INTO allocations
           (transaction_id, amount_paise, category_id, confidence, source, evidence_id, note)
         VALUES ($1, $2, $3, 1.00, 'evidence', $4, $5)`,
        [t.id, sign * give, categoryId, evidenceId, "from the order's line items"],
      );
      remaining.set(categoryId, left - give);
      room -= give;
      written += 1;
    }
  }

  // Anything still in `remaining` had no transaction capacity left to sit on. It is NOT an
  // error and NOT scaled away: the order genuinely cost more than the bank rows it is linked
  // to, and the gap is the transaction's computed remainder — which is exactly where an
  // unexplained difference belongs.

  return { orders: 1, allocationsWritten: written, refused: 0, ...measured };
}

/**
 * Derive one order's allocations and REFILL what that displaced. The whole cycle, in one call.
 *
 * The third fix after the 2026-09-09 incident, and the reason the first two are safe. Evidence
 * outranks a rule's guess, so landing an invoice on a transaction deletes the guess — and the
 * part of the bank row the invoice cannot speak for is then explained by nothing at all. On
 * 2026-09-09 that gap was a large confirmed sum, and it stayed open until somebody ran the
 * engine by hand.
 *
 * Nobody has to remember any more, and the two halves COMMIT TOGETHER: same client, same
 * transaction, so there is no window in which the displacement is durable and the refill is not.
 *
 * The transaction ids are read BEFORE deriving. `deriveForEvidence` does not change which
 * transactions an order is paid by — `evidence_transactions` is written by the matcher, not by
 * it — but reading first means that stays true by construction rather than by inspection.
 */
export async function rederiveAndBackfill(
  client: PoolClient,
  evidenceId: string,
): Promise<DeriveResult> {
  const transactionIds = await collectTransactionIds(client, evidenceId);
  const derived = await deriveForEvidence(client, evidenceId);
  return { ...derived, backfilled: await backfill(client, transactionIds) };
}

/**
 * Re-derive every confirmed order that contains any of these products.
 *
 * The reason `evidence_lines` exists. Called after a category is set, cleared, bulk-applied or
 * merged — anything that changes what a line MEANS without changing what was bought.
 *
 * ONE backfill at the end, over the union of every touched transaction, rather than one per
 * order. Two orders can be paid by the same bank row, and backfilling between them would run
 * the engine against a half-updated transaction — writing a rule allocation over a remainder
 * the second order is about to claim, which the second derivation then displaces again. Same
 * answer, twice the work, and a churned allocation id in the middle for no reason.
 */
export async function rederiveForItems(
  client: PoolClient,
  itemIds: number[],
): Promise<DeriveResult> {
  if (itemIds.length === 0) return emptyResult();

  const affected = await client.query<{ evidence_id: string }>(
    `SELECT DISTINCT evidence_id FROM evidence_lines WHERE item_id = ANY($1::bigint[])`,
    [itemIds],
  );

  const total = emptyResult();
  const touched = new Set<string>();
  for (const row of affected.rows) {
    for (const id of await collectTransactionIds(client, row.evidence_id)) {
      touched.add(id);
    }
    add(total, await deriveForEvidence(client, row.evidence_id));
  }
  total.backfilled = await backfill(client, [...touched]);
  return total;
}

/**
 * Refill the remainder on these transactions, and report how many rows that took.
 *
 * A thin wrapper over the engine, and thin on purpose — `applyRules` owns every invariant
 * (the scoped sweep, the user lock, the remainder that counts evidence rows against the same
 * budget). Reimplementing any of that here is how two writers come to disagree about what
 * "explained" means, which is the failure `src/spend.ts` opens by warning about.
 */
async function backfill(client: PoolClient, transactionIds: string[]): Promise<number> {
  if (transactionIds.length === 0) return 0;
  const result = await applyRules(client, null, transactionIds);
  return result.created;
}

/** A zero result. A literal per call site is how a new field gets forgotten in one of them. */
export function emptyResult(): DeriveResult {
  return {
    orders: 0,
    allocationsWritten: 0,
    refused: 0,
    displaced: 0,
    displacedPaise: 0,
    explainedPaise: 0,
    tradedDown: 0,
    backfilled: 0,
  };
}

/** Fold one derivation into a running total. Every field is additive, which is why it can be. */
export function add(total: DeriveResult, one: DeriveResult): void {
  total.orders += one.orders;
  total.allocationsWritten += one.allocationsWritten;
  total.refused += one.refused;
  total.displaced += one.displaced;
  total.displacedPaise += one.displacedPaise;
  total.explainedPaise += one.explainedPaise;
  total.tradedDown += one.tradedDown;
  total.backfilled += one.backfilled;
}

async function collectTransactionIds(
  client: PoolClient,
  evidenceId: string,
): Promise<string[]> {
  const linked = await client.query<{ transaction_id: string }>(
    "SELECT transaction_id FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId],
  );
  return linked.rows.map((r) => r.transaction_id);
}
