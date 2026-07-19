import { useFetch } from "./useFetch";
import { rupees } from "./format";

type Transaction = {
  id: string;
  txn_date: string;
  amount_paise: number;
  type: string;
  narration: string | null;
  bank_balance_paise: number | null;
};

function amountClass(t: Transaction) {
  if (t.type === "transfer") return "mono r soft";
  return "mono r " + (t.amount_paise < 0 ? "debit" : "credit");
}

// One account's transactions — the drill-in table under an expanded account row.
export default function TransactionList({ accountId }: { accountId: number }) {
  const { data, loading, error } = useFetch<{ transactions: Transaction[] }>(
    `/accounts/${accountId}/transactions`,
  );

  if (loading) return <p className="soft">Loading…</p>;
  if (error) return <p className="soft">{error}</p>;
  if (!data) return null;

  return (
    <table>
      <colgroup>
        <col style={{ width: "110px" }} />
        <col />
        <col style={{ width: "140px" }} />
        <col style={{ width: "140px" }} />
      </colgroup>
      <thead>
        <tr>
          <th>Date</th>
          <th>Narration</th>
          <th className="r">Amount</th>
          <th className="r">Balance</th>
        </tr>
      </thead>
      <tbody>
        {data.transactions.map((t) => (
          <tr key={t.id}>
            <td className="mono soft">{t.txn_date}</td>
            <td className="narration">{t.narration}</td>
            <td className={amountClass(t)}>{rupees(t.amount_paise)}</td>
            <td className="mono r soft">
              {t.bank_balance_paise != null ? rupees(t.bank_balance_paise) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
