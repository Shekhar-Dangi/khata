import { useEffect, useRef, useState } from "react";

import { useFetch } from "../shared/useFetch";
import { useLedgerVersion } from "../shared/ledgerVersion";

// The model path, as the browser sees it: what could be read, what is being read, and how far
// along it is. Shapes mirror src/routes/parse.ts. the design.

/** Why the model could not read a document the last time it was asked. */
export type LastFailure = {
  kind: string | null;
  /** For a person. */
  reason: string | null;
  /** The specific: which total, which setting to change. */
  detail: string | null;
  at: string;
};

export type Candidate = {
  artifact_id: string;
  original_name: string | null;
  byte_size: number;
  /** Why the deterministic path could not read it: `unsupported` or `failed`. */
  parse_status: string;
  reason: string | null;
  /** The recognised merchant, or null when nothing recognised the document. */
  template: string | null;
  /** Null when the model has never been asked. */
  last_failure: LastFailure | null;
};

export type Candidates = {
  candidates: Candidate[];
  total: number;
  /** Never tried. What an offer counts. */
  fresh: number;
  retryable: number;
  median_seconds: number | null;
  estimate_seconds: number | null;
  model?: string;
};

export type BatchFailure = {
  artifact_id: string;
  original_name: string | null;
  kind: string | null;
  reason: string | null;
  detail: string | null;
};

export type Batch = {
  batchId: string;
  kind: string;
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  consented: boolean;
  finished: boolean;
  estimate_seconds: number | null;
  reading: { original_name: string | null; attempt: number; started_at: string | null }[];
  failures: BatchFailure[];
};

export type Progress = { batches: Batch[]; median_seconds: number | null };

/**
 * How often to ask while something is being read.
 *
 * One document is minutes on a CPU, so a second-by-second poll would report nothing new ninety
 * times in a row. Five seconds is quick enough that a finished document shows up while you are
 * still looking, and slow enough to be invisible.
 */
const POLL_MS = 5_000;

/**
 * Batch progress, polled ONLY while there is something to watch.
 *
 * A poll that ran forever would be a request every five seconds for the life of the tab to
 * report that nothing is happening. So it asks once, keeps asking while a batch is live, and
 * stops when none is — and the ledger version wakes it again, which is what starting a batch
 * bumps. That is also why a page reloaded in the middle of a batch picks it straight back up:
 * the first read sees it running.
 *
 * Two components use this (the Sources panel and the tab's own count), and each polls on its
 * own. That is the known trade-off of `useFetch` — no de-duplication — recorded in the
 * the working notes, and at one indexed query per five seconds it is not yet the one worth fixing.
 */
export function useParseProgress() {
  const { version } = useLedgerVersion();
  const [tick, setTick] = useState(0);
  const progress = useFetch<Progress>("/evidence/parse-progress", {
    keepPreviousData: true,
    // Two counters folded into the ONE number `revalidateOn` takes by design (see useFetch):
    // either changing must mean "ask again". They could only collide after 100,000 polls —
    // six days of continuous reading — and a collision would cost one skipped refresh.
    revalidateOn: version * 100_000 + tick,
  });
  const live = (progress.data?.batches ?? []).some((b) => !b.finished);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTick((t) => t + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [live]);

  return { progress, live };
}

/**
 * Fire `onAdvance` whenever documents finish, so the inbox below re-reads and the order that
 * just landed appears without anyone refreshing.
 *
 * Keyed on the COUNT of finished documents rather than on every poll: bumping the ledger
 * version refetches the summary strip, the inbox and anything else watching it, and doing that
 * every five seconds to report that nothing changed would be the waste the poll was careful
 * to avoid.
 */
export function useOnAdvance(batches: Batch[], onAdvance: () => void) {
  const finished = batches.reduce((a, b) => a + b.done + b.failed, 0);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    // The first reading is a baseline, not an advance: a page opened after a batch finished
    // has nothing new to announce.
    if (seen.current !== null && finished > seen.current) onAdvance();
    seen.current = finished;
  }, [finished, onAdvance]);
}

/** "about 4 min", from seconds. Rounded, because precision here would be a lie. */
export function roughly(seconds: number): string {
  if (seconds < 90) return "about a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `about ${hours} h`;
}

/** "3 Blinkit invoices, 1 document nothing recognised" — what a set of candidates IS. */
export function describeCandidates(list: Candidate[]): string {
  const counts = new Map<string, number>();
  for (const c of list) {
    const key = c.template ?? "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([template, n]) =>
      template === ""
        ? `${n} ${n === 1 ? "document" : "documents"} nothing recognised`
        : `${n} ${template[0].toUpperCase()}${template.slice(1)} ${n === 1 ? "invoice" : "invoices"}`,
    )
    .join(", ");
}
