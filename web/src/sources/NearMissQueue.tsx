import { useState } from "react";

import { errorText, mutate } from "../shared/api";
import { rupees } from "../shared/format";
import type { NearMiss } from "./sources";

// Records the matcher believes in on every axis it can measure, held back only by the date.
//
// The whole point of this screen is putting the two strings SIDE BY SIDE. "Sharma Traders"
// against a line you typed as "weekly veg" is obvious to you and invisible to the matcher,
// because a bank narration and free text share no vocabulary. Meanwhile a person's name
// against "Auto" is equally consistent with paying the driver and with coincidence. So the
// screen's job is to show both and get out of the way — not to recommend one.

export default function NearMissQueue({
  rows,
  onAccepted,
}: {
  rows: NearMiss[];
  onAccepted: () => void;
}) {
  if (rows.length === 0) return null;

  return (
    <div>
      <div className="sect">
        <span>Might be these</span>
        <span className="soft">{rows.length} waiting</span>
      </div>
      <p className="note">
        The amount and direction match exactly — only the date is further out than we accept
        automatically. Nothing here is guessed at; accepting is your call.
      </p>
      {rows.map((r) => (
        <NearMissRow key={r.evidenceId} row={r} onAccepted={onAccepted} />
      ))}
    </div>
  );
}

function NearMissRow({ row, onAccepted }: { row: NearMiss; onAccepted: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function accept(transactionId: string) {
    setBusy(transactionId);
    setError(null);
    try {
      await mutate(`/evidence/${row.evidenceId}/match`, {
        method: "POST",
        body: JSON.stringify({ transaction_id: transactionId }),
      });
      onAccepted();
    } catch (e) {
      // A 409 here is not a failure of the request — it means a human already explained that
      // transaction. Saying so is more useful than "request failed".
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="near-miss">
      <div className="near-miss-claim">
        <span className="mono soft">{row.evidenceDate}</span>
        <span className="near-miss-what">{row.description ?? row.externalRef}</span>
        <span className="pill">{row.sourceCategory}</span>
        <span className="mono r debit">{rupees(-row.amountPaise)}</span>
      </div>

      {row.candidates.map((c) => (
        <div className="near-miss-candidate" key={c.transactionId}>
          <span className="mono soft">{c.txnDate}</span>
          <span className="soft near-miss-gap">
            {c.dayGap} {c.dayGap === 1 ? "day" : "days"} apart
          </span>
          <span className="narration">{c.narration}</span>
          <button
            className="btn-secondary"
            disabled={busy !== null}
            onClick={() => void accept(c.transactionId)}
          >
            {busy === c.transactionId ? "Linking…" : "Same thing"}
          </button>
        </div>
      ))}

      {error !== null && <p className="note">{error}</p>}
    </div>
  );
}
