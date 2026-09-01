import { useState } from "react";

import { errorText, mutate } from "../shared/api";

import { useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";
import RulesToolbar from "./RulesToolbar";
import RuleForm from "./RuleForm";
import RulesList from "./RulesList";
import CandidatesList from "./CandidatesList";
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

  // Active rules and candidates are two MODES of one page, not two pages.
  //
  // A candidate is a rule you have not accepted yet, and judging one means knowing what
  // already exists — which rules there are, what they cover, what priority they carry.
  // In its own tab, every review becomes: read the candidate, switch to Rules to check
  // nothing covers it, switch back. Same instinct as the routes layer, where
  // /accounts/:id/keywords is a TRANSFERS route because it lives with its concern.
  //
  // Two modes rather than two stacked lists: they answer different questions and neither
  // wants to be half a screen.
  const [mode, setMode] = useState<"active" | "candidates">("active");
  // Writes from this screen used to be fire-and-forget: a refused PATCH or DELETE looked
  // exactly like success, because nothing read the response. The list refetched, the rule
  // was still there, and the screen said nothing.
  const [writeError, setWriteError] = useState<string | null>(null);

  if (rules.loading) return <p className="soft">Loading…</p>;
  if (rules.error) return <p className="soft">{rules.error}</p>;

  // Any change to what a rule MATCHES throws away the allocations it had already
  // written — they were justified by conditions that no longer exist. Re-running the
  // engine right after is what puts the new guesses on the ledger; leaving that to the
  // user means the reports read wrong until they happen to press Apply.
  async function afterWrite(reapplyNeeded: boolean) {
    setEditing(null);
    try {
      if (reapplyNeeded) await mutate("/rules/apply", { method: "POST" });
    } catch (e) {
      // The rule change itself already landed, so this is NOT a reason to skip the
      // refresh — the ledger has moved and the screen must catch up. Say what failed and
      // carry on: leaving stale rows on screen would hide a change that really happened.
      setWriteError(`${errorText(e)} — the rule saved, but re-applying failed.`);
    }
    await rules.refetch();
    bump();
  }

  // Every rule has fired zero transactions — i.e. the engine has never been run against
  // this ledger. Distinct from "no rules yet", which needs a different sentence.
  const ruleCount = rules.data?.rules.length ?? 0;
  const neverApplied =
    ruleCount > 0 && (rules.data?.rules ?? []).every((r) => r.transactions === 0);

  return (
    <>
      {/* NOT .sect — that is a two-item flex row (label left, value right), so block
          content inside it lays out side by side and squeezes. */}
      <div className="rules-head">
        <h2>Rules</h2>

        <div className="mode-switch" role="tablist" aria-label="Rules view">
          <button
            role="tab"
            aria-selected={mode === "active"}
            className={mode === "active" ? "mode on" : "mode"}
            onClick={() => setMode("active")}
          >
            Active rules <span className="mode-count">{rules.data?.rules.length ?? 0}</span>
          </button>
          <button
            role="tab"
            aria-selected={mode === "candidates"}
            className={mode === "candidates" ? "mode on" : "mode"}
            onClick={() => setMode("candidates")}
          >
            Candidates
          </button>
        </div>

        {/* The intro and the toolbar render in BOTH modes, in the same slot. They used to
            be active-only, so switching tabs changed the header's height and everything
            below jumped. Applying rules and starting a new one are both meaningful while
            reviewing candidates anyway — only the prose changes. */}
        <p className="soft rules-intro">
          {mode === "active"
            ? `A rule explains a transaction automatically. Its guess is provisional — it
               never overwrites an explanation you wrote yourself, and running it again
               changes nothing until a rule changes.`
            : `Patterns that repeat across your unexplained transactions. None of these
               exist yet. Open one to see exactly which transactions it would claim —
               looking is how you create it, because the summary hides the mistakes.`}
        </p>
        {writeError && <p className="debit rules-error">{writeError}</p>}
        {/* Rules that exist but have never run are a STATE, not a table of zeroes. The
            summary strip shows a real ₹0.00 for "guessed by a rule" in exactly this
            situation, and a zero does not tell you the engine has simply never been
            pressed. Said here because this is where the data is already loaded and
            where the button that fixes it lives. */}
        {neverApplied && (
          <p className="note">
            {ruleCount} rule{ruleCount === 1 ? "" : "s"}, none of them ever applied — so
            nothing is being guessed yet. Press “Apply rules”.
          </p>
        )}
        <RulesToolbar
          showForm={editing === "new"}
          onToggleForm={() => setEditing((v) => (v === "new" ? null : "new"))}
          onApplied={rules.refetch}
        />
      </div>

      {mode === "candidates" && (
        <CandidatesList
          version={version}
          // A new rule writes provisional allocations the moment it is applied, so this
          // is a ledger mutation: re-apply, refresh the list, and bump so Summary and the
          // ledger stop showing a number the rule has already changed.
          onCreated={() => afterWrite(true)}
        />
      )}

      {mode === "active" && editing !== null && (
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

      {mode === "active" && (
      <RulesList
        rules={rules.data?.rules ?? []}
        onEdit={(rule) => setEditing(rule)}
        onToggle={async (rule) => {
          setWriteError(null);
          try {
            await mutate(`/rules/${rule.id}`, {
              method: "PATCH",
              body: JSON.stringify({ enabled: !rule.enabled }),
            });
          } catch (e) {
            // Nothing changed, so nothing to refresh — just say so and stop.
            setWriteError(errorText(e, "Could not change the rule"));
            return;
          }
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
          setWriteError(null);
          try {
            await mutate(`/rules/${rule.id}`, { method: "DELETE" });
          } catch (e) {
            setWriteError(errorText(e, "Could not delete the rule"));
            return;
          }
          // Deleting a rule removes its allocations too, so this is a ledger mutation,
          // not just a change to this list. Nothing to re-apply — the rule is gone.
          await afterWrite(false);
        }}
      />
      )}
    </>
  );
}
