// The loop that drains the queue, and the only thing in this feature that runs on its own.
//
// It owns exactly three concerns — WHEN to look
// for work, HOW to hold a job while doing it, and WHAT to do when a handler throws — and knows
// nothing about docling, models or invoices. The handler is injected, so this machinery is
// provable before either heavy dependency exists.
//
// WHY A POLLING LOOP AND NOT LISTEN/NOTIFY. NOTIFY does not survive a disconnect and does not
// replay: a notification sent while this process was restarting is simply gone, and the batch
// stalls until something else happens to poke it. A poll cannot miss an edge, and at one query
// every two seconds against a partial index the cost is not worth optimising on a single-user
// local tool. The moment that stops being true, NOTIFY belongs on TOP of the poll as a latency
// improvement, never instead of it.

import type { PoolClient } from "pg";

import { pool } from "./db.ts";
import {
  type ClaimedJob,
  LEASE_MS,
  claimNext,
  complete,
  fail,
  reclaimExpired,
} from "./parse-queue.ts";
import { type ErrorKind, isErrorKind } from "./parse-queue-policy.ts";

/** Quiet-queue poll interval. Short enough to feel immediate, long enough to be invisible. */
const IDLE_POLL_MS = 2_000;

/**
 * How often a running job's lease is pushed forward.
 *
 * MUST be comfortably under LEASE_MS or a job that is merely SLOW gets reclaimed while it is
 * still working — and then two workers parse one document, which is the exact thing
 * SKIP LOCKED exists to prevent, reintroduced through the back door. One job can legitimately
 * run ~6 minutes on a CPU (docling ~45s, then a ~4-5 minute model read), far past the 5-minute
 * lease — which is fine ONLY because this renews it every ~100s while the job works.
 */
const HEARTBEAT_MS = Math.floor(LEASE_MS / 3);

/**
 * A failure a handler can raise to name its own error kind.
 *
 * Anything else that throws becomes `unknown`, which `retryPolicy` treats as PERMANENT. That
 * asymmetry is deliberate: an unclassified failure is one nobody has reasoned about, and
 * looping on it is how a queue spends an afternoon discovering the same thing three times.
 */
export class ParseFailure extends Error {
  // Declared and assigned explicitly, NOT as a constructor parameter property.
  //
  // `constructor(readonly kind: ErrorKind, ...)` typechecks and then fails at runtime with
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: Node's strip-only mode may only REMOVE types, and a
  // parameter property requires it to EMIT an assignment. Same family as the backtick-in-a-
  // SQL-comment trap — tsc is not the thing that runs this code.
  kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = "ParseFailure";
    this.kind = kind;
  }
}

/**
 * What a worker does with one document.
 *
 * Receives the SAME client that holds the job, so whatever it writes commits with the job's
 * completion or rolls back with its failure. That is what makes "done" mean "the record is in
 * the database" rather than "the code reached the end without throwing".
 */
export type JobHandler = (client: PoolClient, job: ClaimedJob) => Promise<void>;

export type WorkerOptions = {
  handler: JobHandler;
  idlePollMs?: number;
  /** Stop after this many jobs. For tests and scripts; the server passes nothing. */
  maxJobs?: number;
};

export type WorkerHandle = {
  /** Ask the loop to finish the job in flight and stop. Resolves when it has. */
  stop(): Promise<void>;
  /** Resolves when the loop exits, whether by `stop()` or by `maxJobs`. */
  done: Promise<{ processed: number; failed: number }>;
};

/**
 * Run one job to completion, in its own transaction.
 *
 * THE TRANSACTION BOUNDARY IS THE WHOLE CONTRACT. The handler's writes and the job's terminal
 * state are one commit, so the three states a crash can leave behind collapse to two:
 * "not started" and "finished". There is no "record written, job still queued" — which would
 * stage the same order twice on the retry — and no "job done, record rolled back", which would
 * lose a document silently and never look at it again.
 *
 * The failure path needs a SECOND connection, because the first one's transaction is being
 * rolled back and cannot also record why. Reusing it would abort the write that explains the
 * abort, and the job would sit in `running` until its lease expired — turning a clean,
 * explained failure into a five-minute mystery.
 */
async function runJob(job: ClaimedJob, handler: JobHandler): Promise<boolean> {
  const client = await pool.connect();
  const heartbeat = setInterval(() => {
    // Fire-and-forget on purpose: a missed heartbeat is survivable (the lease still has two
    // thirds of its life left), and an await here would serialise against the handler's own
    // work on a different connection for no benefit.
    void pool
      .query("UPDATE parse_jobs SET claimed_at = now() WHERE id = $1 AND state = 'running'", [job.id])
      .catch(() => {});
  }, HEARTBEAT_MS);

  try {
    await client.query("BEGIN");
    await handler(client, job);
    await complete(client, job.id);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});

    const kind: ErrorKind =
      err instanceof ParseFailure && isErrorKind(err.kind) ? err.kind : "unknown";
    const detail = err instanceof Error ? err.message : String(err);

    const reporter = await pool.connect();
    try {
      await reporter.query("BEGIN");
      await fail(reporter, job, kind, detail);
      await reporter.query("COMMIT");
    } catch {
      // If we cannot even record the failure the job stays `running` and the lease sweep
      // collects it. Degraded, not lost — which is the reason the lease exists.
      await reporter.query("ROLLBACK").catch(() => {});
    } finally {
      reporter.release();
    }
    return false;
  } finally {
    clearInterval(heartbeat);
    client.release();
  }
}

/**
 * Start the loop. Returns immediately; the work happens in the background.
 *
 * ONE JOB AT A TIME, and that is not a simplification to revisit later — the local model serves
 * one request at a time on this hardware (`llm.ts` says so and measured it), so a second worker
 * would only queue inside Ollama while making every failure mode harder to reason about.
 */
export function startWorker(opts: WorkerOptions): WorkerHandle {
  const idle = opts.idlePollMs ?? IDLE_POLL_MS;
  let stopping = false;
  let wake: (() => void) | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => { wake = null; resolve(); }, ms);
      // `stop()` cancels the wait instead of adding up to `idle` to every shutdown.
      wake = () => { clearTimeout(timer); wake = null; resolve(); };
    });

  const done = (async () => {
    let processed = 0;
    let failed = 0;

    // Anything left `running` by a process that is no longer alive — which after a `--watch`
    // restart is anything that was in flight. Done once at startup so a restart resumes rather
    // than waits out a five-minute lease.
    await withClient((c) => reclaimExpired(c)).catch(() => 0);

    while (!stopping) {
      if (opts.maxJobs !== undefined && processed + failed >= opts.maxJobs) break;

      let job: ClaimedJob | null = null;
      try {
        job = await withClient((c) => claimNext(c));
      } catch {
        // The database is unreachable. Back off rather than spinning on a dead pool.
        await sleep(idle);
        continue;
      }

      if (job === null) {
        // Nothing to do. Sweep expired leases on the same idle beat — it costs one indexed
        // query against a partial index and it means a crashed worker's job is picked up by
        // whoever is idle, rather than waiting for the next restart.
        await withClient((c) => reclaimExpired(c)).catch(() => 0);
        await sleep(idle);
        continue;
      }

      if (await runJob(job, opts.handler)) processed++;
      else failed++;
    }

    return { processed, failed };
  })();

  return {
    stop: async () => {
      stopping = true;
      wake?.();
      await done;
    },
    done,
  };
}

async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}
