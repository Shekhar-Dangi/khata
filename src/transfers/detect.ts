import type { PoolClient } from "pg";

import { findReferencePartner, indexByReference, type Leg } from "./transfers.ts";

// ── Internal-transfer detection ─────────────────────────────────────────────
//
// THREE passes, strongest evidence first, because the three kinds of evidence deserve
// three different verdicts.
//
//  1. REFERENCE — both legs quote the same 12-digit UPI reference (RRN). This is the
//     bank's own idea that the two rows are one payment, so it auto-resolves with no
//     human in the loop. It also needs nothing set up, which is what makes it the pass
//     that actually fires on a fresh install.
//  2. KEYWORD — the leg's narration names another account of yours (its account number or
//     UPI handle). That plus a matching opposite leg auto-resolves too, but it is dead
//     until somebody fills in `account_keywords`.
//  3. AMOUNT + DATE — no identifier at all, only "a debit here and a credit of exactly
//     the same size over there, a day or two apart". That is a PROPOSAL, never a verdict:
//     written as `suspected`, still counted as spending, waiting for the user.
//
// The order is not cosmetic — it is the whole safety argument. Each pass claims legs
// before the weaker ones see them, so a pair the bank itself identified can never be
// taken first by a coincidence of amount and date.
//
// v1 shipped only pass 2, and pass 2 does nothing until `account_keywords` has rows —
// which, on a fresh install, it never does. Detection silently found zero transfers and
// every rupee moved between your own accounts was counted as spending on BOTH
// legs — a large share of the reported "money out" on real statements.
//
// A rejected proposal has to be REMEMBERED or the next run proposes it again, which is
// why 'rejected' is a state rather than a return to NULL.
const TRANSFER_WINDOW_DAYS = 2;

export type DetectionCounts = {
  resolved: number;
  pending: number;
  suspected: number;
  by_reference: number;
  by_keyword: number;
};

const noCounts = (): DetectionCounts => ({
  resolved: 0,
  pending: 0,
  suspected: 0,
  by_reference: 0,
  by_keyword: 0,
});

// Both legs of a proposal/pair share a `transfer_group_id`. `suspected` + a group means
// "we think these two go together"; `resolved` + a group means "they do".
async function nextTransferGroup(client: PoolClient): Promise<string> {
  const r = await client.query("SELECT nextval('transfer_group_seq') AS g");
  return r.rows[0].g;
}

// Does a HUMAN already have an opinion about either leg?
//
// The same lock the rules engine takes, for the same reason. A `source='user'` allocation
// means somebody looked at this row and called it spending; auto-resolving it as a
// transfer would delete that claim from every total without asking. The pair still gets
// PROPOSED — it may well be a transfer they explained by hand before detection improved —
// but the machine does not get to decide it.
async function anyUserAllocation(
  client: PoolClient,
  ids: string[],
): Promise<boolean> {
  const r = await client.query(
    "SELECT 1 FROM allocations WHERE transaction_id = ANY($1) AND source = 'user' LIMIT 1",
    [ids],
  );
  return r.rowCount !== 0;
}

async function linkLegs(
  client: PoolClient,
  groupId: string,
  status: "resolved" | "suspected",
  evidence: string,
  legId: string,
  legAccountId: number,
  partnerId: string,
  partnerAccountId: number,
) {
  // Resolving takes both legs OUT of EXPLAINABLE_SPEND, which is the set the rules engine
  // sweeps. Any `source='rule'` allocation left on them becomes uncollectable — the
  // engine will never look at that row again, so its own converging sweep can never
  // remove the guess it made. Sweep it here, with the same `source = 'rule'` scope every
  // other sweep in this file carries. (User rows are unreachable: an auto-resolve never
  // gets this far on a transaction a human has explained — see anyUserAllocation.)
  if (status === "resolved") {
    await client.query(
      `DELETE FROM allocations
        WHERE transaction_id = ANY($1) AND source = 'rule'`,
      [[legId, partnerId]],
    );
  }
  await client.query(
    `UPDATE transactions SET transfer_status = $1, transfer_group_id = $2,
            counterparty_account_id = $3, transfer_evidence = $4 WHERE id = $5`,
    [status, groupId, partnerAccountId, evidence, legId],
  );
  await client.query(
    `UPDATE transactions SET transfer_status = $1, transfer_group_id = $2,
            counterparty_account_id = $3, transfer_evidence = $4 WHERE id = $5`,
    [status, groupId, legAccountId, evidence, partnerId],
  );
}

