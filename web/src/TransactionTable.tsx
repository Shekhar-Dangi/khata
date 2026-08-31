import { Fragment, useEffect, useState } from "react";

import { useFetch } from "./useFetch";
import { rupees } from "./format";
import AllocationEditor from "./AllocationEditor";
import CategorySelect from "./CategorySelect";
import { isTransfer, type Category, type Txn } from "./transactions";


/** One row of POST /transactions/suggest. Absent rows are ones the model did not know. */
type Suggestion = {
  transaction_id: string;
  category_id: number | null;
  category_name: string;
};

// ONE table for transactions, wherever they are shown.
//
// The ledger and the drill-downs used to render the same rows two different ways: a table
// with headers here, a bare three-column grid there. Same endpoint, same payload — so the
// difference was never in the data, only in how much of it each place had decided to
// believe in. The drill-down showed date, account, narration, amount and stopped, which
// meant the one screen where you ask "what is this rule actually doing to my money?" was
// also the one screen where you could not answer "…and is any of it explained?", let alone
// fix it.
//
// Now a transaction row looks and behaves the same everywhere: same columns, same headers,
// click to expand, explain it on the spot.
export default function TransactionTable({
  rows,
  onSaved,
  emptyMessage = "No matching transactions.",
  frame = true,
  suggestable = false,
  resetKey = "",
}: {
  rows: Txn[];
  /** Called after an explanation is saved — the owner of the fetch decides what to refresh. */
  onSaved: () => void;
  emptyMessage?: string;
  /** false when the table is already inside a scrolling frame (a drill-down). */
  frame?: boolean;
  /**
   * Offer the local model's opinion on these rows.
   *
   * Only true where a suggestion is meaningful — the ledger filtered to unexplained.
   * Suggesting a category for a row that already carries one is an argument nobody
   * asked for, and an absent control says that better than one returning nothing.
   */
  suggestable?: boolean;
  /**
   * Identity of the current view — the parent's query string. When it changes the rows
   * underneath are a different set, so any suggestions in flight are about a list that no
   * longer exists and get dropped.
   */
  resetKey?: string;
}) {
  // Which row is open is this table's OWN interaction state — nothing else needs it, and
  // no data depends on it.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Suggestions are EPHEMERAL: React state, gone on navigate, never written anywhere.
  // Accepting one goes through the ordinary allocations endpoint and lands as
  // source='user', so there is no new provenance and no migration. What this trades away
  // is the record of what you REJECTED — the signal a persistent suggestions table would
  // buy. Worth revisiting once the feature has earned it. See the design.
  const [suggestions, setSuggestions] = useState<Map<string, Suggestion>>(new Map());
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  // How many rows one press asks about. NOT the page size: the ledger pages at 100 and
  // the model costs ~2.2s a row, so a full page is nearly four minutes behind a button
  // that cannot show progress (it is one round trip). The size is a visible control with
  // its cost printed beside it rather than a number chosen silently on your behalf.
  const [batch, setBatch] = useState(25);

  // Which suggestions you have ticked, and — separately — the category you actually want
  // written. They are different things: the tick says "write this row", the choice says
  // "write THIS". Defaulting the choice to the model's answer is what makes a nearly-right
  // suggestion (right parent, wrong child) a one-dropdown fix instead of a discard.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Map<string, number>>(new Map());

  // Only rows with nothing on them yet: a suggestion for an already-explained row is an
  // argument nobody asked for, and asking about one costs the same ~2.2s as a useful one.
  const askable = rows.filter((r) => r.allocations.length === 0).slice(0, batch);

  // Review mode: the model has answered and the table is now a triage screen, not a
  // ledger. It shows ONLY rows it named — an "Unknown" badge on four rows in five would
  // make a working feature look broken, and there is nothing to decide about them.
  const reviewing = suggestions.size > 0;
  const reviewRows = reviewing ? rows.filter((r) => suggestions.has(r.id)) : rows;
  const allTicked = reviewing && reviewRows.every((r) => selected.has(r.id));

  function tickAll(on: boolean) {
    setSelected(on ? new Set(reviewRows.map((r) => r.id)) : new Set());
  }
  function tick(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // A suggestion is about a specific row in a specific view. Change the filters and the
  // rows underneath change, so holding onto the answers would leave stale opinions
  // attached to a list you can no longer see. `resetKey` is the query the parent built.
  useEffect(() => {
    setSuggestions(new Map());
    setSelected(new Set());
    setChosen(new Map());
    setAskError(null);
  }, [resetKey]);

  function clearSuggestions() {
    setSuggestions(new Map());
    setSelected(new Set());
    setChosen(new Map());
    setAskError(null);
  }

  async function askModel() {
    setAsking(true);
    setAskError(null);
    try {
      const res = await fetch("/transactions/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: askable.map((r) => r.id) }),
      });
      // A path missing from the Vite proxy answers 200 with index.html, so the status
      // proves nothing here — parse the body and let a non-JSON response be the error.
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `request failed: ${res.status}`);
      const got = (body.suggestions as Suggestion[]).filter((s) => s.category_id != null);
      setSuggestions(new Map(got.map((s) => [s.transaction_id, s])));
      // Everything starts TICKED. You came here to accept suggestions; making you tick
      // nine boxes before the button does anything is friction with no safety value,
      // because unticking is how you reject and the narration is right there to read.
      setSelected(new Set(got.map((s) => s.transaction_id)));
      setChosen(new Map(got.map((s) => [s.transaction_id, s.category_id as number])));
    } catch (e) {
      setAskError(e instanceof Error ? e.message : "The local model did not answer");
    } finally {
      setAsking(false);
    }
  }

  // Accepting writes the WHOLE transaction as one allocation. That is only correct because
  // this screen is offered on UNEXPLAINED rows, where there is nothing to split.
  //
  // It writes through the ordinary allocations endpoint, so it lands as source='user' —
  // the same provenance as typing it yourself, because that is what accepting means. No
  // fourth `source` value, no migration, no invariant touched.
  async function acceptSelected() {
    setAccepting(true);
    setAskError(null);
    // Written so far. Load-bearing: these rows are ALREADY COMMITTED, so if a later one
    // fails we must still refresh. Bailing out with an early return would leave the
    // screen showing rows the ledger has already moved past — a silent partial success,
    // which is the worst shape a bug can take in a tool whose job is being trustworthy
    // about numbers.
    const written: string[] = [];
    let failure: string | null = null;

    try {
      // Sequential: each write is a ledger mutation, and firing them together would race
      // the refetch against writes still in flight.
      for (const t of reviewRows) {
        if (!selected.has(t.id)) continue;
        const categoryId = chosen.get(t.id);
        if (categoryId == null) continue;
        const res = await fetch(`/transactions/${t.id}/allocations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            allocations: [{ category_id: categoryId, amount_paise: t.amount_paise }],
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          failure = body.error ?? `request failed: ${res.status}`;
          break; // stop at the first failure rather than pressing on blindly
        }
        written.push(t.id);
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : "Could not save";
    }

    // Drop only what actually landed, so the rows that did NOT save stay on screen with
    // their categories still chosen — you can fix the cause and press accept again.
    if (written.length > 0) {
      setSuggestions((prev) => {
        const next = new Map(prev);
        for (const id of written) next.delete(id);
        return next;
      });
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of written) next.delete(id);
        return next;
      });
      onSaved(); // refresh whatever DID happen, even on a partial failure
    }
    if (failure !== null) {
      setAskError(
        written.length > 0
          ? `Saved ${written.length}, then stopped: ${failure}`
          : failure,
      );
    }
    setAccepting(false);
  }

  // Lazily: `enabled` is why the category list is fetched the first time somebody opens a
  // row, not on every mount. A rules page with a drill-down under every rule would
  // otherwise ask for the same list once per expanded table.
  const cats = useFetch<{ categories: Category[] }>("/categories", {
    // Also needed while reviewing: the suggestion column IS a category picker.
    enabled: expandedId !== null || reviewing,
    keepPreviousData: true,
  });

  const table = (
    <table>
      <colgroup>
        {reviewing && <col style={{ width: "38px" }} />}
        <col style={{ width: "110px" }} />
        <col style={{ width: "130px" }} />
        <col />
        <col style={{ width: "140px" }} />
        {/* In review the last column is a category PICKER, not a word, so it needs room. */}
        <col style={{ width: reviewing ? "215px" : "120px" }} />
      </colgroup>
      <thead>
        <tr>
          {reviewing && (
            <th>
              <input
                type="checkbox"
                aria-label="Select every suggestion"
                checked={allTicked}
                onChange={(e) => tickAll(e.target.checked)}
              />
            </th>
          )}
          <th>Date</th>
          <th>Account</th>
          <th>Narration</th>
          <th className="r">Amount</th>
          <th className="r">{reviewing ? "Suggested" : "Explained"}</th>
        </tr>
      </thead>
      <tbody>
        {reviewRows.length === 0 ? (
          <tr>
            <td colSpan={reviewing ? 6 : 5} className="soft">
              {emptyMessage}
            </td>
          </tr>
        ) : (
          reviewRows.map((t) => {
            const expanded = expandedId === t.id;
            const hasAllocs = t.allocations.length > 0;
            const provisional =
              hasAllocs && t.allocations.some((a) => a.source === "rule");
            return (
              <Fragment key={t.id}>
                <tr
                  className={reviewing ? "txn-row is-review" : "txn-row"}
                  aria-expanded={reviewing ? undefined : expanded}
                  // While reviewing, the row is a decision, not a drill-down: the category
                  // cell is already an editable picker, so expanding would only offer a
                  // slower way to do the same thing.
                  onClick={
                    reviewing ? undefined : () => setExpandedId(expanded ? null : t.id)
                  }
                >
                  {reviewing && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Accept the suggestion for ${t.narration ?? t.id}`}
                        checked={selected.has(t.id)}
                        onChange={(e) => tick(t.id, e.target.checked)}
                      />
                    </td>
                  )}
                  <td className="mono soft">{t.txn_date}</td>
                  <td className="soft">{t.account_name}</td>
                  <td className="narration">{t.narration}</td>
                  {/* transfers are movement (muted), else green in / rust out */}
                  <td
                    className={
                      isTransfer(t)
                        ? "mono r soft"
                        : "mono r " + (t.amount_paise < 0 ? "debit" : "credit")
                    }
                  >
                    {rupees(t.amount_paise)}
                  </td>
                  <td className={reviewing ? "" : "r"}>
                    {reviewing ? (
                      // The picker is PRE-FILLED with the model's answer. Most wrong
                      // suggestions are nearly right — correct parent, wrong child — and
                      // accept-or-discard alone would throw away the 80% that was useful.
                      <CategorySelect
                        value={chosen.get(t.id) ?? null}
                        categories={cats.data?.categories ?? []}
                        onChange={(id) =>
                          setChosen((prev) => {
                            const next = new Map(prev);
                            if (id == null) next.delete(t.id);
                            else next.set(t.id, id);
                            return next;
                          })
                        }
                        disabled={accepting}
                      />
                    ) : isTransfer(t) ? (
                      <span
                        className="pill"
                        title="Money moved between your own accounts. Not spending."
                      >
                        transfer
                      </span>
                    ) : !hasAllocs ? (
                      <span className="soft">explain ▾</span>
                    ) : t.unexplained_paise !== 0 ? (
                      <span className="flag mono">
                        {rupees(Math.abs(t.unexplained_paise))} left
                      </span>
                    ) : provisional ? (
                      <span
                        className="prov"
                        title="A rule guessed this. Open it to confirm."
                      >
                        provisional
                      </span>
                    ) : (
                      <span className="credit">explained</span>
                    )}
                  </td>
                </tr>
                {expanded && !reviewing && (
                  <tr className="txn-detail">
                    <td colSpan={reviewing ? 6 : 5}>
                      {cats.data ? (
                        <AllocationEditor
                          transaction={t}
                          categories={cats.data.categories}
                          onSaved={() => {
                            setExpandedId(null);
                            onSaved();
                          }}
                          onClose={() => setExpandedId(null)}
                        />
                      ) : (
                        <p className="soft">Loading categories…</p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })
        )}
      </tbody>
    </table>
  );

  // A frame of a FIXED size, with the rows scrolling inside it and the header stuck to its
  // top. Two things this fixes: the page no longer changes height as the row count changes,
  // and `position: sticky` on a <th> needs a scrolling ancestor to stick to — on the
  // document scroll it just leaves. Drill-downs pass frame={false}: they are already
  // inside one, and a scrollbar nested in a scrollbar catches the wrong wheel.
  const framed = frame ? <div className="table-scroll">{table}</div> : table;
  if (!suggestable) return framed;

  const ticked = reviewRows.filter((r) => selected.has(r.id)).length;
  // ~2.2s per row on this hardware, measured. The request is ONE round trip, so there is
  // nothing to report while it runs — which is exactly why the cost is shown up front
  // instead of being chosen for you behind a button.
  const estimate = (n: number) => {
    const secs = Math.round(n * 2.2);
    return secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
  };

  return (
    <>
      <div className="sugg-bar">
        {!reviewing ? (
          <>
            <button className="btn" onClick={askModel} disabled={asking || askable.length === 0}>
              {asking ? "Asking the local model…" : "Suggest categories"}
            </button>
            <label className="sugg-batch">
              for
              <select
                className="cat-select"
                value={batch}
                disabled={asking}
                onChange={(e) => setBatch(Number(e.target.value))}
              >
                <option value={25}>25 rows</option>
                <option value={50}>50 rows</option>
                <option value={100}>100 rows</option>
              </select>
              <span className="soft">≈ {estimate(askable.length)}</span>
            </label>
            {asking && (
              <span className="soft">
                {askable.length} rows · nothing is written until you accept
              </span>
            )}
          </>
        ) : (
          <>
            <button className="btn" onClick={acceptSelected} disabled={accepting || ticked === 0}>
              {accepting ? "Accepting…" : `Accept ${ticked} selected`}
            </button>
            <button className="btn-ghost" onClick={clearSuggestions} disabled={accepting}>
              Reject all
            </button>
            <span className="soft">
              {reviewRows.length} of {askable.length} recognised · the rest it did not know.
              Untick to skip one, or change its category before accepting.
            </span>
          </>
        )}
        {askError && <span className="debit">{askError}</span>}
      </div>

      {/* The SAME indeterminate bar the ledger shows while a filter is loading — one
          animated div, no new CSS. Bound straight to `asking` rather than through
          useBusy: that hook exists to stop a 5ms localhost response from strobing, and
          this request takes the better part of a minute. */}
      <div className={"busybar" + (asking ? " on" : "")} aria-hidden="true">
        <i />
      </div>

      {/* Dimmed, not blanked, while the model thinks — the same treatment a filter change
          gets. These rows are real; they are just about to be replaced by a shorter list. */}
      <div className={asking ? "is-stale" : undefined}>{framed}</div>
    </>
  );
}
