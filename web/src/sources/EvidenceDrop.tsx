import { useRef, useState } from "react";

// ONE drop target for every kind of external record — a Splitwise export today, an order
// invoice next. Deliberately not a per-source form.
//
// The server decides what a file is, by its CONTENT (see detectSource). So the person never
// has to answer "what kind of file is this?", which is a question the machine can answer and
// they can get wrong. Adding a source later adds nothing to this component.

type Props = {
  /** Called with the file's text once. The parent decides preview vs commit. */
  onFile: (text: string, name: string) => void;
  busy: boolean;
};

export default function EvidenceDrop({ onFile, busy }: Props) {
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
        className={`dropzone${over ? " over" : ""}`}
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
        <p className="dropzone-lead">Drop an export or receipt here</p>
        <p className="soft">
          A Splitwise group export today. Order invoices when their parsers land — the file
          says what it is, so you never have to.
        </p>
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
