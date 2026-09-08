import { useRef, useState } from "react";

import { useDebounced, useFetch } from "../shared/useFetch";

// A CELL you can type into — the catalogue picker, sized to live inside a table row.
//
// It replaces a panel that opened underneath the row. That panel worked, and it cost the two
// things a review screen cannot spare: opening one pushed every row below it down the page, and
// answering a line meant open, read, choose, close — four actions for a question whose answer is
// usually one word. A row that changes height while you are reading the row under it is the
// same flicker the rest of this screen has been spent removing.
//
// THE EMPTY BOX IS AN ANSWER. Nothing selected means "no catalogue item matched, so one will be
// created", which is what the resolver already decided and by far the commonest outcome — 230 of
// 230 items on the first real drop. That is why there is no "make it a new product" control
// anywhere: it would be a button for the state you are already in.
//
// The list only ever opens on a real query. A blank box fetching "the first page of everything"
// would be a request nobody asked for, on a catalogue that grows forever.

/** What `GET /items` returns, of the little this needs. */
type CatalogueItem = {
  id: string;
  display_name: string | null;
  canonical_name: string;
  category_name: string | null;
};

/** How many suggestions are worth showing. Past this a person retypes rather than scrolls. */
const LIMIT = 6;

export default function ItemCombo({
  value,
  itemId,
  suggestions = [],
  placeholder = "New product",
  onPick,
  disabled = false,
}: {
  /** The catalogue item currently chosen, by name. Null means "none — create one". */
  value: string | null;
  /** Its id, shown beside the name: the only way to tell two same-named products apart. */
  itemId: string | null;
  /**
   * What the RESOLVER thought this line might be, with how alike the strings are.
   *
   * These are the reason a line is marked "needs input" at all, and they were lost when this
   * control replaced the panel that used to list them — leaving the box empty on exactly the
   * lines where the app had an opinion and no way to say it. Shown before anything is typed,
   * because that is when they are the answer.
   */
  suggestions?: { item_id: string; name: string; similarity: number }[];
  placeholder?: string;
  /** Null clears the choice, which is the same as saying "make a new product". */
  onPick: (item: { id: string; name: string } | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);

  // Debounced, because this fires per keystroke against a table that may hold a hundred of
  // these. `enabled` is the safety rule: an empty box makes no request at all.
  const term = useDebounced(query.trim(), 200);
  const search = useFetch<{ items: CatalogueItem[]; total: number }>(
    `/items?q=${encodeURIComponent(term)}&limit=${LIMIT}`,
    { enabled: open && term !== "", keepPreviousData: true },
  );
  const results = search.data?.items ?? [];

  function choose(item: CatalogueItem | null) {
    onPick(
      item === null
        ? null
        : { id: item.id, name: item.display_name ?? item.canonical_name },
    );
    setQuery("");
    setOpen(false);
  }

  return (
    <div
      className="combo"
      ref={box}
      // Closing on blur has to survive the click that caused it: a mousedown inside the panel
      // blurs the input before the click lands, so a naive onBlur would close the list and the
      // choice would never register. relatedTarget tells us whether focus is still inside.
      onBlur={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setQuery("");
        }
      }}
    >
      <input
        className="combo-input"
        disabled={disabled}
        value={open ? query : (value ?? "")}
        placeholder={value === null ? placeholder : ""}
        // SEEDED with what is already chosen, not blanked. Focusing used to empty the cell,
        // which read as "your answer is gone" and made the commonest edit — narrow an existing
        // choice by a word — impossible without retyping the whole name. The seed also gives
        // the search something to run on straight away, so the list opens on the product you
        // already have rather than on an instruction to start typing.
        onFocus={() => {
          setQuery(value ?? "");
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setQuery("");
          }
        }}
        aria-label="Find a product in your catalogue"
      />

      {/* Clearing has to be reachable from the CELL. It was only offered at the bottom of the
          open list, which meant undoing a choice was: focus, read past the suggestions, click.
          A cross on the thing you want rid of is the whole gesture. */}
      {value !== null && (
        <button
          type="button"
          className="combo-clear-x"
          title="Clear — make it a new product"
          aria-label="Clear the chosen product"
          // mousedown, not click: the input's blur fires first on a click and would close the
          // panel and reset the query before the handler ever ran.
          onMouseDown={(e) => {
            e.preventDefault();
            choose(null);
          }}
        >
          ×
        </button>
      )}

      {/* The id, always, and never inside the input — a person checking whether two orders
          really reached the same product has nothing else to compare, and it must not be
          something they have to delete before they can type. */}
      {value !== null && itemId !== null && !open && (
        <span className="combo-id mono soft">#{itemId}</span>
      )}

      {open && (
        <div className="combo-pop">
          {/* Every branch renders SOMETHING. The loading case used to fall through to an empty
              `results.map`, which drew a bordered box six pixels tall under the input and
              looked exactly like a broken popover — the one state a search box must never be
              in is "open, and apparently empty for no reason". */}
          {term === "" && suggestions.length > 0 ? (
            <>
              <p className="combo-said soft">We think it might be one of these</p>
              {suggestions.map((c) => (
                <button
                  key={c.item_id}
                  type="button"
                  className="combo-hit"
                  onClick={() => {
                    onPick({ id: c.item_id, name: c.name });
                    setQuery("");
                    setOpen(false);
                  }}
                >
                  <span className="clip">{c.name}</span>
                  <span className="soft mono combo-hit-meta">
                    {c.similarity}% alike · #{c.item_id}
                  </span>
                </button>
              ))}
            </>
          ) : term === "" ? (
            <p className="combo-said soft">
              Type to search your catalogue. Leave it empty and a new product is created.
            </p>
          ) : search.loading ? (
            <p className="combo-said soft">Searching…</p>
          ) : search.error !== null ? (
            <p className="combo-said flag">{search.error}</p>
          ) : results.length === 0 ? (
            <p className="combo-said soft">Nothing matches — it will be a new product.</p>
          ) : (
            results.map((item) => (
              <button
                key={item.id}
                type="button"
                className="combo-hit"
                onClick={() => choose(item)}
              >
                <span className="clip">{item.display_name ?? item.canonical_name}</span>
                <span className="soft mono combo-hit-meta">
                  {item.category_name ?? "no category"} · #{item.id}
                </span>
              </button>
            ))
          )}

        </div>
      )}
    </div>
  );
}
