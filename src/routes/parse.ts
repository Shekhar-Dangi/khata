// The model path's HTTP surface: what needs it, saying yes to it, and how far along it is.
//
// Four routes, and the shape of them is the design:
// a person is TOLD what would happen, then AGREES to it, then WATCHES it. Nothing here starts
// work as a side effect of asking a question.
//
// It lives with its concern rather than its prefix, the same way `/accounts/:id/keywords` is a
// transfers route. These paths sit under `/evidence` because that is where a person finds
// them, and they are owned here because what they are about is the parse queue.

import { Router } from "express";

import { pool } from "./../db.ts";
import { badRequest, intParam, notFound, route, withTransaction } from "./../http.ts";
import { consent, enqueueBatch, listActiveBatches } from "./../parse-queue.ts";
import { explain, isErrorKind } from "./../parse-queue-policy.ts";
import { RECEIPT_LLM } from "./../llm-config.ts";

const router = Router();
export { router as parse };

/**
 * Which stored documents the deterministic path could not read.
 *
 * `unsupported` means nothing recognised the template; `failed` means a parser ran and could
 * not produce a record. BOTH are model candidates and they are deliberately not collapsed:
 * migration 011 keeps them apart because the first is fixed by writing code and the second by
 * fixing code, and that difference is worth showing a person deciding whether to spend an hour.
 *
 * `pending` is excluded. A document nothing has looked at yet has not earned the model's time —
 * the deterministic path is a second away and free, and it lands most of the corpus.
 */
const CANDIDATE_SQL = `
  FROM artifacts a
 WHERE a.mime = 'application/pdf'
   AND a.parse_status IN ('unsupported', 'failed')
   -- Never re-queue something already outstanding. The partial unique index would refuse the
   -- insert anyway, but counting it here means the estimate a person is shown matches the work
   -- that will actually run.
   AND NOT EXISTS (
     SELECT 1 FROM parse_jobs j
      WHERE j.artifact_id = a.id AND j.state IN ('queued', 'running')
   )`;

/**
 * GET /evidence/llm-parse/candidates — what the model WOULD be asked to read.
 *
 * A read, and only a read. The count is the number the consent dialog quotes, so it is
 * computed the same way the enqueue computes it — one SQL fragment, used twice, because two
 * copies of "what counts as a candidate" is how a dialog comes to promise 80 and run 74.
 */
router.get("/evidence/llm-parse/candidates", route(async (_req, res) => {
  const rows = await pool.query<{
    id: string; original_name: string | null; byte_size: number;
    parse_status: string; parse_error: string | null; source_type: string | null;
    last_kind: string | null; last_detail: string | null; last_at: string | null;
  }>(
    // THE LAST ATTEMPT, per document. A failed job leaves the artifact's own status exactly as
    // it was — `unsupported` stays `unsupported` — so without this a document the model just
    // failed on is indistinguishable from one it has never seen, and the screen would offer to
    // read it again the moment the batch finished, forever. The two are different questions:
    // "read these new ones?" is an offer; "try this one again?" needs the reason beside it.
    `SELECT a.id, a.original_name, a.byte_size, a.parse_status, a.parse_error, a.source_type,
            last.error_kind AS last_kind, last.error_detail AS last_detail,
            last.finished_at AS last_at
     ${CANDIDATE_SQL.replace(
       "FROM artifacts a",
       `FROM artifacts a
        LEFT JOIN LATERAL (
          SELECT j.error_kind, j.error_detail, j.finished_at
            FROM parse_jobs j
           WHERE j.artifact_id = a.id AND j.state = 'failed'
           ORDER BY j.finished_at DESC, j.id DESC
           LIMIT 1
        ) last ON true`,
     )}
     ORDER BY a.created_at DESC`,
  );

  const median = await medianJobSeconds();
  const candidates = rows.rows.map((r) => ({
    artifact_id: r.id,
    original_name: r.original_name,
    byte_size: Number(r.byte_size),
    parse_status: r.parse_status,
    // Why the deterministic path could not read it, in a person's words when it is one of ours.
    reason: isErrorKind(r.parse_error) ? explain(r.parse_error) : r.parse_error,
    template: r.source_type,
    // Null when the model has never been asked. Otherwise why it could not answer — the named
    // kind for the code, the sentence for a person, and the detail that names what to change.
    last_failure:
      r.last_at === null
        ? null
        : {
            kind: r.last_kind,
            reason: isErrorKind(r.last_kind) ? explain(r.last_kind) : r.last_kind,
            detail: r.last_detail,
            at: r.last_at,
          },
  }));
  const fresh = candidates.filter((c) => c.last_failure === null).length;
  return res.json({
    candidates,
    total: candidates.length,
    /** Never tried by the model. What an offer to "read them" should count. */
    fresh,
    /** Tried and failed. Shown with their reasons, and re-run only when a person asks. */
    retryable: candidates.length - fresh,
    // Which model would do the reading, so the consent a person gives names what they are
    // agreeing to run — a 26B model on a CPU and a 4B one on a GPU are different hours.
    model: RECEIPT_LLM.model,
    // Null on a first run, and null is the honest answer: with nothing finished there is no
    // rate, and a countdown invented from no data is confidently wrong for ten minutes.
    median_seconds: median,
    estimate_seconds: median === null ? null : Math.round(fresh * median),
  });
}));

