// Linking an external record to the bank transaction that paid for it. Pure and DB-free.
//
// Design in the design. This is the THIRD instance of the same shape, after
// transfer detection and ahead of invoice matching: generate candidates, score them,
// auto-accept only an unambiguous 1:1, and queue everything else for a human.
//
// It is deliberately NOT a generalisation of transfer detection yet. the design
// says to extract a shared matcher once three real cases exist; this is the second built,
// and transfer detection's passes are tuned to its own evidence hierarchy (a 12-digit RRN
// is proof in a way an amount never is). Merging them now would be speculative.
//
// What makes THIS matcher different from transfer detection, and why it is weaker:
// transfers pair two rows of OUR OWN ledger, so a shared reference is decisive. Here one
// side is a Splitwise row whose description is free text a human typed ("Weekly groceries")
// and the other is a bank narration. They have no vocabulary in common. So the only strong
// signals are the AMOUNT and the DATE, which is precisely why ambiguity has to be queued
// rather than broken by a tiebreak.

import { dayGap } from "./transfers.ts";

/** A bank row a match could land on. Mirrors the columns the DB half selects. */
export type Candidate = {
  /** BIGINT from pg arrives as a string; kept as one so it is never silently narrowed. */
  id: string;
  txn_date: string;
  amount_paise: number;
  narration: string | null;
};

/** What we are looking for: an amount that should have moved, on or near a date. */
export type MatchRequest = {
  externalRef: string;
  /** The expense/settlement date from the source. */
  date: string;
  /**
   * SIGNED, from our account's point of view: negative means cash should have LEFT.
   * The sign is a hard filter, not a score — a debit can never satisfy a credit.
   */
  expectedPaise: number;
};

export type MatchOutcome =
  | { kind: "matched"; transactionId: string; dayGap: number }
  | { kind: "ambiguous"; transactionIds: string[] }
  | { kind: "none" };

/**
 * How far a bank row may sit from the source's date.
 *
 * MEASURED, on 30 real fronted expenses against a 516-row ledger (2026-09-04). The number is
 * not a feel:
 *
 *     window   unique   ambiguous   none
 *          1       10           0     20
 *        2-5       12           0     18     <- plateau
 *          7       13           2     15
 *         10       11           4     15
 *         21        8           7     15
 *
 * Two things that curve says. Widening past 7 days makes it WORSE, not merely slower: unique
 * matches FALL, because a second candidate wandering into the window converts a decided row
 * into an ambiguous one. And the 15 rows that match at no window are not a tuning problem —
 * no bank row of that amount exists anywhere in the ledger, which is its warning that
 * `paid = Cost` is a convention (a co-payment, another card, or cash all look like this).
 *
 * So 3 sits on the plateau with a day of slack: an expense entered the morning after dinner,
 * or a weekend payment posting on Monday, are both ordinary. Re-measure before changing it.
 */
export const DEFAULT_WINDOW_DAYS = 3;

/**
 * Find the bank transaction for one external record.
 *
 * Exact on amount. Not "close enough": an approximate amount match on money is how you
 * attach a receipt to the wrong payment, and the two would then be wrong together and look
 * consistent. Where a real tolerance is needed later (a tip added after the fact, a
 * partial payment) it belongs as an explicit, named case — not as a fuzzy threshold here.
 *
 * Returns `ambiguous` rather than picking the closest date when several rows qualify. Two
 * ₹500 payments on the same day are indistinguishable to this function, and a tiebreak
 * would be a coin flip recorded as a fact. the design's rule holds: never
 * silently guess on money.
 */
export function matchToTransaction(
  request: MatchRequest,
  candidates: Candidate[],
  windowDays = DEFAULT_WINDOW_DAYS,
): MatchOutcome {
  const hits = candidates.filter(
    (c) =>
      c.amount_paise === request.expectedPaise &&
      dayGap(c.txn_date, request.date) <= windowDays,
  );

  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous", transactionIds: hits.map((h) => h.id) };
  return { kind: "matched", transactionId: hits[0].id, dayGap: dayGap(hits[0].txn_date, request.date) };
}

