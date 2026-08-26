import { useState } from "react";

import { useBusy, useFetch } from "./useFetch";
import { rupees } from "./format";
import CategoryBars from "./CategoryBars";
import {
  monthLabel,
  presets,
  previousPeriod,
  type CategoryReport,
  type Period,
} from "./reports";

type Account = { id: number; name: string };

function query(p: Period, accountId: string): string {
  const params = new URLSearchParams();
  if (p.from !== "") params.set("from", p.from);
  if (p.to !== "") params.set("to", p.to);
  if (accountId !== "") params.set("account_id", accountId);
  return params.toString();
}

// Where the money went.
//
// The filters live HERE because every section reads them — that is shared state, and
// shared state belongs at the level that shares it. Everything below is presentational.
//
// Month-versus-month is the same endpoint fetched twice with different periods, merged
// in the browser by category_id. Fifteen rows of client-side arranging is nothing; it is
// client-side work over THOUSANDS of rows that we moved to the server.
export default function ReportsView() {
  const today = new Date().toISOString().slice(0, 10);
  const options = presets(today);
  const [period, setPeriod] = useState<Period>(options[4]!); // All time
  const [accountId, setAccountId] = useState("");
  const [comparing, setComparing] = useState(false);

  const accounts = useFetch<{ accounts: Account[] }>("/accounts");

  const main = useFetch<CategoryReport>(
    `/reports/by-category?${query(period, accountId)}`,
    { keepPreviousData: true },
  );

  // The previous equal-length window. Requested unconditionally-but-inertly when not
  // comparing: passing the same url keeps useFetch from thrashing, and "all time" has no
  // predecessor at all.
  const prev = previousPeriod(period);
  const compareUrl =
    comparing && prev !== null
      ? `/reports/by-category?${query(prev, accountId)}`
      : `/reports/by-category?${query(period, accountId)}`;
  const compared = useFetch<CategoryReport>(compareUrl, {
    keepPreviousData: true,
  });

  const busy = useBusy(main.refreshing || compared.refreshing);

  if (main.loading) return <p className="soft">Loading…</p>;
  if (main.error) return <p className="soft">{main.error}</p>;

  const data = main.data;
  const rows = data?.categories ?? [];
  // Income and spending do not belong in one ranked list: a six-figure salary dwarfs
  // every category of spending and the chart stops saying anything about either.
  const spend = rows.filter((r) => r.total_paise < 0);
  const income = rows.filter((r) => r.total_paise > 0);

  const compareMap =
    comparing && prev !== null && compared.data
      ? new Map(compared.data.categories.map((c) => [c.category_id, c.total_paise]))
      : null;

  const out = Math.abs(data?.out_paise ?? 0);
  const unexplained = Math.abs(data?.unexplained_paise ?? 0);
  const confirmed = rows.reduce((s, r) => s + Math.abs(r.confirmed_paise), 0);
  const provisional = rows.reduce((s, r) => s + Math.abs(r.provisional_paise), 0);

  // The drill-down inherits whatever is filtered right now: same vocabulary, different
  // projection. Clicking a bar in "August, HDFC" shows August's HDFC transactions in
  // that category, not the category's whole history.
  const baseQuery = query(period, accountId);

  return (
    <>
      <div className="rules-head">
        <h2>Where it goes</h2>
        <p className="soft rules-intro">
          Every figure is split by how much we trust it. A rule's guess is not the same
          claim as an explanation you wrote, and merging them would let one sloppy rule
          make your spending look understood.
        </p>

        <div className="report-filters">
          <select
            className="cat-select"
            value={period.label}
            onChange={(e) =>
              setPeriod(options.find((o) => o.label === e.target.value) ?? options[4]!)
            }
          >
            {options.map((o) => (
              <option key={o.label} value={o.label}>
                {o.label}
              </option>
            ))}
          </select>

          <span className="period-range mono soft">
            {period.from === ""
              ? "everything"
              : `${monthLabel(period.from)} – ${monthLabel(period.to)}`}
          </span>

          <select
            className="cat-select"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            <option value="">All accounts</option>
            {(accounts.data?.accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          <label className="rule-check compare-toggle">
            <input
              type="checkbox"
              checked={comparing}
              disabled={prev === null}
              onChange={(e) => setComparing(e.target.checked)}
            />
            <span>
              {prev === null
                ? "compare (pick a period first)"
                : "compare with previous period"}
            </span>
          </label>
        </div>
      </div>

      <div className={"busybar" + (busy ? " on" : "")} aria-hidden="true">
        <i />
      </div>

      <div className={busy ? "is-stale" : undefined}>
        <div className="tiles">
          <div className="tile">
            <span className="label">Money out</span>
            <b className="mono">{rupees(out)}</b>
            <span className="tile-sub soft mono">
              {data?.transactions ?? 0} transactions
            </span>
          </div>
          <div className="tile">
            <span className="label">You confirmed</span>
            <b className="mono st-confirmed">{rupees(confirmed)}</b>
            <span className="tile-sub soft mono">explanations you wrote</span>
          </div>
          <div className="tile">
            <span className="label">A rule guessed</span>
            <b className="mono st-provisional">{rupees(provisional)}</b>
            <span className="tile-sub soft mono">provisional</span>
          </div>
          <div className="tile">
            <span className="label">Can't explain yet</span>
            <b className="mono st-unexplained">{rupees(unexplained)}</b>
            <span className="tile-sub soft mono">nothing covers it</span>
          </div>
        </div>

        <div className="chart-legend">
          <span className="lg"><i className="seg-confirmed" />you confirmed</span>
          <span className="lg"><i className="seg-provisional" />a rule guessed</span>
          <span className="lg"><i className="seg-evidence" />from evidence</span>
        </div>

        <h3 className="report-h">Spending</h3>
        <CategoryBars rows={spend} compare={compareMap} baseQuery={baseQuery} />

        {income.length > 0 && (
          <>
            <h3 className="report-h">Money in</h3>
            <CategoryBars rows={income} compare={compareMap} baseQuery={baseQuery} />
          </>
        )}
      </div>
    </>
  );
}