/**
 * POST /evidence/llm-parse — create an UNCONSENTED batch over the candidates.
 *
 * Takes explicit `artifact_ids`, or `all: true` meaning every candidate. A call carrying
 * NEITHER is refused: the browser holds one page and cannot name the rest, so ids would
 * silently mean the page, and "all" must be said out loud rather than implied by omission.
 * Same rule as `POST /items/category`, and it is here for the same reason.
 *
 * THIS STARTS NOTHING. The batch exists with `consented_at` null, and `claimNext` cannot see
 * an unconsented batch — so the estimate can be shown and declined without anything having run.
 */
router.post("/evidence/llm-parse", route(async (req, res) => {
  const body = req.body ?? {};
  const wantsAll = body.all === true;
  const ids = body.artifact_ids;

  if (!wantsAll && !Array.isArray(ids)) {
    throw badRequest("pass `artifact_ids`, or `all: true` to queue every candidate");
  }
  if (Array.isArray(ids) && ids.length === 0) {
    throw badRequest("`artifact_ids` was empty — nothing to queue");
  }
  // Every id shaped like one BEFORE it reaches `::bigint[]`. Postgres would reject "abc" too,
  // but as a 500 with a database error in the log — for what was only ever a bad request. The
  // same test `intParam` applies to every route id, and for the same reason.
  if (Array.isArray(ids) && !ids.every((id: unknown) => typeof id === "string" && /^\d+$/.test(id))) {
    throw badRequest("every artifact id must be a numeric string");
  }

  const result = await withTransaction(async (client) => {
    // Resolved against the candidate set either way, so an id that is not a candidate — a
    // document already staged, or one already queued — is dropped here rather than becoming
    // a job that immediately fails.
    const rows = await client.query<{ id: string }>(
      wantsAll
        ? `SELECT a.id ${CANDIDATE_SQL} ORDER BY a.created_at DESC`
        : `SELECT a.id ${CANDIDATE_SQL} AND a.id = ANY($1::bigint[]) ORDER BY a.created_at DESC`,
      wantsAll ? [] : [ids.map(String)],
    );
    if (rows.rowCount === 0) return null;

    const enq = await enqueueBatch(client, "llm_receipt", rows.rows.map((r) => r.id));
    return enq;
  });

  if (result === null) {
    return res.status(409).json({
      error: "nothing to queue — every document named is already readable, staged, or in flight",
    });
  }

  const median = await medianJobSeconds();
  return res.status(201).json({
    batch_id: result.batchId,
    queued: result.enqueued,
    skipped: result.alreadyQueued,
    consented: false,
    estimate_seconds: median === null ? null : Math.round(result.enqueued * median),
    message:
      `${result.enqueued} document(s) will be read by the local model. ` +
      "Nothing leaves this machine. Confirm to start.",
  });
}));

/**
 * POST /evidence/llm-parse/:batchId/consent — a person said yes, and only now does work begin.
 *
 * Idempotent: a second call answers 200 with `already: true` rather than an error, because a
 * double-click is not a failure and must not read as one.
 */
