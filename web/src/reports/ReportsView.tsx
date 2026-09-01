import { useState } from "react";

import { useBusy, useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";
import { rupees } from "../shared/format";
import CategoryBars from "./CategoryBars";
import MonthTrend from "./MonthTrend";
import DateRange, { rangeParams } from "../shared/DateRange";
import {
  monthLabel,
  presets,
  previousPeriod,
  type CategoryReport,
  type MonthRow,
  type Period,
} from "./reports";
import { STATE } from "../shared/transactions";

type Account = { id: number; name: string };

function query(p: Period, accountId: string): string {
  const params = rangeParams(p);
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

  const { version } = useLedgerVersion();
  const accounts = useFetch<{ accounts: Account[] }>("/accounts");

  const main = useFetch<CategoryReport>(
    `/reports/by-category?${query(period, accountId)}`,
    { keepPreviousData: true, revalidateOn: version },
  );

  // The trend deliberately IGNORES the period filter and always shows every month: its
  // whole job is "is this going down over time", and answering that inside a one-month
  // window is answering a different question. It does honour the account filter.
  const trend = useFetch<{ months: MonthRow[] }>(
    `/reports/by-month${accountId ? `?account_id=${accountId}` : ""}`,
    { keepPreviousData: true, revalidateOn: version },
  );

  // The previous equal-length window. "All time" has no predecessor, so there is nothing
  // to compare against and the toggle is disabled.
  const prev = previousPeriod(period);
  const compared = useFetch<CategoryReport>(
    `/reports/by-category?${query(prev ?? period, accountId)}`,
    {
      keepPreviousData: true,
      enabled: comparing && prev !== null,
      revalidateOn: version,
    },
  );

  const busy = useBusy(main.refreshing || compared.refreshing);

  if (main.error) return <p className="soft">{main.error}</p>;
  // Gate on the DATA, not on `loading`. `?? 0` fallbacks are why a Rs 0 renders for a
  // frame and vanishes: absent data becomes a zero, and a zero is a claim. There is no
  // state in which this page should show a number it has not been told.
  const data = main.data;
  if (data === null) return <p className="soft">Loading…</p>;

  const rows = data.categories;
  // Income and spending do not belong in one ranked list: a six-figure salary dwarfs
  // every category of spending and the chart stops saying anything about either.
  const spend = rows.filter((r) => r.total_paise < 0);
  const income = rows.filter((r) => r.total_paise > 0);

  // `isStale` is load-bearing here, not a nicety. keepPreviousData means `compared.data`
  // survives a url change, so the instant you tick the box it still holds the PREVIOUS
  // url's result — which was the current period. Every delta would read 0% for a frame
  // and then correct itself. Refusing stale data means no comparison is shown until the
  // comparison has actually been fetched.
  const compareMap =
    comparing && prev !== null && compared.data !== null && !compared.isStale
      ? new Map(compared.data.categories.map((c) => [c.category_id, c.total_paise]))
      : null;

  // All four tiles describe MONEY OUT. They previously mixed universes: `out` counted
  // only negative amounts while `confirmed`/`provisional` summed every category including
  // income, so a rule that categorised salary inflated two tiles and not the other — four
  // numbers that look like they should reconcile and cannot.
  const out = Math.abs(data.out_paise);
  const unexplained = Math.abs(data.unexplained_out_paise);
  const confirmed = spend.reduce((s, r) => s + Math.abs(r.confirmed_paise), 0);
  const provisional = spend.reduce((s, r) => s + Math.abs(r.provisional_paise), 0);

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
          {/* The same control the ledger uses. It used to be presets only, so "March" was
              not a question this page could be asked — you got this month, last month, or
              three months, and nothing in between. */}
          <DateRange period={period} today={today} onChange={setPeriod} />

          {/* "showing", because the bare word sat between two controls with nothing to
              attach it to — "everything" alone reads as a stray label, not as this
              page's answer to "which period am I looking at". */}
          <span className="period-range mono soft">
            showing{" "}
            {period.from === "" && period.to === ""
              ? "everything"
              : period.from === ""
                ? `up to ${monthLabel(period.to)}`
                : period.to === ""
                  ? `${monthLabel(period.from)} onwards`
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
              {data.transactions} transactions
            </span>
          </div>
          <div className="tile">
            <span className="label">{STATE.user}</span>
            <b className="mono st-confirmed">{rupees(confirmed)}</b>
            <span className="tile-sub soft mono">of money out</span>
          </div>
          <div className="tile">
            <span className="label">{STATE.rule}</span>
            <b className="mono st-provisional">{rupees(provisional)}</b>
            <span className="tile-sub soft mono">of money out</span>
          </div>
          <div className="tile">
            <span className="label">{STATE.unexplained}</span>
            <b className="mono st-unexplained">{rupees(unexplained)}</b>
            <span className="tile-sub soft mono">of money out</span>
          </div>
        </div>

        <div className="chart-legend">
          <span className="lg"><i className="seg-confirmed" />confirmed</span>
          <span className="lg"><i className="seg-provisional" />guessed</span>
          <span className="lg"><i className="seg-evidence" />from evidence</span>
        </div>

        <h3 className="report-h">Money you can&rsquo;t explain, over time</h3>
        {trend.data ? (
          <MonthTrend months={trend.data.months} />
        ) : (
          <p className="soft">{trend.error ?? "Loading…"}</p>
        )}

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