/**
 * What cash we expect the bank to show for one source row, or null if none should exist.
 *
 * This is its decomposition turned into a number, and the three cases behave completely
 * differently:
 *
 *   expense, net > 0   we fronted the cash -> a DEBIT of the whole cost
 *   expense, net < 0   someone else paid   -> NOTHING. No bank row exists to find, and
 *                                             looking for one is how a coincidence becomes
 *                                             a match. This is the consumption case.
 *   expense, net = 0   not ours at all     -> nothing
 *   payment,  net > 0  we paid a settlement -> a DEBIT of that amount
 *   payment,  net < 0  we received one      -> a CREDIT of that amount
 *
 * `paid = cost` for the expense case is its convention, not an identity: a co-payment
 * appears in the export as a second payer with a negative net and is invisible. The
 * consequence is a missed match, never a wrong one, because the amount filter is exact.
 */
/** An allocation already sitting on the transaction we are about to explain. */
export type ExistingAllocation = {
  id: string;
  source: "rule" | "user" | "evidence";
  /** Set when a rule proposed this row and a human accepted it (migration 003). */
  confirmed_from_rule_id: string | null;
};

export type PrecedenceDecision =
  | { action: "write" }
  | { action: "displace"; allocationIds: string[] }
  | { action: "conflict"; reason: string; allocationIds: string[] };

/**
 * May an evidence-derived split replace what is already on this transaction?
 *
 * The bug this exists to prevent: writing an evidence split on top of an existing allocation
 * DOUBLES the explained amount. A Rs 250 debit already carrying `Groceries = -250` plus a
 * receipt's `Shared = -166.67, Bills = -83.33` sums to Rs 500 against a Rs 250 transaction.
 *
 * Three tiers, all read from columns that already exist:
 *
 *   1. user, authored directly    a deliberate human decision      NEVER displaced
 *   2. evidence                   a record of what happened
 *   3. rule, or user ACCEPTED FROM a rule                          displaced by evidence
 *
 * Tier 3 is the important one. `source = 'user'` conflates two very different things: 254
 * rows accepted in one bulk action, and 15 authored one at a time. Migration 003 already
 * preserved the difference in `confirmed_from_rule_id` — it was simply never read for
 * AUTHORITY. Nodding at a rule's guess in bulk is weaker evidence than an order receipt;
 * deciding a row yourself is not.
 *
 * So tier 1 keeps the invariant from the design — a deliberate human
 * decision is never overwritten by a machine — while a bulk-confirmed guess gives way to a
 * record of what actually happened. A conflict is surfaced, never silently resolved.
 *
 * Allocations belonging to THIS evidence row must be filtered out by the caller; they are
 * our own previous run and are replaced, not competed with.
 */
export function resolvePrecedence(existing: ExistingAllocation[]): PrecedenceDecision {
  if (existing.length === 0) return { action: "write" };

  const authored = existing.filter(
    (a) => a.source === "user" && a.confirmed_from_rule_id === null,
  );
  if (authored.length > 0) {
    return {
      action: "conflict",
      reason: "a human authored this allocation directly",
      allocationIds: authored.map((a) => a.id),
    };
  }

  // A second evidence record claiming the same transaction is the one-debit-many-orders case
  // that the design says to queue. Neither record outranks the other, and picking
  // one would be a guess.
  const otherEvidence = existing.filter((a) => a.source === "evidence");
  if (otherEvidence.length > 0) {
    return {
      action: "conflict",
      reason: "another external record already explains this transaction",
      allocationIds: otherEvidence.map((a) => a.id),
    };
  }

  return { action: "displace", allocationIds: existing.map((a) => a.id) };
}

export function expectedCash(
  kind: "expense" | "payment",
  costPaise: number,
  netPaise: number,
): number | null {
  if (kind === "payment") {
    // A settlement's cash IS the net: positive means we handed money over.
    return netPaise === 0 ? null : -netPaise;
  }
  // An expense we did not front leaves no trace in our account.
  if (netPaise <= 0) return null;
  return -costPaise;
}
