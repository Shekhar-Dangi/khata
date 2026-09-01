import { Fragment, useState } from "react";

import { rupees } from "../shared/format";
import TransactionPeek from "../shared/TransactionPeek";
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
  onEdit,
  onToggle,
  onDelete,
}: {
  rules: RuleImpact[];
  onEdit: (rule: RuleImpact) => void;
  onToggle: (rule: RuleImpact) => void;
  onDelete: (rule: RuleImpact) => void;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (rules.length === 0) {
    return <p className="soft">No rules yet. The first one takes about ten seconds.</p>;
  }

  return (
    // A fixed frame with the header stuck to its top. Twenty-two rules already ran past
    // the fold, and scrolling the document took the column headings with it — so by the
    // time you reached the interesting rows you could no longer tell which number was
    // "money" and which was "txns".
    <div className="table-scroll">
      <table>
        <colgroup>
          <col style={{ width: "190px" }} />
          <col />
          <col style={{ width: "128px" }} />
          <col style={{ width: "62px" }} />
          <col style={{ width: "104px" }} />
          {/* A yyyy-mm-dd in the mono face is 84px before padding; at 94 the date wrapped
              onto two lines and made every row in the table taller. */}
          <col style={{ width: "112px" }} />
          {/* "edit · off · delete" plus the frame's 16px right gutter. At 124 the third
              action wrapped under the first two. */}
          <col style={{ width: "152px" }} />
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
                    {dead ? "—" : rupees(r.net_paise)}
                  </td>
                  {/* "never" lives here, in the column that asks the question. It used to
                      be "never fired" in the MONEY column, where it wrapped onto two lines
                      and made the row taller, while Txns and Last fired each printed an
                      em-dash saying the same nothing three times over. */}
                  <td className="r mono soft nowrap">
                    {r.last_seen ?? (dead ? "never" : "—")}
                  </td>
                  {/* stopPropagation on every one: these sit inside the row that toggles
                      the drill-down, and editing a rule should not also open it. */}
                  <td className="r">
                    <span className="cat-actions">
                      <button
                        className="link-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit(r);
                        }}
                      >
                        edit
                      </button>
                      <button
                        className="link-btn"
                        title={
                          r.enabled
                            ? "stop this rule guessing (its guesses are removed)"
                            : "let this rule guess again"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggle(r);
                        }}
                      >
                        {r.enabled ? "off" : "on"}
                      </button>
                      {/* Was a bare ✕ sitting between two text links — three affordances
                          in one lane for three actions of the same kind. Same shape as
                          the Categories row now, and `danger` is what marks the
                          destructive one, not a different control type. */}
                      <button
                        className="link-btn danger"
                        title={`delete "${r.name}"`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(r);
                        }}
                      >
                        delete
                      </button>
                    </span>
                  </td>
                </tr>
                {expanded && (
                  <tr className="txn-detail">
                    <td colSpan={7} className="rules-peek">
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
    </div>
  );
}
