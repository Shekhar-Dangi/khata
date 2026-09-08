import { useState } from "react";

import CategorySelect from "../shared/CategorySelect";
import Pager from "../shared/Pager";
import { errorText, mutate } from "../shared/api";
import { useLedgerVersion } from "../shared/ledgerVersion";
import type { Category } from "../shared/transactions";
import { useBusy, useDebounced, useFetch } from "../shared/useFetch";
import { ITEM_FILTERS, countFor, type Item, type ItemFilter, type ItemStats, type ItemsResponse } from "./items";

// THE PRODUCT CATALOGUE — every product the ledger knows, and what each is filed under.
//
// This is the flywheel's third entity and the page that makes it
// pay: a household buys the same few hundred things forever, so classifying one product once
// covers every future basket. Which is exactly why the list leads with HOW OFTEN each was
// bought rather than with what you last edited — the rows worth your attention are the ones
// that will come round again.
//
// SERVER-FILTERED AND SERVER-PAGED, and deliberately unlike the staged Products tab, which
// fetches its whole set and filters in the browser. The difference is not preference:
//
//   the inbox is a BOUNDED WORKING SET — a pile being emptied, whose counts can only be known
//   by resolving every row anyway, so a page costs what the lot costs.
//
//   the catalogue is an UNBOUNDED ARCHIVE — one row per product, forever, whose filters are
//   plain SQL predicates on indexed columns and whose totals are a COUNT. Fetching it whole to
//   filter three fields in JavaScript would get slower every month for no gain.
//
// So: two patterns in one app, each where it belongs, and the rule for choosing is whether the
// set is bounded by work-in-progress or by history.

/** Products per page. A catalogue is scanned, not read, so a screenful is generous. */
const PAGE = 50;

