import { useState } from "react";

import { useBusy, useDebounced, useFetch } from "../shared/useFetch";
import type { LineAnswer, LineResolution } from "./staged";

// Pointing one invoice line at a different product.
//
// THE CATALOGUE IS NEVER SHIPPED TO THE BROWSER. Searching goes through `GET /items?q=`,
// server-side, one request per pause — the design says so explicitly, and the
// reason is that the catalogue grows with every order while the browser's copy would not. A
// select element holding "every product you have ever bought" is a list that is wrong the
// moment it is built and enormous long before that.
//
// The resolver's own candidates are PINNED above the search, whatever is typed. They are the
// rows `pg_trgm` already thought were close, so they are the likeliest answer and should never
// have to be searched for — the same device, for the same reason, as TransactionFinder pinning
// the matcher's near misses above the transaction list.
//
// "Make it a new product" is a first-class answer, not an escape hatch. the design:
// a duplicate item costs a split count and one visible merge; a WRONG merge routes every future
// purchase of two different products into one category and is silent. So the safe direction is
// to create, and the control says that rather than hiding it behind the search.

/** The row shape `GET /items` returns. Ids are strings — pg renders BIGINT as one. */
type CatalogueItem = {
  id: string;
  canonical_name: string;
  display_name: string | null;
  category_id: number | null;
  category_name: string | null;
  alias_count: number;
};

/** Small on purpose: this list lives inside a table row inside another table row. */
const LIMIT = 8;

export default function ItemPicker({
  resolution,
  description,
  code,
  answer,
  onAnswer,
  onClear,
}: {
  resolution: LineResolution;
  /** What the invoice called this line — the label a NEW product will be created under. */
  description: string;
  /** The merchant's sku, or the HSN where there is no sku. Absent on a line carrying neither. */
  code: string | null;
  /** The person's answer so far, so the panel can show which row is currently chosen. */
  answer: LineAnswer | undefined;
  /** The chosen product's NAME travels with the id — see LineAnswer for why it has to. */
  onAnswer: (next: LineAnswer) => void;
  /** Back to whatever the resolver decided. Only offered once there is something to undo. */
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const settled = useDebounced(query, 300);
  const term = settled.trim();

  // `enabled` is the whole safety rule: with an empty box there is no request at all, so the
  // panel opening never asks the server for "the first page of everything". A blank query IS
  // the catalogue, and this component is built not to fetch it.
  const search = useFetch<{ items: CatalogueItem[]; total: number }>(
    `/items?q=${encodeURIComponent(term)}&limit=${LIMIT}`,
    { enabled: term !== "", keepPreviousData: true },
  );
  const working = useBusy(search.refreshing);

  const chosenId =
    answer !== undefined && "item_id" in answer.answer ? answer.answer.item_id : null;
  const creating = answer !== undefined && "create_new" in answer.answer;
  const found = search.data?.items ?? [];
  // The resolver's candidates never repeat inside the search results — the same product
  // offered twice, once with a similarity and once without, reads as two products.
  const results = found.filter((i) => !resolution.candidates.some((c) => c.item_id === i.id));

  return (
    <div className="item-pick">
      {/* What the invoice actually said, quoted where the question is asked. The row above
          shows the description too, but the CODE only appears here — it is the evidence
          turns on, and a person deciding "same product or not?" needs it in front of them. */}
      <p className="soft item-pick-said">
        The invoice says <b>{description}</b>
        {code !== null && <span className="mono"> · {code}</span>}
      </p>
      <div className="item-pick-head">
        <input
          className="finder-search"
          placeholder="Search your products by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the product catalogue"
        />
        <button
          type="button"
          className={creating ? "btn" : "btn-secondary"}
          onClick={() => onAnswer({ answer: { create_new: true }, label: description })}
        >
          {creating ? "Will be a new product" : "Make it a new product"}
        </button>
        {answer !== undefined && (
          <button type="button" className="btn-ghost" onClick={onClear}>
            Undo
          </button>
        )}
      </div>

      <div className={"busybar" + (working ? " on" : "")} aria-hidden="true">
        <i />
      </div>

      <table className="pick-table">
        <colgroup>
          <col />
          <col style={{ width: "150px" }} />
          <col style={{ width: "92px" }} />
          <col style={{ width: "96px" }} />
        </colgroup>
        <thead>
          <tr>
            <th>Product</th>
            <th>Filed under</th>
            <th className="r">Alike</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {resolution.candidates.map((c) => (
            <Row
              key={`cand-${c.item_id}`}
              name={c.name}
              category={undefined}
              similarity={c.similarity}
              chosen={chosenId === c.item_id}
              onPick={() => onAnswer({ answer: { item_id: c.item_id }, label: c.name })}
            />
          ))}
          {results.map((i) => {
            // The display name where there is one, and the canonical name otherwise — the same
            // choice everywhere this catalogue is shown, so a product is not called two things
            // on two screens.
            const name = i.display_name ?? i.canonical_name;
            return (
              <Row
                key={i.id}
                name={name}
                category={i.category_name}
                similarity={null}
                chosen={chosenId === i.id}
                onPick={() => onAnswer({ answer: { item_id: i.id }, label: name })}
              />
            );
          })}
          {/* Three different silences, said three different ways. "No results" under an empty
              box would be a lie — nothing was asked. */}
          {resolution.candidates.length === 0 && term === "" && (
            <tr>
              <td colSpan={4} className="soft">
                Nothing in the catalogue looked close to this line. Search for it, or make it a
                new product.
              </td>
            </tr>
          )}
          {term !== "" && results.length === 0 && !search.loading && search.error === null && (
            <tr>
              <td colSpan={4} className="soft">
                No product matches “{term}”.
              </td>
            </tr>
          )}
          {search.error !== null && (
            <tr>
              <td colSpan={4} className="debit">
                {search.error}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  name,
  category,
  similarity,
  chosen,
  onPick,
}: {
  name: string;
  /**
   * Three states, not two. `undefined` is "this row does not say" — a resolver candidate
   * carries only an id, a name and a similarity — and `null` is "it has none". Rendering the
   * first as "no category yet" would be the screen asserting something it was never told.
   */
  category: string | null | undefined;
  /** How alike the resolver thought the two strings were. Absent for a searched row. */
  similarity: number | null;
  chosen: boolean;
  onPick: () => void;
}) {
  return (
    <tr className={`pick-row${chosen ? " picked" : ""}`} onClick={onPick}>
      <td className="narration">{name}</td>
      <td className="soft">{category === undefined ? "" : (category ?? "none yet")}</td>
      <td className="mono r soft">{similarity === null ? "" : `${similarity}%`}</td>
      <td className="r">
        {chosen ? (
          <span className="credit">chosen</span>
        ) : (
          <span className="soft">use this</span>
        )}
      </td>
    </tr>
  );
}
