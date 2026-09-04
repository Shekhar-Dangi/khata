import { rupees } from "../shared/format";
import type { ImportResponse } from "./sources";

// What an import WILL do, before it does it — and the same component reports what it DID.
//
// One component for both, because the server produces the two by the same code path (a dry
// run commits nothing but is otherwise a real import). Two components would be two chances to
// describe the same numbers differently, which is how a preview stops being trustworthy.

export default function ImportPreview({
  result,
  onCommit,
  onDiscard,
  busy,
}: {
  result: ImportResponse;
  onCommit?: () => void;
  onDiscard?: () => void;
  busy: boolean;
}) {
  const { imported, match } = result;
  const preview = !result.committed;

  return (
    <div>
      <div className="sect">
        <span>{preview ? "What this will do" : "What this did"}</span>
        <span className="pill">{imported.source}</span>
      </div>

      {imported.warnings.map((w) => (
        <p className="note" key={w}>
          {w}
        </p>
      ))}

      {/* The ledger's own vocabulary, in the order the money is decided: what came in, what
          it explains, and what it cannot. Not a grid of equal-weight tiles — the last group
          is the one that needs a person, so it reads last and it is the one with colour. */}
      <dl className="figures">
        <Figure label="Records read" value={String(imported.rows)} />
        <Figure
          label="You paid"
          value={String(imported.stats.paid)}
          hint="a bank row should exist"
        />
        <Figure
          label="Someone else paid"
          value={String(imported.stats.owedByMe)}
          hint="consumed, no cash of yours"
        />
        <Figure label="Not yours" value={String(imported.stats.notMine)} hint="recorded only" />
      </dl>

      <div className="sect">
        <span>Against your bank</span>
      </div>
      <dl className="figures">
        <Figure label="Matched" value={String(match.matched)} tone="ok" />
        <Figure
          label="Needs a look"
          value={String(match.nearMissed + match.ambiguous + match.conflicted)}
          hint="near misses, ties, conflicts"
          tone={match.nearMissed + match.ambiguous + match.conflicted > 0 ? "flag" : undefined}
        />
        <Figure label="No bank row" value={String(match.noCandidate)} hint="paid another way" />
        <Figure
          label="Rule guesses replaced"
          value={String(match.displaced)}
          hint="a record outranks a guess"
          tone={match.displaced > 0 ? "flag" : undefined}
        />
      </dl>

      {/* Consumption is the reason this feature exists, so it gets a sentence rather than a
          tile: it is the only figure here a bank statement could never produce. */}
      <p className="lede">
        <strong>{imported.consumptionWritten}</strong> entries of consumption that never
        touched your account
        {imported.unclassified.count > 0 && (
          <>
            , and{" "}
            <span className="flag mono">
              {rupees(Math.abs(imported.unclassified.amountPaise))}
            </span>{" "}
            across {imported.unclassified.count} more that cannot be categorised yet
          </>
        )}
        .
      </p>

      {match.conflicts.length > 0 && (
        <>
          <div className="sect">
            <span>Left alone</span>
          </div>
          <p className="note">
            These bank rows already carry an allocation you wrote yourself. A record never
            overwrites your own decision — resolve them by hand if the record is right.
          </p>
          <div className="table-scroll short">
            <table>
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {match.conflicts.map((c) => (
                  <tr key={c.externalRef}>
                    <td className="narration">{c.externalRef}</td>
                    <td className="soft">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {imported.unmappedCategories.length > 0 && (
        <p className="note">
          Categories with no mapping yet: {imported.unmappedCategories.join(", ")}. Their
          amounts are counted as unclassified rather than guessed at.
        </p>
      )}

      {preview && (
        <div className="preview-actions">
          <button className="btn" disabled={busy} onClick={onCommit}>
            {busy ? "Importing…" : "Import"}
          </button>
          <button className="btn-ghost" disabled={busy} onClick={onDiscard}>
            Discard
          </button>
          <span className="soft">Nothing has been written yet.</span>
        </div>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "flag";
}) {
  return (
    <div className="figure">
      <dt>{label}</dt>
      <dd className={`mono${tone === "flag" ? " flag" : ""}${tone === "ok" ? " credit" : ""}`}>
        {value}
      </dd>
      {hint !== undefined && <p className="soft">{hint}</p>}
    </div>
  );
}
