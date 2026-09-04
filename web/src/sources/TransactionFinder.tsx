import { Fragment, useMemo, useState } from "react";

import Pager from "../shared/Pager";
import { useBusy, useDebounced, useFetch } from "../shared/useFetch";
import { rupees } from "../shared/format";
import CategoryChoice from "./CategoryChoice";
import { daysApart, type Claim, type EvidenceRecord, type NearMissCandidate } from "./sources";

// Finding the bank rows a record went out as.
//
// A TABLE, with the same columns and the same header treatment as every other list of
// transactions in this app. It was a stack of flex rows, which meant the account name and the
// amount landed at a different x on every line — the narration pushed them along — so the one
// screen whose whole job is comparing rows was the one screen where rows did not line up.
//
// TWO further things were wrong with the list, and they were the same mistake twice: it was
// anchored to NOW rather than to the record.
//
//   - It asked for the 25 most recent transactions. For a record dated 11 August that is 25
//     rows from the last week of the ledger — a list whose first page structurally cannot
//     contain the answer, offered as if it might.
//   - It offered credits for a debit. `matchToTransaction` treats the sign as a hard filter
//     (a credit can never satisfy a debit), so the automatic path and the manual one were
//     working from different rules about what is even possible.
//
// So: a window AROUND the record's date, ordered by how close each row is to it, in the
// direction the money must have gone, widened by a control rather than by scrolling. ±10 days
// is not a guess — it is DEFAULT_NEAR_DAYS, the range the matcher itself already considers
// plausible, so the manual path starts where the automatic one gave up.
//
// The interaction is a RUNNING TOTAL AGAINST A TARGET, which is what makes the two hard cases
// tractable without a rule for either:
//
//   Rs 6,000 entered, paid as Rs 1,000 + Rs 5,000  -> tick both, gap reaches zero
//   Rs 2,745 paid but Rs 2,700 entered             -> tick one, a Rs 45 gap remains
//
// The gap NEVER blocks. It is information: an over-selection leaves the difference as the
// transaction's unexplained remainder, and an under-selection scales the split down. Both are
// stated on screen before the button is pressed.

type Txn = {
  id: string;
  txn_date: string;
  amount_paise: number;
  narration: string | null;
  account_name?: string;
  /** Present from /transactions; absent on a row rebuilt from a near-miss candidate. */
  allocations?: { source: "user" | "rule" | "evidence"; confirmed_from_rule_id: number | null }[];
  /** The server's answer for a suggested candidate, whose allocations were never fetched. */
  claim?: Claim;
};

/**
 * What linking would do to a transaction that is already explained.
 *
 * The same answer `claimOn` gives on the server — derived there from `resolvePrecedence` —
 * said before the button is pressed rather than after. This screen learned it the hard way:
 * a link silently deleted a row, the undo put the LINK back but not the deleted allocation,
 * and the ledger's unexplained total moved by an amount nothing on screen had mentioned.
 *
 * tier 1 — a person authored it directly. A MANUAL link may remove it, and that removal is
 *          the one no undo restores: the warning has to be earned, not assumed.
 * tier 2 — another record's evidence. Refused even for a person; unlink that record first.
 * tier 3 — a rule authored it, or a person accepted a rule's guess. Displaced, and DELETED:
 *          undo does not bring it back, only re-running the rules does.
 */
function claimOf(t: Txn): Claim {
  if (t.allocations !== undefined) {
    // EVIDENCE FIRST: it outranks tier 1 under the manual authority too — the server turns
    // back for another record whoever is asking, and promising a link that will 409 is the
    // one thing this warning must never do.
    if (t.allocations.some((a) => a.source === "evidence")) return "refused";
    if (t.allocations.some((a) => a.source === "user" && a.confirmed_from_rule_id === null))
      return "yours";
    return t.allocations.length > 0 ? "replaces" : "free";
  }
  // A suggested candidate carries the server's own answer; it never fetched the allocations
  // to compute one here.
  return t.claim ?? "free";
}

/** Rows per page. Small on purpose — the whole panel opens inside a table row. */
const PAGE = 8;

