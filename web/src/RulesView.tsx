import { useState } from "react";

import { useFetch } from "./useFetch";
import { rupees } from "./format";

type Condition = { field: string; op: string; value: string | number };
type Rule = {
  id: number;
  name: string;
  conditions: Condition[];
  match_mode: "all" | "any";
  category_id: number | null;
  category_name: string | null;
  priority: number;
  enabled: boolean;
};
type Category = { id: number; name: string; parent_id: number | null };
type Vocabulary = {
  fields: string[];
  ops: string[];
  match_modes: string[];
  ops_by_field: Record<string, string[]>;
};
type ApplyResult = {
  examined: number;
  matched: number;
  created: number;
  removed: number;
  unchanged: number;
  skipped_user_locked: number;
};

const FIELD_LABEL: Record<string, string> = {
  narration: "Narration",
  amount_paise: "Amount",
  txn_date: "Date",
};
const OP_LABEL: Record<string, string> = {
  contains: "contains",
  equals: "is exactly",
  lt: "is less than",
  gt: "is more than",
};

// A draft condition as the FORM holds it: the value stays a string while you type
// (so "1.5" and a half-typed "-" are both fine) and is converted only on save.
type Draft = { field: string; op: string; value: string };

// Convert a draft to the shape the API expects. Amounts are entered in rupees and
// stored in paise — the conversion happens here, once, at the boundary.
function toCondition(d: Draft): Condition {
  if (d.field === "amount_paise") {
    return { field: d.field, op: d.op, value: Math.round(parseFloat(d.value || "0") * 100) };
  }
  return { field: d.field, op: d.op, value: d.value.trim() };
}

// Render a stored condition the way a person would say it.
function describe(c: Condition): string {
  if (c.field === "amount_paise") {
    const paise = typeof c.value === "number" ? c.value : Number(c.value);
    // The overwhelmingly common case is a sign test, and "amount is less than ₹0.00"
    // is a baffling way to write "money went out". Say what it means.
    if (paise === 0 && c.op === "lt") return "money out";
    if (paise === 0 && c.op === "gt") return "money in";
    return `amount ${OP_LABEL[c.op] ?? c.op} ${rupees(Math.abs(paise))}`;
  }
  if (c.field === "txn_date") return `date ${OP_LABEL[c.op] ?? c.op} ${c.value}`;
  return `narration ${OP_LABEL[c.op] ?? c.op} “${c.value}”`;
}

