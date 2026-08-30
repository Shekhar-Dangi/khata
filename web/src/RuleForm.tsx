import { useState } from "react";

import { useFetch } from "./useFetch";
import {
  emptyDraft,
  toCondition,
  toDraft,
  FIELD_LABEL,
  OP_LABEL,
  type Category,
  type Draft,
  type Rule,
  type Vocabulary,
} from "./rules";

// Create OR edit a rule.
//
// One form for both, because they are the same shape: the only differences are where the
// initial values come from, which HTTP verb goes out, and one line of copy. A second
// "EditRuleForm" would be the create form plus a divergence waiting to happen — the
// condition/op snapping logic below is subtle enough that having it in two files means
// having it right in one.
//
// Editing used to mean delete + re-create, which loses the rule's id and with it its
// history in /reports/by-rule. PATCH keeps the row.
//
// ALL form state lives here. That is deliberate: `drafts` used to sit in the parent
// alongside the rules table, so every keystroke re-rendered the table. State only
// re-renders the component that owns it and its children, so moving it down here means
// typing costs exactly this subtree and nothing else.
export default function RuleForm({
  rule,
  onSaved,
  onCancel,
}: {
  /** Absent = create. Present = edit that rule in place. */
  rule?: Rule;
  onSaved: (result: { reapply_needed: boolean }) => void;
  onCancel?: () => void;
}) {
  const cats = useFetch<{ categories: Category[] }>("/categories");
  const vocab = useFetch<Vocabulary>("/rules/vocabulary");

  const editing = rule !== undefined;
  // The initialisers run on the first render only, so this reads the rule once and the
  // form is uncontrolled by it from then on — typing is not fighting a prop.
  const [name, setName] = useState(rule?.name ?? "");
  const [categoryId, setCategoryId] = useState<number | null>(rule?.category_id ?? null);
  const [priority, setPriority] = useState(String(rule?.priority ?? 0));
  const [matchMode, setMatchMode] = useState(rule?.match_mode ?? "all");
  const [drafts, setDrafts] = useState<Draft[]>(
    rule === undefined ? [emptyDraft()] : rule.conditions.map(toDraft),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Immutable updates: a new array, and a new object for the row that changed. React
  // re-renders on reference change, so mutating in place would update nothing.
  const addDraft = () => setDrafts((prev) => [...prev, emptyDraft()]);
  const removeDraft = (i: number) =>
    setDrafts((prev) => prev.filter((_, idx) => idx !== i));

  const updateDraft = (i: number, patch: Partial<Draft>) =>
    setDrafts((prev) =>
      prev.map((d, idx) => {
        if (idx !== i) return d;
        const next = { ...d, ...patch };
        // Switching field can strand an op that is illegal for it — `contains` on a
        // number. Snap to a legal op instead of letting you submit a request the API
        // would reject: make the invalid state unreachable, not merely refused.
        if (patch.field !== undefined) {
          const legal = vocab.data?.ops_by_field[next.field] ?? [];
          if (!legal.includes(next.op)) next.op = legal[0] ?? next.op;
          next.value = "";
        }
        return next;
      }),
    );

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        conditions: drafts.map(toCondition),
        match_mode: matchMode,
        category_id: categoryId,
        priority: Number(priority) || 0,
      };
      const res = await fetch(editing ? `/rules/${rule.id}` : "/rules", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await res.json().catch(() => ({}) as Record<string, unknown>);
      if (!res.ok) {
        throw new Error(
          typeof result.error === "string" ? result.error : `request failed: ${res.status}`,
        );
      }
      // Callback up, data down: this component wrote a rule, but it does not own the
      // list, so it tells the parent — which owns the fetch — what happened.
      onSaved({ reapply_needed: result.reapply_needed === true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the rule");
    } finally {
      setSaving(false);
    }
  }

  const allCats = cats.data?.categories ?? [];
  const parents = allCats.filter((c) => c.parent_id == null);
  const fields = vocab.data?.fields ?? [];
  // Every condition needs a value, except an amount — where an empty box means ₹0, and
  // ₹0 is a meaningful sign test rather than a missing answer.
  const draftsValid = drafts.every(
    (d) => d.value.trim() !== "" || d.field === "amount_paise",
  );
  const canSave = name.trim() !== "" && categoryId !== null && draftsValid;
  const showZeroHint = drafts.some(
    (d) => d.field === "amount_paise" && parseFloat(d.value || "0") === 0,
  );

  return (
    <div className="rule-form">
      <div className="rule-form-row">
        <label className="grow">
          <span className="label">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Blinkit is groceries"
          />
        </label>
        <label>
          <span className="label">Category</span>
          <select
            className="cat-select"
            value={categoryId ?? ""}
            onChange={(e) =>
              setCategoryId(e.target.value ? Number(e.target.value) : null)
            }
          >
            <option value="">Category…</option>
            {parents.map((p) => (
              <optgroup key={p.id} label={p.name}>
                <option value={p.id}>{p.name} (general)</option>
                {allCats
                  .filter((c) => c.parent_id === p.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="rule-priority">
          <span className="label">Priority</span>
          <input
            className="mono"
            inputMode="numeric"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </label>
      </div>

      <div className="cond-head">
        <span className="label">Conditions</span>
        <label className="mode-toggle">
          <select value={matchMode} onChange={(e) => setMatchMode(e.target.value as "all" | "any")}>
            <option value="all">match ALL of these</option>
            <option value="any">match ANY of these</option>
          </select>
        </label>
      </div>

      {drafts.map((d, i) => {
        const legalOps = vocab.data?.ops_by_field[d.field] ?? [];
        return (
          // Index key is fine: the inputs are fully controlled and rows are only added
          // or removed from the end, never reordered.
          <div className="cond-row" key={i}>
            <select
              value={d.field}
              onChange={(e) => updateDraft(i, { field: e.target.value })}
            >
              {fields.map((f) => (
                <option key={f} value={f}>
                  {FIELD_LABEL[f] ?? f}
                </option>
              ))}
            </select>
            <select
              value={d.op}
              onChange={(e) => updateDraft(i, { op: e.target.value })}
            >
              {legalOps.map((o) => (
                <option key={o} value={o}>
                  {OP_LABEL[o] ?? o}
                </option>
              ))}
            </select>

            {d.field === "amount_paise" ? (
              <span className="cond-value">
                <span className="rupee">₹</span>
                <input
                  className="mono"
                  inputMode="decimal"
                  placeholder="0"
                  value={d.value}
                  onChange={(e) => updateDraft(i, { value: e.target.value })}
                />
              </span>
            ) : d.field === "txn_date" ? (
              <input
                type="date"
                value={d.value}
                onChange={(e) => updateDraft(i, { value: e.target.value })}
              />
            ) : (
              <input
                placeholder="blinkit"
                value={d.value}
                onChange={(e) => updateDraft(i, { value: e.target.value })}
              />
            )}

            <button
              className="row-x"
              title="remove condition"
              onClick={() => removeDraft(i)}
              disabled={drafts.length === 1}
            >
              ✕
            </button>
          </div>
        );
      })}

      <button className="add-split" onClick={addDraft}>
        ＋ add condition
      </button>

      {showZeroHint && (
        <p className="soft cond-hint">
          An amount of ₹0 with “is less than” means <b>money out</b> — it keeps a spend
          rule from firing on a refund.
        </p>
      )}

      {editing && (
        <p className="soft cond-hint">
          Saving drops the guesses this rule already made, because they were justified by
          the old conditions. The rules are re-run straight after.
        </p>
      )}

      <div className="rule-form-foot">
        {error && <span className="debit save-error">{error}</span>}
        {onCancel && (
          <button className="link-btn" onClick={onCancel}>
            cancel
          </button>
        )}
        <button className="btn" onClick={save} disabled={saving || !canSave}>
          {saving ? "Saving…" : editing ? "Save changes" : "Save rule"}
        </button>
      </div>
    </div>
  );
}
