// The durable queue: enqueue work, claim it safely, finish it honestly, reclaim what died.
//
// This module knows NOTHING about docling, about models or
// about invoices — it moves rows between four states and counts them. That separation is the
// reason it can be tested without either of the two heavy dependencies the feature needs, and
// the reason a second kind of slow work can reuse it without teaching it a second vocabulary.
//
// The pure half — which errors deserve a retry, and what a set of job counts means — is in
// `parse-queue-policy.ts` beside this, same split as rules.ts / transfers.ts / items.ts and
// for the same reason: this decides whether a document gets a second chance, and getting that
// wrong either burns minutes re-asking a settled question or gives up on a transient hiccup.

import type { PoolClient } from "pg";

import { pool } from "./db.ts";
import { type ErrorKind, isTransient } from "./parse-queue-policy.ts";

/** How long a worker may hold a job before another may take it. See `reclaimExpired`. */
export const LEASE_MS = 5 * 60_000;

/** Attempts a TRANSIENT failure gets before it becomes terminal. A permanent one gets none. */
export const MAX_ATTEMPTS = 3;

export type JobState = "queued" | "running" | "done" | "failed";

export type ClaimedJob = {
  id: string;
  artifactId: string;
  batchId: string;
  attempts: number;
};

/**
 * Create a batch and its jobs in one transaction, UNCONSENTED.
 *
 * Nothing runs yet, and that is the point: `consented_at` is null, and the claim query below
 * refuses to see a batch that has not been agreed to. The estimate this batch represents is
 * half an hour to an hour and a half of local compute, and spending it because a file was
 * dropped — rather than because a person said yes — is the difference between a tool and a
 * surprise.
 *
 * @returns the batch id and how many jobs were actually enqueued, which may be FEWER than
 *          `artifactIds` — see the conflict note below.
 */
export async function enqueueBatch(
  client: PoolClient,
  kind: "llm_receipt",
  artifactIds: string[],
): Promise<{ batchId: string; enqueued: number; alreadyQueued: number }> {
  if (artifactIds.length === 0) {
    throw new Error("a batch needs at least one artifact");
  }

  const batch = await client.query<{ id: string }>(
    "INSERT INTO parse_batches (kind, total) VALUES ($1, $2) RETURNING id",
    [kind, artifactIds.length],
  );
  const batchId = batch.rows[0].id;

  // ON CONFLICT DO NOTHING against `parse_jobs_one_outstanding`. A document already queued or
  // running in an EARLIER batch is not enqueued again: running docling and the model twice
  // over identical bytes would produce two attempts to stage one order, and the loser reports
  // a constraint violation as though the document were bad. Silently skipping is right here
  // and the count says so, which is what stops it being silent.
  const inserted = await client.query(
    `INSERT INTO parse_jobs (artifact_id, batch_id)
     SELECT unnest($1::bigint[]), $2
     ON CONFLICT DO NOTHING`,
    [artifactIds, batchId],
  );
  const enqueued = inserted.rowCount ?? 0;

  // The denominator has to match what will actually run, or the bar never reaches the end.
  if (enqueued !== artifactIds.length) {
    await client.query("UPDATE parse_batches SET total = $2 WHERE id = $1", [
      batchId,
      Math.max(enqueued, 1),
    ]);
  }

  return { batchId, enqueued, alreadyQueued: artifactIds.length - enqueued };
}

