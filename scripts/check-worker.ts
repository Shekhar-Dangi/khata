// Does the worker loop actually drain, retry and survive? Run against a live database.
//
//   node --env-file=.env scripts/check-worker.ts
//
// NOT fully rollback-safe like check-queue.ts: the worker opens its own connections, so its
// work cannot sit inside one outer transaction. It therefore cleans up after itself by id and
// touches ONLY parse_batches / parse_jobs — never an artifact, never the ledger.

import { pool } from "../src/db.ts";
import { consent, enqueueBatch, listActiveBatches } from "../src/parse-queue.ts";
import { ParseFailure, startWorker } from "../src/parse-worker.ts";

const ok = (label: string, cond: boolean, extra = "") =>
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);

const c = await pool.connect();
let batchId = "";
try {
  const arts = await c.query<{ id: string }>("SELECT id FROM artifacts ORDER BY id LIMIT 4");
  const ids = arts.rows.map((r) => r.id);

  await c.query("BEGIN");
  ({ batchId } = await enqueueBatch(c, "llm_receipt", ids));
  await consent(c, batchId);
  await c.query("COMMIT");

  // One document is a transient failure twice, then succeeds; one is permanently bad.
  const seen = new Map<string, number>();
  const handler = async (_client: any, job: any) => {
    const n = (seen.get(job.artifactId) ?? 0) + 1;
    seen.set(job.artifactId, n);
    if (job.artifactId === ids[1] && n <= 2) {
      throw new ParseFailure("llm_unavailable", "ollama not running");
    }
    if (job.artifactId === ids[2]) {
      throw new ParseFailure("does_not_reconcile", "lines 1519 vs stated 1619");
    }
    if (job.artifactId === ids[3]) throw new Error("something nobody named");
  };

  // Start it, wait for the batch to SETTLE, then ask it to stop. `maxJobs` would need the
  // exact number of loop iterations (retries included), which is the thing under test — and
  // guessing it wrong leaves the loop polling an empty queue forever. Waiting on the batch is
  // also what a real caller does, and it exercises stop() on the way out.
  const w = startWorker({ handler, idlePollMs: 100 });

  const deadline = Date.now() + 30_000;
  let settled = false;
  while (Date.now() < deadline) {
    const b = (await listActiveBatches(20)).find((x) => x.batchId === batchId);
    if (b && b.queued === 0 && b.running === 0) { settled = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  ok("batch settles on its own", settled);

  const result = await w.stop();
  void result;
  const counts = await w.done;
  ok("loop drained", counts.processed + counts.failed > 0,
     `processed=${counts.processed} failed=${counts.failed}`);

  const rows = await c.query<{ artifact_id: string; state: string; attempts: number; error_kind: string | null }>(
    "SELECT artifact_id, state, attempts, error_kind FROM parse_jobs WHERE batch_id = $1 ORDER BY artifact_id",
    [batchId]);
  const by = new Map(rows.rows.map((r) => [r.artifact_id, r]));

  ok("clean document succeeds first time",
     by.get(ids[0])?.state === "done" && by.get(ids[0])?.attempts === 1,
     JSON.stringify(by.get(ids[0])));
  ok("transient failure is retried and then succeeds",
     by.get(ids[1])?.state === "done" && by.get(ids[1])?.attempts === 3,
     JSON.stringify(by.get(ids[1])));
  ok("permanent failure is terminal on attempt 1",
     by.get(ids[2])?.state === "failed" && by.get(ids[2])?.attempts === 1,
     JSON.stringify(by.get(ids[2])));
  ok("an unnamed throw fails closed as unknown",
     by.get(ids[3])?.state === "failed" && by.get(ids[3])?.error_kind === "unknown",
     JSON.stringify(by.get(ids[3])));

  const prog = (await listActiveBatches(20)).find((b) => b.batchId === batchId);
  ok("batch reports finished", prog?.finished === true,
     prog ? `done=${prog.done} failed=${prog.failed} total=${prog.total}` : "not found");

  const stuck = await c.query("SELECT count(*)::int AS n FROM parse_jobs WHERE batch_id = $1 AND state IN ('queued','running')", [batchId]);
  ok("nothing left in flight", stuck.rows[0].n === 0);
} finally {
  if (batchId) await c.query("DELETE FROM parse_batches WHERE id = $1", [batchId]);
  console.log("\n  cleaned up batch", batchId);
  c.release();
  await pool.end();
}
