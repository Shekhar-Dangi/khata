// How many DISTINCT categories the rows a candidate would touch ALREADY carry.
//
// This is the honest over-broadness signal, and it earned its place twice on real data:
//   - `atm` looked like the best candidate in the ledger at 45 hits, and its spread of 6
//     revealed it was narration boilerplate ("…BRANCH ATM SERVICE") stamped on ordinary
//     UPI payments — a rule on it would have labelled Amazon Pay groceries as cash.
//   - `amazon` matches a fifth of the whole ledger, which looks alarming until you see
//     spread 1: every row it touches is already Groceries. Breadth is reach; spread is
//     ambiguity, and only the second one is a reason not to write the rule.
//
// Rendered as a small caps label with a hairline marker rather than a pill: the page is
// ink on warm paper with hairline rules, and a row of coloured capsules reads as a
// different product. Colour carries the state; the shape stays out of the way.
export default function SpreadBadge({
  spread,
  detail,
}: {
  spread: number;
  detail: { category: string; count: number }[];
}) {
  if (spread === 0) {
    return (
      <span className="spread clean" title="Touches nothing that is already explained">
        unclaimed
      </span>
    );
  }
  if (spread === 1) {
    return (
      <span
        className="spread one"
        title={`Every explained row it touches is already ${detail[0]?.category}`}
      >
        {detail[0]?.category ?? "consistent"}
      </span>
    );
  }
  return (
    <span className="spread mixed">
      <span className="spread-label">mixed · {spread}</span>
      <span className="spread-detail">
        {detail.map((d) => `${d.category} ${d.count}`).join(" · ")}
      </span>
    </span>
  );
}
