// One pager, used by every list that pages.
//
// It was written three times before this — the ledger, the rule drill-down and the
// transfers list each had their own arithmetic for "which rows am I looking at", and
// two of the three got the last page wrong (`offset + PAGE` overshoots `total`, so the
// count read "301–400 of 337"). The off-by-one belongs in one file.
//
// Presentational: it owns nothing. `offset` comes down, `onOffset` goes up — the list
// that owns the fetch owns the position in it.
export default function Pager({
  offset,
  limit,
  total,
  shown,
  onOffset,
  unit = "transactions",
  busy = false,
}: {
  offset: number;
  limit: number;
  total: number;
  /** Rows actually rendered on this page — the last page is usually shorter. */
  shown: number;
  onOffset: (next: number) => void;
  unit?: string;
  busy?: boolean;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + shown, total);
  const atStart = offset === 0;
  const atEnd = offset + limit >= total;

  return (
    <div className="pager">
      <button
        className="btn-ghost"
        disabled={atStart}
        onClick={() => onOffset(Math.max(0, offset - limit))}
      >
        ‹ Newer
      </button>
      <span className="pager-count mono soft">
        {total === 0
          ? `no ${unit}`
          : `${from}–${to} of ${total.toLocaleString("en-IN")}`}
        {busy && " · updating…"}
      </span>
      <button className="btn-ghost" disabled={atEnd} onClick={() => onOffset(offset + limit)}>
        Older ›
      </button>
    </div>
  );
}
