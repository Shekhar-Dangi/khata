import { useMemo, useState } from "react";

import CategorySelect from "../shared/CategorySelect";
import Pager from "../shared/Pager";
import { errorText, mutate } from "../shared/api";
import { rupees } from "../shared/format";
import type { Category } from "../shared/transactions";
import ItemCombo from "./ItemCombo";
import { ITEM_FILTERS, type ItemFilter, type StagedItem, inFilter } from "./stagedItems";

// THE PRODUCTS IN ONE GROUP'S INBOX — every product its orders will touch, once.
//
// The unit of work is the PRODUCT, not the line. 365 goods lines in the real corpus resolve to
// 234 products; a category belongs to the product, so filing per line means answering the same
// question up to a dozen times and getting a different answer on the twelfth. Walking the
// orders tab means meeting the same milk six times. This tab is the fast lane.
//
// NOTHING IS SELECTED HERE, and that is deliberate. This table had tick boxes and a "file N
// under…" control — a bulk action for a job that is not bulk. Every row already carries its own
// category cell, so ticking eight rows to reach one dropdown was strictly more work than using
// eight dropdowns, and the selection was silently lost on every tab switch because it belonged
// to a tab rather than to the thing being reviewed. The row IS the control.
//
// FILTERING, SEARCH AND PAGING ARE LOCAL. `listStagedItems` loads every staged record, groups
// all lines in memory and resolves each group against the catalogue — grouping needs all the
// lines, `needs_input` is only knowable after resolution, and "most-bought first" is a global
// sort. LIMIT/OFFSET would save serialising two hundred objects and no database work, while
// paged counts would describe a different set from the page (the bug already recorded on
// `listStaged`). One array answers all five chips AND the table, so they cannot disagree.

/** Products per page. Large on purpose: this is a list you sweep, not one you read. */
const PAGE = 100;

export default function StagedProducts({
  all,
  loading,
  error: readError,
  stale,
  categories,
  chosen,
  onMap,
  onFiled,
}: {
  all: StagedItem[];
  loading: boolean;
  error: string | null;
  stale: boolean;
  categories: Category[];
  /** Catalogue items picked here since the page loaded, by normalised key. */
  chosen: Map<string, { id: string; name: string } | null>;
  /**
   * Point every line of every order that reduces to this key at one catalogue item — or at
   * none, which means "create one". THE WHOLE ARGUMENT for this tab: answered here it lands on
   * all twelve sightings at once, instead of twelve times over on the orders tab.
   */
  onMap: (canonical: string, item: { id: string; name: string } | null) => void;
  onFiled: () => void;
}) {
  const [filter, setFilter] = useState<ItemFilter>("needs");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Categories written from here since the list was read. Layered over the response rather than
  // refetched: it is a snapshot, and a row just filed has to stop saying "no category yet"
  // without waiting on a re-read of the most expensive call on the screen.
  const [filed, setFiled] = useState<Map<string, { id: number; name: string } | null>>(new Map());

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
              i.canonical.includes(needle) ||
              (i.item_name ?? "").toLowerCase().includes(needle) ||
              (i.sku ?? "").toLowerCase().includes(needle),
          ),
    [items, needle],
  );
  const matching = useMemo(() => searched.filter((i) => inFilter(i, filter)), [searched, filter]);
  const page = matching.slice(offset, offset + PAGE);

  async function fileOne(item: StagedItem, categoryId: number | null) {
    if (item.item_id === null) return;
    setBusy(true);
    setError(null);
    try {
      // PATCH /items/:id — an integer or an explicit null, which is a real answer ("no category
      // yet"), not a missing one. The route defaults `category_source` to 'user', the
      // provenance a classifier may never overwrite.
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

  const label = ITEM_FILTERS.find((f) => f.id === filter)?.label ?? "all";

  return (
    <>
      <div className="tf-tabs">
        {ITEM_FILTERS.map((f) => {
          const n = searched.filter((i) => inFilter(i, f.id)).length;
          return (
            <button
              key={f.id}
              /* Never removed at zero: that a filter is empty is a fact about the drop, and a
                 chip that vanishes takes the reason the list is empty with it. */
              className={"tf-tab" + (n === 0 && filter !== f.id ? " zero" : "")}
              aria-current={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setOffset(0);
              }}
            >
              {f.label} <b className="mono">{n}</b>
            </button>
          );
        })}
        <input
          className="search tf-search"
          value={query}
          placeholder="Search any spelling, or an ASIN"
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
      </div>

      {error !== null && <p className="note">{error}</p>}

      <div className={stale ? "is-stale" : undefined}>
        <table className="record-table">
          <colgroup>
            {/* Raw value takes what is left, and it needs the most: it is the only column
                whose content is a merchant's untrimmed sentence. The rest are sized to their
                contents so nothing is spent on air. */}
            <col />
            <col style={{ width: "168px" }} />
            <col style={{ width: "188px" }} />
            <col style={{ width: "140px" }} />
            <col style={{ width: "46px" }} />
            <col style={{ width: "54px" }} />
            <col style={{ width: "88px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Raw value</th>
              <th>Normalized</th>
              <th>Catalogue item</th>
              <th>Category</th>
              <th className="r">Lines</th>
              <th className="r">Orders</th>
              <th className="r">Amount</th>
            </tr>
          </thead>
          <tbody>
            {page.map((item) => {
              // A pick made here wins over whatever the resolver proposed — the same precedence
              // the line rows use, and for the same reason: it is the person's own answer.
              const picked = chosen.has(item.canonical)
                ? (chosen.get(item.canonical) ?? null)
                : item.item_id === null
                  ? null
                  : { id: item.item_id, name: item.item_name ?? item.canonical };
              return (
                <tr key={item.key}>
                  {/* The merchant's own words, whole on hover. They run past ninety characters
                      and no column holds that without making every row three lines tall. */}
                  <td title={item.description}>
                    <span className="clip">{item.description}</span>
                    {item.sku !== null && (
                      <div className="soft mono clip sub-line">{item.sku}</div>
                    )}
                  </td>

                  <td title={item.canonical}>
                    <span className="clip mono soft">{item.canonical}</span>
                  </td>

                  <td className="combo-cell">
                    <ItemCombo
                      value={picked === null ? null : picked.name}
                      itemId={picked === null ? null : picked.id}
                      onPick={(next) => onMap(item.canonical, next)}
                    />
                  </td>

                  <td>
                    {item.item_id === null ? (
                      // Nothing to PATCH: the product does not exist until confirm creates it.
                      // Said rather than shown as a disabled control inviting a click.
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

                  <td className="r mono soft">{item.line_count}</td>
                  <td className="r mono soft">{item.order_refs.length}</td>
                  <td className="r mono">{rupees(item.total_paise)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {matching.length === 0 && <p className="soft batch-empty">Nothing matches “{label}”.</p>}
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
