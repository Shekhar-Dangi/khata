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
  placeholder = "New product",
  onPick,
  disabled = false,
}: {
  /** The catalogue item currently chosen, by name. Null means "none — create one". */
  value: string | null;
  /** Its id, shown beside the name: the only way to tell two same-named products apart. */
  itemId: string | null;
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
        onFocus={() => setOpen(true)}
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
          {term === "" ? (
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

          {/* Undo, where the thing being undone is visible. Only offered when there IS a
              choice to take back — on a line that resolved to nothing it would clear nothing. */}
          {value !== null && (
            <button type="button" className="combo-hit combo-clear" onClick={() => choose(null)}>
              Clear — make it a new product
            </button>
          )}
        </div>
      )}
    </div>
  );
}