/**
 * How far either side of the record to look.
 *
 * 10 is `DEFAULT_NEAR_DAYS` from src/evidence-match.ts. The other two are escape hatches for
 * the case this screen exists to serve: an expense entered weeks after it happened.
 */
const WINDOWS = [
  { days: 10, label: "±10 days" },
  { days: 30, label: "±30 days" },
  { days: 0, label: "Any date" },
];

/** `iso` shifted by `days`, in UTC — the local constructor moves the day either side of GMT. */
function shift(iso: string, days: number): string {
  const at = new Date(`${iso}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export default function TransactionFinder({
  record,
  anchorDate,
  expectedPaise,
  suggested,
  busy,
  error,
  onLink,
  onCancel,
}: {
  /** The record being matched, for the parts of the panel that are about it rather than the list. */
  record: EvidenceRecord;
  /** The record's own date. The window is centred here, not on today. */
  anchorDate: string;
  /** Signed: negative means cash should have left. Fixes both the target and the direction. */
  expectedPaise: number;
  /** What the matcher already found — exact amount, just outside its date window. */
  suggested: NearMissCandidate[];
  busy: boolean;
  error: string | null;
  onLink: (transactionIds: string[], categoryId: number | null) => void;
  onCancel: () => void;
}) {
  // The full row, not just its amount: a transaction picked on page 1 is still selected on
  // page 3, and a tally counting a row that nothing on screen shows would be a number with no
  // visible cause. See the "chosen" block below.
  const [picked, setPicked] = useState<Map<string, Txn>>(() =>
    // The near miss starts TICKED. It already matches on amount and direction and the matcher
    // held it back for one reason (the date), so the common case is one click on a button
    // whose tally already reads zero — and nothing is written until that button is pressed.
    suggested.length === 0
      ? new Map()
      : new Map([
          [
            suggested[0].transactionId,
            {
              id: suggested[0].transactionId,
              txn_date: suggested[0].txnDate,
              amount_paise: expectedPaise,
              narration: suggested[0].narration,
              account_name: suggested[0].accountName ?? undefined,
              claim: suggested[0].claim,
            },
          ],
        ]),
  );
  const [query, setQuery] = useState("");
  const [windowDays, setWindowDays] = useState(WINDOWS[0].days);
  const [offset, setOffset] = useState(0);
  // Chosen here, sent WITH the link. A category written against a record that turns out not
  // to link would be a value saved for a row that does not exist yet, so the two travel
  // together — which is also how a person thinks about it: what was this, and what paid for it.
  const [category, setCategory] = useState<number | null>(null);

  // One request per pause, not one per keystroke.
  const settled = useDebounced(query, 300);
  const range =
    windowDays === 0
      ? ""
      : `&from=${shift(anchorDate, -windowDays)}&to=${shift(anchorDate, windowDays)}`;
  const search = useFetch<{ transactions: Txn[]; total: number }>(
    `/transactions?limit=${PAGE}&offset=${offset}` +
      // CLOSEST TO THE RECORD FIRST, not most recent first. The window alone was not enough:
      // ordered by recency, a ±10 day window around 3 August opens on 13 August, so the first
      // page of a list built to answer "what happened around the 3rd" is the part of the
      // window furthest from it.
      `&near=${anchorDate}` +
      `&direction=${expectedPaise < 0 ? "out" : "in"}${range}` +
      (settled.trim() === "" ? "" : `&q=${encodeURIComponent(settled.trim())}`),
    { keepPreviousData: true },
  );
  const working = useBusy(search.refreshing);

  const target = Math.abs(expectedPaise);
  const selected = useMemo(
    () => [...picked.values()].reduce((a, t) => a + Math.abs(t.amount_paise), 0),
    [picked],
  );
  const gap = selected - target;

  // Said BEFORE the button, because two of these outcomes are not undoable. A displaced rule
  // guess is deleted, and unlinking restores the link's absence, not the deleted row; a
  // removed row YOU wrote is simply gone. Refused outranks the rest: a link the server will
  // turn back for is a link the button must not appear to promise.
  const claims = [...picked.values()].map(claimOf);
  const yours = claims.filter((c) => c === "yours").length;
  const replaces = claims.filter((c) => c === "replaces").length;
  const refused = claims.filter((c) => c === "refused").length;
  const warning =
    refused > 0
      ? `${refused} of these is already explained by another record — the link will be refused. Unlink that record first.`
      : yours > 0
        ? `${yours} of these carries an explanation you wrote. Linking removes it, and undo does not bring it back.`
        : replaces > 0
          ? `${replaces} of these already carries a rule's guess. Linking removes it, and undo does not bring it back.`
          : null;

  function toggle(t: Txn) {
    const next = new Map(picked);
    if (next.has(t.id)) next.delete(t.id);
    else next.set(t.id, t);
    setPicked(next);
  }

  // Page 3 of "±10 days" is not page 3 of "any date", and staying there shows an empty list
  // for a filter that has rows. Same reasoning as the tab switch in TransfersView.
  function reframe(next: () => void) {
    next();
    setOffset(0);
  }

  const pinned: Txn[] = suggested
    .filter((c) => !picked.has(c.transactionId))
    .map((c) => ({
      id: c.transactionId,
      txn_date: c.txnDate,
      amount_paise: expectedPaise,
      narration: c.narration,
      account_name: c.accountName ?? undefined,
      claim: c.claim,
    }));
  const chosen = [...picked.values()];
  const results = (search.data?.transactions ?? []).filter(
    (t) => !picked.has(t.id) && !suggested.some((s) => s.transactionId === t.id),
  );
  const total = search.data?.total ?? 0;

  return (
    <div className="finder">
      {/* The arithmetic AND the button, together, above the list.
          They were at opposite ends with twenty-five rows between them, so the number you
          steer by and the control you steer with were never on screen at once — and pressing
          the button meant scrolling away from the reason to press it. */}
      <div className="finder-bar">
        <span className="finder-tally">
          <span>
            target <b className="mono">{rupees(target)}</b>
          </span>
          <span>
            selected <b className="mono">{rupees(selected)}</b>
            <span className="soft">
              {" "}
              · {picked.size} row{picked.size === 1 ? "" : "s"}
            </span>
          </span>
          <span className={picked.size === 0 ? "soft" : gap === 0 ? "credit" : "flag"}>
            gap <b className="mono">{rupees(Math.abs(gap))}</b>{" "}
            <span className="soft">
              {picked.size === 0
                ? ""
                : gap === 0
                  ? "exact"
                  : gap > 0
                    ? "extra stays unexplained"
                    : "split scales down to what you picked"}
            </span>
          </span>
        </span>
        {warning !== null && <span className="finder-warn flag">{warning}</span>}
        <span className="finder-actions">
          {error !== null && <span className="debit save-error">{error}</span>}
          <button className="btn-ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          {picked.size > 0 && (
            <button className="btn-ghost" disabled={busy} onClick={() => setPicked(new Map())}>
              Clear
            </button>
          )}
          <button
            className="btn"
            disabled={busy || picked.size === 0}
            onClick={() => onLink([...picked.keys()], category)}
          >
            {busy ? "Linking…" : `Link ${picked.size} payment${picked.size === 1 ? "" : "s"}`}
          </button>
        </span>
      </div>

      <div className="finder-controls">
        <input
          className="finder-search"
          placeholder="Search these by narration…"
          value={query}
          onChange={(e) => reframe(() => setQuery(e.target.value))}
        />
        {/* A select, not three buttons: this is one setting with three values, and the row
            already carries a text field and would start to look like a toolbar. */}
        <select
          className="finder-window"
          value={windowDays}
          onChange={(e) => reframe(() => setWindowDays(Number(e.target.value)))}
          aria-label="How far from the record's date to look"
        >
          {WINDOWS.map((w) => (
            <option key={w.days} value={w.days}>
              {w.label}
            </option>
          ))}
        </select>
      </div>

      {/* Under the controls, above the list: it is about the RECORD, not about which rows are
          on screen, so it never moves when the search or the window changes. */}
      <CategoryChoice
        sourceCategory={record.sourceCategory}
        categoryName={record.categoryName}
        categoryId={record.categoryId}
        canChoose={record.canChoose}
        needsCategory={record.needsCategory}
        sharePaise={record.expectedPaise}
        busy={busy}
        value={category}
        onChange={setCategory}
      />

      <div className={"busybar" + (working ? " on" : "")} aria-hidden="true">
        <i />
      </div>

      <div className={working || search.isStale ? "is-stale" : undefined}>
        <table className="pick-table">
          <colgroup>
            <col style={{ width: "38px" }} />
            {/* 108px, not 100: a mono YYYY-MM-DD does not fit in 100 and wraps onto two
                lines, which makes every row in the table a different height. */}
            <col style={{ width: "108px" }} />
            <col />
            <col style={{ width: "104px" }} />
            <col style={{ width: "82px" }} />
            <col style={{ width: "112px" }} />
          </colgroup>
          <thead>
            <tr>
              <th />
              <th>Date</th>
              <th>Narration</th>
              <th>Account</th>
              <th className="r">Apart</th>
              <th className="r">Amount</th>
            </tr>
          </thead>
          <tbody>
            {/* The matcher's own candidates, pinned above the search whatever the window or
                the page — they already match on amount and direction, so they are the
                likeliest answer and should never have to be searched for. */}
            {[...chosen, ...pinned].map((t) => (
              <PickRow
                key={t.id}
                txn={t}
                anchorDate={anchorDate}
                checked={picked.has(t.id)}
                near={suggested.some((s) => s.transactionId === t.id)}
                onToggle={() => toggle(t)}
              />
            ))}
            {results.map((t) => (
              <PickRow
                key={t.id}
                txn={t}
                anchorDate={anchorDate}
                checked={false}
                near={false}
                onToggle={() => toggle(t)}
              />
            ))}
            {total === 0 && search.error === null && (
              <tr>
                <td colSpan={6} className="soft">
                  {windowDays === 0
                    ? "No transaction in this direction matches that search."
                    : `Nothing within ${windowDays} days of ${anchorDate}. Widen the range, or search all dates.`}
                </td>
              </tr>
            )}
            {search.error !== null && (
              <tr>
                <td colSpan={6} className="debit">
                  {search.error}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Only once there is a second page. "1–4 of 4" under four rows is a control that can
          do nothing, restating a fact the four rows already made obvious. */}
      {total > PAGE && (
        <Pager
          offset={offset}
          limit={PAGE}
          total={total}
          shown={results.length}
          onOffset={setOffset}
          unit="transactions"
          busy={working}
        />
      )}
    </div>
  );
}

