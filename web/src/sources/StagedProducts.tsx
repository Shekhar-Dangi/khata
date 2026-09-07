import { useMemo, useState } from "react";

import CategorySelect from "../shared/CategorySelect";
import Pager from "../shared/Pager";
import { errorText, mutate } from "../shared/api";
import { rupees } from "../shared/format";
import type { Category } from "../shared/transactions";
import {
  ITEM_FILTERS,
  type ItemFilter,
  type StagedItem,
  inFilter,
  itemVerdict,
} from "./stagedItems";

// THE PRODUCTS IN THE INBOX — every product the staged set will touch, once.
//
// The unit of work is the PRODUCT, not the line. 365 goods lines in the real corpus resolve to
// 234 products; a category belongs to the product, so filing per line means answering the same
// question up to a dozen times and getting a different answer on the twelfth. Walking the
// orders tab means meeting the same milk six times. This tab is the fast lane, and on a big
// drop it is the only one most people need.
//
// EVERYTHING IS FILTERED, SEARCHED AND PAGED HERE, not on the server, and that is a decision
// rather than a shortcut:
//
//   The server cannot page the WORK, only the output. `listStagedItems` loads every staged
//   record, groups all lines into products in memory, and then resolves each group against the
//   catalogue — grouping needs all the lines, `needs_input` is only knowable after resolution,
//   and "most-bought first" is a global sort. LIMIT/OFFSET would save serialising two hundred
//   objects and no database work at all.
//
//   Paged counts would describe a different set from the page. This codebase has already paid
//   for that once — see the note on `listStaged` in src/staging.ts, where paging in SQL made
//   the same inbox report "1 need you" on one page size and "0" on another. Six chips each
//   needing an exact count is five more round trips, or a second pass that can disagree with
//   the first. One array answers all six chips AND the table, so they cannot disagree.
//
//   "Select all 234" has to mean a set, not a promise. Resolution is recomputed per request
//   against a catalogue that moves as you file things, so a bulk action that travelled as a
//   FILTER would act on a set nobody had seen. Holding it here sends the exact keys.
//
// The catalogue page (`GET /items`) is the opposite case and is server-paged, correctly: it is
// an archive that grows forever and its filters are SQL predicates on indexed columns. Inbox is
// a bounded working set; catalogue is an unbounded archive. Two patterns, each where it belongs.

/** Products per page. Large on purpose: this is a list you sweep, not one you read. */
const PAGE = 100;

