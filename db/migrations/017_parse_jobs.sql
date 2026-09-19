-- A durable queue for parsing documents with a model, because the process is not durable.
--
-- A hundred invoices at 20-60s each is 30-100 minutes, which
-- is not a request — so the work has to outlive the request that asked for it. It also has to
-- outlive the PROCESS: `npm run dev` runs under `node --watch` and restarts on every file
-- save, so in development a 60-second model call is killed mid-flight as a matter of routine.
-- An in-memory queue would lose the batch every time somebody touched a file.
--
-- Two tables and not one. A BATCH is what a person consented to and watches; a JOB is one
-- document's attempt at being understood. They have different lifetimes — a batch is finished
-- when none of its jobs are outstanding, and a job can be retried without the batch changing.

-- What a person said yes to, once, for a group of documents dropped together.
--
-- This is the DROP identity that `StagedReview` has never had. It does not replace grouping by
-- merchant: a review is grouped by source because two merchants' receipts must not become one
-- pile with one "select all", and that stays exactly as it is. A batch is the orthogonal
-- question "how far along is the thing I started", which nothing could answer before.
CREATE TABLE IF NOT EXISTS parse_batches (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Which pipeline these jobs run. A closed vocabulary rather than free text: a worker
  -- dispatches on it, so an unknown value is a job nothing will ever pick up.
  kind         TEXT NOT NULL CHECK (kind IN ('llm_receipt')),

  -- How many jobs were enqueued. Stored rather than counted, because it is the DENOMINATOR a
  -- progress bar shows and it must not move while the bar is being watched — a count(*) over
  -- a table someone is still inserting into gives a total that grows as you look at it.
  total        INTEGER NOT NULL CHECK (total > 0),

  -- NULL until a person pressed Proceed. NOTHING RUNS BEFORE THIS IS SET: the estimate is
  -- 30-100 minutes of local compute, and starting that without being asked is the difference
  -- between a tool and a surprise. The worker's claim query joins on it being non-null.
  consented_at TIMESTAMPTZ,

  -- Set when the last outstanding job leaves. Derived, but stored so "is this done" is one
  -- indexed read rather than an aggregate over every job every time the UI polls.
  finished_at  TIMESTAMPTZ,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parse_jobs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- ON DELETE CASCADE: an artifact is the INPUT to this job, and a job for bytes that no
  -- longer exist is unrunnable by definition rather than merely stale.
  artifact_id  BIGINT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  batch_id     BIGINT NOT NULL REFERENCES parse_batches(id) ON DELETE CASCADE,

  --  queued   waiting to be claimed
  --  running  a worker holds it; `claimed_at` is the lease
  --  done     it produced a record, which is staged
  --  failed   terminal. The bytes survive and `/reparse` can run it again.
  state        TEXT NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued', 'running', 'done', 'failed')),

  attempts     INTEGER NOT NULL DEFAULT 0,

  -- THE LEASE. A worker that dies holds nothing — there is no lock to release, because the
  -- process that held it is gone. So a claim is a timestamp, and any `running` job whose
  -- timestamp is older than the lease window is reclaimable by the next worker to look.
  -- Without this a single crash strands a job in `running` forever, and the batch never
  -- finishes because it is waiting on a worker that no longer exists.
  claimed_at   TIMESTAMPTZ,

  -- WHY it failed, as a closed vocabulary, not prose. A worker that reports "failed" is a
  -- worker nobody trusts; the vocabulary names every kind. It is also what
  -- decides whether a retry is worth anything: `llm_unavailable` is transient and retrying
  -- fixes it, `does_not_reconcile` is deterministic and retrying spends three minutes to be
  -- told the same thing. Not a CHECK constraint — the vocabulary lives in TypeScript where
  -- the exhaustive switch that dispatches on it can fail to compile when a member is added.
  error_kind   TEXT,
  error_detail TEXT,

  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A lease belongs to a running job and to nothing else. Making it unrepresentable is what
  -- stops a reclaim sweep from resurrecting a job that already finished.
  CONSTRAINT parse_jobs_claim_check
    CHECK ((state = 'running') = (claimed_at IS NOT NULL)),
  -- A terminal job has a reason or a result; a live one has neither yet.
  CONSTRAINT parse_jobs_finished_check
    CHECK ((state IN ('done', 'failed')) = (finished_at IS NOT NULL))
);

-- ONE OUTSTANDING JOB PER ARTIFACT. Enqueuing the same document twice while the first attempt
-- is still in flight would run docling and the model over identical bytes concurrently, and
-- both would try to stage the same order — one wins and the other is a constraint violation
-- reported as a parse failure, which is a lie about the document.
--
-- Partial, so it constrains only the live states: a document that failed in one batch MUST be
-- re-runnable in the next, which is the entire argument for keeping the bytes.
CREATE UNIQUE INDEX IF NOT EXISTS parse_jobs_one_outstanding
  ON parse_jobs (artifact_id) WHERE state IN ('queued', 'running');

-- The claim query's index: oldest queued job first, cheapest possible.
CREATE INDEX IF NOT EXISTS parse_jobs_claimable
  ON parse_jobs (created_at) WHERE state = 'queued';

-- The reclaim sweep's index: which leases have expired.
CREATE INDEX IF NOT EXISTS parse_jobs_leases
  ON parse_jobs (claimed_at) WHERE state = 'running';

-- Progress, per batch, which the UI asks for on a timer.
CREATE INDEX IF NOT EXISTS parse_jobs_batch_idx ON parse_jobs (batch_id, state);
