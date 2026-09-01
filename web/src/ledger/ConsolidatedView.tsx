import { useEffect, useState } from "react";

import { useBusy, useDebounced, useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";
import Pager from "../shared/Pager";
import TransactionTable from "../shared/TransactionTable";
import DateRange, { rangeParams } from "../shared/DateRange";
import type { Period } from "../reports/reports";
import { STATE, STATE_KEYS, type TransactionsResponse } from "../shared/transactions";

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
  // Opens on UNEXPLAINED rather than on everything.
  //
  // This is the home screen of a tool whose entire claim is "money you can't explain yet",
  // so the default view should be the work rather than the archive. The cost is real and
  // worth naming: looking for a specific transaction now starts with switching this to
  // "Any state", because a row you have already explained is not in the default list.
  // That trade only holds while the unexplained pile is the interesting one.
  const [source, setSource] = useState("unexplained");
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
            aria-label="Search narration"
          />
          <select
            className="cat-select"
            aria-label="Account"
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
            aria-label="State"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">Any state</option>
            {STATE_KEYS.map((k) => (
              <option key={k} value={k}>
                {STATE[k]}
              </option>
            ))}
          </select>
          <DateRange period={period} today={today} onChange={setPeriod} />

        {/* The RESULT, not a filter — so it sits with the controls rather than being
            thrown to the far corner by `margin-left: auto`. The page range lives on the
            pager; this is how many rows the filter found.

            No removable chips here. The controls ARE the state: each dropdown already
            shows what it is set to, so a chip repeating "Unexplained" beside a select
            that says "Unexplained" is the same fact twice, and it cost a whole extra
            line the moment any filter was applied. Resetting a filter is setting its own
            control back — where you set it. */}
      </div>

      {/* The match count is NOT here. The pager below already reads "1–100 of 144
          transactions", so a "144 matches" beside the filters was the same number twice —
          and being variable-width at the end of a nowrap row, it took its width out of the
          search box and shifted every control each time the number changed. One number,
          one place, and a row with no conditional children left in it to move. */}

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
