import { describeRule, type Rule } from "./rules";

// The rules table. PRESENTATIONAL: it owns no state and fetches nothing — it takes rules
// and renders them. That is what makes it safe to grow into the comprehensive component
// this will become (sorting, filtering, enable/disable toggles, inline edit, delete)
// without any of that leaking back into the parent.
//
// It also means this component can only re-render when its parent does, and it has no
// way to trigger a render on its own.
export default function RulesList({
  rules,
  onDelete,
}: {
  rules: Rule[];
  onDelete: (rule: Rule) => void;
}) {
  if (rules.length === 0) {
    return <p className="soft">No rules yet. The first one takes about ten seconds.</p>;
  }

  return (
    <table>
      <colgroup>
        <col style={{ width: "210px" }} />
        <col />
        <col style={{ width: "170px" }} />
        <col style={{ width: "80px" }} />
        <col style={{ width: "40px" }} />
      </colgroup>
      <thead>
        <tr>
          <th>Rule</th>
          <th>When</th>
          <th>Then</th>
          <th className="r">Priority</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r) => (
          <tr key={r.id} className={r.enabled ? undefined : "rule-off"}>
            <td>
              {r.name}
              {!r.enabled && <span className="tag-off">off</span>}
            </td>
            <td className="soft">{describeRule(r)}</td>
            <td>{r.category_name ?? <span className="soft">—</span>}</td>
            <td className="r mono soft">{r.priority}</td>
            <td className="r">
              <button
                className="row-x"
                title={`delete "${r.name}"`}
                onClick={() => onDelete(r)}
              >
                ✕
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
