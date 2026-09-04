import { Fragment, useState } from "react";

import { errorText, mutate } from "../shared/api";
import { rupees } from "../shared/format";
import CategoryChoice from "./CategoryChoice";
import TransactionFinder from "./TransactionFinder";
import type { EvidenceRecord, LinkedTransaction, LinkResult, RecordState } from "./sources";

// ONE table for records, in all three segments — the same columns, the same header treatment
// and the same click-to-expand as every other list in this app.
//
// It was a stack of flex rows with the bank row indented under each record behind a rule. Two
// things that cost: nothing lined up (a category pill and a narration are variable width, so
// the amount and the button landed at a different x on every line, in a screen whose entire
// job is comparing rows), and the actions were bare text at the end of a row, which reads as
// a label rather than as something you can press. A `<table>` fixes the first by construction,
// and moving every action into the expanded panel fixes the second — that is where the ledger
// already puts them.
//
// The last column is an INVITATION rather than a label, so it stays a verb. Same device, and
// the same words, as the ledger's "explain ▾".

/** What a write on this row did, for the parent's undo tray. */
export type Activity = {
  evidenceId: string;
  kind: "linked" | "unlinked" | "categorised";
  what: string;
  transactions: number;
  /**
   * The transactions involved. Carried rather than looked up, because undoing an UNLINK means
   * putting these exact rows back and by then the record no longer names them.
   */
  transactionIds: string[];
  /** Everything this link removed — rule guesses AND rows a person wrote. */
  displaced: number;
  /**
   * Of those, the rows a PERSON authored — the half no undo and no rules re-run restores.
   * Only ever non-zero on a manual link; the automatic matcher is turned back by tier 1
   * before it can remove one.
   */
  displacedAuthored: number;
  /** Linked, but only others' share could be written — see the tray for why that is said. */
  partial: boolean;
  /** The record's source category, named so the partial caveat can say WHY it happened. */
  sourceCategory: string;
  /** Where the share was filed. Only set on a "categorised" entry. */
  categoryName?: string;
};

export default function RecordTable({
  records,
  state,
  expandedId,
  onExpand,
  onChanged,
}: {
  records: EvidenceRecord[];
  state: RecordState;
  expandedId: string | null;
  onExpand: (evidenceId: string | null) => void;
  onChanged: (activity: Activity) => void;
}) {
  return (
    <table className="record-table">
      <colgroup>
        {/* 108px, not 100: a mono YYYY-MM-DD does not fit in 100 and wraps onto two lines,
            which makes every row in the table a different height. */}
        <col style={{ width: "108px" }} />
        <col />
        <col style={{ width: "158px" }} />
        <col style={{ width: "120px" }} />
        <col style={{ width: "192px" }} />
      </colgroup>
      <thead>
        <tr>
          <th>Date</th>
          <th>Record</th>
          <th>Category</th>
          <th className="r">Amount</th>
          <th className="r">{state === "matched" ? "Paid by" : "Match"}</th>
        </tr>
      </thead>
      <tbody>
        {records.map((r) => (
          <Row
            key={r.evidenceId}
            record={r}
            expanded={expandedId === r.evidenceId}
            onExpand={onExpand}
            onChanged={onChanged}
          />
        ))}
      </tbody>
    </table>
  );
}

