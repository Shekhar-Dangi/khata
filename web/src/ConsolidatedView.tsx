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

// The consolidated ledger: every account's transactions in one view.
export default function ConsolidatedView() {
  const { data, loading, error } = useFetch<{ transactions: Txn[] }>("/transactions");

  if (loading) return <p>Loading…</p>;
  if (error) return <p>{error}</p>;
  if (!data) return null;

  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Account</th>
          <th>Narration</th>
          <th>Amount</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        {data.transactions.map((t) => (
          <tr key={t.id}>
            <td>{t.txn_date}</td>
            <td>{t.account_name}</td>
            <td>{t.narration}</td>
            <td>{rupees(t.amount_paise)}</td>
            <td>{t.type}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
