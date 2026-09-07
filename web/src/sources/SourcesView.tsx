import { useRef, useState } from "react";

import { errorText, mutate } from "../shared/api";
import { useBusy, useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";
import Pager from "../shared/Pager";
import EvidenceDrop from "./EvidenceDrop";
import ImportBatchPanel from "./ImportBatchPanel";
import ImportReceipt from "./ImportReceipt";
import StagedReview from "./StagedReview";
import UploadQueue from "./UploadQueue";
import { groupFromFilename, type ImportBatch, type ImportResponse } from "./sources";

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

/**
 * Imports per page. Generous: each is one collapsed line, and the list is what you scan to
 * find the one you came for — a short page would turn a scan into a hunt.
 */
const LIST_PAGE = 8;

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
  // Which imports are open. EMPTY on arrival, always: the page opens nothing on your behalf.
  //
  // It used to open the newest import that still had work, on the reasoning that landing on a
  // finished import would make the page look empty when it was not. That reasoning was about
  // the wrong screen — the collapsed rows already carry their own counts, so an unopened list
  // says how much is waiting without expanding anything, and an accordion that springs open on
  // arrival moves everything under it before you have read any of it.
  //
  // A Set rather than one id: two imports CAN be worth having open at once (the same expense
  // entered in the wrong group is exactly when you would), and an accordion that closes one to
  // open another loses the position you had in it.
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Where in the imports list we are. Paged on the CLIENT: `/evidence/imports` is one row per
  // group, so it is a handful of rows that all arrive together, and a server round trip per
  // page would be a request to re-count something already in memory.
  const [listOffset, setListOffset] = useState(0);
  // A FRESH DROP OWNS THE PAGE.
  //
  // Uploading is not the same act as revisiting. Coming back to an import a week later, the
  // list is the point — you are choosing which one to work on. Having just dropped 24 files,
  // there is nothing to choose, and reviewing them inside a panel wedged between a drop target
  // and six other imports makes the thing you are doing the smallest thing on screen.
  //
  // So the drop switches the page into a single-import view, and leaving it is one explicit
  // click rather than a scroll. Nothing is hidden that was not just put there.
  const [focused, setFocused] = useState(false);
  const { version, bump } = useLedgerVersion();
  // Guards against a drop being read twice while the first read is still resolving.
  const reading = useRef(false);

  const imports = useFetch<{ imports: ImportBatch[] }>("/evidence/imports", {
    keepPreviousData: true,
    revalidateOn: version,
  });
  const working = useBusy(imports.refreshing);
  const batches = imports.data?.imports ?? [];

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
      setFocused(true);
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
      const next = new Set(held);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const isOpen = (group: string) => open.has(group);
  // An open panel must stay reachable: paging away from the import you were working in would
  // be the vanishing this screen exists to stop, so the pager is the only thing that moves
  // the window and it never closes anything.
  const shown = batches.slice(listOffset, listOffset + LIST_PAGE);
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
          {focused ? (
            <>
              {/* One way out, at the top, always in the same place. Leaving is a click rather
                  than a scroll past everything you just imported. */}
              <div className="sources-focus">
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setFocused(false);
                    setQueued(null);
                  }}
                >
                  &lsaquo; All sources
                </button>
                <span className="soft">reviewing what you just dropped</span>
              </div>

              {error !== null && <p className="note">{error}</p>}

              {queued !== null && (
                <UploadQueue
                  files={queued}
                  // The inbox below re-reads off the ledger version, so a finished batch
                  // appears without this screen holding anything about what was in it.
                  onFinished={bump}
                  onDismiss={() => setQueued(null)}
                />
              )}

              <StagedReview />
            </>
          ) : (
            <>
              {/* The drop target is slim once there is anything to work on, and a full
                  invitation only when there is not. See EvidenceDrop for why that is a
                  statement rather than a tweak. */}
              {showDrop && (
                <EvidenceDrop
                  busy={busy}
                  compact={batches.length > 0}
                  onFiles={(files) => void accept(files)}
                />
              )}

              {error !== null && <p className="note">{error}</p>}

              {/* A single text export keeps its inline preview rather than taking the page:
                  its flow is preview-then-commit and what it produces is an import panel in
                  the list below, so focusing it would hide the thing it just made. The page
                  is given over to a DROP OF FILES, which is the case with nothing to choose
                  between and a review that fills a screen on its own. */}
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

              {/* The inbox sits ABOVE the imports: it is the newest work and the only work
                  with nothing on the ledger behind it yet. It renders nothing at all when
                  there is nothing staged, so this screen is unchanged for anyone who only
                  uses exports. */}
              <StagedReview />

              {/* The imports are permanent, not part of an import result: a near miss you did
                  not judge today is still waiting next week, and it would be lost if it only
                  ever appeared on the screen that produced it. */}
              <div className={working || imports.isStale ? "is-stale" : undefined}>
                {shown.map((b) => (
                  <ImportBatchPanel
                    key={b.group}
                    batch={b}
                    expanded={isOpen(b.group)}
                    onToggle={() => toggle(b.group)}
                  />
                ))}
              </div>

              <Pager
                offset={listOffset}
                limit={LIST_PAGE}
                total={batches.length}
                shown={shown.length}
                onOffset={setListOffset}
                unit="imports"
                busy={working}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