function Row({
  record,
  expanded,
  onExpand,
  onChanged,
}: {
  record: EvidenceRecord;
  expanded: boolean;
  onExpand: (evidenceId: string | null) => void;
  onChanged: (activity: Activity) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const what = record.description ?? record.externalRef;

  async function link(ids: string[], categoryId: number | null) {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate<LinkResult>(
        `/evidence/${record.evidenceId}/match`,
        {
          method: "POST",
          // The category rides along with the link. Written in ONE request because a category
          // saved against a record that then fails to link would be a value stored for a row
          // that does not exist — and because it is one decision to the person making it.
          body: JSON.stringify({ transaction_ids: ids, category_id: categoryId }),
        },
      );
      onChanged({
        evidenceId: record.evidenceId,
        kind: "linked",
        what,
        transactions: ids.length,
        transactionIds: ids,
        displaced: result.displaced,
        displacedAuthored: result.displacedAuthored,
        partial: result.partial,
        sourceCategory: record.sourceCategory,
      });
    } catch (e) {
      // Kept on the row rather than raised to the page: the refusal is about THIS record
      // ("a person already explained that transaction"), and moving it to the top would
      // separate it from the only place it can be acted on.
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // Filing the owner's share, on a record that is already linked. Its own write rather than
  // part of the link, because the record is already on the ledger and the money is already
  // sliced — this changes what one slice SAYS, and re-derives through the same writer.
  async function categorise(categoryId: number, categoryName: string) {
    setBusy(true);
    setError(null);
    try {
      await mutate(`/evidence/${record.evidenceId}/category`, {
        method: "POST",
        body: JSON.stringify({ category_id: categoryId }),
      });
      onChanged({
        evidenceId: record.evidenceId,
        kind: "categorised",
        what,
        transactions: record.linked.length,
        transactionIds: record.linked.map((t) => t.transactionId),
        displaced: 0,
        displacedAuthored: 0,
        partial: false,
        sourceCategory: record.sourceCategory,
        categoryName,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      await mutate(`/evidence/${record.evidenceId}/match`, { method: "DELETE" });
      onChanged({
        evidenceId: record.evidenceId,
        kind: "unlinked",
        what,
        transactions: record.linked.length,
        transactionIds: record.linked.map((t) => t.transactionId),
        displaced: 0,
        displacedAuthored: 0,
        partial: false,
        sourceCategory: record.sourceCategory,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Fragment>
      <tr
        className={`txn-row${busy ? " is-writing" : ""}`}
        onClick={() => onExpand(expanded ? null : record.evidenceId)}
      >
        <td className="mono soft">{record.evidenceDate}</td>
        <td>{what}</td>
        {/* WHERE THE MONEY WENT, not what the source called it — they can differ the moment
            anyone answers a catch-all by hand, and a column still reading "General" over a
            row now filed under Groceries would report finished work as outstanding. The
            source category is still on screen: the expanded panel names both. */}
        <td className={record.needsCategory ? "flag" : "soft"}>
          {record.needsCategory ? `${record.sourceCategory} — none` : (record.categoryName ?? record.sourceCategory)}
        </td>
        <td className="mono r debit">{rupees(record.expectedPaise)}</td>
        <td className="r nowrap">
          <Verdict record={record} open={expanded} />
        </td>
      </tr>

      {expanded && (
        <tr className="txn-detail">
          <td colSpan={5}>
            {record.state === "matched" ? (
              <Linked
                record={record}
                onCategorise={(id, name) => void categorise(id, name)}
                linked={record.linked}
                busy={busy}
                error={error}
                onUnlink={() => void unlink()}
                onClose={() => onExpand(null)}
              />
            ) : (
              <TransactionFinder
                record={record}
                anchorDate={record.evidenceDate}
                expectedPaise={record.expectedPaise}
                suggested={record.candidates}
                busy={busy}
                error={error}
                onLink={(ids, categoryId) => void link(ids, categoryId)}
                onCancel={() => onExpand(null)}
              />
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * The state cell — what is known about this record's payment, and the way in.
 *
 * Enough to scan a segment without opening anything: how far apart the two dates are and
 * which account it came out of are the two facts that make a match believable at a glance.
 * The narration, which is what you actually check against, is one click away.
 */
function Verdict({ record, open }: { record: EvidenceRecord; open: boolean }) {
  const caret = open ? " ▴" : " ▾";

  if (record.state === "matched") {
    const first = record.linked[0];
    if (record.linked.length > 1) {
      return (
        <span className="credit">
          {record.linked.length} payments{caret}
        </span>
      );
    }
    // Account first, then the gap: the header says "Paid by", so the account is the answer to
    // it and the gap is the qualifier.
    return (
      <span className="credit">
        {first === undefined
          ? "linked"
          : `${first.accountName ?? "—"} · ${first.dayGap === 0 ? "same day" : `${first.dayGap}d`}`}
        {caret}
      </span>
    );
  }

  if (record.state === "near") {
    const best = record.candidates[0];
    return (
      <span className="flag">
        {best === undefined ? "near miss" : `${best.dayGap}d apart`}
        {caret}
      </span>
    );
  }

  // Not "find it": the payment was FOUND, exactly, and the matcher was turned back by what
  // already explains it. The flag colour says there is something to read, and the segment's
  // blurb says what linking it would mean.
  if (record.state === "conflicted") {
    return <span className="flag">explained already{caret}</span>;
  }

  // The one cell in this column that is purely an invitation. A verb, like "explain ▾".
  return <span className="soft">find it{caret}</span>;
}

/**
 * What a matched record is matched to, and the way to take it back.
 *
 * The reason the matched segment exists is to be CHECKABLE, and a count of fourteen is not
 * checkable — these rows are. Unlink is a real button in a real action bar, not grey text at
 * the end of a row: undoing a write that moved money between categories should look at least
 * as much like a control as the thing that did it.
 */
function Linked({
  record,
  linked,
  busy,
  error,
  onCategorise,
  onUnlink,
  onClose,
}: {
  record: EvidenceRecord;
  linked: LinkedTransaction[];
  busy: boolean;
  error: string | null;
  onCategorise: (categoryId: number, categoryName: string) => void;
  onUnlink: () => void;
  onClose: () => void;
}) {
  const total = linked.reduce((a, t) => a + t.txnAmountPaise, 0);

  return (
    <div className="linked">
      <table className="pick-table">
        <colgroup>
          <col style={{ width: "108px" }} />
          <col />
          <col style={{ width: "104px" }} />
          <col style={{ width: "82px" }} />
          <col style={{ width: "112px" }} />
        </colgroup>
        <thead>
          <tr>
            <th>Date</th>
            <th>Bank narration</th>
            <th>Account</th>
            <th className="r">Apart</th>
            <th className="r">Amount</th>
          </tr>
        </thead>
        <tbody>
          {linked.map((t) => (
            <tr key={t.transactionId}>
              <td className="mono soft">{t.txnDate}</td>
              <td className="narration">{t.narration}</td>
              <td className="soft">{t.accountName ?? ""}</td>
              <td className="soft r nowrap">
                {t.dayGap === 0 ? "same day" : `${t.dayGap}d`}
              </td>
              <td className="mono r">{rupees(t.txnAmountPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Between the rows and the actions: it is about the money in the table above, and it
          is a decision, so it sits with the decisions rather than under them. */}
      <CategoryChoice
        sourceCategory={record.sourceCategory}
        categoryName={record.categoryName}
        categoryId={record.categoryId}
        canChoose={record.canChoose}
        needsCategory={record.needsCategory}
        sharePaise={record.expectedPaise}
        busy={busy}
        onSave={onCategorise}
      />

      <div className="editor-foot">
        <span className="soft linked-note">
          {linked.length > 1 && (
            <>
              <b className="mono">{rupees(total)}</b> across {linked.length} payments.{" "}
            </>
          )}
          Unlinking removes the slices this record wrote. A rule guess it replaced does not come
          back — re-run the rules to regenerate it.
        </span>
        <span className="editor-actions">
          {error !== null && <span className="debit save-error">{error}</span>}
          <button className="btn-ghost" disabled={busy} onClick={onClose}>
            Close
          </button>
          <button className="btn-secondary" disabled={busy} onClick={onUnlink}>
            {busy ? "Unlinking…" : "Unlink"}
          </button>
        </span>
      </div>
    </div>
  );
}
