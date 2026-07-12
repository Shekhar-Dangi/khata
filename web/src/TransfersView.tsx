import { useFetch } from "./useFetch";
import { rupees } from "./format";

type Transfer = {
  id: string;
  account_name: string;
  txn_date: string;
  amount_paise: number;
  type: string;
  transfer_status: string | null;
  transfer_group_id: string | null;
  counterparty_name: string | null;
};

// Internal transfers between the user's own accounts (both legs).
export default function TransfersView() {
  const { data, loading, error } = useFetch<{ transfers: Transfer[] }>("/transfers");

  if (loading) return <p>Loading…</p>;
  if (error) return <p>{error}</p>;
  if (!data) return null;
  if (data.transfers.length === 0) return <p>No internal transfers detected.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Account</th>
          <th>Counterparty</th>
          <th>Amount</th>
          <th>Status</th>
          <th>Group</th>
        </tr>
      </thead>
      <tbody>
        {data.transfers.map((t) => (
          <tr key={t.id}>
            <td>{t.txn_date}</td>
            <td>{t.account_name}</td>
            <td>{t.counterparty_name ?? "—"}</td>
            <td>{rupees(t.amount_paise)}</td>
            <td>{t.transfer_status ?? t.type}</td>
            <td>{t.transfer_group_id ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
