import { useState } from "react";

import { useFetch } from "./useFetch";
import RulesToolbar from "./RulesToolbar";
import RuleForm from "./RuleForm";
import RulesList from "./RulesList";
import type { RuleImpact } from "./rules";

// Composition and one piece of shared data. Everything else has been pushed DOWN into
// the component that uses it:
//
//   RulesToolbar  owns applying + result    -> clicking Apply re-renders only the bar
//   RuleForm      owns all the form state   -> typing re-renders only the form
//   RulesList     owns only which row is open -> its own interaction state, nothing else
//
// The /reports/by-rule fetch stays here because every child has a relationship to it: the
// list consumes it, and both the form and the toolbar invalidate it — creating a rule
// changes the list, and applying rules changes the impact numbers in it.
// Callback up, data down.
export default function RulesView() {
  // /reports/by-rule returns everything /rules did PLUS what each rule actually
  // touched, so this is one request rather than two joined in the browser.
  const rules = useFetch<{ rules: RuleImpact[] }>("/reports/by-rule");
  // Whether the form is open genuinely changes THIS layout, so it belongs here.
  const [showForm, setShowForm] = useState(false);

  if (rules.loading) return <p className="soft">Loading…</p>;
  if (rules.error) return <p className="soft">{rules.error}</p>;

  return (
    <>
      {/* NOT .sect — that is a two-item flex row (label left, value right), so block
          content inside it lays out side by side and squeezes. */}
      <div className="rules-head">
        <h2>Rules</h2>
        <p className="soft rules-intro">
          A rule explains a transaction automatically. Its guess is provisional — it never
          overwrites an explanation you wrote yourself, and running it again changes
          nothing until a rule changes.
        </p>
        <RulesToolbar
          showForm={showForm}
          onToggleForm={() => setShowForm((v) => !v)}
          onApplied={rules.refetch}
        />
      </div>

      {showForm && (
        <RuleForm
          onCreated={() => {
            setShowForm(false);
            rules.refetch(); // the list is ours to refresh; the form only reports
          }}
        />
      )}

      <RulesList
        rules={rules.data?.rules ?? []}
        onDelete={async (rule) => {
          // Deleting a rule also removes the allocations it produced, which is real
          // (if provisional) work disappearing off the ledger — worth one confirm.
          if (!confirm(`Delete “${rule.name}”? Its provisional explanations go too.`)) {
            return;
          }
          await fetch(`/rules/${rule.id}`, { method: "DELETE" });
          rules.refetch();
        }}
      />
    </>
  );
}
