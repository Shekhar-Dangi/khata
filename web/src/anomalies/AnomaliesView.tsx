import { useState } from "react";

import { useFetch } from "../shared/useFetch";
import { rupees } from "../shared/format";
import Pager from "../shared/Pager";
import LoadingLine from "../shared/LoadingLine";

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

const PAGE = 25;

// Reconciliation gaps: where our computed balance disagrees with the bank's stated one.
export default function AnomaliesView() {
  const { data, loading, error } = useFetch<{ accounts: AccountAnomaly[] }>(
    "/anomalies",
  );

  if (loading) return <LoadingLine />;
  if (error) return <p className="soft">{error}</p>;
  if (!data) return null;
  // The best news this screen can give you. As a bare sentence at the top of an
  // otherwise blank page it read as a load that had failed.
  if (data.accounts.length === 0)
    return (
      <div className="empty-state">
        <h3>Everything reconciles</h3>
        <p>
          Every account's running balance agrees with the balance its statement states.
          Nothing is missing and nothing is counted twice.
        </p>
      </div>
    );

  return (
    <div>
      {data.accounts.map((a) => (
        <AccountAnomalies key={a.account_id} account={a} />
      ))}
    </div>
  );
}

// One account's discrepancies, paged.
//
// The page is sliced in the BROWSER here, unlike every other list in the app, and that
// is a deliberate exception rather than an oversight: /anomalies already computes and
// returns the whole set in one walk of the account, so there is nothing to save by
// asking the server again. The rule the codebase actually follows is "don't ship
// thousands of rows to filter fifteen" — and a reconciliation walk that produced
// thousands of discrepancies would be a broken importer, not a paging problem.
//
// Its own component so the page position is per-account. One `offset` shared across
// three accounts would move all three tables at once.
function AccountAnomalies({ account }: { account: AccountAnomaly }) {
  const [offset, setOffset] = useState(0);
  const rows = account.discrepancies.slice(offset, offset + PAGE);

  return (
    <div>
      <div className="sect">
        <span>{account.account_name}</span>
        <span className="mono flag">
          {account.total_difference_paise != null
            ? rupees(Math.abs(account.total_difference_paise))
            : "—"}
        </span>
      </div>
      <div className="table-scroll short">
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
            {rows.map((d) => (
              <tr key={d.transaction_id}>
                <td className="mono soft">{d.txn_date}</td>
                <td className="narration">{d.narration}</td>
                <td className="mono r soft">{rupees(d.expected_paise)}</td>
                <td className="mono r soft">{rupees(d.stated_paise)}</td>
                <td className="mono r flag">{rupees(Math.abs(d.difference_paise))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {account.discrepancies.length > PAGE && (
        <Pager
          offset={offset}
          limit={PAGE}
          total={account.discrepancies.length}
          shown={rows.length}
          onOffset={setOffset}
          unit="discrepancies"
        />
      )}
    </div>
  );
}
