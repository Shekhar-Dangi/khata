import { useFetch } from "./useFetch";
import { rupees } from "./format";
import type { TouchedTxn } from "./rules";

// The transactions one rule explained. Its own component so it fetches ONLY when a row
// is actually expanded — 22 rules would otherwise mean 22 requests on page load for
// data almost none of which is being looked at.
//
// The endpoint is just the ledger with one more filter. That is the payoff for the
// shared filter vocabulary: "everything this rule touched" needed no new query.
export default function RuleTransactions({ ruleId }: { ruleId: number }) {
  const txns = useFetch<{ transactions: TouchedTxn[]; total: number }>(
    `/transactions?rule_id=${ruleId}&limit=200`,
  );

  if (txns.loading) return <p className="soft touched-empty">Loading…</p>;
  if (txns.error) return <p className="soft touched-empty">{txns.error}</p>;

  const rows = txns.data?.transactions ?? [];
  const total = txns.data?.total ?? 0;
  if (rows.length === 0) {
    return (
      <p className="soft touched-empty">
        This rule has not matched anything. A typo, or a merchant you stopped using.
      </p>
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
