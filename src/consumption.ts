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
// Columns: (consumed_on DATE, category_id BIGINT, amount_paise BIGINT).
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
    SELECT t.txn_date AS consumed_on, al.category_id, al.amount_paise
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
    SELECT con.consumed_on, con.category_id, con.amount_paise
      FROM consumption con
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