// Take a leg (and anything else in its group) back to "never looked at".
//
// A stronger pass is allowed to overrule a weaker one's PROPOSAL — that is the point of
// running them in order — but it must first release the proposal's other leg, or that
// leg is left `suspected` pointing at a partner that has since been claimed by someone
// else. Only `suspected` and `pending` are releasable: `resolved` is a decision already
// made, and `rejected` is the user's own answer. Neither gets overwritten by a machine.
async function releaseProposal(client: PoolClient, legId: string): Promise<void> {
  const row = (
    await client.query(
      `SELECT transfer_status, transfer_group_id FROM transactions
        WHERE id = $1 FOR UPDATE`,
      [legId],
    )
  ).rows[0];
  if (row === undefined) return;
  if (row.transfer_status !== "suspected" && row.transfer_status !== "pending") return;

  const clear = `SET transfer_status = NULL, transfer_group_id = NULL,
                     counterparty_account_id = NULL, transfer_evidence = NULL`;
  // `WHERE transfer_group_id = NULL` matches nothing in SQL, so a group-less leg (an
  // unpaired `pending`) has to be updated as itself.
  if (row.transfer_group_id === null) {
    await client.query(`UPDATE transactions ${clear} WHERE id = $1`, [legId]);
  } else {
    await client.query(`UPDATE transactions ${clear} WHERE transfer_group_id = $1`, [
      row.transfer_group_id,
    ]);
  }
}

// Rows a pass is still allowed to touch: never `resolved` (already decided), never
// `rejected` (the user decided). Everything else is fair game for a stronger signal.
const OPEN_LEG = `transfer_status IS DISTINCT FROM 'resolved'
              AND transfer_status IS DISTINCT FROM 'rejected'`;

// ── pass 1: shared UPI reference ────────────────────────────────────────────
//
// The index is built over the WHOLE open ledger, not just this account, because the
// partner is by definition somewhere else. It is rebuilt per account run, which is one
// extra query per account and keeps the function free of cross-call state.
async function referencePass(
  client: PoolClient,
  accountId: number,
  claimed: Set<string>,
): Promise<DetectionCounts> {
  const counts = noCounts();

  const openRows: Leg[] = (
    await client.query(
      `SELECT id, account_id, amount_paise, txn_date, narration
         FROM transactions
        WHERE narration IS NOT NULL AND type <> 'opening_balance' AND ${OPEN_LEG}
        ORDER BY id`,
    )
  ).rows.map((r) => ({
    id: String(r.id),
    account_id: Number(r.account_id),
    amount_paise: Number(r.amount_paise), // BIGINT arrives as a string
    txn_date: r.txn_date,
    narration: r.narration,
  }));

  const index = indexByReference(openRows);
  // Only this account's legs, and only DEBITS — one link per pair, not one per leg. The
  // credit side is what findReferencePartner returns.
  const legs = openRows.filter(
    (r) => r.account_id === accountId && r.amount_paise < 0,
  );

  for (const leg of legs) {
    if (claimed.has(leg.id)) continue;
    const match = findReferencePartner(leg, index, TRANSFER_WINDOW_DAYS);
    if (match === null) continue;
    if (claimed.has(match.partner.id)) continue;

    // A weaker pass, or an earlier run, may already have PROPOSED one of these legs to
    // somebody else. Take both proposals apart before making the stronger claim.
    await releaseProposal(client, leg.id);
    await releaseProposal(client, match.partner.id);

    // Strong evidence still does not outrank a person. If either leg carries a hand
    // written explanation, this becomes a proposal rather than a verdict.
    const locked = await anyUserAllocation(client, [leg.id, match.partner.id]);
    const status = locked ? "suspected" : "resolved";
    const groupId = await nextTransferGroup(client);
    await linkLegs(
      client,
      groupId,
      status,
      `reference:${match.reference}`,
      leg.id,
      leg.account_id,
      match.partner.id,
      match.partner.account_id,
    );
    claimed.add(leg.id);
    claimed.add(match.partner.id);
    if (status === "resolved") {
      counts.resolved++;
      counts.by_reference++;
    } else {
      counts.suspected++;
    }
  }

  return counts;
}

