// Does the parse queue actually behave? Run it against a live database.
//
//   node --env-file=.env scripts/check-queue.ts
//
// SAFE ON REAL DATA. Everything happens inside one transaction that ends in ROLLBACK, so it
// leaves no batch, no job and no trace — unlike scripts/smoke.sh, whose documented cleanup is
// a full re-seed. It needs three artifacts to point jobs at and never modifies them.
//
// It exists because the queue is the one part of this feature that CANNOT be tested purely:
// FOR UPDATE SKIP LOCKED, the lease, and the ordering of a claim are all properties of
// Postgres rather than of our code, and a unit test with a fake client would assert that the
// fake behaves the way we hoped. It has already earned its place twice — it found a claim
// query with no tie-break (tied created_at values, so the drain order changed with the plan)
// and, through the runtime it needs, a backtick inside a SQL comment that tsc accepts and
// Node's type stripper rejects.

import { pool } from "../src/db.ts";
import {
  claimNext, complete, consent, enqueueBatch, fail, listActiveBatches, reclaimExpired,
} from "../src/receipts/model/queue.ts";

const ok = (label: string, cond: boolean, extra = "") =>
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);

const c = await pool.connect();
try {
  const arts = await c.query<{ id: string }>("SELECT id FROM artifacts ORDER BY id LIMIT 3");
  if (arts.rowCount !== 3) throw new Error("need 3 artifacts to test against");
  const ids = arts.rows.map((r) => r.id);

  await c.query("BEGIN");

  const { batchId, enqueued } = await enqueueBatch(c, "llm_receipt", ids);
  ok("enqueue creates jobs", enqueued === 3, `enqueued=${enqueued}`);

  ok("unconsented work is invisible", (await claimNext(c)) === null);

  const dup = await enqueueBatch(c, "llm_receipt", ids);
  ok("re-enqueuing outstanding artifacts is skipped", dup.enqueued === 0 && dup.alreadyQueued === 3,
     `enqueued=${dup.enqueued} skipped=${dup.alreadyQueued}`);

  ok("consent flips the gate", await consent(c, batchId));
  ok("consent is idempotent", (await consent(c, batchId)) === false);

  const j1 = await claimNext(c);
  ok("claim returns a job", j1 !== null, `attempts=${j1?.attempts}`);
  ok("claim increments attempts at CLAIM time", j1?.attempts === 1);

  const t = await fail(c, j1!, "llm_unavailable", "Ollama down");
  ok("transient failure returns to the queue", t.willRetry);

  const j2 = await claimNext(c);
  ok("reclaimed job comes back with attempts=2", j2?.attempts === 2, `id=${j2?.id} prev=${j1?.id}`);

  const p = await fail(c, j2!, "does_not_reconcile", "lines 1519 vs stated 1619");
  ok("permanent failure is terminal on attempt 1", !p.willRetry);

  const j3 = await claimNext(c)!;
  await complete(c, j3!.id);
  const j4 = await claimNext(c)!;
  await complete(c, j4!.id);

  ok("queue is drained", (await claimNext(c)) === null);

  const b = await c.query<{ finished_at: string | null }>(
    "SELECT finished_at FROM parse_batches WHERE id = $1", [batchId]);
  ok("batch settles when nothing is outstanding", b.rows[0].finished_at !== null);

  const st = await c.query<{ state: string; attempts: number; error_kind: string | null }>(
    "SELECT state, attempts, error_kind FROM parse_jobs WHERE batch_id = $1 ORDER BY id", [batchId]);
  console.log("  final:", st.rows.map((r) => `${r.state}/a${r.attempts}/${r.error_kind ?? "-"}`).join(" "));

  // Lease expiry.
  const { batchId: b2 } = await enqueueBatch(c, "llm_receipt", [ids[0]]);
  await consent(c, b2);
  const stuck = await claimNext(c);
  await c.query("UPDATE parse_jobs SET claimed_at = now() - interval '10 minutes' WHERE id = $1", [stuck!.id]);
  const n = await reclaimExpired(c);
  ok("an expired lease is reclaimed", n === 1, `reclaimed=${n}`);
  const back = await c.query<{ state: string }>("SELECT state FROM parse_jobs WHERE id = $1", [stuck!.id]);
  ok("reclaimed job is queued again", back.rows[0].state === "queued");

  const progress = await c.query("SELECT 1");
  void progress;

  await c.query("ROLLBACK");
  console.log("\n  rolled back — no rows kept");
} finally {
  c.release();
  await pool.end();
}
