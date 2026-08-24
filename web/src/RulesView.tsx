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
type ApplyResult = {
  examined: number;
  matched: number;
  created: number;
  removed: number;
  unchanged: number;
  skipped_user_locked: number;
};

const FIELD_LABEL: Record<string, string> = {
  narration: "narration",
  amount_paise: "amount",
  txn_date: "date",
};
const OP_LABEL: Record<string, string> = {
  contains: "contains",
  equals: "is",
  lt: "is less than",
  gt: "is more than",
};

// Render a stored condition the way a person would say it. The rule is data, so this
// is a rendering concern only — nothing here decides what matches.
function describe(c: Condition): string {
  const field = FIELD_LABEL[c.field] ?? c.field;
  const op = OP_LABEL[c.op] ?? c.op;
  const value =
    c.field === "amount_paise" && typeof c.value === "number"
      ? rupees(c.value)
      : `“${c.value}”`;
  return `${field} ${op} ${value}`;
}

export default function RulesView() {
  const rules = useFetch<{ rules: Rule[] }>("/rules");
  const cats = useFetch<{ categories: Category[] }>("/categories");

  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-rule form. One condition is enough to be useful; more is a later refinement.
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [needle, setNeedle] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [priority, setPriority] = useState("0");
  const [debitsOnly, setDebitsOnly] = useState(true);
  const [saving, setSaving] = useState(false);

  async function apply() {
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/rules/apply", { method: "POST" });
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      setResult((await res.json()) as ApplyResult);
      rules.refetch();
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
      const conditions: Condition[] = [
        { field: "narration", op: "contains", value: needle.trim() },
      ];
      // A spend rule should not fire on a refund of the same merchant, so the
      // amount condition is the difference between "Amazon" and "money to Amazon".
      if (debitsOnly) {
        conditions.push({ field: "amount_paise", op: "lt", value: 0 });
      }
      const res = await fetch("/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          conditions,
          match_mode: "all",
          category_id: categoryId,
          priority: Number(priority) || 0,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `request failed: ${res.status}`);
      }
      setName("");
      setNeedle("");
      setCategoryId(null);
      setPriority("0");
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
  const parents = (cats.data?.categories ?? []).filter((c) => c.parent_id == null);
  const canSave = name.trim() !== "" && needle.trim() !== "" && categoryId !== null;

  return (
    <>
      <div className="sect">
        <h2>Rules</h2>
        <p className="soft rules-intro">
          A rule explains a transaction automatically. Its guess is provisional — it
          never overwrites an explanation you wrote yourself, and running it again
          changes nothing until a rule changes.
        </p>

        <div className="rules-actions">
          <button className="btn" onClick={apply} disabled={applying}>
            {applying ? "Applying…" : "Apply rules"}
          </button>
          <button className="btn-ghost" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "＋ New rule"}
          </button>
          {result && (
            // The counters ARE the feedback. created:0 removed:0 on a second run is
            // how you can see the engine converged rather than churning.
            <span className="apply-result mono">
              {result.created} created · {result.removed} removed ·{" "}
              {result.unchanged} unchanged · {result.skipped_user_locked} yours, left
              alone
            </span>
          )}
          {error && <span className="debit save-error">{error}</span>}
        </div>
      </div>

      {showForm && (
        <div className="rule-form">
          <div className="rule-form-row">
            <label>
              <span className="label">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Blinkit is groceries"
              />
            </label>
            <label>
              <span className="label">Narration contains</span>
              <input
                value={needle}
                onChange={(e) => setNeedle(e.target.value)}
                placeholder="blinkit"
              />
            </label>
          </div>
          <div className="rule-form-row">
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
                    {(cats.data?.categories ?? [])
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
            <label className="rule-check">
              <input
                type="checkbox"
                checked={debitsOnly}
                onChange={(e) => setDebitsOnly(e.target.checked)}
              />
              <span>Money out only (ignores refunds)</span>
            </label>
          </div>
          <div className="rule-form-foot">
            <button
              className="btn"
              onClick={createRule}
              disabled={saving || !canSave}
            >
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
                  {r.conditions.map(describe).join(
                    r.match_mode === "all" ? " and " : " or ",
                  )}
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