export default function StagedProducts({
  all,
  loading,
  error: readError,
  stale,
  categories,
  onFiled,
}: {
  /** Fetched by the parent: the tab label needs the count before anyone opens the tab. */
  all: StagedItem[];
  loading: boolean;
  error: string | null;
  stale: boolean;
  categories: Category[];
  /** A category landed on a product — the orders tab shows the same fact and must re-read. */
  onFiled: () => void;
}) {
  const [filter, setFilter] = useState<ItemFilter>("needs");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  // Selection is a SET OF KEYS plus a flag for "everything that matches", because those are two
  // different facts and collapsing them is the bug this screen exists to fix. `allMatching` is
  // resolved to real keys at the moment of writing, never left as an intention.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What this screen has filed since it loaded. The response is a snapshot; a row the person
  // just categorised has to stop saying "no category yet" without waiting for a refetch.
  const [filed, setFiled] = useState<Map<string, { id: number; name: string } | null>>(new Map());

  // The response, with this screen's own writes laid over it. Done once, here, so every count,
  // every chip and every row read the same array — the whole reason filtering is local.
  const items = useMemo(() => {
    if (filed.size === 0) return all;
    return all.map((i) => {
      if (i.item_id === null || !filed.has(i.item_id)) return i;
      const next = filed.get(i.item_id) ?? null;
      return { ...i, category: next === null ? null : { id: String(next.id), name: next.name } };
    });
  }, [all, filed]);

  const needle = query.trim().toLowerCase();
  const searched = useMemo(
    () =>
      needle === ""
        ? items
        : items.filter(
            (i) =>
              i.description.toLowerCase().includes(needle) ||
              (i.item_name ?? "").toLowerCase().includes(needle) ||
              (i.sku ?? "").toLowerCase().includes(needle),
          ),
    [items, needle],
  );
  const matching = useMemo(
    () => searched.filter((i) => inFilter(i, filter)),
    [searched, filter],
  );
  const page = matching.slice(offset, offset + PAGE);

  // Which rows are ticked right now. ONE definition, so the header box, the strip and the
  // bulk action cannot disagree about the set they act on — the disagreement that made
  // "select all" mean ten.
  const chosen = allMatching ? matching : matching.filter((i) => picked.has(i.key));
  // Only a product that already EXISTS can be filed: there is no id to PATCH until confirm
  // creates one. Said as a number rather than enforced silently.
  const fileable = chosen.filter((i) => i.item_id !== null);

  function reset(next: Partial<{ filter: ItemFilter; query: string }>) {
    if (next.filter !== undefined) setFilter(next.filter);
    if (next.query !== undefined) setQuery(next.query);
    setOffset(0);
    setPicked(new Set());
    setAllMatching(false);
  }

  function toggle(key: string) {
    setPicked((held) => {
      // Resolving "everything" down to real keys the moment one is unticked — otherwise the
      // flag and the set describe different selections and the next write picks one at random.
      const base = allMatching ? new Set(matching.map((i) => i.key)) : new Set(held);
      if (base.has(key)) base.delete(key);
      else base.add(key);
      return base;
    });
    setAllMatching(false);
  }

  function togglePage() {
    const onPage = page.every((i) => allMatching || picked.has(i.key));
    setAllMatching(false);
    setPicked(() => (onPage ? new Set() : new Set(page.map((i) => i.key))));
  }

  async function fileAll(categoryId: number | null) {
    if (fileable.length === 0) return;
    setBusy(true);
    setError(null);
    const name = categoryId === null
      ? null
      : { id: categoryId, name: categories.find((c) => c.id === categoryId)?.name ?? "filed" };
    try {
      const results = await Promise.allSettled(
        fileable.map((i) =>
          mutate(`/items/${i.item_id}`, {
            method: "PATCH",
            body: JSON.stringify({ category_id: categoryId }),
          }),
        ),
      );
      // Only the ones that actually landed. Painting a row as filed because the batch it was in
      // mostly worked is how a screen starts lying about the ledger.
      setFiled((held) => {
        const next = new Map(held);
        results.forEach((r, at) => {
          const id = fileable[at].item_id;
          if (r.status === "fulfilled" && id !== null) next.set(id, name);
        });
        return next;
      });
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) setError(`${failed} of ${fileable.length} could not be filed`);
      onFiled();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function fileOne(item: StagedItem, categoryId: number | null) {
    if (item.item_id === null) return;
    setBusy(true);
    setError(null);
    try {
      await mutate(`/items/${item.item_id}`, {
        method: "PATCH",
        body: JSON.stringify({ category_id: categoryId }),
      });
      setFiled((held) =>
        new Map(held).set(
          item.item_id as string,
          categoryId === null
            ? null
            : {
                id: categoryId,
                name: categories.find((c) => c.id === categoryId)?.name ?? "filed",
              },
        ),
      );
      onFiled();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="soft batch-empty">Reading the products…</p>;
  if (readError !== null) return <p className="note">{readError}</p>;

  const allOnPage = page.length > 0 && page.every((i) => allMatching || picked.has(i.key));
  const pageIsAll = allMatching || (allOnPage && matching.length === page.length);
  const label = ITEM_FILTERS.find((f) => f.id === filter)?.label ?? "all";

  return (
    <>
      <div className="tf-tabs">
        {ITEM_FILTERS.map((f) => {
          const n = searched.filter((i) => inFilter(i, f.id)).length;
          return (
            <button
              key={f.id}
              /* Never removed at zero. The set of things that can be true of a product is the
                 same five words wherever you are, and a chip that vanishes takes the reason
                 the list is empty with it. */
              className={"tf-tab" + (n === 0 && filter !== f.id ? " zero" : "")}
              aria-current={filter === f.id}
              onClick={() => reset({ filter: f.id })}
            >
              {f.label} <b className="mono">{n}</b>
            </button>
          );
        })}
        <input
          className="search tf-search"
          value={query}
          placeholder="Search any spelling, or an ASIN"
          onChange={(e) => reset({ query: e.target.value })}
        />
      </div>

      {/* ALWAYS ON SCREEN, dimmed when nothing is ticked. A bar that appears on first tick
          pushes the table down under the cursor that just ticked it. */}
      <div className="finder-bar">
        <span className="finder-tally">
          {chosen.length === 0 ? (
            <span className="soft">Nothing selected</span>
          ) : (
            <>
              <span>
                selected <b className="mono">{chosen.length}</b>
                <span className="soft"> of {matching.length}</span>
              </span>
              {fileable.length < chosen.length && (
                <span className="soft">
                  <b className="mono">{fileable.length}</b> can be filed now — the rest are
                  created on confirm
                </span>
              )}
            </>
          )}
        </span>

        {/* THE FIX FOR "select all gave me ten". Ticking the header takes the page, and this
            says so and offers the rest — rather than silently meaning one or the other. */}
        {allOnPage && !pageIsAll && (
          <span className="finder-warn">
            All {page.length} on this page.{" "}
            <button className="btn-ghost" onClick={() => setAllMatching(true)}>
              Select all {matching.length} matching “{label}”
            </button>
          </span>
        )}
        {allMatching && (
          <span className="finder-warn credit">
            All {matching.length} matching “{label}” — not just this page.
          </span>
        )}

        <span className="finder-actions">
          {error !== null && <span className="debit save-error">{error}</span>}
          {chosen.length > 0 && (
            <button className="btn-ghost" disabled={busy} onClick={() => reset({})}>
              Clear
            </button>
          )}
          <CategorySelect
            value={null}
            categories={categories}
            disabled={busy || fileable.length === 0}
            placeholder={busy ? "Filing…" : `File ${fileable.length} under…`}
            onChange={(id) => void fileAll(id)}
          />
        </span>
      </div>

      <div className={stale ? "is-stale" : undefined}>
        <table className="record-table">
          <colgroup>
            <col style={{ width: "38px" }} />
            <col />
            <col style={{ width: "150px" }} />
            <col style={{ width: "190px" }} />
            <col style={{ width: "104px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allOnPage}
                  onChange={togglePage}
                  aria-label="Select every product on this page"
                />
              </th>
              <th>Product</th>
              <th>On confirm</th>
              <th>Category</th>
              <th className="r">In this drop</th>
            </tr>
          </thead>
          <tbody>
            {page.map((item) => {
              const verdict = itemVerdict(item);
              const ticked = allMatching || picked.has(item.key);
              return (
                <tr key={item.key} className="txn-row">
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={ticked}
                      onChange={() => toggle(item.key)}
                      aria-label={`Select ${item.description}`}
                    />
                  </td>
                  <td>
                    <span className="clip">{item.item_name ?? item.description}</span>
                    {/* The merchant's own words, only where they differ from the product's —
                        repeating an identical string twice says nothing and costs a line. */}
                    {item.item_name !== null && item.item_name !== item.description && (
                      <div className="soft mono clip sub-line">{item.description}</div>
                    )}
                  </td>
                  <td>
                    <span className={`tag-claim ${verdict}`}>
                      {verdict === "input" ? "needs input" : verdict}
                    </span>
                  </td>
                  <td>
                    {item.item_id === null ? (
                      // Nothing to PATCH: the product does not exist until confirm creates it.
                      // Said, rather than shown as a disabled control inviting a click.
                      <span className="soft">after confirm</span>
                    ) : (
                      <CategorySelect
                        value={item.category === null ? null : Number(item.category.id)}
                        categories={categories}
                        disabled={busy}
                        placeholder="No category yet"
                        onChange={(id) => void fileOne(item, id)}
                      />
                    )}
                  </td>
                  <td className="r">
                    <div className="mono">{rupees(item.total_paise)}</div>
                    <div className="soft mono sub-line">
                      {item.line_count}× · {item.order_refs.length} order
                      {item.order_refs.length === 1 ? "" : "s"}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {matching.length === 0 && (
          <p className="soft batch-empty">Nothing matches “{label}”.</p>
        )}
      </div>

      <Pager
        offset={offset}
        limit={PAGE}
        total={matching.length}
        shown={page.length}
        onOffset={setOffset}
        unit="products"
        busy={stale}
      />
    </>
  );
}
