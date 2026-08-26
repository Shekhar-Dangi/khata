import { useFetch } from "./useFetch";
import { rupees } from "./format";
import type { TouchedTxn } from "./rules";

// The transactions behind an aggregate — whatever the aggregate was.
//
// It takes a QUERY STRING rather than a rule id, because "everything this rule touched"
// and "everything in this category, in this period, on this account" are the same
// request with different filters. One component serves both, and will serve the next
// drill-down without changing. That is the return on the shared filter vocabulary.
//
// Its own component so it fetches ONLY when a row is actually expanded — 22 rules would
// otherwise mean 22 requests on load for data almost none of which is being looked at.
export default function TransactionPeek({
  query,
  emptyMessage = "Nothing here.",
  variant = "table",
}: {
  query: string;
  emptyMessage?: string;
  /**
   * "bars" renders rows on the SAME grid as a bar row (shared CSS custom properties),
   * so each amount sits in the same column as the bar value above it. A separate table
   * with its own colgroup cannot line up with a grid no matter how the widths are
   * guessed — they have to share one definition.
   */
  variant?: "table" | "bars";
}) {
  const txns = useFetch<{ transactions: TouchedTxn[]; total: number }>(
    `/transactions?${query}&limit=200`,
  );

  if (txns.loading) return <p className="soft touched-empty">Loading…</p>;
  if (txns.error) return <p className="soft touched-empty">{txns.error}</p>;

  const rows = txns.data?.transactions ?? [];
  const total = txns.data?.total ?? 0;
  if (rows.length === 0) {
    return <p className="soft touched-empty">{emptyMessage}</p>;
  }

  if (variant === "bars") {
    return (
      <div className="touched">
        {rows.map((t) => (
          <div className="peek-row" key={t.id}>
            <span className="peek-when">
              <span className="mono soft">{t.txn_date}</span>
              <em>{t.account_name}</em>
            </span>
            <span className="narration">{t.narration}</span>
            <span
              className={
                "peek-amount mono " + (t.amount_paise < 0 ? "debit" : "credit")
              }
            >
              {rupees(t.amount_paise)}
            </span>
            <span />
          </div>
        ))}
        {total > rows.length && (
          <p className="soft touched-more">
            showing {rows.length} of {total}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="touched">
      <table className="touched-table">
        <colgroup>
          <col style={{ width: "104px" }} />
          <col style={{ width: "120px" }} />
          <col />
          <col style={{ width: "120px" }} />
        </colgroup>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="mono soft">{t.txn_date}</td>
              <td className="soft">{t.account_name}</td>
              <td className="narration">{t.narration}</td>
              <td className={"mono r " + (t.amount_paise < 0 ? "debit" : "credit")}>
                {rupees(t.amount_paise)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > rows.length && (
        <p className="soft touched-more">
          showing {rows.length} of {total}
        </p>
      )}
    </div>
  );
}
