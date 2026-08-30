import { Fragment, useState } from "react";

import { useFetch } from "./useFetch";
import { rupees } from "./format";
import AllocationEditor from "./AllocationEditor";
import { isTransfer, type Category, type Txn } from "./transactions";

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
}: {
  rows: Txn[];
  /** Called after an explanation is saved — the owner of the fetch decides what to refresh. */
  onSaved: () => void;
  emptyMessage?: string;
  /** false when the table is already inside a scrolling frame (a drill-down). */
  frame?: boolean;
}) {
  // Which row is open is this table's OWN interaction state — nothing else needs it, and
  // no data depends on it.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Lazily: `enabled` is why the category list is fetched the first time somebody opens a
  // row, not on every mount. A rules page with a drill-down under every rule would
  // otherwise ask for the same list once per expanded table.
  const cats = useFetch<{ categories: Category[] }>("/categories", {
    enabled: expandedId !== null,
    keepPreviousData: true,
  });

  const table = (
    <table>
      <colgroup>
        <col style={{ width: "110px" }} />
        <col style={{ width: "130px" }} />
        <col />
        <col style={{ width: "140px" }} />
        <col style={{ width: "120px" }} />
      </colgroup>
      <thead>
        <tr>
          <th>Date</th>
          <th>Account</th>
          <th>Narration</th>
          <th className="r">Amount</th>
          <th className="r">Explained</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={5} className="soft">
              {emptyMessage}
            </td>
          </tr>
        ) : (
          rows.map((t) => {
            const expanded = expandedId === t.id;
            const hasAllocs = t.allocations.length > 0;
            const provisional =
              hasAllocs && t.allocations.some((a) => a.source === "rule");
            return (
              <Fragment key={t.id}>
                <tr
                  className="txn-row"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : t.id)}
                >
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
                  <td className="r">
                    {isTransfer(t) ? (
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
                {expanded && (
                  <tr className="txn-detail">
                    <td colSpan={5}>
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
  return frame ? <div className="table-scroll">{table}</div> : table;
}
