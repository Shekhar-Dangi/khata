import { useFetch } from "./useFetch";
import { rupees } from "./format";

type Account = { id: number; name: string; bank: string; balance_paise: number };
type Anomaly = { account_id: number; total_difference_paise: number | null };

// The summary strip: the hero "money you can't explain yet" + net worth + per-account chips.
export default function Summary() {
  const accounts = useFetch<{ accounts: Account[] }>("/accounts");
  const anomalies = useFetch<{ accounts: Anomaly[] }>("/anomalies");

  const accts = accounts.data?.accounts ?? [];
  const anoms = anomalies.data?.accounts ?? [];

  // DERIVED VALUES — computed from fetched data at render time, never stored in state.
  const net = accts.reduce((sum, a) => sum + a.balance_paise, 0);
  const unexplained = anoms.reduce(
    (sum, a) => sum + Math.abs(a.total_difference_paise ?? 0),
    0,
  );

  return (
    <div className="summary">
      <div className="shell">
        <div>
          <div className="label">Money you can't explain yet</div>
          <div className="hero">{rupees(unexplained)}</div>
        </div>
        <div>
          <div className="label">Net across accounts</div>
          <div className="net">{rupees(net)}</div>
        </div>
        <div className="chips">
          {accts.map((a) => (
            <div key={a.id}>
              <div className="label" style={{ margin: 0 }}>
                {a.name}
              </div>
              <b className={a.balance_paise < 0 ? "debit" : undefined}>
                {rupees(a.balance_paise)}
              </b>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
