import { useMemo, useState } from "react";

import { useFetch } from "./useFetch";
import { rupees } from "./format";

type Txn = {
  id: string;
  account_name: string;
  txn_date: string;
  amount_paise: number;
  type: string;
  narration: string | null;
};

// amount colour: transfers are movement (muted), else green in / rust out.
function amountClass(t: Txn) {
  if (t.type === "transfer") return "mono r soft";
  return "mono r " + (t.amount_paise < 0 ? "debit" : "credit");
}

// The consolidated ledger: every account's transactions in one view, with live filter.
export default function ConsolidatedView() {
  const { data, loading, error } = useFetch<{ transactions: Txn[] }>(
    "/transactions",
  );
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const txns = data?.transactions ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return txns;
    return txns.filter(
      (t) =>
        t.narration?.toLowerCase().includes(q) ||
        t.account_name.toLowerCase().includes(q),
    );
  }, [data, query]);

  if (loading) return <p className="soft">Loading…</p>;
  if (error) return <p className="soft">{error}</p>;
  if (!data) return null;

  return (
    <>
      <input
        className="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by narration or account…"
      />
      <table>
        <colgroup>
          <col style={{ width: "110px" }} />
          <col style={{ width: "130px" }} />
          <col />
          <col style={{ width: "140px" }} />
          <col style={{ width: "70px" }} />
        </colgroup>
        <thead>
          <tr>
            <th>Date</th>
            <th>Account</th>
            <th>Narration</th>
            <th className="r">Amount</th>
            <th>Type</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={5} className="soft">
                No matching transactions.
              </td>
            </tr>
          ) : (
            filtered.map((t) => (
              <tr key={t.id}>
                <td className="mono soft">{t.txn_date}</td>
                <td className="soft">{t.account_name}</td>
                <td className="narration">{t.narration}</td>
                <td className={amountClass(t)}>{rupees(t.amount_paise)}</td>
                <td className="soft">{t.type}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}
