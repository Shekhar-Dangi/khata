// Turning a confirmed invoice's LINES into allocations, and keeping them true afterwards.
//
// the design: look each line's item up, group by category, sum, write one
// allocation per category with `source='evidence'`. And its other half, which is the harder
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
// allocation and its amount lands in the remainder — the design makes partial
// itemisation a first-class outcome, so an 80%-classified basket yields 80% of its allocations
// and an honest gap. An "Uncategorised" bucket would be a fake explanation, and would make the
// one number this product exists to report quietly wrong.
//
// PRECEDENCE IS NOT REIMPLEMENTED HERE. `resolvePrecedence` already answers it, and answers it
// the way the design settled: a row a person authored directly is never displaced; a
// rule's guess, or one confirmed FROM a rule, is; another evidence record on the same
// transaction refuses both. A second copy of that decision is how two paths come to disagree
// about whose money it is.

import type { PoolClient } from "pg";

import { type ExistingAllocation, resolvePrecedence } from "./evidence-match.ts";

/** What one re-derivation did, so a route can say it rather than leaving it to be guessed. */
export type DeriveResult = {
  /** Orders whose allocations were rewritten. */
  orders: number;
  allocationsWritten: number;
  /** Orders left alone because a person's own allocation stood in the way. */
  refused: number;
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
  const none: DeriveResult = { orders: 0, allocationsWritten: 0, refused: 0 };

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

  // NEVER TRADE AN EXPLANATION FOR A SMALLER ONE.
  //
  // Precedence says an evidence record outranks a rule's guess, and it does — a document beats
  // a pattern match. But that is only true when the document actually says something. An order
  // whose products are all uncategorised explains NOTHING, and displacing a confirmed rule
  // allocation with it converts explained money back into unexplained: the ledger gets strictly
  // worse and the removed row cannot be restored.
  //
  // Learned the expensive way on a real ledger: a sweep displaced 32 confirmed allocations
  // worth a large sum and wrote a fraction of it in their place, because 109 of 117 products had no
  // category yet. Outranking is not the same as improving.
  if (decision.action === "displace" && decision.allocationIds.length > 0) {
    const held = await client.query<{ total: string }>(
      "SELECT COALESCE(sum(abs(amount_paise)), 0)::text AS total FROM allocations WHERE id = ANY($1)",
      [decision.allocationIds],
    );
    if (wouldExplain < Number(held.rows[0].total)) {
      return { ...none, refused: 1 };
    }
  }

  await client.query(
    "DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'",
    [evidenceId],
  );
  if (decision.action === "displace" && decision.allocationIds.length > 0) {
    await client.query("DELETE FROM allocations WHERE id = ANY($1)", [decision.allocationIds]);
  }

  if (lines.rowCount === 0) return { orders: 1, allocationsWritten: 0, refused: 0 };

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
  // past its own amount, which is the bug the design records from the multi-transaction
  // work. Draining a per-category remainder across transactions in turn cannot do that: a
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
  // to, and the gap is the transaction's computed remainder — which is exactly where
  // the design says an unexplained difference belongs.

  return { orders: 1, allocationsWritten: written, refused: 0 };
}

/**
 * Re-derive every confirmed order that contains any of these products.
 *
 * The reason `evidence_lines` exists. Called after a category is set, cleared, bulk-applied or
 * merged — anything that changes what a line MEANS without changing what was bought.
 */
export async function rederiveForItems(
  client: PoolClient,
  itemIds: number[],
): Promise<DeriveResult> {
  if (itemIds.length === 0) return { orders: 0, allocationsWritten: 0, refused: 0 };

  const affected = await client.query<{ evidence_id: string }>(
    `SELECT DISTINCT evidence_id FROM evidence_lines WHERE item_id = ANY($1::bigint[])`,
    [itemIds],
  );

  const total: DeriveResult = { orders: 0, allocationsWritten: 0, refused: 0 };
  for (const row of affected.rows) {
    const one = await deriveForEvidence(client, row.evidence_id);
    total.orders += one.orders;
    total.allocationsWritten += one.allocationsWritten;
    total.refused += one.refused;
  }
  return total;
}
