import { useEffect, useState } from "react";

import { useBusy, useDebounced, useFetch } from "./useFetch";
import { useLedgerVersion } from "./ledgerVersion";
import Pager from "./Pager";
import TransactionTable from "./TransactionTable";
import DateRange, { rangeParams } from "./DateRange";
import type { Period } from "./reports";
import type { TransactionsResponse } from "./transactions";

type Account = { id: number; name: string };

const ALL_TIME: Period = { from: "", to: "", label: "All time" };

const PAGE = 100;

// The consolidated ledger: every account's transactions, filtered and paged BY THE
// SERVER.
//
// This used to fetch the whole ledger and filter it with a useMemo. That works at 277
// rows and stops working somewhere before 10,000, where the unfiltered payload is
// megabytes the browser must download and parse before it can hide a single row.
// Postgres has indexes for this; Array.filter does not.
//
// The rows themselves are TransactionTable's job now — the same component the rule and
// category drill-downs render. What lives here is what is genuinely this screen's: the
// filters, the page position, and the fetch they build.
export default function ConsolidatedView() {
  const [query, setQuery] = useState("");
  const [accountId, setAccountId] = useState("");
  // The `source` filter has existed in the shared vocabulary since the beginning; this
  // screen simply never exposed it. "unexplained" is the soul metric made clickable.
  const [source, setSource] = useState("");
  const [period, setPeriod] = useState<Period>(ALL_TIME);
  const [offset, setOffset] = useState(0);
  const { version, bump } = useLedgerVersion();

  // The ledger opens on everything, unlike the reports page. This is where you come to
  // FIND a transaction, and defaulting to a period would hide the one you are looking for
  // behind a filter you did not set.
  const today = new Date().toISOString().slice(0, 10);

  // The input updates on every keystroke so typing stays instant; the URL only follows
  // once you pause. Otherwise "blinkit" would be seven requests.
  const debouncedQuery = useDebounced(query);

  const params = new URLSearchParams({
    limit: String(PAGE),
    offset: String(offset),
  });
  if (debouncedQuery.trim() !== "") params.set("q", debouncedQuery.trim());
  if (accountId !== "") params.set("account_id", accountId);
  if (source !== "") params.set("source", source);
  // "Unexplained" is the headline metric made clickable, and that metric is SPEND: not an
  // opening balance, not a transfer. Without this the filter answers a different question
  // than the number it is named after — 262 rows against a figure computed from 156 — and
  // the rows it adds are transfers, which are not money you failed to explain but money
  // that moved between your own accounts.
  if (source === "unexplained") params.set("spend_only", "true");
  rangeParams(period, params);

  // keepPreviousData: the url here is built from filters, so a change means "same view,
  // different parameters" — not a different resource. Holding the old rows and dimming
  // them beats blanking the table on every keystroke.
  const { data, loading, error, isStale, refreshing } =
    useFetch<TransactionsResponse>(`/transactions?${params}`, {
      keepPreviousData: true,
      revalidateOn: version,
    });

  const accounts = useFetch<{ accounts: Account[] }>("/accounts");

  // Feedback that a filter is working, without strobing on a 5ms localhost response.
  // See useBusy: nothing shows below ~90ms, and once shown it holds for ~320ms.
  const busy = useBusy(refreshing);

  // Changing a filter invalidates the current page: page 3 of "blinkit" is not page 3 of
  // everything, and staying there would show a confusing empty result.
  useEffect(() => {
    setOffset(0);
    // The period is two primitives, not the object — an inline `{from, to}` would be a
    // new reference every render and reset the page on each one.
  }, [debouncedQuery, accountId, source, period.from, period.to]);

  if (loading) return <p className="soft">Loading…</p>;
  if (error) return <p className="soft">{error}</p>;

  const rows = data?.transactions ?? [];
  const total = data?.total ?? 0;

  return (
    <>
      <div className="ledger-filters">
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search narration…"
        />
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
        <select
          className="cat-select"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">Any state</option>
          <option value="unexplained">Unexplained</option>
          <option value="rule">Provisional — a rule guessed</option>
          <option value="user">Confirmed — you said</option>
        </select>
        <DateRange period={period} today={today} onChange={setPeriod} />
        {/* The range lives on the pager. This says how many rows the FILTER found, which
            is the question the box beside it just asked. */}
        <span className="ledger-count mono soft">
          {total === 0
            ? "no matches"
            : `${total.toLocaleString("en-IN")} match${total === 1 ? "" : "es"}`}
          {busy && " · updating…"}
        </span>
      </div>

      {/* An indeterminate bar above the table: the clearest "working" signal there is,
          and it costs one animated div rather than re-rendering anything. */}
      <div className={"busybar" + (busy ? " on" : "")} aria-hidden="true">
        <i />
      </div>

      {/* Softened, not replaced: these rows are real, just one filter behind. */}
      <div className={busy || isStale ? "is-stale" : undefined}>
        <TransactionTable
          rows={rows}
          onSaved={bump}
          // Suggesting is offered ONLY while filtered to unexplained. Proposing a category
          // for a row that already has one is either noise or an argument you did not ask
          // for, and an absent button says that more clearly than one returning nothing.
          suggestable={source === "unexplained"}
          // Confirming only means something on rows a rule guessed. On any other filter
          // there is nothing to claim, and an absent control says so better than a
          // disabled one.
          confirmable={source === "rule"}
          // Identity of this view. Change a filter and the rows underneath are a different
          // set, so any suggestions held against the old ones are dropped.
          resetKey={params.toString()}
        />
      </div>

      <Pager
        offset={offset}
        limit={PAGE}
        total={total}
        shown={rows.length}
        onOffset={setOffset}
        busy={busy}
      />
    </>
  );
}
