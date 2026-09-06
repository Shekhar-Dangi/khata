import { useEffect, useRef, useState } from "react";

import { errorText, mutate } from "../shared/api";
import { useBusy, useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";
import EvidenceDrop from "./EvidenceDrop";
import ImportBatchPanel from "./ImportBatchPanel";
import ImportReceipt from "./ImportReceipt";
import StagedReview from "./StagedReview";
import UploadQueue from "./UploadQueue";
import { groupFromFilename, outstanding, type ImportBatch, type ImportResponse } from "./sources";

// Where outside records come in, and what state they are in.
//
// A tab rather than a modal, deliberately. Importing produces persistent WORK — orders to
// confirm, near misses to judge, conflicts to resolve — and a modal cannot hold a queue you
// come back to a week later. So this is a place, not an action: "the records I have brought in,
// and what is still unresolved about them".
//
// THE SHAPE OF THE PAGE, and why it changed. It used to be a mode switch: the drop panel, OR
// the import report, OR the queue — with the queue hidden for as long as a preview was on
// screen. Three things that are one thing. You cannot judge "12 will match" without seeing the
// fifteen already waiting, and having the page swap its contents under you on every step is
// the flicker this rewrite exists to remove.
//
// Now it is one stack that only ever grows a section at the top: bring files in, read what they
// will do, and work through the result in a list that was already there and stays there.
//
// TWO FLOWS BEHIND ONE DROP TARGET, and the line between them is not a preference:
//
//   a text export (Splitwise)  —  preview, then commit. It reaches the ledger immediately and
//                                 can displace a rule's guess, so `dry_run` shows what it will
//                                 do before it does it.
//   invoices (PDF)             —  bounded-concurrent upload straight to the INBOX. There is
//                                 nothing to preview: the design puts a person
//                                 between the parse and the ledger already, and a dry run would
//                                 be a second, weaker version of the review screen below.
//
// Which flow a drop enters is decided from the LEADING BYTES, the same signal the server's
// `sniffMime` uses and for the same reason: a filename is client-controlled and an extension is
// a claim, not a fact. This only picks a screen — the server sniffs every upload itself and
// remains the only thing entitled to say what a file is — so a wrong guess here costs a layout,
// never a corrupted document.

/** `%PDF-`, the magic number a PDF is required to start with. Mirrors PDF_MAGIC in artifacts.ts. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

async function looksLikePdf(file: File): Promise<boolean> {
  // Five bytes off the front, never the whole file: this decides a route, and reading 10 MB to
  // do it would stall the drop of 252 files before the first request went out.
  const head = new Uint8Array(await file.slice(0, PDF_MAGIC.length).arrayBuffer());
  return head.length === PDF_MAGIC.length && PDF_MAGIC.every((b, i) => head[i] === b);
}

export default function SourcesView() {
  const [file, setFile] = useState<{ file: File; group: string } | null>(null);
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [done, setDone] = useState<ImportResponse | null>(null);
  // One drop, in flight. Held by identity so UploadQueue can tell a re-drop from a re-render;
  // a new array is a new batch and the same array never is.
  const [queued, setQueued] = useState<File[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which imports are open. A Set rather than one id: two imports CAN be worth having open at
  // once (the same expense entered in the wrong group is exactly when you would), and an
  // accordion that closes one to open another loses the position you had in it.
  const [open, setOpen] = useState<Set<string> | null>(null);
  const { version, bump } = useLedgerVersion();
  // Guards against a drop being read twice while the first read is still resolving.
  const reading = useRef(false);

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

  async function accept(files: File[]) {
    if (reading.current) return;
    reading.current = true;
    setError(null);
    try {
      const marks = await Promise.all(files.map(looksLikePdf));
      const textual = files.filter((_, i) => !marks[i]);

      // A single text file is the export path: its GROUP comes from the filename and is part of
      // a record's identity, and it is the one import worth previewing. Everything else — any
      // PDF, or several files at once — goes to the queue, which sends each on its own merits.
      if (files.length === 1 && textual.length === 1) {
        const group = groupFromFilename(textual[0].name);
        setFile({ file: textual[0], group });
        setDone(null);
        setQueued(null);
        await send(textual[0], group, true);
        return;
      }
      setPreview(null);
      setFile(null);
      setDone(null);
      setQueued(files);
    } finally {
      reading.current = false;
    }
  }

  async function send(payload: File, group: string, dryRun: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate<ImportResponse>(
        `/evidence/import?group=${encodeURIComponent(group)}` +
          `&filename=${encodeURIComponent(payload.name)}${dryRun ? "&dry_run=1" : ""}`,
        {
          method: "POST",
          // The FILE, not its text. `file.text()` decodes the bytes as UTF-8 and substitutes
          // U+FFFD for anything invalid, irreversibly — see the note on EvidenceDrop's props.
          // The server sniffs the leading bytes and decodes text itself, so this path is
          // unchanged for a CSV and safe for everything that is not one.
          headers: { "Content-Type": "application/octet-stream" },
          body: payload,
        },
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
  const showDrop = preview === null && done === null && queued === null;

  // NOTHING IS DRAWN UNTIL THE SHAPE OF THE PAGE IS KNOWN.
  //
  // The drop target has two sizes, and which one is right depends on whether any import
  // exists — so drawing it before the answer arrived meant drawing the WRONG one: the full
  // 200px invitation appeared, the request landed, and it collapsed to a 56px bar, pulling
  // everything below it up the page. A resize on arrival is the least forgiving thing an
  // interface can do, because the thing you were about to click moves out from under you.
  //
  // `loading` is exactly "there is nothing to show yet", and with data held across refetches
  // it is true only on the FIRST load — so this gate costs nothing afterwards. See useFetch:
  // `refreshing` is the flag for "a request is in flight", and that one deliberately keeps
  // what is on screen rather than replacing it.
  const settled = !imports.loading;

  return (
    <div>
      {/* ABOVE everything, and the only thing on screen during the first load. It used to sit
          under the drop panel, where on arrival it read as "the uploader is working" — it is
          the PAGE that is working. Once settled it has the drop panel above it and the list
          below, which is where a list's own progress belongs. useBusy keeps it dark for
          anything fast enough not to need it. */}
      <div className={"busybar" + (working ? " on" : "")} aria-hidden="true">
        <i />
      </div>

      {settled && (
        <div className="sources-body">
          {/* The drop target is slim once there is anything to work on, and a full invitation
              only when there is not. See EvidenceDrop for why that is a statement rather than
              a tweak — and it is now decided once rather than corrected. */}
          {showDrop && (
            <EvidenceDrop
              busy={busy}
              compact={batches.length > 0}
              onFiles={(files) => void accept(files)}
            />
          )}

          {error !== null && <p className="note">{error}</p>}

          {queued !== null && (
            <UploadQueue
              files={queued}
              // The inbox below re-reads off the ledger version, so a finished batch appears
              // without this screen holding anything about what was in it.
              onFinished={bump}
              onDismiss={() => setQueued(null)}
            />
          )}

          {preview !== null && file !== null && (
            <ImportReceipt
              result={preview}
              busy={busy}
              onCommit={() => void send(file.file, file.group, false)}
              onDiscard={reset}
            />
          )}

          {done !== null && (
            <ImportReceipt result={done} busy={false} onDone={() => setDone(null)} />
          )}

          {imports.error !== null && <p className="note">{imports.error}</p>}

          {/* The inbox sits ABOVE the imports: it is the newest work and the only work with
              nothing on the ledger behind it yet. It renders nothing at all when there is
              nothing staged, so this screen is unchanged for anyone who only uses exports. */}
          <StagedReview />

          {/* The imports are permanent, not part of an import result: a near miss you did not
              judge today is still waiting next week, and it would be lost if it only ever
              appeared on the screen that produced it. */}
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
      )}
    </div>
  );
}
