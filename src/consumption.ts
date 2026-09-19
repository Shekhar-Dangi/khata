import { EXPLAINABLE_SPEND } from "./spend.ts";

// What counts as CONSUMPTION — the one definition, the way EXPLAINABLE_SPEND is the one
// definition of spend. Design in the design.
//
// Spend and consumption answer different questions and are allowed to disagree:
//
//   spend        what left my account          bank + allocations
//   consumption  what I actually used          allocations + things others paid for
//
// A shared bill you paid for three people is 4,000 of spend and 2,000 of consumption. A
// bill a flatmate paid for you is 0 of spend and 1,500 of consumption — no transaction
// exists for it at all. In the verified export, 43 of 93 expenses were that second kind,
// so this is about half the shared data rather than an edge case.
//
// It is a UNION of two sources, and that is exactly why it lives in one string in one
// module you have to import. src/spend.ts already makes the argument and it applies here
// with more force, because a union is easier to half-remember than a predicate:
// "Two copies of a definition drift, and then the headline metric and the engine quietly
// disagree about what they are talking about."
//
// Columns: (consumed_on DATE, category_id BIGINT, amount_paise BIGINT,
//           account_id BIGINT, kind TEXT, transaction_id BIGINT, evidence_id BIGINT, detail TEXT).
//
// The last five exist so the SAME definition answers both "how much" and "which entries" —
// the totals on the Consumed view and the rows you drill into beneath them. A second query
// for the rows would be a second definition, and a total that disagrees with the list under it
// is the bug this module exists to prevent. `kind` is 'bank' (arm 1) or 'paid_for_you' (arm 2);
// arm 2 has no account, because no account of yours was involved.
//
// SIGN: amount_paise stays signed exactly as the ledger stores it — negative is money
// consumed. Both arms already use that convention, so the union needs no negation and no
// caller has to remember which half is which. Present it positively at the edge, not here.
export const CONSUMPTION_ROWS = `
    -- 1. Consumption you PAID FOR, already sliced as allocations.
    --    excluded_from_spend removes the shared bucket: the part of a bill you fronted
    --    for other people is money that moved, and is not something you consumed. That
    --    flag is why this is a join on categories rather than a hardcoded category name —
    --    a name matched in code is the "debit" lexical trap.
    SELECT t.txn_date AS consumed_on, al.category_id, al.amount_paise,
           t.account_id, 'bank'::text AS kind, t.id AS transaction_id,
           NULL::bigint AS evidence_id, t.narration AS detail
      FROM allocations al
      JOIN transactions t   ON t.id = al.transaction_id
      JOIN categories cat   ON cat.id = al.category_id
      LEFT JOIN categories par ON par.id = cat.parent_id
     -- The flag counts on the category OR ITS PARENT. Allocations point at leaves
     -- (Income > Salary, Transfers > Shared), so checking only the leaf would mean
     -- flagging a parent did nothing, and every child added later would have to be
     -- remembered separately. Flagging the parent covers the subtree, now and in future.
     WHERE NOT cat.excluded_from_spend
       AND NOT COALESCE(par.excluded_from_spend, false)
       AND ${EXPLAINABLE_SPEND}

    UNION ALL

    -- 2. Consumption SOMEONE ELSE paid for. No transaction exists, which is the whole
    --    reason this table is separate from allocations — see the migration comment in
    --    005_consumption.sql for why a nullable allocations.transaction_id was rejected.
    SELECT con.consumed_on, con.category_id, con.amount_paise,
           NULL::bigint AS account_id, 'paid_for_you'::text AS kind, NULL::bigint AS transaction_id,
           con.evidence_id, ev.description AS detail
      FROM consumption con
      LEFT JOIN evidence ev ON ev.id = con.evidence_id
`;

// Why there is no double counting, stated as an invariant worth testing rather than a
// comment worth trusting:
//
// An expense you paid for contributes through arm 1 ONLY — it has allocations, and no
// consumption row is ever written for it. An expense someone else paid for contributes
// through arm 2 ONLY — it has no transaction, so it cannot appear in arm 1.
//
// The useful consequence: the figure does not move when a match happens. Before the
// statement is imported, an expense you paid for contributes 0 (no transaction, no
// allocation, no consumption row); after import and matching it contributes its share via
// allocations. What must never happen is a consumption row being written for an expense
// you paid for as a stopgap while it waits to match — that row would survive the match and
// the amount would then be counted twice.


/**
 * The terms that walk "money out" to "consumed", one line each on the Consumed view.
 *
 * WHY A FORMULA AND NOT A SECOND TABLE (owner, 2026-09-19). The page used to show spending by
 * category and, underneath, consumption by category — same categories, different money, and
 * nothing saying how one became the other. Every term here is a different money, named:
 *
 *   money_out      what left your accounts — the same figure as the "Money out" tile
 *   unexplained    of that, what has no category yet. Cannot be "consumed as" anything
 *   fronted        of that, what you paid for OTHER people or moved around (Transfers,
 *                  Shared, Income — every category flagged excluded_from_spend)
 *   paid_for_you   what flatmates paid for you. Never on your statement
 *   received       credits filed under a spending category, which count AGAINST consumption —
 *                  a refund, or money received that was filed where spending goes. Shown on
 *                  its own line so it is never silent: a sizeable credit filed under a spending category sat in the
 *                  old total unannounced
 *   consumed       the result
 *
 * All paise, all magnitudes (positive).
 */
export type ConsumptionTerms = {
  money_out_paise: number;
  unexplained_paise: number;
  fronted_paise: number;
  paid_for_you_paise: number;
  received_paise: number;
  consumed_paise: number;
};

/**
 * What the terms fail to account for — zero when the formula on screen adds up.
 *
 * Every term is computed from the ledger INDEPENDENTLY rather than one being derived as the
 * balancing figure, because a balancing figure would make the formula add up by construction
 * and hide exactly the mistake it exists to expose. A non-zero answer is shown, not rounded
 * away.
 */
export function unaccounted(t: ConsumptionTerms): number {
  return (
    t.consumed_paise -
    (t.money_out_paise - t.unexplained_paise - t.fronted_paise + t.paid_for_you_paise - t.received_paise)
  );
}
