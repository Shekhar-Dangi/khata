import { useRef, useState } from "react";

// ONE drop target for every kind of external record — a Splitwise export, an order invoice,
// two hundred and fifty of them at once. Deliberately not a per-source form.
//
// The server decides what a file is, by its CONTENT (see `sniffMime` in src/artifacts.ts). So
// the person never has to answer "what kind of file is this?", which is a question the machine
// can answer and they can get wrong. Adding a source later adds nothing to this component.
//
// TWO SIZES, and which one shows is a statement about what the screen is for. On an empty
// ledger, bringing a file in is the only thing you can do, so it is a 200px invitation. Once
// records are in, the screen is a WORKLIST and importing is an occasional errand at the top of
// it — a full-height panel there pushed the work you came for below the fold, every time.

/**
 * The server's own cap (`UPLOAD_LIMIT` in src/server.ts). Checked here as well so the person is
 * told immediately rather than after uploading and waiting for a 413.
 *
 * It was 5 MB here long after the server was raised to 10 for the artifact store, which is the
 * failure mode a duplicated constant always has: the copy that is WRONG is the one that
 * refuses work the system would have accepted, and it refuses it silently and locally.
 */
const MAX_BYTES = 10 * 1024 * 1024;

type Props = {
  /**
   * Called with the FILES, never their text.
   *
   * `file.text()` was the bug this signature exists to prevent: it decodes the bytes as UTF-8,
   * every invalid sequence becomes U+FFFD, and the substitution is irreversible — so a PDF
   * arrived at the server as mush, and it arrived looking like a perfectly ordinary string.
   * This is the client-side twin of an earlier server-side bug:
   * `express.text()` on the import route decoded uploads the same way, which is why the route
   * takes `express.raw()` and sniffs the leading bytes instead. Bytes stay bytes on both sides
   * of the wire now; a `File` is a `Blob`, and fetch sends one without touching its contents.
   */
  onFiles: (files: File[]) => void;
  busy: boolean;
  /** Slim bar rather than a panel. Still a drop target — dragging must work in both. */
  compact?: boolean;
};

export default function EvidenceDrop({ onFiles, busy, compact = false }: Props) {
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function take(list: FileList | null) {
    setRejected(null);
    const files = list === null ? [] : [...list];
    if (files.length === 0) return;

    // Oversized files are dropped from the batch, not the batch from them. A person dragging a
    // folder of 250 invoices where one is 11 MB should upload 249 and be told about the one —
    // refusing the whole drop would make them find the offender themselves, from a message
    // that named it and then threw away everything around it.
    const tooBig = files.filter((f) => f.size > MAX_BYTES);
    const ok = files.filter((f) => f.size <= MAX_BYTES);
    if (tooBig.length > 0) {
      setRejected(
        tooBig.length === 1
          ? `${tooBig[0].name} is larger than 10 MB and was left out.`
          : `${tooBig.length} files are larger than 10 MB and were left out.`,
      );
    }
    if (ok.length > 0) onFiles(ok);
  }

  return (
    <div>
      <div
        className={`dropzone${compact ? " compact" : ""}${over ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          // The whole list, not `files[0]`. Taking one file out of a drop of two hundred is
          // not a smaller import — it is 199 files silently discarded, with the interface
          // reporting success for the one it kept.
          take(e.dataTransfer.files);
        }}
      >
        <p className="dropzone-lead">
          {compact
            ? "Bring in more exports or invoices"
            : "Drop exports or invoices here"}
        </p>
        {/* The reassurance sits INSIDE the panel rather than under it. It was a left-aligned
            paragraph below a centred panel — an orphan with nothing to line up against — and
            it opened by restating the fact the empty panel above it had already made
            ("Nothing imported yet"). What is left is the half that answers the question a
            person actually has with a file in their hand. */}
        {!compact && (
          <p className="soft dropzone-note">
            Whole folders are fine. Nothing reaches your ledger until you have seen what it
            would do, and dropping the same files again picks up where you left off rather than
            duplicating them.
          </p>
        )}
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Reading…" : "Choose files"}
        </button>
        {/* The input is the real control; the whole panel is a bigger target for it. Hidden
            with `hidden` rather than display:none so it stays reachable by label/click.
            `accept` is a FILTER in the picker, never a decision about what the file is — the
            server sniffs the bytes and is the only thing entitled to that answer. */}
        <input
          ref={input}
          type="file"
          multiple
          accept=".csv,.pdf,text/csv,text/plain,application/pdf"
          hidden
          onChange={(e) => {
            take(e.target.files);
            // Clear it, or choosing the SAME file twice fires no change event and the
            // second attempt looks like a dead button.
            e.target.value = "";
          }}
        />
      </div>
      {rejected !== null && <p className="note">{rejected}</p>}
    </div>
  );
}
