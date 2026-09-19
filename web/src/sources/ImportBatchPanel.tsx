import { useState } from "react";

import Pager from "../shared/Pager";
import { errorText, mutate } from "../shared/api";
import { useBusy, useFetch } from "../shared/useFetch";
import { useReportActivity } from "./pageActivity";
import { useLedgerVersion } from "../shared/ledgerVersion";
import RecordTable, { type Activity } from "./RecordTable";
import {
  SEGMENTS,
  type ImportBatch,
  type RecordState,
  type RecordsResponse,
  outstanding,
  shortDate,
} from "./sources";

// One import, and everything still unresolved about it, behind one collapse.
//
// The queue this replaces was flat: every unmatched record from every export in a single list,
// with no way to tell which file a row came from and no way to put a finished import away. So
// the screen only ever grew, and the fifteen rows you dealt with last month sat above the
// three you care about today.
//
// Keyed by GROUP rather than by upload, because re-importing an export is the same import —
// the writer upserts on the natural key. See `listImports` on the server for the full reason.

/** Records per page. The rows are tall (a record plus what it links to), so a screenful. */
const PAGE = 8;

export default function ImportBatchPanel({
  batch,
  expanded,
  onToggle,
}: {
  batch: ImportBatch;
  expanded: boolean;
  onToggle: () => void;
}) {
  // What just happened, and how to take it back. See the note on the tray below.
  const [activity, setActivity] = useState<Activity[]>([]);
  const { bump } = useLedgerVersion();

  function record(next: Activity) {
    // Keyed by record, newest first: acting on the same row twice is one story, not two, and
    // the older line would offer an undo that no longer describes anything.
    setActivity((held) => [next, ...held.filter((a) => a.evidenceId !== next.evidenceId)].slice(0, 4));
    bump();
  }

  const left = outstanding(batch);
  const segments = SEGMENTS.filter((s) => countOf(batch, s.state) > 0);

  return (
    <section className="batch">
      <button className="batch-head" aria-expanded={expanded} onClick={onToggle}>
        <span className="batch-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="batch-name">{batch.group}</span>
        <span className="pill">{batch.source}</span>
        <span className="soft batch-when">
          {batch.records} records · imported {shortDate(batch.lastImportedAt.slice(0, 10))}
        </span>
        <span className={`batch-left${left > 0 ? " flag" : " credit"}`}>
          {left > 0
            ? `${left} waiting on you`
            : batch.matched > 0
              ? `${batch.matched} matched · nothing waiting`
              : "nothing waiting"}
        </span>
      </button>

      {expanded && (
        <div className="batch-body">
          {activity.length > 0 && (
            <UndoTray entries={activity} onUndone={() => bump()} onClear={() => setActivity([])} />
          )}

          {segments.length === 0 ? (
            <p className="soft batch-empty">
              All placed
              {batch.noCashExpected > 0 && <> · {batch.noCashExpected} paid by others</>}
            </p>
          ) : (
            segments.map((s) => (
              <Segment
                key={s.state}
                group={batch.group}
                state={s.state}
                title={s.title}
                blurb={s.blurb}
                unit={s.unit}
                onChanged={record}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

function countOf(batch: ImportBatch, state: RecordState): number {
  if (state === "matched") return batch.matched;
  if (state === "near") return batch.near;
  // One line per state — a fallthrough here silently counts one segment as another, and a
  // CONFLICTED segment that inherited the unmatched count is worse than none: its header
  // promises rows its list then says are not there, while the real ones stay unreachable
  // with the header still counting them as work.
  if (state === "conflicted") return batch.conflicted;
  return batch.unmatched;
}

/**
 * One segment of the worklist, with its own position in it.
 *
 * Paged separately rather than as one list with headings, because the three are worked at
 * different rates: you skim fourteen matched rows once and then spend real time on three near
 * misses, and a single pager would make "next page" mean a different thing depending on where
 * you happened to be.
 */
function Segment({
  group,
  state,
  title,
  blurb,
  unit,
  onChanged,
}: {
  group: string;
  state: RecordState;
  title: string;
  blurb: string;
  unit: string;
  onChanged: (activity: Activity) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const { version } = useLedgerVersion();

  const { data, loading, error, isStale, refreshing } = useFetch<RecordsResponse>(
    `/evidence/records?group=${encodeURIComponent(group)}&state=${state}` +
      `&limit=${PAGE}&offset=${offset}`,
    // keepPreviousData: linking a record re-reads all three segments, and blanking the list
    // you are working through on every write is the flash this screen was built to remove.
    { keepPreviousData: true, revalidateOn: version },
  );
  const busy = useBusy(refreshing);
  // The page draws the one loading line; this segment only says it is waiting.
  useReportActivity(loading, refreshing);

  const rows = data?.records ?? [];
  const total = data?.total ?? 0;

  // A segment whose last row was just dealt with. Removing it silently would be the vanish
  // this screen is trying to stop; saying so once is the honest end of the list.
  if (!loading && error === null && total === 0) {
    return (
      <>
        <div className="sect">
          <span>{title}</span>
        </div>
        <p className="soft batch-empty">Nothing here any more.</p>
      </>
    );
  }

  return (
    <>
      <div className="sect">
        <span>{title}</span>
        <span className="soft">{total}</span>
      </div>
      {/* `.note` is the amber box for problems; a segment's description is not one. */}
      <p className="soft up-note">{blurb}</p>

      <div className={busy || isStale ? "is-stale" : undefined}>
        {error !== null && <p className="note">{error}</p>}
        <RecordTable
          records={rows}
          state={state}
          expandedId={openId}
          onExpand={setOpenId}
          onChanged={(a) => {
            setOpenId(null);
            onChanged(a);
          }}
        />
      </div>

      {total > PAGE && (
        <Pager
          offset={offset}
          limit={PAGE}
          total={total}
          shown={rows.length}
          onOffset={setOffset}
          unit={unit}
          busy={busy}
        />
      )}
    </>
  );
}

/**
 * What just happened, and how to take it back.
 *
 * Linking used to be a flicker: the row left the list and nothing said where it went or what
 * it did. That is the worst possible feedback for a write that moves money between categories
 * — the only evidence it worked was the absence of what you were looking at.
 *
 * So the action is stated, and it is REVERSIBLE from here. It is also reversible from the
 * matched list for as long as the record exists (every matched row carries Unlink); this strip
 * is the immediate one, for the moment you realise you ticked the wrong box.
 */
function UndoTray({
  entries,
  onUndone,
  onClear,
}: {
  entries: Activity[];
  onUndone: () => void;
  onClear: () => void;
}) {
  return (
    <div className="tray">
      <div className="tray-head">
        <span className="soft">Just now</span>
        <button className="btn-ghost" onClick={onClear}>
          Dismiss
        </button>
      </div>
      {entries.map((e) => (
        <TrayLine key={e.evidenceId} entry={e} onUndone={onUndone} />
      ))}
    </div>
  );
}

function TrayLine({ entry, onUndone }: { entry: Activity; onUndone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function undo() {
    setBusy(true);
    setError(null);
    try {
      if (entry.kind === "linked") {
        await mutate(`/evidence/${entry.evidenceId}/match`, { method: "DELETE" });
      } else {
        // Undoing an unlink means putting the SAME transactions back, so the ids are carried
        // in the entry — by the time this runs the record no longer knows them.
        await mutate(`/evidence/${entry.evidenceId}/match`, {
          method: "POST",
          body: JSON.stringify({ transaction_ids: entry.transactionIds }),
        });
      }
      setDone(true);
      onUndone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tray-line">
      <span className="tray-what">
        {entry.kind === "linked" ? "Linked" : entry.kind === "unlinked" ? "Unlinked" : "Filed"}{" "}
        <b>{entry.what}</b>
        <span className="soft">
          {" "}
          {entry.kind === "categorised"
            ? `under ${entry.categoryName ?? "a category"}`
            : `· ${entry.transactions} payment${entry.transactions === 1 ? "" : "s"}`}
        </span>
      </span>
      {/* Said only when it is true, and said BEFORE the undo rather than after it fails to
          restore something. The two halves of what a link removed are different sentences on
          purpose: a displaced rule guess is regenerated by a rules re-run, while a row the
          person wrote themselves is simply gone — and the second warning is the one that has
          to be earned. */}
      {entry.kind === "linked" && !done && (
        <>
          {entry.displacedAuthored > 0 && (
            <span className="flag tray-caveat">
              removed the explanation you wrote on {entry.displacedAuthored} transaction
              {entry.displacedAuthored === 1 ? "" : "s"} — undo will not bring it back
            </span>
          )}
          {entry.displaced - entry.displacedAuthored > 0 && (
            <span className="soft tray-caveat">
              replaced {entry.displaced - entry.displacedAuthored} rule guess
              {entry.displaced - entry.displacedAuthored === 1 ? "" : "es"} — re-run the rules
              to regenerate
            </span>
          )}
          {entry.partial && (
            <span className="flag tray-caveat">
              only others' share was written — '{entry.sourceCategory}' is a catch-all in the
              source, so open the row and file your share yourself
            </span>
          )}
        </>
      )}
      {error !== null && <span className="flag tray-caveat">{error}</span>}
      {/* Categorising has no Undo, and should not: it removes nothing, and the picker that
          set it is still on the row, open on the value it just wrote. A second way to change
          the same field would be a worse one. */}
      {entry.kind === "categorised" ? null : done ? (
        <span className="soft">undone</span>
      ) : (
        <button className="btn-ghost" disabled={busy} onClick={() => void undo()}>
          {busy ? "Undoing…" : "Undo"}
        </button>
      )}
    </div>
  );
}
