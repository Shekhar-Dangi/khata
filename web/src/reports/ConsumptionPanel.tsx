import { useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";
import { rupees } from "../shared/format";

// What you actually CONSUMED — the second view the design argue for.
//
// It sits under "Where it goes" and not in its own tab on purpose. That view already answers
// "where does my money go" for CASH; this answers "what did I actually use" over the same
// ledger. They are two lenses on one question, and the GAP between them is the meaningful
// part — a shared bill you fronted is all cash and a third consumption, while a bill a
// flatmate paid for you is none of the first and all of the second.
//
// It deliberately does NOT touch the summary strip. That hero is "money you can't explain
// yet", a cash metric; putting consumption there would make one number mean two things,
// which is the exact failure warns about.

type Row = {
  id: number;
  name: string;
  parent_name: string | null;
  consumed_paise: number;
  entries: number;
};

type Consumption = {
  categories: Row[];
  non_cash_paise: number;
  non_cash_entries: number;
  unclassified_paise: number;
};

export default function ConsumptionPanel() {
  const { version } = useLedgerVersion();
  const { data, loading, error } = useFetch<Consumption>("/reports/consumption", {
    keepPreviousData: true,
    revalidateOn: version,
  });

  if (loading) return <p className="soft">Loading…</p>;
  if (error) return <p className="soft">{error}</p>;
  if (!data) return null;

  const total = data.categories.reduce((a, r) => a + r.consumed_paise, 0);
  const biggest = Math.max(1, ...data.categories.map((r) => Math.abs(r.consumed_paise)));

  if (total === 0 && data.non_cash_paise === 0) {
    return (
      <div className="empty-state">
        <h3>Nothing to consume yet</h3>
        <p>
          Consumption is what you used, whoever paid for it. Import a Splitwise export under
          Sources and the part your flatmates covered will show up here — it never appears on
          a bank statement.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="sect">
        <span>What you consumed</span>
        <span className="mono">{rupees(total)}</span>
      </div>

      {/* The number this whole feature exists to produce, said first and in words. A bank
          statement cannot show it, so it does not belong in a column of look-alike totals. */}
      <p className="lede">
        {data.non_cash_paise > 0 ? (
          <>
            <span className="mono">{rupees(data.non_cash_paise)}</span> of that never moved
            through your account — someone else paid, across {data.non_cash_entries}{" "}
            {data.non_cash_entries === 1 ? "entry" : "entries"}.
          </>
        ) : (
          <>All of this moved through your own account. Nothing was bought for you.</>
        )}
        {data.unclassified_paise > 0 && (
          <>
            {" "}
            A further{" "}
            <span className="mono flag">{rupees(data.unclassified_paise)}</span> is consumption
            we cannot categorise yet, so it is counted here as missing rather than guessed at.
          </>
        )}
      </p>

      <div className="table-scroll">
        <table>
          <colgroup>
            <col />
            <col style={{ width: "220px" }} />
            <col style={{ width: "130px" }} />
            <col style={{ width: "80px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Category</th>
              <th>Share</th>
              <th className="r">Consumed</th>
              <th className="r">Entries</th>
            </tr>
          </thead>
          <tbody>
            {data.categories.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.parent_name !== null && <span className="soft">{r.parent_name} · </span>}
                  {r.name}
                </td>
                <td>
                  {/* One bar, one scale, drawn to the largest row — the same device
                      CategoryBars uses, so the two panels read as one system. */}
                  <span
                    className="consumed-bar"
                    style={{ width: `${(Math.abs(r.consumed_paise) / biggest) * 100}%` }}
                  />
                </td>
                <td className="mono r">{rupees(r.consumed_paise)}</td>
                <td className="mono r soft">{r.entries}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
