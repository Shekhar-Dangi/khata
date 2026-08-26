import { useState } from "react";

import type { ApplyResult } from "./rules";

// The apply action and its result.
//
// `applying` and `result` live HERE, not in the parent, and that placement is the whole
// point of this component existing. A state change re-renders the component that owns it
// and everything below — so holding the result upstairs meant clicking Apply re-rendered
// the rules table too. Owning it here scopes the update to this bar.
//
// Note what it does NOT do: refetch /rules. Applying rules writes allocations; it does
// not change a single rule row, so re-reading them would be a request whose response is
// guaranteed identical to what is already on screen.
export default function RulesToolbar({
  showForm,
  onToggleForm,
}: {
  showForm: boolean;
  onToggleForm: () => void;
}) {
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
        <button className="btn-ghost" onClick={onToggleForm}>
          {showForm ? "Cancel" : "＋ New rule"}
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
