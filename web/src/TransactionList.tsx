import { Fragment, useState } from "react";

import { useFetch } from "./useFetch";
import { rupees } from "./format";
import AllocationEditor from "./AllocationEditor";

type Allocation = {
  amount_paise: number;
  category_id: number;
  category_name: string;
  source: "rule" | "user" | "evidence";
  confidence: string; // NUMERIC(3,2) — pg sends it as a string, e.g. "0.80"
};
type Transaction = {
  id: string;
  txn_date: string;
  amount_paise: number;
  type: string;
  narration: string | null;
  explained_paise: number;
  unexplained_paise: number;
  allocations: Allocation[];
};
type Category = { id: number; name: string; parent_id: number | null };

function amountClass(t: Transaction) {
  if (t.type === "transfer") return "mono r soft";
  return "mono r " + (t.amount_paise < 0 ? "debit" : "credit");
}

// One account's transactions; click a row to expand its allocation editor ("explain this").
export default function TransactionList({ accountId }: { accountId: number }) {
  const txns = useFetch<{ transactions: Transaction[] }>(
    `/accounts/${accountId}/transactions`,
  );
  const cats = useFetch<{ categories: Category[] }>("/categories");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (txns.loading) return <p className="soft">Loading…</p>;
  if (txns.error) return <p className="soft">{txns.error}</p>;
  if (!txns.data) return null;

  return (
    <table>
      <colgroup>
        <col style={{ width: "110px" }} />
        <col />
        <col style={{ width: "130px" }} />
        <col style={{ width: "150px" }} />
      </colgroup>
      <thead>
        <tr>
          <th>Date</th>
          <th>Narration</th>
          <th className="r">Amount</th>
          <th className="r">Explained</th>
        </tr>
      </thead>
      <tbody>
        {txns.data.transactions.map((t) => {
          const expanded = expandedId === t.id;
          const hasAllocs = t.allocations.length > 0;
          // THREE states, not two. A rule's guess is not the same as your answer,
          // and collapsing them would make "explained" mean two different things.
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
                <td className="narration">{t.narration}</td>
                <td className={amountClass(t)}>{rupees(t.amount_paise)}</td>
                <td className="r">
                  {!hasAllocs ? (
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
                  <td colSpan={4}>
                    {cats.data ? (
                      <AllocationEditor
                        transaction={t}
                        categories={cats.data.categories}
                        onSaved={() => {
                          setExpandedId(null);
                          txns.refetch(); // reload so explained/unexplained update
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
        })}
      </tbody>
    </table>
  );
}