export default function RulesView() {
  const rules = useFetch<{ rules: Rule[] }>("/rules");
  const cats = useFetch<{ categories: Category[] }>("/categories");
  // The form builds itself from the server's vocabulary instead of a hardcoded copy,
  // so a new field or op shows up here without a second place to edit.
  const vocab = useFetch<Vocabulary>("/rules/vocabulary");

  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [priority, setPriority] = useState("0");
  const [matchMode, setMatchMode] = useState("all");
  const [drafts, setDrafts] = useState<Draft[]>([
    { field: "narration", op: "contains", value: "" },
  ]);
  const [saving, setSaving] = useState(false);

  // Immutable array updates — new array, new object, never a mutation.
  const addDraft = () =>
    setDrafts((prev) => [...prev, { field: "narration", op: "contains", value: "" }]);
  const removeDraft = (i: number) =>
    setDrafts((prev) => prev.filter((_, idx) => idx !== i));
  const updateDraft = (i: number, patch: Partial<Draft>) =>
    setDrafts((prev) =>
      prev.map((d, idx) => {
        if (idx !== i) return d;
        const next = { ...d, ...patch };
        // Changing the field can strand an op that is illegal for it (contains on a
        // number). Snap to the first legal op rather than letting the API 400.
        if (patch.field !== undefined) {
          const legal = vocab.data?.ops_by_field[next.field] ?? [];
          if (!legal.includes(next.op)) next.op = legal[0] ?? next.op;
          next.value = "";
        }
        return next;
      }),
    );

  async function apply() {
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/rules/apply", { method: "POST" });
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      setResult((await res.json()) as ApplyResult);
      // NOT refetching the rules here on purpose. Applying rules writes allocations;
      // it does not change a single rule row, so re-reading /rules would be a request
      // whose response is guaranteed identical to what is already on screen.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setApplying(false);
    }
  }

  async function createRule() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          conditions: drafts.map(toCondition),
          match_mode: matchMode,
          category_id: categoryId,
          priority: Number(priority) || 0,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `request failed: ${res.status}`);
      }
      setName("");
      setCategoryId(null);
      setPriority("0");
      setMatchMode("all");
      setDrafts([{ field: "narration", op: "contains", value: "" }]);
      setShowForm(false);
      rules.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the rule");
    } finally {
      setSaving(false);
    }
  }

  if (rules.loading) return <p className="soft">Loading…</p>;
  if (rules.error) return <p className="soft">{rules.error}</p>;

  const list = rules.data?.rules ?? [];
  const allCats = cats.data?.categories ?? [];
  const parents = allCats.filter((c) => c.parent_id == null);
  const fields = vocab.data?.fields ?? [];
  // A condition needs a value except for the sign tests, where 0 is meaningful.
  const draftsValid = drafts.every(
    (d) => d.value.trim() !== "" || d.field === "amount_paise",
  );
  const canSave = name.trim() !== "" && categoryId !== null && draftsValid;

  return (
    <>
      {/* NOT .sect — that is a two-item flex row (label left, value right). Putting
          block content inside it lays the blocks out side by side and squeezes them. */}
      <div className="rules-head">
        <h2>Rules</h2>
        <p className="soft rules-intro">
          A rule explains a transaction automatically. Its guess is provisional — it never
          overwrites an explanation you wrote yourself, and running it again changes nothing
          until a rule changes.
        </p>
        <div className="rules-actions">
          <button className="btn" onClick={apply} disabled={applying}>
            {applying ? "Applying…" : "Apply rules"}
          </button>
          <button className="btn-ghost" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "＋ New rule"}
          </button>
        </div>
        {/* On its own line, so its width can never shove the buttons around. */}
        {result && (
          <p className="apply-result mono">
            {result.created} created · {result.removed} removed · {result.unchanged}{" "}
            unchanged · {result.skipped_user_locked} yours, left alone
            {result.created === 0 && result.removed === 0 && (
              <span className="apply-note"> — nothing changed, the rules had already been applied</span>
            )}
          </p>
        )}
        {error && <p className="debit save-error">{error}</p>}
      </div>

      {showForm && (
        <div className="rule-form">
          <div className="rule-form-row">
            <label className="grow">
              <span className="label">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Blinkit is groceries" />
            </label>
            <label>
              <span className="label">Category</span>
              <select
                className="cat-select"
                value={categoryId ?? ""}
                onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}
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
              <input className="mono" inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} />
            </label>
          </div>

          <div className="cond-head">
            <span className="label">Conditions</span>
            <label className="mode-toggle">
              <select value={matchMode} onChange={(e) => setMatchMode(e.target.value)}>
                <option value="all">match ALL of these</option>
                <option value="any">match ANY of these</option>
              </select>
            </label>
          </div>

          {drafts.map((d, i) => {
            const legalOps = vocab.data?.ops_by_field[d.field] ?? [];
            return (
              <div className="cond-row" key={i}>
                <select value={d.field} onChange={(e) => updateDraft(i, { field: e.target.value })}>
                  {fields.map((f) => (
                    <option key={f} value={f}>
                      {FIELD_LABEL[f] ?? f}
                    </option>
                  ))}
                </select>
                <select value={d.op} onChange={(e) => updateDraft(i, { op: e.target.value })}>
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
                  <input type="date" value={d.value} onChange={(e) => updateDraft(i, { value: e.target.value })} />
                ) : (
                  <input placeholder="blinkit" value={d.value} onChange={(e) => updateDraft(i, { value: e.target.value })} />
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

          {drafts.some((d) => d.field === "amount_paise" && parseFloat(d.value || "0") === 0) && (
            <p className="soft cond-hint">
              An amount of ₹0 with “is less than” means <b>money out</b> — it keeps a spend rule
              from firing on a refund.
            </p>
          )}

          <div className="rule-form-foot">
            <button className="btn" onClick={createRule} disabled={saving || !canSave}>
              {saving ? "Saving…" : "Save rule"}
            </button>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <p className="soft">No rules yet. The first one takes about ten seconds.</p>
      ) : (
        <table>
          <colgroup>
            <col style={{ width: "210px" }} />
            <col />
            <col style={{ width: "170px" }} />
            <col style={{ width: "80px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Rule</th>
              <th>When</th>
              <th>Then</th>
              <th className="r">Priority</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className={r.enabled ? undefined : "rule-off"}>
                <td>
                  {r.name}
                  {!r.enabled && <span className="tag-off">off</span>}
                </td>
                <td className="soft">
                  {r.conditions.map(describe).join(r.match_mode === "all" ? " and " : " or ")}
                </td>
                <td>{r.category_name ?? <span className="soft">—</span>}</td>
                <td className="r mono soft">{r.priority}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
