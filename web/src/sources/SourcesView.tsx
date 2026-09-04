import { useState } from "react";

import { errorText, mutate } from "../shared/api";
import { useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";
import EvidenceDrop from "./EvidenceDrop";
import ImportPreview from "./ImportPreview";
import NearMissQueue from "./NearMissQueue";
import { groupFromFilename, type ImportResponse, type NearMiss } from "./sources";

// Where outside records come in, and what state they are in.
//
// A tab rather than a modal, deliberately. Importing produces persistent WORK — near misses
// to judge, conflicts to resolve — and a modal cannot hold a queue you come back to a week
// later. So this is a place, not an action: "the records I have brought in, and what is still
// unresolved about them".
//
// The flow is preview -> commit, never a single button that writes. An import can displace a
// rule's guess and can silently fail to explain a transaction someone already explained; a
// person deserves to see both before it happens, not after.

export default function SourcesView() {
  const [file, setFile] = useState<{ text: string; group: string } | null>(null);
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [done, setDone] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { bump } = useLedgerVersion();

  const queue = useFetch<{ near_misses: NearMiss[] }>("/evidence/near-misses");

  async function send(text: string, group: string, dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate<ImportResponse>(
        `/evidence/import?group=${encodeURIComponent(group)}${dryRun ? "&dry_run=1" : ""}`,
        { method: "POST", headers: { "Content-Type": "text/csv" }, body: text },
      );
      if (dryRun) {
        setPreview(result);
      } else {
        setDone(result);
        setPreview(null);
        setFile(null);
        // Balances, categories and the unexplained total all move on an import, and the
        // summary strip lives in a different subtree — see ledgerVersion.tsx.
        bump();
        void queue.refetch();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPreview(null);
    setFile(null);
    setError(null);
  }

  const rows = queue.data?.near_misses ?? [];

  return (
    <div>
      {done === null && preview === null && (
        <EvidenceDrop
          busy={busy}
          onFile={(text, name) => {
            const group = groupFromFilename(name);
            setFile({ text, group });
            setDone(null);
            void send(text, group, true);
          }}
        />
      )}

      {error !== null && <p className="note">{error}</p>}

      {preview !== null && file !== null && (
        <ImportPreview
          result={preview}
          busy={busy}
          onCommit={() => void send(file.text, file.group, false)}
          onDiscard={reset}
        />
      )}

      {done !== null && (
        <>
          <ImportPreview result={done} busy={false} />
          <div className="preview-actions">
            <button className="btn-secondary" onClick={() => setDone(null)}>
              Import another
            </button>
          </div>
        </>
      )}

      {/* The queue is permanent, not part of the import result: a near miss you did not
          judge today is still waiting next week, and it would be lost if it only ever
          appeared on the screen that produced it. */}
      {preview === null && (
        <NearMissQueue
          rows={rows}
          onAccepted={() => {
            void queue.refetch();
            bump();
          }}
        />
      )}

      {preview === null && done === null && rows.length === 0 && !queue.loading && (
        <p className="soft sources-tail">
          Nothing is waiting on you. Imports are safe to repeat — a record already in the
          ledger is updated, never duplicated.
        </p>
      )}
    </div>
  );
}
