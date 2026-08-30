import { useState } from "react";

import { useFetch } from "./useFetch";
import { useLedgerVersion } from "./ledgerVersion";
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
  const { version, bump } = useLedgerVersion();
  const rules = useFetch<{ rules: RuleImpact[] }>("/reports/by-rule", {
    revalidateOn: version,
  });
  // What the form is doing genuinely changes THIS layout, so it belongs here.
  // null = closed, "new" = creating, a rule = editing that one.
  const [editing, setEditing] = useState<null | "new" | RuleImpact>(null);

  if (rules.loading) return <p className="soft">Loading…</p>;
  if (rules.error) return <p className="soft">{rules.error}</p>;

  // Any change to what a rule MATCHES throws away the allocations it had already
  // written — they were justified by conditions that no longer exist. Re-running the
  // engine right after is what puts the new guesses on the ledger; leaving that to the
  // user means the reports read wrong until they happen to press Apply.
  async function afterWrite(reapplyNeeded: boolean) {
    setEditing(null);
    if (reapplyNeeded) await fetch("/rules/apply", { method: "POST" });
    await rules.refetch();
    bump();
  }

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
          showForm={editing === "new"}
          onToggleForm={() => setEditing((v) => (v === "new" ? null : "new"))}
          onApplied={rules.refetch}
        />
      </div>

      {editing !== null && (
        <RuleForm
          // key remounts the form when you switch from one rule to another, which is what
          // resets the drafts. Without it React keeps the same component instance and its
          // useState initialisers — written for the PREVIOUS rule — never run again, so
          // clicking "edit" on a second rule would show the first one's conditions.
          key={editing === "new" ? "new" : editing.id}
          rule={editing === "new" ? undefined : editing}
          onCancel={() => setEditing(null)}
          onSaved={(r) => afterWrite(r.reapply_needed)}
        />
      )}

      <RulesList
        rules={rules.data?.rules ?? []}
        onEdit={(rule) => setEditing(rule)}
        onToggle={async (rule) => {
          await fetch(`/rules/${rule.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: !rule.enabled }),
          });
          // Turning a rule off deletes its guesses; turning it back on has to re-make
          // them. Both are ledger mutations, so both re-run and bump.
          await afterWrite(true);
        }}
        onDelete={async (rule) => {
          // Deleting a rule also removes the allocations it produced, which is real
          // (if provisional) work disappearing off the ledger — worth one confirm.
          if (!confirm(`Delete “${rule.name}”? Its provisional explanations go too.`)) {
            return;
          }
          await fetch(`/rules/${rule.id}`, { method: "DELETE" });
          // Deleting a rule removes its allocations too, so this is a ledger mutation,
          // not just a change to this list. Nothing to re-apply — the rule is gone.
          await afterWrite(false);
        }}
      />
    </>
  );
}
