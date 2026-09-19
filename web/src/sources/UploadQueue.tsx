import { useEffect, useRef, useState } from "react";

import { errorText, mutate } from "../shared/api";
import { groupFromFilename } from "./sources";

// Bringing a few hundred files in, four at a time, with the progress said out loud.
//
// WHY NOT ONE REQUEST. A few hundred in a single call runs for minutes inside one HTTP
// request: proxies time out, there is no progress, it is not resumable, and one credit note
// near the end rolls back everything before it that already worked. A
// rollback of minutes of correct work is a worse outcome than the failure that caused it.
//
// WHY NOT ALL AT ONCE. Hundreds of parallel uploads spawn as many Python interpreters against a
// connection pool of ten.
//
// So: four at a time, ONE TRANSACTION PER FILE on the server. The bottleneck is Python startup
// (~1.6s, mostly importing pdfplumber), so four-way reaches roughly two minutes, and each file
// commits or is held on its own. The unit of atomicity matches the person's unit, which is an
// order — never "the drop".
//
// AND IT IS RESUMABLE, which is why nothing here blocks a re-drop. The server dedupes on the
// content hash, so interrupting at file 100 and dropping the whole folder again skips the first 100
// almost instantly. An interface that refused the second drop would be protecting the person
// from the recovery path.

/** Four — chosen against Python startup cost and a ten-connection pool, not tuned. */
const CONCURRENCY = 4;

/** How the server answers an upload. A 202 ("stored, nothing reads it yet") is a success. */
type ImportAck = {
  artifact?: { id?: string; parse_status?: string; duplicate_bytes?: boolean };
  message?: string;
  /** Present only on the Splitwise path, which this queue does not narrate in detail. */
  imported?: { rows?: number };
};

/** What became of one file. Kept per file because "230 of 250" is not an account of anything. */
export type Outcome = {
  name: string;
  /** The request itself succeeded. Says nothing about whether anything could parse the file. */
  ok: boolean;
  /** `staged` | `parsed` | `unsupported` | `failed` | `pending`, or null when the call failed. */
  status: string | null;
  said: string;
  /** The server already had these exact bytes. The resumable path, not a mistake. */
  duplicate: boolean;
};

/** Held = stored, but nothing can post it yet. A state, and never an error. */
function isHeld(o: Outcome): boolean {
  return o.ok && (o.status === "unsupported" || o.status === "failed");
}

async function sendOne(file: File): Promise<Outcome> {
  try {
    const ack = await mutate<ImportAck>(
      `/evidence/import?filename=${encodeURIComponent(file.name)}` +
        // The group rides along on every upload, and the server ignores it for anything that
        // is not a text export. One code path: deciding here which files "need" a group would
        // mean deciding here what each file IS, which is the server's answer to give.
        `&group=${encodeURIComponent(groupFromFilename(file.name))}`,
      {
        method: "POST",
        // The File itself. `Content-Type` is set explicitly so the browser does not infer one
        // from the Blob — the server sniffs the leading bytes either way and never reads this
        // header, but sending a header that claims to know is worse than sending one that does
        // not. The body is bytes; nothing decodes it before it leaves.
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      },
    );
    return {
      name: file.name,
      ok: true,
      status: ack.artifact?.parse_status ?? null,
      said: ack.message ?? (ack.imported !== undefined ? "imported" : "stored"),
      duplicate: ack.artifact?.duplicate_bytes === true,
    };
  } catch (e) {
    return { name: file.name, ok: false, status: null, said: errorText(e), duplicate: false };
  }
}

