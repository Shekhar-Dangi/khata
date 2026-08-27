import { Fragment, useEffect, useState } from "react";

import { useBusy, useDebounced, useFetch } from "./useFetch";
import { useLedgerVersion } from "./ledgerVersion";
import { rupees } from "./format";
import AllocationEditor from "./AllocationEditor";

type Allocation = {
  amount_paise: number;
  category_id: number;
  category_name: string;
  source: "rule" | "user" | "evidence";
};
type Txn = {
  id: string;
  account_name: string;
  txn_date: string;
  amount_paise: number;
  type: string;
  narration: string | null;
  explained_paise: number;
  unexplained_paise: number;
  allocations: Allocation[];
};
type Account = { id: number; name: string };
type Category = { id: number; name: string; parent_id: number | null };

const PAGE = 100;

// amount colour: transfers are movement (muted), else green in / rust out.
function amountClass(t: Txn) {
  if (t.type === "transfer") return "mono r soft";
  return "mono r " + (t.amount_paise < 0 ? "debit" : "credit");
}

// The consolidated ledger: every account's transactions, filtered and paged BY THE
// SERVER.
//
// This used to fetch the whole ledger and filter it with a useMemo. That works at 277
// rows and stops working somewhere before 10,000, where the unfiltered payload is
// megabytes the browser must download and parse before it can hide a single row.
// Postgres has indexes for this; Array.filter does not.
export default function ConsolidatedView() {
  const [query, setQuery] = useState("");
  const [accountId, setAccountId] = useState("");
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { version, bump } = useLedgerVersion();

  // The input updates on every keystroke so typing stays instant; the URL only follows
  // once you pause. Otherwise "blinkit" would be seven requests.
  const debouncedQuery = useDebounced(query);

  const params = new URLSearchParams({
    limit: String(PAGE),
    offset: String(offset),
  });
  if (debouncedQuery.trim() !== "") params.set("q", debouncedQuery.trim());
  if (accountId !== "") params.set("account_id", accountId);

  // keepPreviousData: the url here is built from filters, so a change means "same view,
  // different parameters" — not a different resource. Holding the old rows and dimming
  // them beats blanking the table on every keystroke.
  const { data, loading, error, isStale, refreshing } = useFetch<{
    transactions: Txn[];
    total: number;
  }>(`/transactions?${params}`, { keepPreviousData: true, revalidateOn: version });

  const accounts = useFetch<{ accounts: Account[] }>("/accounts");
  const cats = useFetch<{ categories: Category[] }>("/categories");

  // Feedback that a filter is working, without strobing on a 5ms localhost response.
  // See useBusy: nothing shows below ~90ms, and once shown it holds for ~320ms.
  const busy = useBusy(refreshing);

  // Changing a filter invalidates the current page: page 3 of "blinkit" is not page 3 of
  // everything, and staying there would show a confusing empty result.
  useEffect(() => {
    setOffset(0);
  }, [debouncedQuery, accountId]);

  if (loading) return <p className="soft">Loading…</p>;
  if (error) return <p className="soft">{error}</p>;

  const rows = data?.transactions ?? [];
  const total = data?.total ?? 0;
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + rows.length, total);

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
        <span className="ledger-count mono soft">
          {total === 0
            ? "no matches"
            : `${showingFrom}–${showingTo} of ${total.toLocaleString("en-IN")}`}
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
        <table>
          <colgroup>
            <col style={{ width: "110px" }} />
            <col style={{ width: "130px" }} />
            <col />
            <col style={{ width: "140px" }} />
            <col style={{ width: "120px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Date</th>
              <th>Account</th>
              <th>Narration</th>
              <th className="r">Amount</th>
              <th className="r">Explained</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="soft">
                  No matching transactions.
                </td>
              </tr>
            ) : (
              rows.map((t) => {
                const expanded = expandedId === t.id;
                const hasAllocs = t.allocations.length > 0;
                const provisional =
                  hasAllocs && t.allocations.some((a) => a.source === "rule");
                return (
                  <Fragment key={t.id}>
                    <tr
                      className="txn-row"
                      aria-expanded={expanded}
                      onClick={() => setExpandedId(expanded ? null : t.id)}
                    >
                      <td className="mono soft">{t.txn_date}</td>
                      <td className="soft">{t.account_name}</td>
                      <td className="narration">{t.narration}</td>
                      <td className={amountClass(t)}>{rupees(t.amount_paise)}</td>
                      <td className="r">
                        {!hasAllocs ? (
                          <span className="soft">explain ▾</span>
                        ) : t.unexplained_paise !== 0 ? (
                          <span className="flag mono">
                            {rupees(Math.abs(t.unexplained_paise))} left
                          </span>
                        ) : provisional ? (
                          <span className="prov" title="A rule guessed this. Open it to confirm.">
                            provisional
                          </span>
                        ) : (
                          <span className="credit">explained</span>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="txn-detail">
                        <td colSpan={5}>
                          {cats.data ? (
                            <AllocationEditor
                              transaction={t}
                              categories={cats.data.categories}
                              onSaved={() => {
                                setExpandedId(null);
                                // Explaining a transaction moves the headline numbers and
                                // every report, none of which are below this component.
                                bump();
                              }}
                              onClose={() => setExpandedId(null)}
                            />
                          ) : (
                            <p className="soft">Loading categories…</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {total > PAGE && (
        <div className="pager">
          <button
            className="btn-ghost"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
          >
            ‹ Newer
          </button>
          <button
            className="btn-ghost"
            disabled={offset + PAGE >= total}
            onClick={() => setOffset((o) => o + PAGE)}
          >
            Older ›
          </button>
        </div>
      )}
    </>
  );
}