function PickRow({
  txn,
  anchorDate,
  checked,
  near,
  onToggle,
}: {
  txn: Txn;
  anchorDate: string;
  checked: boolean;
  near: boolean;
  onToggle: () => void;
}) {
  const gap = daysApart(txn.txn_date, anchorDate);
  const claim = claimOf(txn);
  return (
    <Fragment>
      <tr className={`pick-row${checked ? " picked" : ""}`} onClick={onToggle}>
        {/* The cell swallows its own clicks, or the checkbox's change AND the row's click
            both fire and the tick immediately untick s itself. */}
        <td onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={checked} onChange={onToggle} />
        </td>
        <td className="mono soft">{txn.txn_date}</td>
        <td className="narration">
          {near && <span className="tag-near">near miss</span>}
          {claim === "refused" && <span className="tag-claim refused">another record</span>}
          {claim === "yours" && <span className="tag-claim refused">yours</span>}
          {claim === "replaces" && <span className="tag-claim">explained</span>}
          {txn.narration}
        </td>
        <td className="soft">{txn.account_name ?? ""}</td>
        <td className="soft r nowrap">{gap === 0 ? "same day" : `${gap}d`}</td>
        <td className="mono r">{rupees(txn.amount_paise)}</td>
      </tr>
    </Fragment>
  );
}
