import { useState } from "react";

import { useFetch } from "./useFetch";
import { useLedgerVersion } from "./ledgerVersion";

export type CategoryNode = {
  id: number;
  name: string;
  parent_id: number | null;
  parent_name: string | null;
  children: number;
  allocations: number;
  rules: number;
};

// The category tree, editable.
//
// The starter tree in db/categories.sql is a STARTER, not a schema. Someone else's idea
// of how spending divides up is a guess about a stranger's life, and the moment it does
// not fit, the honest thing to do is change it — so every row here can be renamed,
// moved, or deleted, and new ones added at either level.
//
// Two levels, enforced by the API. It is not an arbitrary cap: the report rolls a parent
// up as "this category or its direct children", so a third level's money would appear in
// no bar at all. A depth limit is easier to explain than a silent hole in a total.
export default function CategoriesView() {
  const { bump } = useLedgerVersion();
  const cats = useFetch<{ categories: CategoryNode[] }>("/categories");
  const [adding, setAdding] = useState<number | null | "top">(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A delete that turned out to need a destination, mid-question. Not a window.prompt:
  // this app draws its own everything, and a native dialog freezes the page while open.
  const [reassigning, setReassigning] = useState<{
    cat: CategoryNode;
    allocations: number;
    rules: number;
  } | null>(null);

  if (cats.loading) return <p className="soft">Loading…</p>;
  if (cats.error) return <p className="soft">{cats.error}</p>;

  const all = cats.data?.categories ?? [];
  const parents = all.filter((c) => c.parent_id === null);

  // Every mutation here can change what the reports show (a rename retitles a bar, a
  // delete-with-reassign moves money between them), so the ledger version is bumped
  // rather than just refetching this list.
  async function mutate(
    url: string,
    init: RequestInit,
  ): Promise<Record<string, unknown> | null> {
    setError(null);
    const res = await fetch(url, init);
    // Parse the BODY. Through the Vite dev proxy an unlisted path answers 200 with
    // index.html, so res.ok on its own proves nothing.
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (!res.ok) {
      setError(typeof body.error === "string" ? body.error : `failed: ${res.status}`);
      return null;
    }
    await cats.refetch();
    bump();
    return body;
  }

  async function save(id: number, name: string, parentId: number | null) {
    const done = await mutate(`/categories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parent_id: parentId }),
    });
    if (done !== null) setEditingId(null);
  }

  async function create(name: string, parentId: number | null) {
    const done = await mutate("/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parent_id: parentId }),
    });
    if (done !== null) setAdding(null);
  }

  // A category in use is holding real explanations and rules. Deleting it is therefore a
  // decision about where that money GOES, not a yes/no.
  //
  // The SERVER is what knows: it refuses with 409 and the counts. We turn its refusal
  // into the question rather than re-deriving "is this in use?" in the browser, where the
  // answer would be one render out of date the moment a rule fires.
  async function remove(c: CategoryNode) {
    setError(null);
    setReassigning(null);
    const res = await fetch(`/categories/${c.id}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (res.ok) {
      await cats.refetch();
      bump();
      return;
    }
    if (res.status === 409 && body.error === "category is in use") {
      setReassigning({
        cat: c,
        allocations: Number(body.allocations),
        rules: Number(body.rules),
      });
      return;
    }
    setError(typeof body.error === "string" ? body.error : `failed: ${res.status}`);
  }

  async function removeWithReassign(c: CategoryNode, targetId: number) {
    const done = await mutate(`/categories/${c.id}?reassign_to=${targetId}`, {
      method: "DELETE",
    });
    if (done !== null) setReassigning(null);
  }

  return (
    <>
      <div className="rules-head">
        <h2>Categories</h2>
        <p className="soft rules-intro">
          A starting set, not a schema. Rename, re-file or delete anything that does not
          match how you think about your money.
        </p>
        <div className="head-actions">
          <button className="btn" onClick={() => setAdding("top")}>
            ＋ New top-level category
          </button>
        </div>
      </div>

      {error && <p className="note">{error}</p>}

      {reassigning && (
        <ReassignPrompt
          // Remount when the target changes, so the destination picker never carries a
          // choice made about a different category.
          key={reassigning.cat.id}
          target={reassigning}
          options={all.filter((o) => o.id !== reassigning.cat.id)}
          onCancel={() => setReassigning(null)}
          onConfirm={(id) => removeWithReassign(reassigning.cat, id)}
        />
      )}

      <div className="cat-tree">
        {adding === "top" && (
          <CategoryEditor
            initialName=""
            onCancel={() => setAdding(null)}
            onSave={(name) => create(name, null)}
          />
        )}

        {parents.map((p) => (
          <div className="cat-group" key={p.id}>
            {editingId === p.id ? (
              <CategoryEditor
                initialName={p.name}
                onCancel={() => setEditingId(null)}
                onSave={(name) => save(p.id, name, null)}
              />
            ) : (
              <Row
                cat={p}
                onEdit={() => setEditingId(p.id)}
                onDelete={() => remove(p)}
                extra={
                  <button className="link-btn" onClick={() => setAdding(p.id)}>
                    ＋ sub
                  </button>
                }
              />
            )}

            {all
              .filter((c) => c.parent_id === p.id)
              .map((c) =>
                editingId === c.id ? (
                  <CategoryEditor
                    key={c.id}
                    initialName={c.name}
                    parents={parents}
                    parentId={p.id}
                    onCancel={() => setEditingId(null)}
                    onSave={(name, parentId) => save(c.id, name, parentId)}
                  />
                ) : (
                  <Row
                    key={c.id}
                    cat={c}
                    child
                    onEdit={() => setEditingId(c.id)}
                    onDelete={() => remove(c)}
                  />
                ),
              )}

            {adding === p.id && (
              <CategoryEditor
                initialName=""
                onCancel={() => setAdding(null)}
                onSave={(name) => create(name, p.id)}
              />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function Row({
  cat,
  child = false,
  onEdit,
  onDelete,
  extra,
}: {
  cat: CategoryNode;
  child?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  extra?: React.ReactNode;
}) {
  // Only what is TRUE of this row. The list previously wrote "unused" against every empty
  // category, which is most of them on a fresh install — twenty-odd lines of grey text
  // saying nothing, in a list whose job is to let you find one name and change it.
  // Silence is the correct rendering of zero.
  const used = cat.allocations > 0 || cat.rules > 0;

  return (
    <div className={"cat-row " + (child ? "child" : "parent")}>
      <span className="cat-label">{cat.name}</span>
      {used ? (
        <span
          className="cat-usage"
          title={`${cat.allocations} explanation${cat.allocations === 1 ? "" : "s"}, ${cat.rules} rule${cat.rules === 1 ? "" : "s"}`}
        >
          {cat.allocations > 0 && cat.allocations}
          {cat.rules > 0 && <em>{cat.rules}r</em>}
        </span>
      ) : (
        <span />
      )}
      {/* Always visible — see the rationale on `.cat-actions` in index.css. Hiding these
          until hover was tried and reverted, because an action you cannot see is an
          action you do not know exists and on this screen the actions are the point.
          (This comment used to describe the reverted hover behaviour and pointed at an
          @media rule that does not exist.) */}
      <span className="cat-actions">
        {extra}
        <button className="link-btn" onClick={onEdit}>
          rename
        </button>
        <button className="link-btn danger" onClick={onDelete}>
          delete
        </button>
      </span>
    </div>
  );
}

// The inline editor. Its own component so its draft state lives beside the input —
// typing a category name re-renders one row, not the whole tree.
function CategoryEditor({
  initialName,
  parents,
  parentId,
  onCancel,
  onSave,
}: {
  initialName: string;
  /** Present only when the row can be re-filed — a top-level row with children cannot. */
  parents?: CategoryNode[];
  parentId?: number | null;
  onCancel: () => void;
  onSave: (name: string, parentId: number | null) => void;
}) {
  const [name, setName] = useState(initialName);
  const [parent, setParent] = useState<string>(
    parentId === undefined || parentId === null ? "" : String(parentId),
  );

  return (
    <div className="cat-edit">
      <input
        autoFocus
        value={name}
        placeholder="Category name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim() !== "") {
            onSave(name.trim(), parent === "" ? null : Number(parent));
          }
          if (e.key === "Escape") onCancel();
        }}
      />
      {parents !== undefined && (
        <select
          className="cat-select"
          value={parent}
          onChange={(e) => setParent(e.target.value)}
        >
          <option value="">— top level —</option>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              under {p.name}
            </option>
          ))}
        </select>
      )}
      <button
        className="btn"
        disabled={name.trim() === ""}
        onClick={() => onSave(name.trim(), parent === "" ? null : Number(parent))}
      >
        Save
      </button>
      <button className="link-btn" onClick={onCancel}>
        cancel
      </button>
    </div>
  );
}

// "Where should this money go?" — the second half of deleting a category that is in use.
//
// Nothing is selected by default, on purpose. A pre-filled destination is a decision made
// for you by alphabetical accident, and what is being moved is every explanation you ever
// wrote in this category.
function ReassignPrompt({
  target,
  options,
  onCancel,
  onConfirm,
}: {
  target: { cat: CategoryNode; allocations: number; rules: number };
  options: CategoryNode[];
  onCancel: () => void;
  onConfirm: (id: number) => void;
}) {
  const [choice, setChoice] = useState("");
  const { cat, allocations, rules } = target;
  const holds = [
    allocations > 0 ? `${allocations} explanation${allocations === 1 ? "" : "s"}` : null,
    rules > 0 ? `${rules} rule${rules === 1 ? "" : "s"}` : null,
  ]
    .filter((x) => x !== null)
    .join(" and ");

  return (
    <div className="note">
      <div className="reassign-said">
        <b>{cat.name}</b> holds {holds}. Deleting it has to move them somewhere.
      </div>
      <div className="kw-add">
        <select
          className="cat-select"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">Move them to…</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.parent_name ? `${o.parent_name} > ${o.name}` : o.name}
            </option>
          ))}
        </select>
        <button
          className="btn"
          disabled={choice === ""}
          onClick={() => onConfirm(Number(choice))}
        >
          Move and delete
        </button>
        <button className="link-btn" onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  );
}
