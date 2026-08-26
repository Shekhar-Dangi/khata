import { Fragment, useState } from "react";

import { rupees } from "./format";
import TransactionPeek from "./TransactionPeek";
import { describeRule, type RuleImpact } from "./rules";

// The rules table, with what each rule actually did. Click a row to see the transactions
// it explained.
//
// It owns `expandedId` and nothing else. That is not a contradiction of "presentational":
// which row is open is this table's OWN interaction state — no other component needs it,
// and no data depends on it. State belongs where it is used, and here that is here.
// Rule DATA still arrives as a prop, and refreshing it is still the parent's job.
export default function RulesList({
  rules,
  onDelete,
}: {
  rules: RuleImpact[];
  onDelete: (rule: RuleImpact) => void;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (rules.length === 0) {
    return <p className="soft">No rules yet. The first one takes about ten seconds.</p>;
  }

  return (
    <table>
      <colgroup>
        <col style={{ width: "190px" }} />
        <col />
        <col style={{ width: "128px" }} />
        <col style={{ width: "62px" }} />
        <col style={{ width: "104px" }} />
        <col style={{ width: "94px" }} />
        <col style={{ width: "36px" }} />
      </colgroup>
      <thead>
        <tr>
          <th>Rule</th>
          <th>When</th>
          <th>Then</th>
          <th className="r">Txns</th>
          <th className="r">Money</th>
          <th className="r">Last fired</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r) => {
          const expanded = expandedId === r.id;
          // Zero is the most actionable number in this table, so it gets said in words
          // rather than shown as a 0 the eye slides past.
          const dead = r.transactions === 0;
          return (
            <Fragment key={r.id}>
              <tr
                className={"txn-row" + (r.enabled ? "" : " rule-off")}
                aria-expanded={expanded}
                onClick={() => setExpandedId(expanded ? null : r.id)}
              >
                <td>
                  {r.name}
                  {!r.enabled && <span className="tag-off">off</span>}
                </td>
                <td className="soft">{describeRule(r)}</td>
                <td>{r.category_name ?? <span className="soft">—</span>}</td>
                <td className="r mono soft">{dead ? "—" : r.transactions}</td>
                {/* SIGNED, and coloured by direction. money_paise is a magnitude, which
                    made a salary rule and a rent rule look like the same kind of thing.
                    net_paise carries the direction, and for a rule whose allocations all
                    point one way — which is every rule — it is the same figure with its
                    meaning restored. */}
                <td
                  className={
                    "r mono " +
                    (dead ? "soft" : r.net_paise < 0 ? "debit" : "credit")
                  }
                >
                  {dead ? "never fired" : rupees(r.net_paise)}
                </td>
                <td className="r mono soft">{r.last_seen ?? "—"}</td>
                <td className="r">
                  <button
                    className="row-x"
                    title={`delete "${r.name}"`}
                    onClick={(e) => {
                      e.stopPropagation(); // do not toggle the row open on delete
                      onDelete(r);
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
              {expanded && (
                <tr className="txn-detail">
                  <td colSpan={7}>
                    <TransactionPeek
                      query={`rule_id=${r.id}`}
                      emptyMessage="This rule has not matched anything. A typo, or a merchant you stopped using."
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
