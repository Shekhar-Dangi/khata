import { useState } from "react";

import TransactionTable from "./TransactionTable";
import CategorySelect from "./CategorySelect";
import SpreadBadge from "./SpreadBadge";
import type { Category, Txn } from "./transactions";
import type { Candidate } from "./rules";

// How many preview rows to render inside an expanded candidate.
//
// PAGE SIZE, not overflow, is what keeps a drill-down short: nesting a scroll frame inside
// the candidates frame makes the wheel pick the inner one and the outer list appear stuck.
const PREVIEW_ROWS = 25;

type Preview = {
  transactions: Txn[];
  total: number;
  user_locked: number;
  would_explain: number;
};

/** "amazon india" -> "Amazon India" — a starting name, editable before saving. */
const titleCase = (value: string) =>
  value.replace(/\b\w/g, (ch) => ch.toUpperCase());

export default function CandidateRow({
  candidate,
  categories,
  onCreated,
}: {
  candidate: Candidate;
  categories: Category[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [name, setName] = useState(titleCase(candidate.value));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const conditions = [
    { field: "narration", op: "contains", value: candidate.value },
  ];

  // The dry run is MANDATORY, and the way it is enforced is that creating LIVES INSIDE it.
  // A separate "create" control in the row would let you act on a summary — and both traps
  // found while mining (the "BRANCH ATM SERVICE" boilerplate, the discarded `amazon`) were
  // invisible in the summary and obvious in the rows. Keeping the action where the
  // evidence is means there is no state to remember and nothing to leave behind on
  // collapse: close the panel and the offer to create closes with it.
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next || preview !== null) return;
    setLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch("/rules/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conditions, match_mode: "all" }),
      });
      // A missing Vite proxy path answers 200 with index.html, so the status alone proves
      // nothing here — parse the body and let a non-JSON response be the error.
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `request failed: ${res.status}`);
      setPreview(body as Preview);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setLoading(false);
    }
  }

  async function create() {
    if (categoryId == null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          conditions,
          match_mode: "all",
          category_id: categoryId,
          // A more specific candidate must outrank a broader one that also matches.
          // chooseWinner orders by priority DESC first, and both rules carry exactly one
          // condition, so specificity cannot break the tie — priority is the only lever.
          priority: candidate.words > 1 ? 10 : 0,
          enabled: true,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `request failed: ${res.status}`);
      onCreated();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not create the rule");
      setSaving(false);
    }
  }

  const shown = preview?.transactions.slice(0, PREVIEW_ROWS) ?? [];

  return (
    <>
      <tr className={open ? "cand-row open" : "cand-row"}>
        <td>
          <button className="cand-toggle" onClick={toggle} aria-expanded={open}>
            <span className="chev">{open ? "▾" : "▸"}</span>
            <span className="mono cand-value">{candidate.value}</span>
          </button>
          {candidate.collidesWith && (
            <span className="cand-collide">covered by “{candidate.collidesWith}”</span>
          )}
        </td>
        <td className="num">{candidate.unexplainedHits}</td>
        <td className="num soft">{candidate.ledgerHits}</td>
        <td className="cand-spread">
          <SpreadBadge spread={candidate.spread} detail={candidate.spreadDetail} />
        </td>
      </tr>

      {open && (
        <tr className="cand-detail">
          <td colSpan={4}>
            {loading && <p className="soft">Loading the dry run…</p>}
            {previewError && <p className="debit">{previewError}</p>}
            {preview && (
              <>
                <p className="soft cand-impact">
                  Matches <b>{preview.total}</b> transactions · would newly explain{" "}
                  <b>{preview.would_explain}</b>
                  {preview.user_locked > 0 && (
                    <>
                      {" "}
                      · skips <b>{preview.user_locked}</b> you explained yourself
                    </>
                  )}
                </p>

                <div className="cand-form">
                  <label className="cand-field">
                    <span>Rule name</span>
                    <input
                      className="cand-input"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={saving}
                    />
                  </label>
                  <label className="cand-field">
                    <span>Category</span>
                    <CategorySelect
                      value={categoryId}
                      categories={categories}
                      onChange={setCategoryId}
                      placeholder="Assign to…"
                      disabled={saving}
                    />
                  </label>
                  <button
                    className="btn"
                    onClick={create}
                    disabled={saving || categoryId == null || name.trim() === ""}
                  >
                    {saving ? "Creating…" : "Create rule"}
                  </button>
                  {saveError && <span className="debit save-error">{saveError}</span>}
                </div>

                <TransactionTable
                  rows={shown}
                  frame={false}
                  onSaved={onCreated}
                  emptyMessage="This rule would match nothing."
                />
                {preview.total > shown.length && (
                  <p className="soft cand-more">
                    Showing {shown.length} of {preview.total}.
                  </p>
                )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
