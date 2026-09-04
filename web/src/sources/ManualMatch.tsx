import { useMemo, useState } from "react";

import { errorText, mutate } from "../shared/api";
import { useFetch } from "../shared/useFetch";
import { rupees } from "../shared/format";
import type { NearMiss, NearMissCandidate } from "./sources";

// Records still waiting for a bank transaction, and the screen where a person supplies the
// judgement the matcher cannot.
//
// The interaction is a RUNNING TOTAL AGAINST A TARGET. That is what makes the two hard cases
// tractable without a rule for either:
//
//   Rs 6,000 entered, paid as Rs 1,000 + Rs 5,000  -> tick both, gap reaches zero
//   Rs 2,745 paid but Rs 2,700 entered             -> tick one, a Rs 45 gap remains
//
// The gap NEVER blocks. It is information: an over-selection leaves the difference as the
// transaction's unexplained remainder, and an under-selection scales the split down. Both are
// stated on screen before the button is pressed, because a person choosing this deserves to
// know which one they are choosing.

type Txn = {
  id: string;
  txn_date: string;
  amount_paise: number;
  narration: string | null;
  account_name?: string;
};

export default function ManualMatch({
  rows,
  onLinked,
}: {
  rows: NearMiss[];
  onLinked: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (rows.length === 0) return null;

  return (
    <div>
      <div className="sect">
        <span>Still looking for a payment</span>
        <span className="soft">{rows.length} waiting</span>
      </div>
      <p className="note">
        Nothing matched these automatically. Pick the payment — or payments — they went out as.
        The totals do not have to agree exactly.
      </p>
      {rows.map((r) => (
        <UnmatchedRow
          key={r.evidenceId}
          row={r}
          open={openId === r.evidenceId}
          onToggle={() => setOpenId(openId === r.evidenceId ? null : r.evidenceId)}
          onLinked={onLinked}
        />
      ))}
    </div>
  );
}

function UnmatchedRow({
  row,
  open,
  onToggle,
  onLinked,
}: {
  row: NearMiss;
  open: boolean;
  onToggle: () => void;
  onLinked: () => void;
}) {
  const [picked, setPicked] = useState<Map<string, number>>(new Map());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only fetch once the row is open — otherwise every unmatched record fires a search on
  // mount, which is a request per row for lists nobody has looked at yet.
  const search = useFetch<{ transactions: Txn[] }>(
    `/transactions?limit=25${query.trim() === "" ? "" : `&q=${encodeURIComponent(query.trim())}`}`,
    { enabled: open, keepPreviousData: true },
  );

  const target = Math.abs(row.expectedPaise);
  const selected = useMemo(
    () => [...picked.values()].reduce((a, v) => a + Math.abs(v), 0),
    [picked],
  );
  const gap = selected - target;

  function toggle(t: Txn) {
    const next = new Map(picked);
    if (next.has(t.id)) next.delete(t.id);
    else next.set(t.id, t.amount_paise);
    setPicked(next);
  }

  async function link() {
    setBusy(true);
    setError(null);
    try {
      await mutate(`/evidence/${row.evidenceId}/match`, {
        method: "POST",
        body: JSON.stringify({ transaction_ids: [...picked.keys()] }),
      });
      onLinked();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // Its own near-miss candidates first: they already match on amount and direction, so they
  // are the likeliest answer and should not have to be searched for.
  const suggested: NearMissCandidate[] = row.candidates;
  const results = (search.data?.transactions ?? []).filter(
    (t) => !suggested.some((s) => s.transactionId === t.id),
  );

  return (
    <div className="near-miss">
      <div className="near-miss-claim">
        <span className="mono soft">{row.evidenceDate}</span>
        <span className="near-miss-what">{row.description ?? row.externalRef}</span>
        <span className="pill">{row.sourceCategory}</span>
        <span className="mono r debit">{rupees(row.expectedPaise)}</span>
        <button className="btn-ghost" onClick={onToggle}>
          {open ? "Close" : "Find it"}
        </button>
      </div>

      {open && (
        <div className="matcher">
          {/* The arithmetic, always visible while choosing. Not a validation message that
              appears after a mistake — the number a person is steering by. */}
          <div className="matcher-tally">
            <span>
              target <b className="mono">{rupees(target)}</b>
            </span>
            <span>
              selected{" "}
              <b className="mono">{rupees(selected)}</b>
              <span className="soft"> · {picked.size} row{picked.size === 1 ? "" : "s"}</span>
            </span>
            <span className={gap === 0 ? "credit" : "flag"}>
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
          </div>

          {suggested.length > 0 && (
            <p className="soft matcher-hint">
              Same amount, just outside the date window:
            </p>
          )}
          {suggested.map((c) => (
            <Row
              key={c.transactionId}
              id={c.transactionId}
              date={c.txnDate}
              amount={row.expectedPaise}
              narration={c.narration}
              note={`${c.dayGap} days apart`}
              checked={picked.has(c.transactionId)}
              onToggle={() =>
                toggle({
                  id: c.transactionId,
                  txn_date: c.txnDate,
                  amount_paise: row.expectedPaise,
                  narration: c.narration,
                })
              }
            />
          ))}

          <input
            className="matcher-search"
            placeholder="Search any transaction by narration…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {search.error !== null && <p className="note">{search.error}</p>}
          {results.map((t) => (
            <Row
              key={t.id}
              id={t.id}
              date={t.txn_date}
              amount={t.amount_paise}
              narration={t.narration}
              note={t.account_name}
              checked={picked.has(t.id)}
              onToggle={() => toggle(t)}
            />
          ))}

          {error !== null && <p className="note">{error}</p>}

          <div className="preview-actions">
            <button className="btn" disabled={busy || picked.size === 0} onClick={() => void link()}>
              {busy
                ? "Linking…"
                : `Link ${picked.size} payment${picked.size === 1 ? "" : "s"}`}
            </button>
            {picked.size > 0 && (
              <button className="btn-ghost" onClick={() => setPicked(new Map())}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  date,
  amount,
  narration,
  note,
  checked,
  onToggle,
}: {
  id: string;
  date: string;
  amount: number;
  narration: string | null;
  note?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className={`matcher-row${checked ? " picked" : ""}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="mono soft">{date}</span>
      <span className="narration">{narration}</span>
      {note !== undefined && <span className="soft matcher-note">{note}</span>}
      <span className="mono r">{rupees(amount)}</span>
    </label>
  );
}
