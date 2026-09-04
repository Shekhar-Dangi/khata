import { useState } from "react";

import CategorySelect from "../shared/CategorySelect";
import { useFetch } from "../shared/useFetch";
import { rupees } from "../shared/format";
import type { Category } from "../shared/transactions";

// What the owner's share of a record was actually for.
//
// THE GAP THIS CLOSES. `source_category_map` translates the source's taxonomy into ours, and
// two of its rows map to NULL on purpose: Splitwise's `General` is a catch-all — anything
// from an appliance to a repair visit to a snack — so ANY single
// mapping would be wrong for most of what it holds. The importer therefore writes only the
// shared slice, and the owner's share stays an unexplained remainder on the transaction.
//
// That rule was decided about IMPORT time, where the question is asked in bulk about rows
// nobody is looking at, and there "do not ask" is right. At REVIEW time it is a different
// question: the description and the amount are on screen, and a person knows perfectly well
// that "Bookshelf" is Furniture. The rule was sound and its scope was too wide — the cost was that
// the owner's share of every General expense had no way to be resolved inside the app at all.
//
// WHAT IT DELIBERATELY DOES NOT OFFER: changing a category the map DID answer. A record's
// allocations are re-derived from the map whenever it is linked again, so an override there
// would be quietly undone the next time anyone touched the link — a decision reversed by a
// machine, which is the one thing the engine's most important invariant forbids. Where the map
// has an answer, the place to change the answer is the map.
//
// The picker is `CategorySelect`, not a second hand-rolled one: it carries a real rule of the
// taxonomy (a parent is selectable as "(general)", so money can land on "Shopping" without
// claiming to know which kind), and a copy that forgot it would offer a different taxonomy on
// a different screen.

export default function CategoryChoice({
  sourceCategory,
  categoryName,
  categoryId,
  canChoose,
  needsCategory,
  sharePaise,
  busy,
  /** Absent while the record has no transaction yet — see the note on the button. */
  onSave,
  value,
  onChange,
}: {
  sourceCategory: string;
  categoryName: string | null;
  categoryId: string | null;
  canChoose: boolean;
  needsCategory: boolean;
  /** The owner's own share, so the prompt can name the money it is about. */
  sharePaise: number;
  busy: boolean;
  onSave?: (categoryId: number, categoryName: string) => void;
  /** Lifted when the parent needs the choice for its own write — the finder does. */
  value?: number | null;
  onChange?: (categoryId: number | null) => void;
}) {
  // Opens on what is already filed, so correcting a choice is a change rather than a re-entry.
  const [own, setOwn] = useState<number | null>(categoryId === null ? null : Number(categoryId));
  const controlled = onChange !== undefined;
  const chosen = controlled ? (value ?? null) : own;
  const set = controlled ? onChange : setOwn;

  // Only fetched where a choice is actually offered. Every expanded row asking for the
  // category tree would be a request per row for a list most of them never show.
  const cats = useFetch<{ categories: Category[] }>("/categories", { enabled: canChoose });

  if (!canChoose) {
    // Nothing to ask and nothing to correct. A settlement reaches here with no category at
    // all — it is a transfer between people, not spending — so it says nothing rather than
    // showing an empty field.
    if (categoryName === null) return null;
    return (
      <p className="soft category-said">
        Your share is filed under <b>{categoryName}</b>, from the source category{" "}
        <i>{sourceCategory}</i>.
      </p>
    );
  }

  return (
    <div className="category-choice">
      <p className="category-prompt">
        {needsCategory ? (
          <>
            <span className="flag">
              <b className="mono">{rupees(Math.abs(sharePaise))}</b> of this is yours and
              unexplained
            </span>{" "}
            — <i>{sourceCategory}</i> is a catch-all in the source, so nothing can say what it
            was but you.
          </>
        ) : (
          <>
            Your share is filed under <b>{categoryName}</b> — your answer, not the source's,
            because <i>{sourceCategory}</i> is a catch-all. Change it here.
          </>
        )}
      </p>
      <div className="category-row">
        <CategorySelect
          value={chosen}
          categories={cats.data?.categories ?? []}
          onChange={(id) => set?.(id)}
          placeholder={cats.loading ? "Loading…" : "Pick a category…"}
          disabled={busy || cats.loading}
        />
        {/* Absent when the parent is doing the writing. The finder links and categorises in
            ONE request, because a category chosen against a record that turns out not to link
            would be a value written for a row that does not exist yet. */}
        {onSave !== undefined && (
          <button
            className="btn-secondary"
            disabled={busy || chosen === null}
            // The NAME as well as the id: the caller reports what just happened in words,
            // and this is the only place that already holds the category list.
            onClick={() =>
              chosen !== null &&
              onSave(
                chosen,
                cats.data?.categories.find((c) => c.id === chosen)?.name ?? "a category",
              )
            }
          >
            {busy ? "Saving…" : "Save category"}
          </button>
        )}
      </div>
      {cats.error !== null && <p className="note">{cats.error}</p>}
    </div>
  );
}