export default function ItemsView() {
  const { version, bump } = useLedgerVersion();
  const [filter, setFilter] = useState<ItemFilter>("unclassified");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  // Selection is a SET OF IDS plus a flag for "everything that matches". Two different facts:
  // the browser holds one page and cannot name the other four hundred rows, so "all matching"
  // has to travel to the server as the FILTER. Collapsing them is how "select all" comes to
  // mean "this page" — the bug the staged worklist already had.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced so typing does not fire a query per keystroke against a growing table.
  const term = useDebounced(query.trim(), 250);
  const params =
    `?limit=${PAGE}&offset=${offset}` +
    (term === "" ? "" : `&q=${encodeURIComponent(term)}`) +
    (filter === "unclassified" ? "&unclassified=1" : "");

  const list = useFetch<ItemsResponse>(`/items${params}`, {
    keepPreviousData: true,
    revalidateOn: version,
  });
  // The counts the tabs carry. Its own call because they describe the WHOLE catalogue, not the
  // page — a tab counting the rows on screen would say "50" whatever the truth was.
  const stats = useFetch<ItemStats>("/items/stats", { revalidateOn: version });
  const cats = useFetch<{ categories: Category[] }>("/categories");
  const categories = cats.data?.categories ?? [];
  const working = useBusy(list.refreshing);

  const rows = list.data?.items ?? [];
  // "Filed" is the one view the server has no predicate for — `unclassified=1` or everything.
  // Narrowed here rather than adding a parameter for a view that is the complement of one that
  // already exists; the count still comes from stats, so the tab cannot disagree with itself.
  const shown = filter === "classified" ? rows.filter((i) => i.category_id !== null) : rows;
  const total = list.data?.total ?? 0;
  const matching = countFor(filter, stats.data ?? null) ?? total;

  function reset(next: Partial<{ filter: ItemFilter; query: string; offset: number }>) {
    if (next.filter !== undefined) setFilter(next.filter);
    if (next.query !== undefined) setQuery(next.query);
    setOffset(next.offset ?? 0);
    setPicked(new Set());
    setAllMatching(false);
  }

  const selected = allMatching ? matching : picked.size;
  const allOnPage = shown.length > 0 && shown.every((i) => allMatching || picked.has(i.id));

  function toggle(id: string) {
    setPicked((held) => {
      const base = allMatching ? new Set(shown.map((i) => i.id)) : new Set(held);
      if (base.has(id)) base.delete(id);
      else base.add(id);
      return base;
    });
    setAllMatching(false);
  }

  async function file(categoryId: number | null) {
    if (selected === 0) return;
    setBusy(true);
    setError(null);
    try {
      // The SET, or the FILTER that describes it. Sending ids for "all matching" would send the
      // fifty this page happens to hold and silently file only those.
      await mutate<{ filed: number }>("/items/category", {
        method: "POST",
        body: JSON.stringify(
          allMatching
            ? {
                category_id: categoryId,
                q: term === "" ? undefined : term,
                unclassified: filter === "unclassified",
              }
            : { category_id: categoryId, item_ids: [...picked].map(Number) },
        ),
      });
      setPicked(new Set());
      setAllMatching(false);
      // Categories move allocation-derived numbers everywhere, and the summary strip lives in
      // another subtree — see ledgerVersion.tsx. This also re-reads the list and the counts.
      bump();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function fileOne(item: Item, categoryId: number | null) {
    setBusy(true);
    setError(null);
    try {
      await mutate(`/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ category_id: categoryId }),
      });
      bump();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const label = ITEM_FILTERS.find((f) => f.id === filter)?.label ?? "all";

  return (
    <div>
      <div className="busybar" aria-hidden="true">
        <i />
      </div>

      <div className="sect">
        <span>Products</span>
        <span className="soft mono catalogue-said">
          {stats.data === null
            ? ""
            : `${stats.data.total} products · ${stats.data.aliases} spellings` +
              (stats.data.open_proposals > 0 ? ` · ${stats.data.open_proposals} to merge` : "")}
        </span>
      </div>

      <div className="tf-tabs">
        {ITEM_FILTERS.map((f) => {
          const n = countFor(f.id, stats.data ?? null);
          return (
            <button
              key={f.id}
              className={"tf-tab" + (n === 0 && filter !== f.id ? " zero" : "")}
              aria-current={filter === f.id}
              onClick={() => reset({ filter: f.id })}
            >
              {f.label} <b className="mono">{n ?? "—"}</b>
            </button>
          );
        })}
        <input
          className="search tf-search"
          value={query}
          placeholder="Search a product, or any spelling of it"
          onChange={(e) => reset({ query: e.target.value })}
        />
      </div>

      {/* ALWAYS ON SCREEN, dimmed when nothing is ticked. A bar that appears on the first tick
          pushes the table down under the cursor that just ticked it. */}
      <div className="finder-bar">
        <span className="finder-tally">
          {selected === 0 ? (
            <span className="soft">Nothing selected — tick rows to file several at once</span>
          ) : (
            <span>
              selected <b className="mono">{selected}</b>
              <span className="soft"> of {matching}</span>
            </span>
          )}
        </span>

        {/* Ticking the header takes the page; this says so and offers the rest, so neither
            answer is ever the silent one. */}
        {allOnPage && !allMatching && matching > shown.length && (
          <span className="finder-warn">
            All {shown.length} on this page.{" "}
            <button className="btn-ghost" onClick={() => setAllMatching(true)}>
              Select all {matching} in “{label}”
            </button>
          </span>
        )}
        {allMatching && (
          <span className="finder-warn credit">
            All {matching} in “{label}” — not just this page.
          </span>
        )}

        <span className="finder-actions">
          {error !== null && <span className="debit save-error">{error}</span>}
          {selected > 0 && (
            <button className="btn-ghost" disabled={busy} onClick={() => reset({ offset })}>
              Clear
            </button>
          )}
          <CategorySelect
            value={null}
            categories={categories}
            disabled={busy || selected === 0}
            placeholder={busy ? "Filing…" : `File ${selected} under…`}
            onChange={(id) => void file(id)}
          />
        </span>
      </div>

      {list.error !== null && <p className="note">{list.error}</p>}
      {cats.error !== null && <p className="note">Categories could not be read — {cats.error}</p>}

      <div className={working || list.isStale ? "is-stale" : undefined}>
        <table className="record-table">
          <colgroup>
            <col style={{ width: "38px" }} />
            <col />
            <col style={{ width: "72px" }} />
            <col style={{ width: "84px" }} />
            <col style={{ width: "224px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allOnPage}
                  onChange={() =>
                    allOnPage
                      ? reset({ offset })
                      : setPicked(new Set(shown.map((i) => i.id)))
                  }
                  aria-label="Select every product on this page"
                />
              </th>
              <th>Product</th>
              <th className="r">Bought</th>
              <th className="r">Spellings</th>
              <th>Category</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => (
              <tr key={item.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={allMatching || picked.has(item.id)}
                    onChange={() => toggle(item.id)}
                    aria-label={`Select ${item.canonical_name}`}
                  />
                </td>
                {/* The NORMALISED key leads, because it is the identity everything else keys
                    on. The merchant's own words sit under it, and only where they say
                    something different — an identical second line is a wasted one. */}
                <td title={item.display_name ?? item.canonical_name}>
                  <span className="clip">{item.canonical_name}</span>
                  {item.display_name !== null &&
                    item.display_name.toLowerCase() !== item.canonical_name && (
                      <div className="soft mono clip sub-line">{item.display_name}</div>
                    )}
                </td>
                <td className="r mono soft">{item.times_seen}</td>
                <td className="r mono soft">{item.alias_count}</td>
                <td>
                  <CategorySelect
                    value={item.category_id === null ? null : Number(item.category_id)}
                    categories={categories}
                    disabled={busy}
                    placeholder="No category yet"
                    onChange={(id) => void fileOne(item, id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!list.loading && shown.length === 0 && (
          <p className="soft batch-empty">
            {term === "" ? `Nothing in “${label}”.` : `Nothing matches “${term}”.`}
          </p>
        )}
      </div>

      <Pager
        offset={offset}
        limit={PAGE}
        total={total}
        shown={shown.length}
        onOffset={(next) => {
          setOffset(next);
          setPicked(new Set());
          setAllMatching(false);
        }}
        unit="products"
        busy={working}
      />
    </div>
  );
}
