import { useState } from "react";

import { rupees } from "./format";
import TransactionPeek from "./TransactionPeek";
import { pctChange, type CategoryRow } from "./reports";

// A ranked bar list, stacked by how much we trust each figure.
//
// Not a pie chart. Thirteen categories means thirteen slices nobody can compare, and
// people read LENGTH far more accurately than angle. Ranked bars also put the answer to
// "what is big" in the first row rather than somewhere around the circle.
//
// Category is identified by its LABEL, which sits right beside the bar — so colour is
// free to encode the thing a label cannot: provenance. Three states, three colours, and
// nothing else on the page needs a hue.
export default function CategoryBars({
  rows,
  compare,
  baseQuery,
}: {
  rows: CategoryRow[];
  compare: Map<number, number> | null;
  /** The page's current filters, so a drill-down inherits the period and account. */
  baseQuery: string;
}) {
  // Which row is open is this component's own interaction state — nothing else needs it.
  const [openId, setOpenId] = useState<number | null>(null);
  if (rows.length === 0) {
    return <p className="soft">Nothing in this period.</p>;
  }

  // Scale to the largest bar, not to the total: the question is "how do these compare",
  // and scaling to the sum wastes most of the width on the long tail.
  const max = Math.max(...rows.map((r) => Math.abs(r.total_paise)));

  return (
    <div className="bars">
      {rows.map((r) => {
        const magnitude = Math.abs(r.total_paise);
        const width = max === 0 ? 0 : (magnitude / max) * 100;
        const confirmed = Math.abs(r.confirmed_paise);
        const provisional = Math.abs(r.provisional_paise);
        const evidence = Math.abs(r.evidence_paise);
        const seg = (v: number) => (magnitude === 0 ? 0 : (v / magnitude) * 100);
        const before = compare?.get(r.category_id);
        const delta =
          before === undefined ? null : pctChange(r.total_paise, before);

        const open = openId === r.category_id;

        return (
          <div key={r.category_id}>
          <button
            className={"barrow" + (open ? " open" : "")}
            aria-expanded={open}
            onClick={() => setOpenId(open ? null : r.category_id)}
            title={`${r.transactions} transaction${r.transactions === 1 ? "" : "s"} — click to see them`}
          >
            <span className="barlabel">
              {r.category_name}
              {r.parent_name && <em>{r.parent_name}</em>}
            </span>

            {/* Segments are laid out inside a track scaled to the row's own share of the
                largest bar, so the stack reads as a breakdown AND the row reads as a
                magnitude. 2px gaps keep adjacent segments from blurring together. */}
            <span className="bartrack">
              <span className="barfill" style={{ width: `${width}%` }}>
                {confirmed > 0 && (
                  <i className="seg-confirmed" style={{ width: `${seg(confirmed)}%` }} />
                )}
                {evidence > 0 && (
                  <i className="seg-evidence" style={{ width: `${seg(evidence)}%` }} />
                )}
                {provisional > 0 && (
                  <i
                    className="seg-provisional"
                    style={{ width: `${seg(provisional)}%` }}
                  />
                )}
              </span>
            </span>

            <span className="barvalue mono">{rupees(magnitude)}</span>
            <span className="bardelta mono">
              {delta === null ? (
                before === undefined ? (
                  ""
                ) : (
                  <span className="soft">new</span>
                )
              ) : (
                <span className={delta > 0 ? "debit" : "credit"}>
                  {delta > 0 ? "+" : ""}
                  {delta.toFixed(0)}%
                </span>
              )}
            </span>
          </button>
          {open && (
            <div className="bar-peek">
              <TransactionPeek
                query={`${baseQuery}${baseQuery === "" ? "" : "&"}category_id=${r.category_id}`}
                emptyMessage="No transactions in this category for the current filters."
              />
            </div>
          )}
          </div>
        );
      })}
    </div>
  );
}
