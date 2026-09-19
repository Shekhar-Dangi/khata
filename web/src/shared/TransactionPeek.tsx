import { useEffect, useState } from "react";

import { useFetch } from "./useFetch";
import { useLedgerVersion } from "./ledgerVersion";
import LoadingLine from "./LoadingLine";
import Pager from "./Pager";
import TransactionTable from "./TransactionTable";
import type { TransactionsResponse } from "./transactions";

// Ten, not twenty-five. This opens INSIDE another table, under the row you clicked, so
// every row it adds pushes that row further up the screen. Ten fits without losing the
// rule you are looking at.
const PAGE = 10;

// The transactions behind an aggregate — whatever the aggregate was.
//
// It takes a QUERY STRING rather than a rule id, because "everything this rule touched"
// and "everything in this category, in this period, on this account" are the same request
// with different filters. One component serves both, and will serve the next drill-down
// without changing. That is the return on the shared filter vocabulary.
//
// It renders the SAME TransactionTable as the ledger, so a transaction looks and behaves
// the same wherever you meet it — including being explainable on the spot. You are most
// likely to want to fix a categorisation at exactly the moment you are looking at what a
// rule did to it, and until now that meant leaving for the ledger and searching for the
// row again.
//
// Its own component so it fetches ONLY when a row is actually expanded — 22 rules would
// otherwise mean 22 requests on load for data almost none of which is being looked at.
export default function TransactionPeek({
  query,
  emptyMessage = "Nothing here.",
}: {
  query: string;
  emptyMessage?: string;
}) {
  const [offset, setOffset] = useState(0);
  const { version, bump } = useLedgerVersion();

  // Page 3 of one rule is not page 3 of another. The component is usually remounted on
  // open, but a caller that keeps it mounted while changing the query would otherwise
  // land on an offset that belongs to the previous filter.
  useEffect(() => {
    setOffset(0);
  }, [query]);

  const txns = useFetch<TransactionsResponse>(
    `/transactions?${query}&limit=${PAGE}&offset=${offset}`,
    { keepPreviousData: true, revalidateOn: version },
  );

  // Inside `.peek`, so the line sits where the table will — the expansion never opens onto a
  // blank gap, and never onto a sentence. See LoadingLine.
  if (txns.loading) {
    return (
      <div className="peek">
        <LoadingLine />
      </div>
    );
  }
  if (txns.error) return <p className="soft touched-empty">{txns.error}</p>;

  const data = txns.data;
  if (data === null) {
    return (
      <div className="peek">
        <LoadingLine />
      </div>
    );
  }

  const rows = data.transactions;
  if (rows.length === 0 && offset === 0) {
    return <p className="soft touched-empty">{emptyMessage}</p>;
  }

  return (
    <div className="peek">
      <TransactionTable
        rows={rows}
        frame={false}
        emptyMessage={emptyMessage}
        // Explaining a transaction moves the headline numbers and every report, none of
        // which are below this component.
        onSaved={bump}
      />
      {data.total > PAGE && (
        <Pager
          offset={offset}
          limit={PAGE}
          total={data.total}
          shown={rows.length}
          onOffset={setOffset}
          busy={txns.refreshing}
        />
      )}
    </div>
  );
}
