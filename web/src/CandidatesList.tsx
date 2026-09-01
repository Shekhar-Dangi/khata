import { useFetch } from "./useFetch";
import CandidateRow from "./CandidateRow";
import type { Category } from "./transactions";
import type { CandidatesResponse } from "./rules";

// Rules that do not exist yet, mined from the narrations of unexplained transactions.
//
// Computed on demand and stored nowhere: candidates are a deterministic function of the
// ledger, so a table would only be a cache that goes stale the moment a rule is created.
// That also means this whole feature needed no migration.
//
// Sorted safe-first by the server (spread ascending, then reach) rather than by hit count.
// Sorting by hits alone floats a payment rail like `paytm` — which spans three categories
// and can never carry one honestly — above a clean merchant cluster.
export default function CandidatesList({
  version,
  onCreated,
}: {
  version: number;
  onCreated: () => void;
}) {
  const candidates = useFetch<CandidatesResponse>("/rules/candidates", {
    revalidateOn: version,
    keepPreviousData: true,
  });
  const cats = useFetch<{ categories: Category[] }>("/categories", {
    keepPreviousData: true,
  });

  if (candidates.loading) return <p className="soft">Mining the ledger…</p>;
  if (candidates.error) return <p className="soft">{candidates.error}</p>;

  const data = candidates.data;
  const rows = data?.candidates ?? [];

  if (rows.length === 0) {
    return (
      <p className="soft">
        No candidates. Either everything is explained, or what is left has no repeated
        pattern a rule could catch — which is a real answer, not a failure.
      </p>
    );
  }

  return (
    <>
      <p className="soft cand-stats">
        <b>{rows.length}</b> candidates covering <b>{data?.covered ?? 0}</b> of{" "}
        <b>{data?.unexplained_total ?? 0}</b> unexplained transactions
      </p>

      <div className="table-scroll">
        <table className="cand-table">
          <colgroup>
            <col />
            <col style={{ width: "110px" }} />
            <col style={{ width: "100px" }} />
            <col style={{ width: "210px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Pattern</th>
              <th className="num">Unexplained</th>
              {/* Was "In ledger", which printed unexplainedHits + explainedHits — a
                  number that equals the column beside it for most candidates, so two
                  lanes said one thing. The decision-relevant figure is how many rows
                  this pattern would claim that you have ALREADY explained: that is the
                  over-broadness warning, and it pairs with the spread beside it. */}
              <th className="num">Also explained</th>
              <th>Already means</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <CandidateRow
                // The value is the identity of a candidate, and it is what the miner
                // dedupes on — so it is stable across a refetch and safe as a key.
                key={c.value}
                candidate={c}
                categories={cats.data?.categories ?? []}
                onCreated={onCreated}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
