import { useRef, useState } from "react";

// ONE drop target for every kind of external record — a Splitwise export today, an order
// invoice next. Deliberately not a per-source form.
//
// The server decides what a file is, by its CONTENT (see detectSource). So the person never
// has to answer "what kind of file is this?", which is a question the machine can answer and
// they can get wrong. Adding a source later adds nothing to this component.
//
// TWO SIZES, and which one shows is a statement about what the screen is for. On an empty
// ledger, bringing a file in is the only thing you can do, so it is a 200px invitation. Once
// records are in, the screen is a WORKLIST and importing is an occasional errand at the top of
// it — a full-height panel there pushed the work you came for below the fold, every time.

type Props = {
  /** Called with the file's text once. The parent decides preview vs commit. */
  onFile: (text: string, name: string) => void;
  busy: boolean;
  /** Slim bar rather than a panel. Still a drop target — dragging must work in both. */
  compact?: boolean;
};

export default function EvidenceDrop({ onFile, busy, compact = false }: Props) {
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function take(file: File | undefined) {
    if (file === undefined) return;
    setRejected(null);
    // 5 MB matches the server's own limit. Checking here as well means the person is told
    // immediately rather than after uploading and waiting for a 413.
    if (file.size > 5 * 1024 * 1024) {
      setRejected(`${file.name} is larger than 5 MB`);
      return;
    }
    onFile(await file.text(), file.name);
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
          void take(e.dataTransfer.files[0]);
        }}
      >
        <p className="dropzone-lead">
          {compact ? "Bring in another export or receipt" : "Drop an export or receipt here"}
        </p>
        {!compact && (
          <>
            <p className="soft">
              A Splitwise group export today. Order invoices when their parsers land — the file
              says what it is, so you never have to.
            </p>
            {/* The reassurance sits INSIDE the panel rather than under it. It was a
                left-aligned paragraph below a centred panel — an orphan with nothing to line
                up against — and it opened by restating the fact the empty panel above it had
                already made ("Nothing imported yet"). What is left is the half that answers
                the question a person actually has with a file in their hand. */}
            <p className="soft dropzone-note">
              Nothing is written until you have seen what it would do. Re-importing the same
              file updates records rather than duplicating them.
            </p>
          </>
        )}
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Reading…" : "Choose a file"}
        </button>
        {/* The input is the real control; the whole panel is a bigger target for it. Hidden
            with `hidden` rather than display:none so it stays reachable by label/click. */}
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          onChange={(e) => {
            void take(e.target.files?.[0]);
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
