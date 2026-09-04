import { rupees } from "../shared/format";
import type { ImportResponse } from "./sources";

// What an import WILL do, before it does it — and, once it has, one line saying it did.
//
// This used to be eight equal-weight tiles across two sections, plus a lede, plus two tables,
// and it filled the screen twice over before you reached anything you could act on. The
// numbers were all true and the layout said they were all equally important, which is the one
// thing a summary must never say. Read it: four of the eight are counts you glance at once and
// never again ("Records read: 93"), and one of them is the whole reason to keep reading.
//
// So the counts became a sentence — an import receipt is read once, and prose is a quarter of
// the height of a tile grid — and only the outcome, the part that decides whether you press
// the button, keeps a scannable line of its own. The detail is still here; it is behind a
// disclosure instead of in front of the decision.
//
// One component for preview and result, because the server produces the two by the same code
// path (a dry run commits nothing but is otherwise a real import). Two components would be two
// chances to describe the same numbers differently, which is how a preview stops being trusted.

export default function ImportReceipt({
  result,
  onCommit,
  onDiscard,
  onDone,
  busy,
}: {
  result: ImportResponse;
  onCommit?: () => void;
  onDiscard?: () => void;
  /** Dismiss the committed receipt and go back to the drop target. */
  onDone?: () => void;
  busy: boolean;
}) {
  const { imported, match } = result;
  const preview = !result.committed;
  const needsYou = match.nearMissed + match.ambiguous + match.conflicted;

  // Committed: one line. The work is directly below, and a full report of an import that has
  // already happened would push it off the screen — which is exactly the complaint the whole
  // rewrite is answering.
  if (!preview) {
    return (
      <div className="receipt done">
        <p className="receipt-said">
          <strong>Imported {imported.rows} records</strong> from {imported.group}
          {" — "}
          {match.matched} matched to your bank
          {needsYou > 0 && <>, {needsYou} need you</>}
          {match.noCandidate > 0 && <>, {match.noCandidate} with no bank row</>}. Everything is
          in the list below.
        </p>
        <div className="preview-actions">
          <button className="btn-secondary" onClick={onDone}>
            Import another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="receipt">
      <div className="sect">
        <span>What this will do</span>
        <span className="pill">{imported.source}</span>
      </div>

      {imported.warnings.map((w) => (
        <p className="note" key={w}>
          {w}
        </p>
      ))}

      {/* The ledger's own vocabulary, in the order the money is decided: what came in, then
          what it explains, then what it cannot. */}
      <p className="receipt-said">
        <strong>{imported.rows} records</strong> from <b>{imported.group}</b> — {imported.stats.paid}{" "}
        you paid, {imported.stats.owedByMe} someone else paid, {imported.stats.notMine} not
        yours
        {imported.stats.payments > 0 && <>, {imported.stats.payments} settlements</>}.
      </p>

      {/* The one line that decides whether the button gets pressed, so it is the one line with
          structure and colour. Same device as the matcher's tally, for the same reason: these
          are the numbers you are steering by. */}
      <div className="receipt-tally">
        <span className={match.matched > 0 ? "credit" : "soft"}>
          <b className="mono">{match.matched}</b> will match a bank row
        </span>
        <span className={needsYou > 0 ? "flag" : "soft"}>
          <b className="mono">{needsYou}</b> need you
          <span className="soft"> · near misses, ties, conflicts</span>
        </span>
        <span className="soft">
          <b className="mono">{match.noCandidate}</b> with no bank row
          <span className="soft"> · paid another way</span>
        </span>
        {match.displaced > 0 && (
          <span className="flag">
            <b className="mono">{match.displaced}</b> rule guesses replaced
          </span>
        )}
        {/* A matched record whose category has no mapping gets only its shared slice written;
            the rest stays as a visible remainder. Counted here because "it matched" and "it
            matched, but half your money is still unexplained" are different facts, and the
            second is the one a person has to act on. */}
        {match.partiallyAllocated > 0 && (
          <span className="flag">
            <b className="mono">{match.partiallyAllocated}</b> matched without a category —
            their own share stays unexplained
          </span>
        )}
      </div>

      {/* Consumption gets a sentence rather than a tile: it is the only figure here a bank
          statement could never produce. */}
      <p className="lede">
        <strong>{imported.consumptionWritten}</strong> entries of consumption that never touched
        your account
        {imported.unclassified.count > 0 && (
          <>
            , and{" "}
            <span className="flag mono">{rupees(Math.abs(imported.unclassified.amountPaise))}</span>{" "}
            across {imported.unclassified.count} more that cannot be categorised yet
          </>
        )}
        .
      </p>

      {/* WHAT matched, not just how many — but folded away. A count of 12 is a number to trust
          or not; the pairs are the thing you can actually check. Checking a couple is how you
          come to trust the other ten, and most of the time you do not need to. */}
      {match.pairs.length > 0 && (
        <details className="fold">
          <summary>The {match.pairs.length} it would match, in full</summary>
          <div className="table-scroll short">
            <table>
              <colgroup>
                {/* 112px, not 100: a mono YYYY-MM-DD does not fit in 100 and wraps onto two
                    lines, which makes every row in the table a different height. */}
                <col style={{ width: "112px" }} />
                <col style={{ width: "180px" }} />
                <col />
                <col style={{ width: "90px" }} />
                <col style={{ width: "120px" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Record</th>
                  <th>Bank row</th>
                  <th className="r">Apart</th>
                  <th className="r">Amount</th>
                </tr>
              </thead>
              <tbody>
                {match.pairs.map((p) => (
                  <tr key={p.evidenceId + p.transactionId}>
                    <td className="mono soft">{p.evidenceDate}</td>
                    <td>{p.description ?? p.externalRef}</td>
                    <td className="narration">{p.narration}</td>
                    <td className="mono r soft">{p.dayGap === 0 ? "same day" : `${p.dayGap}d`}</td>
                    <td className="mono r">{rupees(p.txnAmountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {match.conflicts.length > 0 && (
        <details className="fold" open>
          {/* Open by default, unlike the matches. This is the case where the import declines to
              do something you might expect it to do, and a person who does not expand it would
              be left believing those records were handled. */}
          <summary>
            {match.conflicts.length} left alone — you already explained those bank rows
          </summary>
          <p className="note">
            A record never overwrites your own decision. Resolve them by hand if the record is
            right.
          </p>
          <div className="table-scroll short">
            <table>
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {match.conflicts.map((c) => (
                  <tr key={c.externalRef}>
                    <td className="narration">{c.externalRef}</td>
                    <td className="soft">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {imported.unmappedCategories.length > 0 && (
        <p className="note">
          Categories with no mapping yet: {imported.unmappedCategories.join(", ")}. Their amounts
          are counted as unclassified rather than guessed at.
        </p>
      )}

      <div className="preview-actions">
        <button className="btn" disabled={busy} onClick={onCommit}>
          {busy ? "Importing…" : "Import"}
        </button>
        <button className="btn-ghost" disabled={busy} onClick={onDiscard}>
          Discard
        </button>
        <span className="soft">Nothing has been written yet.</span>
      </div>
    </div>
  );
}
