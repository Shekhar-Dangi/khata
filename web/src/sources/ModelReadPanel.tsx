import { useCallback, useState } from "react";

import { errorText, mutate } from "../shared/api";
import { useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";
import {
  type Batch,
  type BatchFailure,
  type Candidate,
  type Candidates,
  describeCandidates,
  roughly,
  useOnAdvance,
  useParseProgress,
} from "./modelRead";
import { useReportActivity } from "./pageActivity";

// Reading, with the local model, the documents no parser can.
//
// Three states, and the page shows whichever are true — they are not a wizard:
//
//   OFFER     files no parser can read, that the model has never been asked about.
//             Nothing runs until a person presses the button: on a CPU this is minutes per
//             document, and spending an hour of the machine because a file was dropped is the
//             difference between a tool and a surprise.
//   READING   a batch in flight. Polled while it runs and never otherwise. Says WHICH document
//             it is on, because a bar that sits still for four minutes reads as a hang.
//   RESULT    a batch that finished in the last hour — how many landed in the inbox below, and
//             for every one that did not, why, with the detail that names what to change.
//
// DRAWN IN THE UPLOAD QUEUE'S LANGUAGE on purpose: same card, same prose line, same hairline
// determinate bar, same fold. It is the same kind of thing — a batch of files becoming work —
// and a second visual vocabulary for it would make two halves of one flow look unrelated.
//
// It renders NOTHING when none of the three is true, so the screen is unchanged for anyone who
// never drops a document a parser cannot read.

export default function ModelReadPanel() {
  const { version, bump } = useLedgerVersion();
  const { progress } = useParseProgress();
  const batches = progress.data?.batches ?? [];
  const live = batches.filter((b) => !b.finished);

  // Candidates re-read whenever the ledger moves (an upload finishing, a batch advancing) AND
  // whenever the batch list changes shape — a document leaves the candidate set the moment it
  // is queued, and the offer must not keep counting it.
  const shape = batches.map((b) => `${b.batchId}:${b.queued}:${b.running}`).join("|");
  const candidates = useFetch<Candidates>(
    `/evidence/llm-parse/candidates?_=${encodeURIComponent(shape)}`,
    { keepPreviousData: true, revalidateOn: version },
  );

  useReportActivity(progress.loading || candidates.loading, candidates.refreshing);

  // Documents finishing move the inbox below; this makes it re-read, once per document.
  useOnAdvance(progress.data?.batches ?? null, useCallback(() => bump(), [bump]));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Not now" and "Done" are this visit's answers, not stored ones. The offer comes back the
  // next time the page opens because the files are still unread; a finished batch drops off
  // the server's list by itself after an hour.
  const [snoozed, setSnoozed] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const list = candidates.data?.candidates ?? [];
  const fresh = list.filter((c) => c.last_failure === null);
  const failedBefore = list.filter((c) => c.last_failure !== null);
  const finished = batches.filter((b) => b.finished && !dismissed.has(b.batchId));

  /** Queue these documents AND start them: the button a person pressed is the consent. */
  async function read(ids: string[]) {
    setBusy(true);
    setError(null);
    try {
      const created = await mutate<{ batch_id: string }>("/evidence/llm-parse", {
        method: "POST",
        // EXACT IDS, not `all: true`. The person agreed to the files listed on screen, and a
        // file that arrived between the list and the click is not one of them.
        body: JSON.stringify({ artifact_ids: ids }),
      });
      await mutate(`/evidence/llm-parse/${created.batch_id}/consent`, { method: "POST" });
      // Wakes the progress poll (it listens to the ledger version) and re-reads the offer,
      // which must now be empty — everything it listed is queued.
      bump();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const showOffer = fresh.length > 0 && live.length === 0 && !snoozed;
  if (live.length === 0 && finished.length === 0 && !showOffer && failedBefore.length === 0 && error === null) {
    return null;
  }

  return (
    <div className="model-read">
      {live.map((b) => (
        <Reading key={b.batchId} batch={b} />
      ))}

      {finished.map((b) => (
        <Finished
          key={b.batchId}
          batch={b}
          onDone={() => setDismissed((held) => new Set(held).add(b.batchId))}
        />
      ))}

      {showOffer && (
        <Offer
          fresh={fresh}
          model={candidates.data?.model ?? null}
          estimate={candidates.data?.estimate_seconds ?? null}
          busy={busy}
          onRead={() => void read(fresh.map((c) => c.artifact_id))}
          onLater={() => setSnoozed(true)}
        />
      )}

      {/* Tried before and failed: never re-offered automatically — the same model on the same
          document gives the same answer. Hidden while a batch runs so the page is not two lists
          of the same files. */}
      {failedBefore.length > 0 && live.length === 0 && (
        <details className="fold">
          <summary>{failedBefore.length} couldn't be read before</summary>
          <FailureTable
            rows={failedBefore.map((c) => ({
              artifact_id: c.artifact_id,
              original_name: c.original_name,
              kind: c.last_failure?.kind ?? null,
              reason: c.last_failure?.reason ?? null,
              detail: c.last_failure?.detail ?? null,
            }))}
          />
          <div className="preview-actions">
            <button
              className="btn-secondary"
              disabled={busy}
              title="Worth it after a change — a model pulled, a window raised — and not otherwise"
              onClick={() => void read(failedBefore.map((c) => c.artifact_id))}
            >
              Try again
            </button>
          </div>
        </details>
      )}

      {error !== null && <p className="note">{error}</p>}
    </div>
  );
}

// ONE LINE PER CARD: what, a count, the action. The owner's call (2026-09-19), after the first
// real drop put a paragraph in front of two files. Anything longer is a `title` — there for the
// person who wants it, invisible to the one who does not.

function Offer({
  fresh,
  model,
  estimate,
  busy,
  onRead,
  onLater,
}: {
  fresh: Candidate[];
  model: string | null;
  estimate: number | null;
  busy: boolean;
  onRead: () => void;
  onLater: () => void;
}) {
  return (
    <div className="receipt upload">
      <p className="up-line">
        <b>{describeCandidates(fresh)}</b>
        <span className="soft">
          {" · no parser yet"}
          {estimate !== null && ` · ${roughly(estimate)}`}
        </span>
      </p>

      <div className="preview-actions">
        <button
          className="btn"
          disabled={busy}
          // The part a person may want before agreeing, kept off the page.
          title={
            `${model ?? "The local model"} runs on this machine. Nothing reaches your ledger ` +
            "until you confirm each order."
          }
          onClick={onRead}
        >
          {busy ? "Starting…" : "Read with local model"}
        </button>
        <button className="btn-secondary" disabled={busy} onClick={onLater}>
          Not now
        </button>
      </div>

      <details className="fold">
        <summary>Which files</summary>
        <FileList files={fresh} />
      </details>
    </div>
  );
}

function FileList({ files }: { files: Candidate[] }) {
  return (
    <div className="table-scroll short">
      <table>
        <colgroup>
          <col />
          <col style={{ width: "120px" }} />
        </colgroup>
        <thead>
          <tr>
            <th>File</th>
            <th>Merchant</th>
          </tr>
        </thead>
        <tbody>
          {files.map((c) => (
            <tr key={c.artifact_id} title={c.reason ?? c.parse_status}>
              <td className="narration">{c.original_name ?? `document ${c.artifact_id}`}</td>
              <td className="soft">{c.template ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Reading({ batch }: { batch: Batch }) {
  const finished = batch.done + batch.failed;
  // The denominator is what was actually queued, never what was asked for. See `isSettled`.
  const total = Math.max(batch.total, finished + batch.queued + batch.running, 1);
  const pct = Math.round((finished / total) * 100);
  const now = batch.reading[0];

  return (
    <div className="receipt upload">
      <p
        className="up-line"
        // Which file, and whether it is a retry — useful when the bar sits still for four
        // minutes, noise otherwise.
        title={
          now === undefined
            ? "Waiting for the model"
            : `Reading ${now.original_name ?? "a document"}` +
              (now.attempt > 1 ? ` — attempt ${now.attempt}` : "")
        }
      >
        <b>
          Reading {Math.min(finished + (now !== undefined ? 1 : 0), total)} of {total}
        </b>
        <span className="soft">
          {batch.estimate_seconds !== null && ` · ${roughly(batch.estimate_seconds)} left`}
        </span>
        {batch.failed > 0 && <span className="flag">{` · ${batch.failed} couldn't be read`}</span>}
      </p>

      <div className="up-track" aria-hidden="true">
        <i style={{ width: `${pct}%` }} />
      </div>

      {batch.failures.length > 0 && (
        <details className="fold">
          <summary>Why</summary>
          <FailureTable rows={batch.failures} />
        </details>
      )}
    </div>
  );
}

function Finished({ batch, onDone }: { batch: Batch; onDone: () => void }) {
  return (
    <div className="receipt done">
      <p className="up-line">
        <b>
          {batch.done} of {batch.total} read
        </b>
        {batch.done > 0 && <span className="soft"> · waiting below to confirm</span>}
        {batch.failed > 0 && <span className="flag">{` · ${batch.failed} couldn't be read`}</span>}
      </p>

      {batch.failures.length > 0 && (
        <details className="fold">
          <summary>Why</summary>
          <FailureTable rows={batch.failures} />
        </details>
      )}

      <div className="preview-actions">
        <button className="btn-secondary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * Every failure with its reason AND its detail — the detail is the part a person acts on
 * ("lines sum to Rs 1,519, the invoice states Rs 1,619", "set RECEIPT_LLM_NUM_CTX lower").
 */
function FailureTable({ rows }: { rows: BatchFailure[] }) {
  return (
    <div className="table-scroll short">
      <table>
        <colgroup>
          <col style={{ width: "30%" }} />
          <col style={{ width: "28%" }} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>File</th>
            <th>Why</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f.artifact_id}>
              <td className="narration">{f.original_name ?? `document ${f.artifact_id}`}</td>
              <td className="flag narration">{f.reason ?? f.kind ?? "unknown"}</td>
              <td className="soft narration">{f.detail ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * "reading 2/5" beside the Sources tab, while a batch runs — visible from every tab, which is
 * the part of "always visible" the panel cannot do from inside one page. Drawn with
 * `.mode-count`, the count that already rides along on a tab. Polls only while something runs.
 */
export function ReadingCount() {
  const { progress } = useParseProgress();
  const live = (progress.data?.batches ?? []).filter((b) => !b.finished);
  if (live.length === 0) return null;
  const finished = live.reduce((a, b) => a + b.done + b.failed, 0);
  const total = live.reduce((a, b) => a + b.total, 0);
  return (
    <span className="mode-count" title="Documents being read by the local model">
      {" "}reading {finished}/{total}
    </span>
  );
}