// ── pass 2: strong identifier in the narration ──────────────────────────────
async function keywordPass(
  client: PoolClient,
  accountId: number,
  claimed: Set<string>,
): Promise<DetectionCounts> {
  const counts = noCounts();

  // Re-evaluate anything not already settled. A `suspected` leg is included on purpose:
  // adding the keyword that was missing should be able to UPGRADE a guess to a fact.
  const legs = (
    await client.query(
      `SELECT id, account_id, amount_paise, txn_date, narration
         FROM transactions
        WHERE account_id = $1 AND narration IS NOT NULL AND ${OPEN_LEG}
        ORDER BY id
        FOR UPDATE`,
      [accountId],
    )
  ).rows;

  // STRONG identifiers of your OTHER accounts, lowercased once so the narration scan is
  // a cheap case-insensitive substring check. A `name` keyword is weak by design and is
  // not on its own enough to move money out of the spend column.
  const keywords = (
    await client.query(
      `SELECT account_id, lower(keyword) AS keyword
         FROM account_keywords
        WHERE account_id <> $1 AND kind IN ('account_number', 'upi_handle')`,
      [accountId],
    )
  ).rows;
  if (keywords.length === 0) return counts;

  for (const leg of legs) {
    if (claimed.has(String(leg.id))) continue;
    const narration = String(leg.narration).toLowerCase();
    const match = keywords.find((k) => narration.includes(k.keyword));
    if (match === undefined) continue; // no strong signal — pass 3 may still propose one
    const counterpartyId = Number(match.account_id);

    const partners = (
      await client.query(
        `SELECT id FROM transactions
          WHERE account_id = $1 AND amount_paise = $2
            AND txn_date BETWEEN $3::date - $4::int AND $3::date + $4::int
            AND ${OPEN_LEG}
          ORDER BY abs($3::date - txn_date), id`,
        [counterpartyId, -Number(leg.amount_paise), leg.txn_date, TRANSFER_WINDOW_DAYS],
      )
    ).rows.filter((p) => !claimed.has(String(p.id)));

    if (partners.length === 0) {
      // Strong identifier, no partner yet (the other sheet is not imported) → pending.
      // Deliberately still inside spend: an unpaired leg is one real debit until the
      // other half shows up to cancel it.
      await client.query(
        `UPDATE transactions SET transfer_status = 'pending',
           counterparty_account_id = $1, transfer_evidence = $2 WHERE id = $3`,
        [counterpartyId, `keyword:${match.keyword}`, leg.id],
      );
      counts.pending++;
      continue;
    }

    // ORDER BY put the closest date first with id breaking the tie, so the choice is a
    // function of the data rather than of whatever order the plan returned rows in —
    // the same reason chooseWinner ends in `id ASC`.
    const partner = partners[0];
    // Exactly one candidate → auto-resolve. More than one → we took the nearest, but
    // "nearest" is a guess, so it goes to the user as a proposal instead of a verdict.
    // A hand-written explanation on either leg also demotes this to a proposal.
    const locked = await anyUserAllocation(client, [String(leg.id), String(partner.id)]);
    const status = partners.length === 1 && !locked ? "resolved" : "suspected";
    await releaseProposal(client, String(leg.id));
    await releaseProposal(client, String(partner.id));
    const groupId = await nextTransferGroup(client);
    await linkLegs(
      client,
      groupId,
      status,
      `keyword:${match.keyword}`,
      leg.id,
      Number(leg.account_id),
      partner.id,
      counterpartyId,
    );
    claimed.add(String(leg.id));
    claimed.add(String(partner.id));
    if (status === "resolved") {
      counts.resolved++;
      counts.by_keyword++;
    } else {
      counts.suspected++;
    }
  }

  return counts;
}

// ── pass 3: amount and date only ────────────────────────────────────────────
async function amountDatePass(
  client: PoolClient,
  accountId: number,
  claimed: Set<string>,
): Promise<DetectionCounts> {
  const counts = noCounts();

  // Only legs nobody has looked at yet (`transfer_status IS NULL`), and only DEBITS —
  // one proposal per pair, not one per leg. The credit side is what the search finds.
  const legs = (
    await client.query(
      `SELECT id, account_id, amount_paise, txn_date
         FROM transactions
        WHERE account_id = $1 AND transfer_status IS NULL AND amount_paise < 0
          AND type <> 'opening_balance'
        ORDER BY id
        FOR UPDATE`,
      [accountId],
    )
  ).rows;

  for (const leg of legs) {
    if (claimed.has(String(leg.id))) continue;
    const candidates = (
      await client.query(
        `SELECT id, account_id FROM transactions
          WHERE account_id <> $1 AND amount_paise = $2
            AND txn_date BETWEEN $3::date - $4::int AND $3::date + $4::int
            AND transfer_status IS NULL
            AND type <> 'opening_balance'
          ORDER BY abs($3::date - txn_date), id`,
        [accountId, -Number(leg.amount_paise), leg.txn_date, TRANSFER_WINDOW_DAYS],
      )
    ).rows.filter((c) => !claimed.has(String(c.id)));

    if (candidates.length === 0) continue;
    const partner = candidates[0];
    const groupId = await nextTransferGroup(client);
    await linkLegs(
      client,
      groupId,
      "suspected",
      "amount+date",
      leg.id,
      Number(leg.account_id),
      partner.id,
      Number(partner.account_id),
    );
    claimed.add(String(leg.id));
    claimed.add(String(partner.id));
    counts.suspected++;
  }

  return counts;
}

// Run the passes IN ORDER across every account, then the next pass across every account.
//
// Not account-by-account-through-all-three. A reference pair between accounts 1 and 3 is
// found while processing account 1, but if account 1 ran its amount+date pass before
// account 3 ran its reference pass, a coincidence on account 1 could claim the very leg
// account 3 was about to match on the bank's own reference number. Stage order is what
// makes "strongest evidence first" true of the whole ledger rather than of one account.
const PASSES = [referencePass, keywordPass, amountDatePass];

export async function detectTransfers(
  client: PoolClient,
  accountIds: number[],
  claimed: Set<string>,
): Promise<DetectionCounts> {
  const totals = noCounts();
  for (const pass of PASSES) {
    for (const accountId of accountIds) {
      const counts = await pass(client, accountId, claimed);
      totals.resolved += counts.resolved;
      totals.pending += counts.pending;
      totals.suspected += counts.suspected;
      totals.by_reference += counts.by_reference;
      totals.by_keyword += counts.by_keyword;
    }
  }
  return totals;
}

