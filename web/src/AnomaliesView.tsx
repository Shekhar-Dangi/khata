import { useFetch } from "./useFetch";
import { rupees } from "./format";

type Discrepancy = {
  transaction_id: string;
  txn_date: string;
  narration: string | null;
  expected_paise: number;
  stated_paise: number;
  difference_paise: number;
};

type AccountAnomaly = {
  account_id: number;
  total_difference_paise: number | null;
  discrepancies: Discrepancy[];
};

// Reconciliation anomalies: where our computed balance disagrees with the bank's.
export default function AnomaliesView() {
  const { data, loading, error } = useFetch<{ accounts: AccountAnomaly[] }>("/anomalies");

  if (loading) return <p>Loading…</p>;
  if (error) return <p>{error}</p>;
  if (!data) return null;
  if (data.accounts.length === 0) return <p>No anomalies — everything reconciles.</p>;

  return (
    <div>
      {data.accounts.map((a) => (
        <section key={a.account_id}>
          <h3>
            Account {a.account_id} — total unexplained{" "}
            {a.total_difference_paise != null ? rupees(a.total_difference_paise) : "—"}
          </h3>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Narration</th>
                <th>Expected</th>
                <th>Bank stated</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              {a.discrepancies.map((d) => (
                <tr key={d.transaction_id}>
                  <td>{d.txn_date}</td>
                  <td>{d.narration}</td>
                  <td>{rupees(d.expected_paise)}</td>
                  <td>{rupees(d.stated_paise)}</td>
                  <td>{rupees(d.difference_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