router.post("/evidence/llm-parse/:batchId/consent", route(async (req, res) => {
  // The same `intParam` every route id goes through. Not a hand-rolled regex: `Number("abc")`
  // is NaN and `Number("")` is 0, neither throws, and an unchecked id reaches Postgres as NaN
  // and comes back a 500 for what was only ever a bad request.
  const batchId = String(intParam(req.params.batchId, "batch id"));

  const started = await withTransaction(async (client) => {
    const exists = await client.query("SELECT 1 FROM parse_batches WHERE id = $1", [batchId]);
    if (exists.rowCount === 0) throw notFound("no such batch");
    return consent(client, batchId);
  });

  return res.json({ batch_id: batchId, consented: true, already: !started });
}));

/**
 * GET /evidence/parse-progress — every batch still running, and any that just finished.
 *
 * Polled, so it is ONE query for all batches rather than one per batch (see
 * `listActiveBatches`). Recently-finished batches are included on purpose: a bar that vanishes
 * the instant the last job lands never shows anyone the result of the thing they waited for.
 */
router.get("/evidence/parse-progress", route(async (_req, res) => {
  const batches = await listActiveBatches(10);
  const median = await medianJobSeconds();

  // The failures, so the progress panel can say WHAT went wrong rather than only how many did —
  // and the detail, because for a settings problem the detail is the part that names the fix.
  const failures = await pool.query<{
    batch_id: string; artifact_id: string; original_name: string | null;
    error_kind: string | null; error_detail: string | null;
  }>(
    `SELECT j.batch_id, j.artifact_id, a.original_name, j.error_kind, j.error_detail
       FROM parse_jobs j
       JOIN artifacts a ON a.id = j.artifact_id
      WHERE j.state = 'failed'
        AND j.batch_id = ANY($1::bigint[])
      ORDER BY j.finished_at DESC
      LIMIT 100`,
    [batches.map((b) => b.batchId)],
  );

  // What is being read RIGHT NOW. On a CPU one document is minutes, and a bar that sits still
  // for four of them reads as a hang unless it says what it is waiting on. The attempt number
  // rides along so a retry after a restart is visible as one rather than as a document that
  // mysteriously started again.
  const running = await pool.query<{
    batch_id: string; original_name: string | null; attempts: number; started_at: string | null;
  }>(
    `SELECT j.batch_id, a.original_name, j.attempts, j.started_at
       FROM parse_jobs j
       JOIN artifacts a ON a.id = j.artifact_id
      WHERE j.state = 'running' AND j.batch_id = ANY($1::bigint[])`,
    [batches.map((b) => b.batchId)],
  );

  return res.json({
    batches: batches.map((b) => ({
      ...b,
      estimate_seconds:
        median === null ? null : Math.round((b.queued + b.running) * median),
      reading: running.rows
        .filter((r) => r.batch_id === b.batchId)
        .map((r) => ({ original_name: r.original_name, attempt: Number(r.attempts), started_at: r.started_at })),
      failures: failures.rows
        .filter((f) => f.batch_id === b.batchId)
        .map((f) => ({
          artifact_id: f.artifact_id,
          original_name: f.original_name,
          kind: f.error_kind,
          reason: isErrorKind(f.error_kind) ? explain(f.error_kind) : f.error_kind,
          detail: f.error_detail,
        })),
    })),
    median_seconds: median,
  });
}));

/**
 * How long a finished job has actually taken, as a MEDIAN.
 *
 * Median rather than mean: one document that hit the 180s ceiling would drag a mean far enough
 * to make every estimate wrong, and the thing being estimated is the typical case. Null when
 * nothing has finished — see the note in `estimateRemaining` about why that is the right answer
 * rather than a guess.
 */
async function medianJobSeconds(): Promise<number | null> {
  const res = await pool.query<{ median: string | null }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at))
            ) AS median
       FROM parse_jobs
      WHERE state = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL`,
  );
  const median = res.rows[0]?.median;
  // NUMERIC arrives as a string from pg. Number() first, always.
  if (median === null || median === undefined) return null;
  const n = Number(median);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