/** A person pressed Proceed. Until this runs, `claimNext` cannot see the batch's jobs. */
export async function consent(client: PoolClient, batchId: string): Promise<boolean> {
  const res = await client.query(
    "UPDATE parse_batches SET consented_at = now() WHERE id = $1 AND consented_at IS NULL",
    [batchId],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Take the oldest runnable job, or null when there is none.
 *
 * `FOR UPDATE SKIP LOCKED` is the whole concurrency design. One worker is the intent — the
 * model serves one request at a time, so a second would only queue inside Ollama — but during
 * a `node --watch` restart the old process and the new one genuinely overlap, and SKIP LOCKED
 * makes double-claiming IMPOSSIBLE rather than merely discouraged. Without it, two workers
 * select the same row, both update it, and one document is parsed twice.
 *
 * The lease is taken in the same statement that claims the row, so there is no window in which
 * a job is running and unleased.
 */
export async function claimNext(client: PoolClient): Promise<ClaimedJob | null> {
  const res = await client.query<{
    id: string; artifact_id: string; batch_id: string; attempts: number;
  }>(
    `UPDATE parse_jobs j
        SET state      = 'running',
            claimed_at = now(),
            started_at = COALESCE(j.started_at, now()),
            attempts   = j.attempts + 1
      WHERE j.id = (
        SELECT c.id
          FROM parse_jobs c
          JOIN parse_batches b ON b.id = c.batch_id
         WHERE c.state = 'queued'
           -- UNCONSENTED WORK IS INVISIBLE. Not filtered in the worker, where forgetting it
           -- would be one missing condition away from spending an hour nobody asked for.
           AND b.consented_at IS NOT NULL
         -- THE id TIE-BREAK IS LOAD-BEARING, the same way chooseWinner's is.
         -- Every job in a batch is inserted by ONE statement, so they all carry the same
         -- created_at — and SQL guarantees nothing about the order of tied rows, so without
         -- this the queue drains in whatever order the plan happens to produce, and that
         -- changes as the table grows. Found by the lifecycle check: a job returned to the
         -- queue by a transient failure was overtaken by one enqueued at the same instant.
         ORDER BY c.created_at, c.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING j.id, j.artifact_id, j.batch_id, j.attempts`,
  );
  const row = res.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    artifactId: row.artifact_id,
    batchId: row.batch_id,
    attempts: row.attempts,
  };
}

/**
 * The job produced a record.
 *
 * Takes a client rather than opening its own transaction, because the caller has just written
 * the staged record and THE TWO MUST COMMIT TOGETHER. A job marked done whose record rolled
 * back is a document the queue will never look at again and the ledger has never seen.
 */
export async function complete(client: PoolClient, jobId: string): Promise<void> {
  await client.query(
    `UPDATE parse_jobs
        SET state = 'done', claimed_at = NULL, finished_at = now(), error_kind = NULL
      WHERE id = $1`,
    [jobId],
  );
  await settleBatch(client, jobId);
}

/**
 * The job did not.
 *
 * A TRANSIENT error goes back to `queued` until the attempt cap; a PERMANENT one is terminal
 * immediately. Retrying `does_not_reconcile` three times spends three minutes to be told the
 * same thing, and the arithmetic gate is deterministic — the document has not changed between
 * attempts, so neither has the answer.
 *
 * Failing is never data loss. The artifact keeps its bytes and its named reason, and
 * `POST /evidence/artifacts/:id/reparse` runs it again once something has actually changed.
 */
export async function fail(
  client: PoolClient,
  job: ClaimedJob,
  kind: ErrorKind,
  detail: string,
): Promise<{ willRetry: boolean }> {
  const willRetry = isTransient(kind) && job.attempts < MAX_ATTEMPTS;

  if (willRetry) {
    await client.query(
      `UPDATE parse_jobs
          SET state = 'queued', claimed_at = NULL, error_kind = $2, error_detail = $3
        WHERE id = $1`,
      [job.id, kind, detail.slice(0, 2000)],
    );
    return { willRetry };
  }

  await client.query(
    `UPDATE parse_jobs
        SET state = 'failed', claimed_at = NULL, finished_at = now(),
            error_kind = $2, error_detail = $3
      WHERE id = $1`,
    [job.id, kind, detail.slice(0, 2000)],
  );
  await settleBatch(client, job.id);
  return { willRetry };
}

/**
 * Return every expired lease to the queue. Run on boot and on a timer.
 *
 * THE FAILURE THIS EXISTS FOR: a worker that dies holds nothing. There is no lock to release,
 * because the process that held it is gone — so without this, one killed process strands a job
 * in `running` forever and its batch never finishes, waiting on a worker that no longer
 * exists. Under `node --watch` that is not a rare event, it is most Tuesdays.
 *
 * `attempts` was already incremented when the job was claimed, so a job killed repeatedly
 * reaches the cap and stops rather than looping forever. That is why the increment lives in
 * the CLAIM and not in the completion — a crash never reaches a completion.
 */
export async function reclaimExpired(client: PoolClient): Promise<number> {
  const res = await client.query(
    `UPDATE parse_jobs
        SET state = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
            claimed_at = NULL,
            finished_at = CASE WHEN attempts >= $2 THEN now() ELSE NULL END,
            error_kind = 'worker_died',
            error_detail = 'the worker holding this job stopped before finishing it'
      WHERE state = 'running'
        AND claimed_at < now() - ($1::int || ' milliseconds')::interval`,
    [LEASE_MS, MAX_ATTEMPTS],
  );
  return res.rowCount ?? 0;
}

/** Close a batch once nothing is outstanding. Idempotent — the WHERE clause is the guard. */
async function settleBatch(client: PoolClient, jobId: string): Promise<void> {
  await client.query(
    `UPDATE parse_batches b
        SET finished_at = now()
      WHERE b.id = (SELECT batch_id FROM parse_jobs WHERE id = $1)
        AND b.finished_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM parse_jobs o
           WHERE o.batch_id = b.id AND o.state IN ('queued', 'running')
        )`,
    [jobId],
  );
}

export type BatchProgress = {
  batchId: string;
  kind: string;
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  consented: boolean;
  finished: boolean;
};

/**
 * Every batch that is not finished, plus any that finished recently.
 *
 * ONE query for all of them, not one per batch. The UI asks for this on a timer, and a poll
 * that costs a query per batch is a poll that gets slower exactly as a person's backlog grows.
 */
export async function listActiveBatches(limit = 10): Promise<BatchProgress[]> {
  const res = await pool.query<{
    id: string; kind: string; total: number; consented_at: string | null;
    finished_at: string | null; queued: string; running: string; done: string; failed: string;
  }>(
    `SELECT b.id, b.kind, b.total, b.consented_at, b.finished_at,
            count(*) FILTER (WHERE j.state = 'queued')  AS queued,
            count(*) FILTER (WHERE j.state = 'running') AS running,
            count(*) FILTER (WHERE j.state = 'done')    AS done,
            count(*) FILTER (WHERE j.state = 'failed')  AS failed
       FROM parse_batches b
       LEFT JOIN parse_jobs j ON j.batch_id = b.id
      WHERE b.finished_at IS NULL
         OR b.finished_at > now() - interval '1 hour'
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    batchId: r.id,
    kind: r.kind,
    total: Number(r.total),
    // pg returns count() as BIGINT, which arrives as a STRING. Comparing these without
    // Number() is the documented trap in this codebase and it silently sorts "10" before "9".
    queued: Number(r.queued),
    running: Number(r.running),
    done: Number(r.done),
    failed: Number(r.failed),
    consented: r.consented_at !== null,
    finished: r.finished_at !== null,
  }));
}
