import { useFetch } from "./useFetch";
import { rupees } from "./format";

type Account = { id: number; name: string; bank: string; balance_paise: number };
type Anomaly = {
  account_id: number;
  account_name: string;
  total_difference_paise: number | null;
};
type SummaryTotals = {
  net_paise: number;
  unexplained_paise: number;
  provisional_paise: number;
};

// The summary strip. Three numbers about MEANING (unexplained / provisional / net),
// plus a fourth about RECONCILIATION when it applies.
export default function Summary() {
  // One endpoint, three aggregates. The alternative — pulling the whole ledger into the
  // browser and adding it up here — stops being reasonable once real statements land.
  const totals = useFetch<SummaryTotals>("/summary");
  const accounts = useFetch<{ accounts: Account[] }>("/accounts");
  const anomalies = useFetch<{ accounts: Anomaly[] }>("/anomalies");

  const t = totals.data;
  const accts = accounts.data?.accounts ?? [];

  // This is NOT "money you can't explain" — it is the bank's stated balance disagreeing
  // with our own ledger, which is a different failure with a different fix. It used to
  // be displayed as the hero metric; labelling it honestly is the whole point.
  const drift = (anomalies.data?.accounts ?? []).reduce(
    (sum, a) => sum + Math.abs(a.total_difference_paise ?? 0),
    0,
  );

  return (
    <div className="summary">
      <div className="shell">
        <div>
          <div className="label">Money you can't explain yet</div>
          <div className="hero">{t ? rupees(t.unexplained_paise) : "—"}</div>
        </div>

        {/* Kept separate from the hero on purpose: folding a rule's guess into
            "explained" would let one sloppy rule deflate the number that matters. */}
        <div>
          <div className="label">Explained by a rule, unconfirmed</div>
          <div className="net flag">{t ? rupees(t.provisional_paise) : "—"}</div>
        </div>

        <div>
          <div className="label">Net across accounts</div>
          <div className="net">{t ? rupees(t.net_paise) : "—"}</div>
        </div>

        {drift > 0 && (
          <div>
            <div className="label">Doesn't match the bank</div>
            <div className="net debit">{rupees(drift)}</div>
          </div>
        )}

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
