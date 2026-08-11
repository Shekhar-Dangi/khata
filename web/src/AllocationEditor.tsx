import { useState } from "react";

import { rupees } from "./format";

type Allocation = {
  amount_paise: number;
  category_id: number;
  category_name: string;
};
type Category = { id: number; name: string; parent_id: number | null };
type EditorTxn = { id: string; amount_paise: number; allocations: Allocation[] };

// A row is edited as a POSITIVE rupee magnitude (string, so typing "1.5" is smooth);
// the transaction's sign is applied only when we save.
type Row = { category_id: number | null; amount: string };

const paiseOf = (row: Row) =>
  Math.round(Math.abs(parseFloat(row.amount) || 0) * 100);

export default function AllocationEditor({
  transaction,
  categories,
  onSaved,
  onClose,
}: {
  transaction: EditorTxn;
  categories: Category[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const sign = Math.sign(transaction.amount_paise) || 1; // -1 debit / +1 credit

  const [rows, setRows] = useState<Row[]>(
    transaction.allocations.length > 0
      ? transaction.allocations.map((a) => ({
          category_id: a.category_id,
          amount: String(Math.abs(a.amount_paise) / 100),
        }))
      : [{ category_id: null, amount: "" }],
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // --- IMMUTABLE array updates: always build a NEW array/object, never mutate the old.
  //     (React re-renders only when the reference changes.) Use the prev => ... form
  //     because each update is computed from the previous state.
  const addRow = () =>
    setRows((prev) => [...prev, { category_id: null, amount: "" }]);

  const removeRow = (i: number) =>
    setRows((prev) => prev.filter((_, idx) => idx !== i));

  const updateRow = (i: number, patch: Partial<Row>) =>
    setRows((prev) =>
      // map = new array; for row i, {...row, ...patch} = new object; others returned as-is
      prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)),
    );

  // --- DERIVED (computed each render, never stored) ---
  const txnMag = Math.abs(transaction.amount_paise);
  const explainedMag = rows.reduce((s, r) => s + paiseOf(r), 0);
  const remainingMag = txnMag - explainedMag;
  const overAllocated = remainingMag < 0;
  const validRows = rows.filter((r) => r.category_id != null && paiseOf(r) > 0);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const allocations = validRows.map((r) => ({
        category_id: r.category_id,
        amount_paise: paiseOf(r) * sign, // apply the transaction's sign here
      }));
      const res = await fetch(`/transactions/${transaction.id}/allocations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allocations }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `request failed: ${res.status}`);
      }
      onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const parents = categories.filter((c) => c.parent_id == null);

  return (
    <div className="editor">
      {rows.map((row, i) => (
        // Index key is fine here: the inputs are fully controlled (value from state),
        // and rows aren't reordered — only added/removed.
        <div className="editor-row" key={i}>
          <select
            className="cat-select"
            value={row.category_id ?? ""}
            onChange={(e) =>
              updateRow(i, {
                category_id: e.target.value ? Number(e.target.value) : null,
              })
            }
          >
            <option value="">Category…</option>
            {parents.map((p) => (
              <optgroup key={p.id} label={p.name}>
                <option value={p.id}>{p.name} (general)</option>
                {categories
                  .filter((c) => c.parent_id === p.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <span className="rupee">₹</span>
          <input
            className="amt-input mono"
            inputMode="decimal"
            placeholder="0"
            value={row.amount}
            onChange={(e) => updateRow(i, { amount: e.target.value })}
          />
          <button className="row-x" title="remove" onClick={() => removeRow(i)}>
            ✕
          </button>
        </div>
      ))}

      <button className="add-split" onClick={addRow}>
        ＋ add split
      </button>

      <div className="editor-foot">
        <span
          className={
            "remaining " +
            (remainingMag === 0 ? "ok" : overAllocated ? "debit" : "flag")
          }
        >
          {overAllocated
            ? `over by ${rupees(Math.abs(remainingMag))}`
            : remainingMag === 0
              ? "fully explained ✓"
              : `${rupees(remainingMag)} left`}
        </span>
        <span className="editor-actions">
          {saveError && <span className="debit save-error">{saveError}</span>}
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn"
            onClick={save}
            disabled={saving || validRows.length === 0 || overAllocated}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </span>
      </div>
    </div>
  );
}