export default function UploadQueue({
  files,
  onFinished,
  onDismiss,
}: {
  files: File[];
  /** Fired once, when the queue drains — the review screen re-reads the inbox off this. */
  onFinished: () => void;
  onDismiss: () => void;
}) {
  const [done, setDone] = useState<Outcome[]>([]);
  const [running, setRunning] = useState(true);
  // A flag, not an AbortController. Stopping means "send no MORE files": the four requests
  // already out are each a committed transaction on the server, and killing one mid-flight
  // buys nothing and loses the answer to work that has already happened.
  const stopped = useRef(false);
  // WHICH BATCH HAS ALREADY BEEN STARTED, by identity.
  //
  // StrictMode runs every effect twice in development — mount, clean up, mount again — and an
  // effect that UPLOADS is not idempotent the way an effect that fetches is. Without this
  // guard a drop of 250 files is sent 500 times in dev. Keyed on the array's identity because
  // `files` is handed down once per drop and never mutated, so "same array" is exactly "same
  // batch"; a length or a name would call two identical drops one.
  const startedFor = useRef<File[] | null>(null);

  useEffect(() => {
    if (startedFor.current === files) return;
    startedFor.current = files;
    stopped.current = false;
    setDone([]);
    setRunning(true);

    // A shared cursor and N workers pulling from it — the standard bounded-concurrency shape,
    // and it is safe without a lock only because JavaScript runs one thing at a time between
    // awaits: `cursor++` cannot interleave. A chunked version (slice 4, await all, next 4)
    // would idle three workers behind the slowest file in every chunk.
    let cursor = 0;
    async function worker() {
      for (;;) {
        if (stopped.current) return;
        const i = cursor++;
        if (i >= files.length) return;
        const outcome = await sendOne(files[i]);
        setDone((held) => [...held, outcome]);
      }
    }

    void (async () => {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()),
      );
      setRunning(false);
      onFinished();
    })();

    // NO cleanup that cancels. Two reasons, and they point the same way: StrictMode's cleanup
    // is indistinguishable from a real unmount, so cancelling there would abort every batch in
    // development; and an upload is a WRITE, so a person switching tabs mid-run wants the
    // remaining imports to land, not to be silently abandoned half done. The state updates
    // after an unmount are harmless — React has not warned about them since 18.
  }, [files, onFinished]);

  const held = done.filter(isHeld).length;
  const failed = done.filter((o) => !o.ok).length;
  const duplicates = done.filter((o) => o.duplicate).length;
  const pct = files.length === 0 ? 100 : Math.round((done.length / files.length) * 100);

  return (
    <div className="receipt upload">
      <div className="sect">
        <span>{running ? "Bringing them in" : "Brought in"}</span>
        <span className="pill">{files.length} files</span>
      </div>

      {/* A determinate bar, unlike the .busybar everywhere else on this screen: there IS a
          denominator here, and "112 of 250" is the only thing that makes a two-minute wait
          bearable. Same hairline geometry, so it still reads as the same system. */}
      <div className="up-track" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </div>

      <p className="up-line">
        <b className="mono">
          {done.length} of {files.length}
        </b>
        {held > 0 && (
          <span className="soft">
            {" · "}
            {held} need the local model
          </span>
        )}
        {duplicates > 0 && (
          <span className="soft">
            {" · "}
            {duplicates} already had
          </span>
        )}
        {failed > 0 && <span className="flag">{` · ${failed} could not be sent`}</span>}
      </p>

      {/* Only the one note that asks something of a person. The rest — resumability, what
          "held" means — is a tooltip or is said by the card below it. */}
      {!running && failed > 0 && (
        <p className="soft up-note">Drop them again to retry — the ones that landed are skipped.</p>
      )}

      {done.length > 0 && (
        <details className="fold" open={!running && (held > 0 || failed > 0)}>
          <summary>File by file</summary>
          <div className="table-scroll short">
            <table>
              <colgroup>
                <col />
                <col style={{ width: "120px" }} />
                <col style={{ width: "40%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>File</th>
                  <th>State</th>
                  <th>What the server said</th>
                </tr>
              </thead>
              <tbody>
                {/* Newest first: during a run the interesting row is the one that just landed,
                    and a list that grows downwards puts it wherever the scroll happens to be. */}
                {[...done].reverse().map((o, i) => (
                  <tr key={`${o.name}-${done.length - i}`}>
                    <td className="narration">{o.name}</td>
                    <td className={o.ok ? (isHeld(o) ? "soft" : "credit") : "debit"}>
                      {!o.ok
                        ? "not sent"
                        : isHeld(o)
                          ? "held"
                          : o.duplicate
                            ? "already had"
                            : (o.status ?? "stored")}
                    </td>
                    <td className="soft narration">{o.said}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="preview-actions">
        {running ? (
          <button
            className="btn-secondary"
            title="Dropping the same files again picks up where this left off"
            onClick={() => {
              stopped.current = true;
            }}
          >
            Stop after the ones in flight
          </button>
        ) : (
          <button className="btn-secondary" onClick={onDismiss}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}
