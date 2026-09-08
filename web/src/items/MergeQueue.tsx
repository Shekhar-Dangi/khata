import { useState } from "react";

import Pager from "../shared/Pager";
import { errorText, mutate } from "../shared/api";
import { useLedgerVersion } from "../shared/ledgerVersion";
import { useBusy, useFetch } from "../shared/useFetch";
import type { MergeProposal, ProposalsResponse } from "./items";

// THE MERGE QUEUE — pairs the resolver suspects are one product and would not join alone.
//
// Why a queue exists at all is the asymmetry `items.ts` is built around: a duplicate costs a
// split count and ONE visible merge, while a wrong merge routes every future purchase of two
// products into one category and is SILENT. So the resolver is biased toward creating, and
// anything it is unsure of is parked here rather than decided.
//
// What lands here is specifically a pair the TEXT thinks is one thing and the MERCHANT thinks
// is two — different skus from the same seller are never auto-linked however similar the
// wording, which is the rule that stopped four creatine flavours collapsing into one item.
// Most of the queue is therefore the same product in two sizes, and the rest is the reason the
// rule exists: Coca-Cola and Pepsi are 57% alike as strings and are not the same drink.
//
// Sorted by similarity, because a person working through this wants the near-certain ones
// first — and because the tail is where the refusals live.

/** Pairs per page. Each row is a judgement, so a screenful is small. */
const PAGE = 20;

export default function MergeQueue() {
  const { version, bump } = useLedgerVersion();
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useFetch<ProposalsResponse>(
    `/items/proposals?status=open&limit=${PAGE}&offset=${offset}`,
    { keepPreviousData: true, revalidateOn: version },
  );
  const working = useBusy(list.refreshing);
  const rows = list.data?.proposals ?? [];
  const total = list.data?.total ?? 0;

  async function decide(p: MergeProposal, verdict: "accept" | "reject") {
    setBusy(p.id);
    setError(null);
    try {
      await mutate(`/items/proposals/${p.id}/${verdict}`, { method: "POST" });
      // A merge moves aliases and can change what a category applies to, so everything
      // allocation-derived re-reads — and this list re-reads with it.
      bump();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (list.loading) return <p className="soft batch-empty">Reading the merge queue…</p>;
  if (list.error !== null) return <p className="note">{list.error}</p>;
  if (total === 0) {
    return (
      <p className="soft batch-empty">
        Nothing to judge. A pair lands here when two products read alike but carry different
        merchant ids.
      </p>
    );
  }

  return (
    <>
      {error !== null && <p className="note">{error}</p>}

      <div className={working || list.isStale ? "is-stale" : undefined}>
        <table className="record-table">
          <colgroup>
            <col style={{ width: "58px" }} />
            <col />
            <col />
            <col style={{ width: "186px" }} />
          </colgroup>
          <thead>
            <tr>
              <th className="r">Alike</th>
              {/* The keeper first, and said so: which of the two survives is not obvious and
                  decides what the merged product ends up called. */}
              <th>Keeps this one</th>
              <th>Folds in</th>
              <th className="r">Same product?</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="r mono soft">{p.similarity}%</td>
                <td title={p.lo_name ?? p.lo_canonical}>
                  <span className="clip">{p.lo_canonical}</span>
                  <div className="soft mono clip sub-line">#{p.lo_id}</div>
                </td>
                <td title={p.hi_name ?? p.hi_canonical}>
                  <span className="clip">{p.hi_canonical}</span>
                  <div className="soft mono clip sub-line">#{p.hi_id}</div>
                </td>
                <td className="r">
                  <span className="merge-verdict">
                    <button
                      className="btn-secondary"
                      disabled={busy !== null}
                      onClick={() => void decide(p, "accept")}
                    >
                      {busy === p.id ? "…" : "Merge"}
                    </button>
                    {/* Rejecting is REMEMBERED, not deleted: the pair is never proposed again,
                        so saying "different" once is a decision that keeps paying. */}
                    <button
                      className="btn-ghost"
                      disabled={busy !== null}
                      onClick={() => void decide(p, "reject")}
                    >
                      Different
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pager
        offset={offset}
        limit={PAGE}
        total={total}
        shown={rows.length}
        onOffset={setOffset}
        unit="pairs"
        busy={working}
      />
    </>
  );
}
