import { useState } from "react";

import { useLedgerVersion } from "./ledgerVersion";
import type { ApplyResult } from "./rules";

// The apply action and its result.
//
// `applying` and `result` live HERE, not in the parent, and that placement is the whole
// point of this component existing. A state change re-renders the component that owns it
// and everything below — so holding the result upstairs meant clicking Apply re-rendered
// the rules table too. Owning it here scopes the update to this bar.
//
// It DOES report upward when a run finishes. Applying rules writes allocations, and the
// list now shows allocation-derived numbers (transactions touched, money, last fired),
// so those go stale the moment a run changes anything. This was correct to omit when the
// list showed only rule rows; adding impact columns changed what the data depends on.
export default function RulesToolbar({
  showForm,
  onToggleForm,
  onApplied,
}: {
  showForm: boolean;
  onToggleForm: () => void;
  onApplied: () => void;
}) {
  const { bump } = useLedgerVersion();
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setApplying(true);
    setError(null);
    try {
      const res = await fetch("/rules/apply", { method: "POST" });
      if (!res.ok) throw new Error(`request failed: ${res.status}`);
      setResult((await res.json()) as ApplyResult);
      onApplied();
      // A rule run rewrites allocations, which moves the summary strip and every report —
      // none of which are below this component, so a callback cannot reach them.
      bump();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setApplying(false);
    }
  }

  const noChange = result !== null && result.created === 0 && result.removed === 0;

  return (
    <>
      <div className="rules-actions">
        <button className="btn" onClick={apply} disabled={applying}>
          {applying ? "Applying…" : "Apply rules"}
        </button>
        {/* The tier follows what the button DOES. Creating a rule is a real action and
            was reading as a footnote next to the filled primary; cancelling out of the
            form is exactly what ghost is for. */}
        <button
          className={showForm ? "btn-ghost" : "btn-secondary"}
          onClick={onToggleForm}
        >
          {showForm ? "Cancel" : "+ New rule"}
        </button>
      </div>

      {/* On its own line so its width can never reflow the buttons above it. */}
      {result && (
        <p className="apply-result mono">
          {result.created} created · {result.removed} removed · {result.unchanged}{" "}
          unchanged · {result.skipped_user_locked} yours, left alone
          {noChange && (
            <span className="apply-note">
              {" "}
              — nothing changed, the rules had already been applied
            </span>
          )}
        </p>
      )}
      {error && <p className="debit save-error">{error}</p>}
    </>
  );
}
