import { useEffect, useState } from "react";

import { errorText, mutate } from "../shared/api";
import { useBusy, useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";
import EvidenceDrop from "./EvidenceDrop";
import ImportBatchPanel from "./ImportBatchPanel";
import ImportReceipt from "./ImportReceipt";
import { groupFromFilename, outstanding, type ImportBatch, type ImportResponse } from "./sources";

// Where outside records come in, and what state they are in.
//
// A tab rather than a modal, deliberately. Importing produces persistent WORK — near misses to
// judge, conflicts to resolve — and a modal cannot hold a queue you come back to a week later.
// So this is a place, not an action: "the records I have brought in, and what is still
// unresolved about them".
//
// The flow is preview -> commit, never a single button that writes. An import can displace a
// rule's guess and can silently fail to explain a transaction someone already explained; a
// person deserves to see both before it happens, not after.
//
// THE SHAPE OF THE PAGE, and why it changed. It used to be a mode switch: the drop panel, OR
// the import report, OR the queue — with the queue hidden for as long as a preview was on
// screen. Three things that are one thing. You cannot judge "12 will match" without seeing the
// fifteen already waiting, and having the page swap its contents under you on every step is
// the flicker this rewrite exists to remove.
//
// Now it is one stack that only ever grows a section at the top: bring a file in, read what it
// will do, and work through the result in a list that was already there and stays there.

export default function SourcesView() {
  const [file, setFile] = useState<{ text: string; group: string } | null>(null);
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [done, setDone] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which imports are open. A Set rather than one id: two imports CAN be worth having open at
  // once (the same expense entered in the wrong group is exactly when you would), and an
  // accordion that closes one to open another loses the position you had in it.
  const [open, setOpen] = useState<Set<string> | null>(null);
  const { version, bump } = useLedgerVersion();

  const imports = useFetch<{ imports: ImportBatch[] }>("/evidence/imports", {
    keepPreviousData: true,
    revalidateOn: version,
  });
  const working = useBusy(imports.refreshing);
  const batches = imports.data?.imports ?? [];

  // Open the newest import, once, and only until the person says otherwise. `null` means "not
  // decided yet" rather than "all closed" — without that distinction the first render (before
  // the list arrives) would count as a decision to close everything.
  useEffect(() => {
    // `imports.data`, not the `batches` derived from it: `?? []` is a NEW array on every
    // render while the request is in flight, so depending on it would re-run this effect
    // forever. Same trap `revalidateOn` exists to avoid in useFetch.
    const list = imports.data?.imports;
    if (open !== null || list === undefined || list.length === 0) return;
    // The one with work outstanding, else simply the newest. Landing on a finished import
    // with nothing in it would make the page look empty when it is not.
    const first = list.find((b) => outstanding(b) > 0) ?? list[0];
    setOpen(new Set([first.group]));
  }, [imports.data, open]);

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
        // The import's own batch, open, so the work it just created is the thing you are
        // looking at rather than something to go and find.
        setOpen(new Set([group]));
        // Balances, categories and the unexplained total all move on an import, and the
        // summary strip lives in a different subtree — see ledgerVersion.tsx.
        bump();
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

  function toggle(group: string) {
    setOpen((held) => {
      const next = new Set(held ?? []);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const isOpen = (group: string) => open !== null && open.has(group);
  const showDrop = preview === null && done === null;

  return (
    <div>
      {/* The drop target is slim once there is anything to work on, and a full invitation only
          when there is not. See EvidenceDrop for why that is a statement rather than a tweak. */}
      {showDrop && (
        <EvidenceDrop
          busy={busy}
          compact={batches.length > 0}
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
        <ImportReceipt
          result={preview}
          busy={busy}
          onCommit={() => void send(file.text, file.group, false)}
          onDiscard={reset}
        />
      )}

      {done !== null && (
        <ImportReceipt result={done} busy={false} onDone={() => setDone(null)} />
      )}

      {/* The imports are permanent, not part of an import result: a near miss you did not judge
          today is still waiting next week, and it would be lost if it only ever appeared on the
          screen that produced it. */}
      <div className={"busybar" + (working ? " on" : "")} aria-hidden="true">
        <i />
      </div>

      {imports.error !== null && <p className="note">{imports.error}</p>}

      <div className={working || imports.isStale ? "is-stale" : undefined}>
        {batches.map((b) => (
          <ImportBatchPanel
            key={b.group}
            batch={b}
            expanded={isOpen(b.group)}
            onToggle={() => toggle(b.group)}
          />
        ))}
      </div>
    </div>
  );
}
