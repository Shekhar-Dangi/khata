import { useFetch } from "./useFetch";
import { rupees } from "./format";

type Transfer = {
  id: string;
  account_name: string;
  txn_date: string;
  amount_paise: number;
  type: string;
  transfer_status: string | null;
  counterparty_name: string | null;
};

// Internal transfers between the user's own accounts — movement, not spend (muted).
export default function TransfersView() {
  const { data, loading, error } = useFetch<{ transfers: Transfer[] }>("/transfers");

  if (loading) return <p className="soft">Loading…</p>;
  if (error) return <p className="soft">{error}</p>;
  if (!data) return null;
  if (data.transfers.length === 0)
    return <p className="soft">No internal transfers detected.</p>;

  return (
    <table>
      <colgroup>
        <col style={{ width: "110px" }} />
        <col />
        <col />
        <col style={{ width: "150px" }} />
        <col style={{ width: "120px" }} />
      </colgroup>
      <thead>
        <tr>
          <th>Date</th>
          <th>Account</th>
          <th>Counterparty</th>
          <th className="r">Amount</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody className="muted">
        {data.transfers.map((t) => (
          <tr key={t.id}>
            <td className="mono">{t.txn_date}</td>
            <td>{t.account_name}</td>
            <td>{t.counterparty_name ?? "—"}</td>
            <td className="mono r">{rupees(t.amount_paise)}</td>
            <td>
              <span className="pill">{t.transfer_status ?? t.type}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
