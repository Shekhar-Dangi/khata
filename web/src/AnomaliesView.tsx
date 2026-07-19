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
  account_name: string;
  total_difference_paise: number | null;
  discrepancies: Discrepancy[];
};

// Reconciliation gaps: where our computed balance disagrees with the bank's stated one.
export default function AnomaliesView() {
  const { data, loading, error } = useFetch<{ accounts: AccountAnomaly[] }>(
    "/anomalies",
  );

  if (loading) return <p className="soft">Loading…</p>;
  if (error) return <p className="soft">{error}</p>;
  if (!data) return null;
  if (data.accounts.length === 0)
    return <p className="soft">No anomalies — everything reconciles.</p>;

  return (
    <div>
      {data.accounts.map((a) => (
        <div key={a.account_id}>
          <div className="sect">
            <span>{a.account_name}</span>
            <span className="mono flag">
              {a.total_difference_paise != null
                ? rupees(Math.abs(a.total_difference_paise))
                : "—"}
            </span>
          </div>
          <table>
            <colgroup>
              <col style={{ width: "110px" }} />
              <col />
              <col style={{ width: "130px" }} />
              <col style={{ width: "130px" }} />
              <col style={{ width: "130px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Date</th>
                <th>Narration</th>
                <th className="r">Expected</th>
                <th className="r">Bank stated</th>
                <th className="r">Difference</th>
              </tr>
            </thead>
            <tbody>
              {a.discrepancies.map((d) => (
                <tr key={d.transaction_id}>
                  <td className="mono soft">{d.txn_date}</td>
                  <td className="narration">{d.narration}</td>
                  <td className="mono r soft">{rupees(d.expected_paise)}</td>
                  <td className="mono r soft">{rupees(d.stated_paise)}</td>
                  <td className="mono r flag">
                    {rupees(Math.abs(d.difference_paise))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
