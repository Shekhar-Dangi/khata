// src/server.ts
import express from "express";
import path2 from "node:path";

// src/db.ts
import { Pool, types } from "pg";
types.setTypeParser(1082, (value) => value);
var pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10
});
pool.on("error", (err) => {
  console.error("[pg] idle client error \u2014 the pool will replace it:", err.message);
});

// src/http.ts
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw error;
  } finally {
    client.release();
  }
}
var HttpError = class extends Error {
  status;
  /** Extra fields merged into the JSON body — counts, hints, whatever the caller needs. */
  detail;
  constructor(status, message, detail = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
};
var badRequest = (message, detail) => new HttpError(400, message, detail);
var notFound = (message) => new HttpError(404, message);
var conflict = (message, detail) => new HttpError(409, message, detail);
function isUniqueViolation(error) {
  return error?.code === "23505";
}
function intParam(raw, what = "id") {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw badRequest(`${what} must be a positive integer`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw badRequest(`${what} must be a positive integer`);
  return n;
}
function route(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
var errorHandler = (err, req, res, _next) => {
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "request body is not valid JSON" });
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({
      error: `that file is too large (limit ${err.limit ?? "unknown"} bytes)`
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...err.detail });
    return;
  }
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ error: "internal error" });
};
var notFoundHandler = (_req, res) => {
  res.status(404).json({ error: "not found" });
};

// src/receipts/model/queue-policy.ts
var ERROR_KINDS = [
  // -- reading the file at all
  "empty",
  "too_large",
  "unreadable_mime",
  "encrypted",
  "corrupt",
  "too_many_pages",
  // -- the extractor
  "models_missing",
  "extract_timeout",
  "extract_crashed",
  // -- the model
  "llm_unavailable",
  // A SETTING is wrong for this machine: the model is not pulled, the window does not fit in
  // memory, or the model rejects the thinking flag. Not the document, and not a hiccup.
  "llm_misconfigured",
  "llm_timeout",
  "llm_truncated",
  "schema_violation",
  // -- the answer was well-formed and wrong
  "hallucinated_lines",
  "does_not_reconcile",
  "wrong_merchant",
  "not_an_invoice",
  "credit_note",
  // -- the machinery
  "duplicate_order",
  "worker_died",
  "db_error",
  "unknown"
];
function isErrorKind(v) {
  return typeof v === "string" && ERROR_KINDS.includes(v);
}
function retryPolicy(kind) {
  switch (kind) {
    // The machine, not the document.
    case "llm_unavailable":
    // Ollama was not running. Start it and this succeeds.
    case "llm_timeout":
    // it was busy or cold; the next attempt may be warm.
    case "extract_timeout":
    case "extract_crashed":
    // a native crash in a C extension is not reproducible by rule.
    case "worker_died":
    // `node --watch` restarted mid-call. Most Tuesdays.
    case "db_error":
      return "transient";
    // The document, or a settled fact about it.
    case "empty":
    case "too_large":
    // never truncate. A bigger window fixes it, a retry does not.
    case "unreadable_mime":
    case "encrypted":
    // no password will appear between attempts.
    case "corrupt":
    case "too_many_pages":
    case "llm_truncated":
    // the budget was wrong; re-running spends it again to prove it.
    case "schema_violation":
    case "hallucinated_lines":
    case "does_not_reconcile":
    case "wrong_merchant":
    case "not_an_invoice":
    case "credit_note":
    // held for the refund feature, not a failure to fix by retrying.
    case "duplicate_order":
      return "permanent";
    // A setup step, not a retry. Docling downloads hundreds of megabytes on first run, and
    // spinning on that three times makes one missing install look like three broken documents.
    case "models_missing":
      return "permanent";
    // Same argument, and the retry is worse than useless: every attempt RELOADS the model
    // (65s on the machine this was built on) to fail identically, because the setting that
    // caused it has not changed. The detail names the variable; fixing it and re-running is
    // the cure, and a retry is not.
    case "llm_misconfigured":
      return "permanent";
    case "unknown":
      return "permanent";
  }
}
function isTransient(kind) {
  return retryPolicy(kind) === "transient";
}
function explain(kind) {
  switch (kind) {
    case "empty":
      return "the file had no content";
    case "too_large":
      return "this document is too big for the model to read in one pass \u2014 the detail says which limit";
    case "unreadable_mime":
      return "nothing here reads that kind of file";
    case "encrypted":
      return "the PDF is password-protected";
    case "corrupt":
      return "the PDF could not be opened";
    case "too_many_pages":
      return "too many pages for an invoice \u2014 this looks like a different kind of document";
    case "models_missing":
      return "the document reader's models are not installed yet \u2014 run the setup step once";
    case "extract_timeout":
      return "reading the document took too long";
    case "extract_crashed":
      return "the document reader stopped unexpectedly";
    case "llm_unavailable":
      return "the local model is not running \u2014 is Ollama started?";
    case "llm_misconfigured":
      return "the local model is not set up for this \u2014 the detail says which setting to change";
    case "llm_timeout":
      return "the local model took too long to answer";
    case "llm_truncated":
      return "the model's answer was cut off before it finished";
    case "schema_violation":
      return "the model's answer was not in the shape we asked for";
    case "hallucinated_lines":
      return "the model listed items that do not appear in the document";
    case "does_not_reconcile":
      return "the line items do not add up to the total the invoice states";
    case "wrong_merchant":
      return "the merchant on the document does not match the one expected";
    case "not_an_invoice":
      return "this does not look like an invoice";
    case "credit_note":
      return "this is a credit note \u2014 held until refunds are supported";
    case "duplicate_order":
      return "this order is already in your ledger";
    case "worker_died":
      return "the app restarted while this was being read";
    case "db_error":
      return "the database refused the write";
    case "unknown":
      return "something went wrong that nobody has named yet";
  }
}

// src/receipts/model/queue.ts
var LEASE_MS = 5 * 6e4;
var MAX_ATTEMPTS = 3;
async function enqueueBatch(client, kind, artifactIds) {
  if (artifactIds.length === 0) {
    throw new Error("a batch needs at least one artifact");
  }
  const batch = await client.query(
    "INSERT INTO parse_batches (kind, total) VALUES ($1, $2) RETURNING id",
    [kind, artifactIds.length]
  );
  const batchId = batch.rows[0].id;
  const inserted = await client.query(
    `INSERT INTO parse_jobs (artifact_id, batch_id)
     SELECT unnest($1::bigint[]), $2
     ON CONFLICT DO NOTHING`,
    [artifactIds, batchId]
  );
  const enqueued = inserted.rowCount ?? 0;
  if (enqueued !== artifactIds.length) {
    await client.query("UPDATE parse_batches SET total = $2 WHERE id = $1", [
      batchId,
      Math.max(enqueued, 1)
    ]);
  }
  return { batchId, enqueued, alreadyQueued: artifactIds.length - enqueued };
}
async function consent(client, batchId) {
  const res = await client.query(
    "UPDATE parse_batches SET consented_at = now() WHERE id = $1 AND consented_at IS NULL",
    [batchId]
  );
  return (res.rowCount ?? 0) > 0;
}
async function claimNext(client) {
  const res = await client.query(
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
         -- created_at \u2014 and SQL guarantees nothing about the order of tied rows, so without
         -- this the queue drains in whatever order the plan happens to produce, and that
         -- changes as the table grows. Found by the lifecycle check: a job returned to the
         -- queue by a transient failure was overtaken by one enqueued at the same instant.
         ORDER BY c.created_at, c.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING j.id, j.artifact_id, j.batch_id, j.attempts`
  );
  const row = res.rows[0];
  if (row === void 0) return null;
  return {
    id: row.id,
    artifactId: row.artifact_id,
    batchId: row.batch_id,
    attempts: row.attempts
  };
}
async function complete(client, jobId) {
  await client.query(
    `UPDATE parse_jobs
        SET state = 'done', claimed_at = NULL, finished_at = now(), error_kind = NULL
      WHERE id = $1`,
    [jobId]
  );
  await settleBatch(client, jobId);
}
async function fail(client, job, kind, detail) {
  const willRetry = isTransient(kind) && job.attempts < MAX_ATTEMPTS;
  if (willRetry) {
    await client.query(
      `UPDATE parse_jobs
          SET state = 'queued', claimed_at = NULL, error_kind = $2, error_detail = $3
        WHERE id = $1`,
      [job.id, kind, detail.slice(0, 2e3)]
    );
    return { willRetry };
  }
  await client.query(
    `UPDATE parse_jobs
        SET state = 'failed', claimed_at = NULL, finished_at = now(),
            error_kind = $2, error_detail = $3
      WHERE id = $1`,
    [job.id, kind, detail.slice(0, 2e3)]
  );
  await settleBatch(client, job.id);
  return { willRetry };
}
async function reclaimExpired(client) {
  const res = await client.query(
    `UPDATE parse_jobs
        SET state = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
            claimed_at = NULL,
            finished_at = CASE WHEN attempts >= $2 THEN now() ELSE NULL END,
            error_kind = 'worker_died',
            error_detail = 'the worker holding this job stopped before finishing it'
      WHERE state = 'running'
        AND claimed_at < now() - ($1::int || ' milliseconds')::interval`,
    [LEASE_MS, MAX_ATTEMPTS]
  );
  return res.rowCount ?? 0;
}
async function settleBatch(client, jobId) {
  await client.query(
    `UPDATE parse_batches b
        SET finished_at = now()
      WHERE b.id = (SELECT batch_id FROM parse_jobs WHERE id = $1)
        AND b.finished_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM parse_jobs o
           WHERE o.batch_id = b.id AND o.state IN ('queued', 'running')
        )`,
    [jobId]
  );
}
async function listActiveBatches(limit = 10) {
  const res = await pool.query(
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
    [limit]
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
    finished: r.finished_at !== null
  }));
}

// src/receipts/model/worker.ts
var IDLE_POLL_MS = 2e3;
var HEARTBEAT_MS = Math.floor(LEASE_MS / 3);
var ParseFailure = class extends Error {
  // Declared and assigned explicitly, NOT as a constructor parameter property.
  //
  // `constructor(readonly kind: ErrorKind, ...)` typechecks and then fails at runtime with
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: Node's strip-only mode may only REMOVE types, and a
  // parameter property requires it to EMIT an assignment. Same family as the backtick-in-a-
  // SQL-comment trap — tsc is not the thing that runs this code.
  kind;
  constructor(kind, message) {
    super(message);
    this.name = "ParseFailure";
    this.kind = kind;
  }
};
async function runJob(job, handler) {
  const client = await pool.connect();
  const heartbeat = setInterval(() => {
    void pool.query("UPDATE parse_jobs SET claimed_at = now() WHERE id = $1 AND state = 'running'", [job.id]).catch(() => {
    });
  }, HEARTBEAT_MS);
  try {
    await client.query("BEGIN");
    await handler(client, job);
    await complete(client, job.id);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
    });
    const kind = err instanceof ParseFailure && isErrorKind(err.kind) ? err.kind : "unknown";
    const detail = err instanceof Error ? err.message : String(err);
    const reporter = await pool.connect();
    try {
      await reporter.query("BEGIN");
      await fail(reporter, job, kind, detail);
      await reporter.query("COMMIT");
    } catch {
      await reporter.query("ROLLBACK").catch(() => {
      });
    } finally {
      reporter.release();
    }
    return false;
  } finally {
    clearInterval(heartbeat);
    client.release();
  }
}
function startWorker(opts) {
  const idle = opts.idlePollMs ?? IDLE_POLL_MS;
  let stopping = false;
  let wake = null;
  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
  const done = (async () => {
    let processed = 0;
    let failed = 0;
    await withClient((c) => reclaimExpired(c)).catch(() => 0);
    while (!stopping) {
      if (opts.maxJobs !== void 0 && processed + failed >= opts.maxJobs) break;
      let job = null;
      try {
        job = await withClient((c) => claimNext(c));
      } catch {
        await sleep(idle);
        continue;
      }
      if (job === null) {
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
    done
  };
}
async function withClient(fn) {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

// src/receipts/model/markdown-extract.ts
import { spawn as spawn2 } from "node:child_process";

// src/receipts/pdf-extract.ts
import { spawn } from "node:child_process";
import path from "node:path";
var EXTRACT_TIMEOUT_MS = 2e4;
var MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
function pythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const root = repoRoot();
  return process.platform === "win32" ? path.join(root, "ingest", ".venv", "Scripts", "python.exe") : path.join(root, "ingest", ".venv", "bin", "python");
}
function repoRoot() {
  return path.resolve(import.meta.dirname, "../..");
}
function extractPdf(bytes, timeoutMs = EXTRACT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(pythonBin(), ["-m", "ingest.receipts.cli"], {
      cwd: repoRoot(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const out = [];
    let outBytes = 0;
    let err = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        kind: "timeout",
        error: `extraction exceeded ${timeoutMs}ms and was killed`
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({
          ok: false,
          kind: "output_too_large",
          error: `extractor produced more than ${MAX_OUTPUT_BYTES} bytes`
        });
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err = (err + chunk.toString("utf8")).slice(-4e3);
    });
    child.on("error", (e) => {
      finish({
        ok: false,
        kind: "internal",
        error: `could not start the extractor (${pythonBin()}): ${e.message}`
      });
    });
    child.on("close", (code) => {
      const raw = Buffer.concat(out).toString("utf8").trim();
      if (raw === "") {
        finish({
          ok: false,
          kind: "internal",
          error: `extractor exited ${code} with no output${err ? `: ${err}` : ""}`
        });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        finish({ ok: false, kind: "internal", error: "extractor did not return JSON" });
        return;
      }
      const body = parsed;
      if (body.ok === true && body.document) {
        finish({
          ok: true,
          document: body.document,
          // The reconcile gate runs INSIDE the child (shapes.reconcile), so a record that
          // comes back has already been proved to add up. A parse that did not is reported
          // here as parseError and never as a record — there is no third state where we hold
          // a basket we know is wrong.
          record: body.record ?? null,
          parseError: body.parse_error ?? null
        });
        return;
      }
      finish({
        ok: false,
        // The child's vocabulary is closed and matches ours, but this is a process boundary:
        // trusting it blindly would let a future change introduce a kind nothing handles.
        kind: body.kind ?? "internal",
        error: body.error ?? `extractor exited ${code}`
      });
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(bytes);
  });
}

// src/llm/config.ts
var CHARS_PER_TOKEN = 2.9;
var PROMPT_OVERHEAD_TOKENS = 300;
var MIN_MARKDOWN_CHARS = 2e3;
var DEDICATED_OPTIONS = /* @__PURE__ */ new Set(["num_ctx", "num_predict", "temperature"]);
var DEFAULTS = {
  RECEIPT_LLM: { numCtx: 8192, numPredict: 2048, timeoutMs: 6e5 },
  CATEGORY_LLM: { numCtx: null, numPredict: 40, timeoutMs: 6e4 }
};
function parseProfile(env, prefix, errors) {
  const d = DEFAULTS[prefix];
  const get = (key2) => {
    const v = env[key2];
    return v === void 0 || v.trim() === "" ? void 0 : v.trim();
  };
  const int = (key2, fallback, min, max) => {
    const raw = get(key2);
    if (raw === void 0) return fallback;
    if (!/^\d+$/.test(raw)) {
      errors.push(`${key2} must be a whole number, got "${raw}"`);
      return fallback;
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      errors.push(`${key2} must be between ${min} and ${max}, got ${raw}`);
      return fallback;
    }
    return n;
  };
  const host = get("OLLAMA_HOST") ?? "http://127.0.0.1:11434";
  const model = get(`${prefix}_MODEL`) ?? get("OLLAMA_MODEL") ?? "qwen3:4b";
  const numCtx = get(`${prefix}_NUM_CTX`) === void 0 && d.numCtx === null ? null : int(`${prefix}_NUM_CTX`, d.numCtx ?? 8192, 1024, 1048576);
  const numPredict = int(`${prefix}_NUM_PREDICT`, d.numPredict, 1, 1048576);
  const timeoutMs = int(`${prefix}_TIMEOUT_MS`, d.timeoutMs, 1e3, 864e5);
  let think = false;
  const rawThink = get(`${prefix}_THINK`)?.toLowerCase();
  if (rawThink !== void 0) {
    if (rawThink === "true" || rawThink === "1") think = true;
    else if (rawThink === "false" || rawThink === "0") think = false;
    else if (rawThink === "low" || rawThink === "medium" || rawThink === "high" || rawThink === "unset") {
      think = rawThink;
    } else {
      errors.push(`${prefix}_THINK must be true, false, low, medium, high or unset, got "${rawThink}"`);
    }
  }
  let temperature = 0;
  const rawTemp = get(`${prefix}_TEMPERATURE`);
  if (rawTemp !== void 0) {
    if (!/^\d+(\.\d+)?$/.test(rawTemp) || Number(rawTemp) > 2) {
      errors.push(`${prefix}_TEMPERATURE must be a number from 0 to 2, got "${rawTemp}"`);
    } else {
      temperature = Number(rawTemp);
    }
  }
  let keepAlive = null;
  const rawKeep = get(`${prefix}_KEEP_ALIVE`);
  if (rawKeep !== void 0) {
    if (!/^-?\d+(\.\d+)?(ms|s|m|h)?$/.test(rawKeep)) {
      errors.push(`${prefix}_KEEP_ALIVE must look like 30m, 1h, 300 or -1, got "${rawKeep}"`);
    } else {
      keepAlive = rawKeep;
    }
  }
  const extraOptions = {};
  const rawOpts = get(`${prefix}_OPTIONS`);
  if (rawOpts !== void 0) {
    let parsed;
    try {
      parsed = JSON.parse(rawOpts);
    } catch {
      errors.push(`${prefix}_OPTIONS must be a JSON object, e.g. {"num_thread": 8} \u2014 could not parse it`);
    }
    if (parsed !== void 0) {
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push(`${prefix}_OPTIONS must be a JSON object, not an array or a value`);
      } else {
        for (const [k, v] of Object.entries(parsed)) {
          if (DEDICATED_OPTIONS.has(k)) {
            errors.push(`${prefix}_OPTIONS sets "${k}" \u2014 use ${prefix}_${k.toUpperCase()} instead`);
          } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            extraOptions[k] = v;
          } else {
            errors.push(`${prefix}_OPTIONS.${k} must be a string, number or boolean`);
          }
        }
      }
    }
  }
  if (numCtx !== null && numPredict >= numCtx) {
    errors.push(
      `${prefix}_NUM_PREDICT (${numPredict}) must be smaller than ${prefix}_NUM_CTX (${numCtx}) \u2014 the answer is written into the same window as the prompt`
    );
  }
  return {
    prefix,
    host,
    model,
    numCtx,
    numPredict,
    timeoutMs,
    think,
    temperature,
    keepAlive,
    extraOptions
  };
}
function parseLlmConfig(env) {
  const errors = [];
  const host = env.OLLAMA_HOST?.trim();
  if (host && !/^https?:\/\/[^\s]+$/.test(host)) {
    errors.push(`OLLAMA_HOST must be an http(s) URL, got "${host}"`);
  }
  const receiptBase = parseProfile(env, "RECEIPT_LLM", errors);
  const category = parseProfile(env, "CATEGORY_LLM", errors);
  const numCtx = receiptBase.numCtx ?? 8192;
  const extractTimeoutMs = (() => {
    const raw = env.RECEIPT_EXTRACT_TIMEOUT_MS?.trim();
    if (!raw) return 12e4;
    if (!/^\d+$/.test(raw) || Number(raw) < 1e3 || Number(raw) > 36e5) {
      errors.push(`RECEIPT_EXTRACT_TIMEOUT_MS must be a whole number from 1000 to 3600000, got "${raw}"`);
      return 12e4;
    }
    return Number(raw);
  })();
  const maxMarkdownChars = Math.floor(
    Math.max(0, numCtx - receiptBase.numPredict - PROMPT_OVERHEAD_TOKENS) * CHARS_PER_TOKEN
  );
  if (receiptBase.numPredict < numCtx && maxMarkdownChars < MIN_MARKDOWN_CHARS) {
    errors.push(
      `RECEIPT_LLM_NUM_CTX ${numCtx} leaves room for only ${maxMarkdownChars} characters of document (the smallest real invoice is ~2,150) \u2014 raise it, or lower RECEIPT_LLM_NUM_PREDICT`
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    receipt: { ...receiptBase, numCtx, extractTimeoutMs, maxMarkdownChars },
    category
  };
}
function loadLlmConfig(env) {
  const parsed = parseLlmConfig(env);
  if (parsed.ok) return { receipt: parsed.receipt, category: parsed.category };
  throw new Error(
    "Invalid local-model settings in .env:\n" + parsed.errors.map((e) => `  - ${e}`).join("\n") + "\nSee .env.example for every setting and its default."
  );
}
var loaded = loadLlmConfig(process.env);
var RECEIPT_LLM = loaded.receipt;
var CATEGORY_LLM = loaded.category;
function ollamaRequestBase(p) {
  const options = {
    // The free-form options first and the dedicated settings on top. The parser already refuses
    // a clash between the two, so this order is a second guard, not the only one.
    ...p.extraOptions,
    temperature: p.temperature,
    num_predict: p.numPredict
  };
  if (p.numCtx !== null) options.num_ctx = p.numCtx;
  const body = { model: p.model, stream: false, options };
  if (p.think !== "unset") body.think = p.think;
  if (p.keepAlive !== null) {
    body.keep_alive = /^-?\d+(\.\d+)?$/.test(p.keepAlive) ? Number(p.keepAlive) : p.keepAlive;
  }
  return body;
}

// src/receipts/model/markdown-extract.ts
var EXTRACT_MARKDOWN_TIMEOUT_MS = RECEIPT_LLM.extractTimeoutMs;
var MAX_OUTPUT_BYTES2 = 8 * 1024 * 1024;
var PYTHON_KINDS = /* @__PURE__ */ new Set([
  "empty",
  "too_many_pages",
  "too_large",
  "corrupt",
  "models_missing",
  "extract_crashed"
]);
function extractMarkdown(bytes, timeoutMs = EXTRACT_MARKDOWN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn2(pythonBin(), ["-m", "ingest.receipts.to_markdown"], {
      cwd: repoRoot(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // The markdown budget is DERIVED from the model's window (llm-config.ts), so it is
      // handed to Python rather than kept as a second constant there. Raising the window then
      // admits bigger documents in one place, and the two halves cannot disagree about the size
      // of a document the model can read.
      env: { ...process.env, RECEIPT_MAX_MARKDOWN_CHARS: String(RECEIPT_LLM.maxMarkdownChars) }
    });
    const out = [];
    let outBytes = 0;
    let err = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        kind: "extract_timeout",
        error: `converting the document exceeded ${timeoutMs}ms and was killed`
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES2) {
        child.kill("SIGKILL");
        finish({
          ok: false,
          kind: "too_large",
          error: `the converter produced more than ${MAX_OUTPUT_BYTES2} bytes`
        });
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err = (err + chunk.toString("utf8")).slice(-4e3);
    });
    child.on("error", (e) => {
      finish({
        ok: false,
        kind: "models_missing",
        error: `could not start the converter (${pythonBin()}): ${e.message}`
      });
    });
    child.on("close", () => {
      const raw = Buffer.concat(out).toString("utf8").trim();
      if (raw === "") {
        finish({
          ok: false,
          kind: "extract_crashed",
          error: `the converter produced no output${err ? `: ${err.slice(-300)}` : ""}`
        });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        finish({
          ok: false,
          kind: "extract_crashed",
          error: `the converter did not answer with JSON: ${raw.slice(0, 200)}`
        });
        return;
      }
      const body = parsed;
      if (body.ok === true && typeof body.markdown === "string") {
        finish({
          ok: true,
          markdown: body.markdown,
          chars: typeof body.chars === "number" ? body.chars : body.markdown.length,
          pages: typeof body.pages === "number" ? body.pages : null
        });
        return;
      }
      const kind = body.kind;
      finish({
        ok: false,
        kind: typeof kind === "string" && PYTHON_KINDS.has(kind) ? kind : "unknown",
        error: typeof body.error === "string" ? body.error : "the converter did not say why"
      });
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(bytes);
  });
}

// src/receipts/model/read.ts
import { createHash } from "node:crypto";

// src/llm/ollama.ts
function diagnoseOllamaRefusal(status, body, p) {
  if (status === 404 || /model ['"]?[^'"]*['"]? not found/i.test(body)) {
    return {
      misconfigured: true,
      message: `the model "${p.model}" is not available in Ollama \u2014 run \`ollama pull ${p.model}\`, or set ${p.prefix}_MODEL to a model you have`
    };
  }
  if (/out[- ]of[- ]memory|requires more system memory|failed to allocate|insufficient memory/i.test(body)) {
    const window = p.numCtx === null ? "Ollama's default window" : `a ${p.numCtx}-token window`;
    return {
      misconfigured: true,
      message: `"${p.model}" does not fit in memory with ${window} \u2014 set ${p.prefix}_NUM_CTX lower, or set ${p.prefix}_MODEL to a smaller model`
    };
  }
  if (/does not support thinking/i.test(body)) {
    return {
      misconfigured: true,
      message: `"${p.model}" does not accept a thinking setting \u2014 set ${p.prefix}_THINK=unset`
    };
  }
  return {
    misconfigured: false,
    message: `the local model answered ${status}${body ? `: ${body}` : ""}`
  };
}

// src/receipts/model/read.ts
var RECEIPT_PROMPT_VERSION = "r1";
var SCHEMA = {
  type: "object",
  properties: {
    is_invoice: { type: "boolean" },
    is_credit_note: { type: "boolean" },
    merchant: { type: "string" },
    external_ref: { type: "string" },
    order_date: { type: ["string", "null"] },
    total_paise: { type: "integer" },
    invoices: {
      type: "array",
      items: {
        type: "object",
        properties: {
          invoice_number: { type: "string" },
          seller_name: { type: ["string", "null"] },
          invoice_date: { type: ["string", "null"] },
          total_paise: { type: "integer" },
          lines: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["goods", "fee"] },
                description: { type: "string" },
                sku: { type: ["string", "null"] },
                qty: { type: "integer" },
                amount_paise: { type: "integer" }
              },
              required: ["kind", "description", "sku", "qty", "amount_paise"]
            }
          }
        },
        required: ["invoice_number", "seller_name", "invoice_date", "total_paise", "lines"]
      }
    }
  },
  required: [
    "is_invoice",
    "is_credit_note",
    "merchant",
    "external_ref",
    "order_date",
    "total_paise",
    "invoices"
  ]
};
var PREFIX = "You read Indian retail invoices and return their contents exactly as printed.\n\nRULES:\n- Copy every amount as INTEGER PAISE. Rs 1,422.43 is 142243. Never round.\n- Copy descriptions VERBATIM from the document. Never tidy, translate or shorten them.\n- Never invent a line. If a row is unreadable, leave it out rather than guessing.\n- A delivery charge, packaging fee or handling fee has kind 'fee'. Everything bought by the customer has kind 'goods'.\n- external_ref is the ORDER id, not an invoice number. One order can contain several invoices from different sellers; list each separately with its own total.\n- total_paise at the top level is the ORDER total: the sum of the invoice totals.\n- Dates are YYYY-MM-DD, or null when the document does not state one.\n- is_invoice is false when this document is not an invoice at all.\n- is_credit_note is true for a refund, credit note or return.\n\nDOCUMENT:\n";
function buildRequest(markdown, cfg = RECEIPT_LLM) {
  return { ...ollamaRequestBase(cfg), prompt: PREFIX + markdown + "\n", format: SCHEMA };
}
function classifyHttpFailure(status, body, cfg = RECEIPT_LLM) {
  const d = diagnoseOllamaRefusal(status, body, cfg);
  return new LlmParseFailure(d.misconfigured ? "llm_misconfigured" : "llm_unavailable", d.message);
}
var LlmParseFailure = class extends Error {
  kind;
  constructor(kind, message) {
    super(message);
    this.name = "LlmParseFailure";
    this.kind = kind;
  }
};
var cache = /* @__PURE__ */ new Map();
function cacheKey(markdown, cfg = RECEIPT_LLM) {
  const { model, think, temperature, numCtx, numPredict, extraOptions } = cfg;
  return createHash("sha256").update(JSON.stringify({
    v: RECEIPT_PROMPT_VERSION,
    model,
    think,
    temperature,
    numCtx,
    numPredict,
    extraOptions
  })).update("\0").update(markdown).digest("hex");
}
async function readInvoice(markdown) {
  const key2 = cacheKey(markdown);
  const hit = cache.get(key2);
  if (hit !== void 0) return hit;
  const cfg = RECEIPT_LLM;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  let raw;
  try {
    const res = await fetch(cfg.host + "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildRequest(markdown, cfg)),
      signal: ctl.signal
    });
    if (!res.ok) {
      const why = (await res.text().catch(() => "")).slice(0, 300);
      throw classifyHttpFailure(res.status, why, cfg);
    }
    const body = await res.json();
    if (typeof body.response !== "string") {
      throw new LlmParseFailure("schema_violation", "the model returned no response field");
    }
    const promptTokens = Number(body.prompt_eval_count);
    const outputTokens = Number(body.eval_count);
    if (Number.isFinite(promptTokens) && Number.isFinite(outputTokens) && promptTokens + outputTokens >= cfg.numCtx) {
      throw new LlmParseFailure(
        "too_large",
        `the document filled the model's ${cfg.numCtx}-token window (${promptTokens} in, ${outputTokens} out) and may have been cut \u2014 raise RECEIPT_LLM_NUM_CTX if this machine has the memory`
      );
    }
    if (body.done_reason === "length") {
      throw new LlmParseFailure(
        "llm_truncated",
        `the model's answer hit the ${cfg.numPredict}-token output cap before it finished \u2014 raise RECEIPT_LLM_NUM_PREDICT for invoices this long`
      );
    }
    raw = body.response;
  } catch (err) {
    if (err instanceof LlmParseFailure) throw err;
    if (ctl.signal.aborted) {
      throw new LlmParseFailure(
        "llm_timeout",
        `the local model took longer than ${Math.round(cfg.timeoutMs / 1e3)}s \u2014 raise RECEIPT_LLM_TIMEOUT_MS on a slow machine`
      );
    }
    throw new LlmParseFailure(
      "llm_unavailable",
      `could not reach the local model at ${cfg.host} \u2014 is Ollama running?`
    );
  } finally {
    clearTimeout(timer);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LlmParseFailure(
      "llm_truncated",
      "the model's answer was not complete JSON \u2014 the generation was probably cut off"
    );
  }
  const record = coerce(parsed);
  cache.set(key2, record);
  return record;
}
function coerce(value) {
  const bad = (why) => {
    throw new LlmParseFailure("schema_violation", why);
  };
  if (value === null || typeof value !== "object") return bad("the answer was not an object");
  const o = value;
  const int = (v, what) => {
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
      return bad(`${what} was not an integer`);
    }
    return v;
  };
  const str = (v, what) => typeof v === "string" ? v : bad(`${what} was not a string`);
  const nullableStr = (v) => typeof v === "string" ? v : null;
  const invoices = Array.isArray(o.invoices) ? o.invoices : bad("invoices was not an array");
  return {
    is_invoice: o.is_invoice === true,
    is_credit_note: o.is_credit_note === true,
    merchant: str(o.merchant, "merchant"),
    external_ref: str(o.external_ref, "external_ref"),
    order_date: nullableStr(o.order_date),
    total_paise: int(o.total_paise, "total_paise"),
    invoices: invoices.map((raw, i) => {
      if (raw === null || typeof raw !== "object") return bad(`invoice ${i} was not an object`);
      const inv = raw;
      const lines = Array.isArray(inv.lines) ? inv.lines : bad(`invoice ${i} had no lines array`);
      return {
        invoice_number: str(inv.invoice_number, `invoice ${i} number`),
        seller_name: nullableStr(inv.seller_name),
        invoice_date: nullableStr(inv.invoice_date),
        total_paise: int(inv.total_paise, `invoice ${i} total`),
        lines: lines.map((lraw, j) => {
          if (lraw === null || typeof lraw !== "object") return bad(`line ${i}.${j} was not an object`);
          const l = lraw;
          return {
            kind: l.kind === "fee" ? "fee" : "goods",
            description: str(l.description, `line ${i}.${j} description`),
            sku: nullableStr(l.sku),
            qty: int(l.qty, `line ${i}.${j} qty`),
            amount_paise: int(l.amount_paise, `line ${i}.${j} amount`)
          };
        })
      };
    })
  };
}

// src/receipts/templates.ts
var SIGNATURES = [
  {
    template: "blinkit",
    // Blinkit splits every order between two legal sellers, so BOTH
    // names appear across a single order's invoices and either one identifies the template.
    // "Grofers" is the company's former name and is still printed in its own footer — worth
    // matching, because a template that names itself twice will eventually name itself once.
    markers: [
      "blink commerce private limited",
      "zomato hyperpure private limited",
      "grofers india private limited",
      "blinkit"
    ]
  },
  {
    template: "amazon",
    markers: [
      "amazon retail india private limited",
      "amazon seller services",
      "amazon.in"
    ]
  }
];
function detectReceiptTemplate(text) {
  const haystack = text.toLowerCase();
  const hits = SIGNATURES.filter((sig) => sig.markers.some((m) => haystack.includes(m)));
  if (hits.length !== 1) return null;
  return hits[0].template;
}
var PARSERS_AVAILABLE = {
  blinkit: false,
  // Landed 2026-09-06: ingest/receipts/amazon.py, verified on a real corpus of a few hundred
  // invoices, with every file it did not land quarantined for a stated reason (credit notes,
  // a delivery challan, and an invoice Amazon printed with a blank order number).
  amazon: true
};

// src/receipts/model/verify.ts
var COVERAGE_FLOOR = 0.3;
function normalise(s) {
  return s.toLowerCase().replace(/[​-‍﻿]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function verify(record, markdown) {
  const warnings = [];
  const fail2 = (kind, reason) => ({ ok: false, kind, reason, warnings });
  if (!record.is_invoice) {
    return fail2("not_an_invoice", "the document does not appear to be an invoice");
  }
  if (record.is_credit_note) {
    return fail2("credit_note", "this is a credit note \u2014 held until refunds are supported");
  }
  if (record.external_ref.trim() === "") {
    return fail2("schema_violation", "no order reference was found on the document");
  }
  if (record.invoices.length === 0) {
    return fail2("schema_violation", "the document produced no invoices");
  }
  const allLines = record.invoices.flatMap((i) => i.lines);
  if (allLines.length === 0) {
    return fail2("schema_violation", "the document produced no line items");
  }
  if (record.total_paise === 0) {
    return fail2("schema_violation", "the order total is zero");
  }
  for (const inv of record.invoices) {
    const lineSum = inv.lines.reduce((a, l) => a + l.amount_paise, 0);
    if (lineSum !== inv.total_paise) {
      return fail2(
        "does_not_reconcile",
        `invoice ${inv.invoice_number}: the lines sum to ${paise(lineSum)} but the invoice states ${paise(inv.total_paise)}`
      );
    }
  }
  const invoiceSum = record.invoices.reduce((a, i) => a + i.total_paise, 0);
  if (invoiceSum !== record.total_paise) {
    return fail2(
      "does_not_reconcile",
      `order ${record.external_ref}: the invoices sum to ${paise(invoiceSum)} but the order total is ${paise(record.total_paise)}`
    );
  }
  const haystack = normalise(markdown);
  const ungrounded = allLines.filter((l) => {
    const needle = normalise(l.description);
    if (needle === "") return true;
    if (haystack.includes(needle)) return false;
    const words = needle.split(" ");
    if (words.length < 4) return true;
    return !haystack.includes(words.slice(0, 4).join(" "));
  });
  if (ungrounded.length > 0) {
    return fail2(
      "hallucinated_lines",
      `${ungrounded.length} item(s) do not appear in the document, starting with "${ungrounded[0].description.slice(0, 60)}"`
    );
  }
  const coverage = coverageOf(record, markdown);
  if (coverage !== null && coverage < COVERAGE_FLOOR) {
    warnings.push(
      `only ${Math.round(coverage * 100)}% of the amounts printed on this document were claimed by a line \u2014 it may be missing rows`
    );
  }
  if (allLines.every((l) => l.qty === 0)) {
    warnings.push("no line states a quantity");
  }
  return { ok: true, warnings };
}
function coverageOf(record, markdown) {
  const printed = [...markdown.matchAll(/\b\d{1,3}(?:,\d{2,3})*\.\d{2}\b|\b\d+\.\d{2}\b/g)].map((m) => Math.round(Number(m[0].replace(/,/g, "")) * 100)).filter((n) => Number.isFinite(n) && n > 0);
  if (printed.length === 0) return null;
  const claimed = /* @__PURE__ */ new Set();
  for (const inv of record.invoices) {
    claimed.add(Math.abs(inv.total_paise));
    for (const l of inv.lines) claimed.add(Math.abs(l.amount_paise));
  }
  claimed.add(Math.abs(record.total_paise));
  const matched = printed.filter((p) => claimed.has(p)).length;
  return matched / printed.length;
}
function paise(n) {
  return "Rs " + (n / 100).toFixed(2);
}

// src/receipts/model/job.ts
async function runLlmReceiptJob(client, job) {
  const row = await client.query(
    "SELECT bytes, mime, parse_status FROM artifacts WHERE id = $1",
    [job.artifactId]
  );
  const artifact = row.rows[0];
  if (artifact === void 0) {
    throw new ParseFailure("corrupt", "the artifact no longer exists");
  }
  if (artifact.parse_status === "parsed") {
    throw new ParseFailure("duplicate_order", "this document was already landed");
  }
  if (artifact.mime !== "application/pdf") {
    throw new ParseFailure("unreadable_mime", `the model path reads PDFs, not ${artifact.mime}`);
  }
  const md = await extractMarkdown(artifact.bytes);
  if (!md.ok) throw new ParseFailure(md.kind, md.error);
  let record;
  try {
    record = await readInvoice(md.markdown);
  } catch (err) {
    if (err instanceof LlmParseFailure) throw new ParseFailure(err.kind, err.message);
    throw new ParseFailure("unknown", err instanceof Error ? err.message : String(err));
  }
  const verdict = verify(record, md.markdown);
  if (!verdict.ok) throw new ParseFailure(verdict.kind, verdict.reason);
  const sourceType = detectReceiptTemplate(md.markdown) ?? merchantSlug(record.merchant);
  const landed = await client.query(
    "SELECT 1 FROM evidence WHERE external_ref = $1 AND source_type = $2",
    [record.external_ref, sourceType]
  );
  if ((landed.rowCount ?? 0) > 0) {
    throw new ParseFailure("duplicate_order", `order ${record.external_ref} is already in your ledger`);
  }
  await client.query(
    `UPDATE artifacts
        SET parse_status = 'staged',
            source_type  = $2,
            external_ref = $3,
            record       = $4::jsonb,
            parse_error  = NULL,
            parsed_at    = now()
      WHERE id = $1`,
    [
      job.artifactId,
      sourceType,
      record.external_ref,
      JSON.stringify(toParsedRecord({ ...record, merchant: sourceType }, verdict.warnings))
    ]
  );
}
function merchantSlug(name) {
  const slug = name.toLowerCase().replace(/\b(private|pvt|limited|ltd|llp|inc|india|co)\b\.?/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "unrecognised" : slug;
}
function toParsedRecord(record, warnings) {
  return {
    source_type: record.merchant,
    external_ref: record.external_ref,
    order_date: record.order_date,
    total_paise: record.total_paise,
    invoices: record.invoices.map((inv) => ({
      invoice_number: inv.invoice_number,
      seller_name: inv.seller_name,
      invoice_date: inv.invoice_date,
      total_paise: inv.total_paise,
      lines: inv.lines.map((l) => ({
        kind: l.kind,
        invoice_number: inv.invoice_number,
        description: l.description,
        sku: l.sku,
        hsn: null,
        qty: l.qty,
        amount_paise: l.amount_paise,
        unit_paise: null,
        net_paise: null,
        tax_paise: null,
        discount_paise: null
      }))
    })),
    payment: [],
    // Said plainly on every such order, because a person reviewing it should know which of the
    // two paths read it without having to look anything up.
    warnings: ["read by the local model, not by a parser", ...warnings]
  };
}

// src/routes/accounts.ts
import { Router } from "express";

// src/accounts.ts
import { createHash as createHash2 } from "node:crypto";
async function accountExists(accountId) {
  const r = await pool.query("SELECT 1 FROM accounts WHERE id = $1", [accountId]);
  return r.rowCount !== 0;
}
function transactionHash(accountId, t) {
  const key2 = [
    accountId,
    t.txn_date,
    t.txn_time ?? "",
    t.amount_paise,
    t.narration ?? ""
  ].join("|");
  return createHash2("sha256").update(key2).digest("hex");
}

// src/transfers/reconcile.ts
async function fetchTransactionsByAccount(accountId) {
  return pool.query(
    "SELECT * FROM transactions WHERE account_id = $1 ORDER BY txn_date, statement_id, statement_seq",
    [accountId]
  );
}
async function reconcileAccount(accountId) {
  const result = await fetchTransactionsByAccount(accountId);
  const ledgerSum = await pool.query(
    "SELECT COALESCE(SUM(amount_paise), 0) AS total FROM transactions WHERE account_id = $1",
    [accountId]
  );
  const hasOpeningRow = result.rows.some((t) => t.type === "opening_balance");
  const response = {
    account_id: accountId,
    reconciled: true,
    // `reconciled: true` after zero comparisons is vacuous — the same way [].every() is
    // true. Unverifiable and verified are different claims, so say which one this is.
    verifiable: false,
    // Where the walk started from: an explicit opening_balance row, the bank's first
    // stated balance, or nowhere (no anchor and no checkpoints).
    opening_anchor: hasOpeningRow ? "opening_balance_row" : "none",
    // Money that existed before our earliest row, derived from the bank's first stated
    // balance. Null when an explicit opening row already accounts for it.
    implied_opening_paise: null,
    checkpoints_checked: 0,
    transactions_considered: result.rowCount,
    ledger_balance_paise: Number(ledgerSum.rows[0].total),
    bank_last_stated_paise: null,
    total_difference_paise: null,
    discrepancies: []
  };
  let computed = 0;
  let running = 0;
  let runningAtLastCheckpoint = 0;
  let anchored = hasOpeningRow;
  for (const t of result.rows) {
    const amount = Number(t.amount_paise);
    computed += amount;
    running += amount;
    if (t.bank_balance_paise != null) {
      const stated = Number(t.bank_balance_paise);
      response.checkpoints_checked += 1;
      response.bank_last_stated_paise = stated;
      if (!anchored) {
        const implied = stated - computed;
        response.opening_anchor = "first_stated_balance";
        response.implied_opening_paise = implied;
        computed = stated;
        running += implied;
        anchored = true;
        runningAtLastCheckpoint = running;
        continue;
      }
      if (computed !== stated) {
        response.reconciled = false;
        response.discrepancies.push({
          transaction_id: t.id,
          txn_date: t.txn_date,
          narration: t.narration,
          expected_paise: computed,
          stated_paise: stated,
          difference_paise: stated - computed
          // per-segment error
        });
        computed = stated;
      }
      runningAtLastCheckpoint = running;
    }
  }
  response.verifiable = response.checkpoints_checked > 0;
  if (response.bank_last_stated_paise != null) {
    response.total_difference_paise = response.bank_last_stated_paise - runningAtLastCheckpoint;
  }
  return response;
}

// src/spend.ts
var EXPLAINABLE_SPEND = `type <> 'opening_balance'
   AND type <> 'transfer'
   AND transfer_status IS DISTINCT FROM 'resolved'`;
var ALLOWED_TYPES = ["opening_balance", "transfer", "regular"];
var KEYWORD_KINDS = ["account_number", "upi_handle", "name"];
var TRANSFER_STATUSES = ["pending", "resolved", "suspected", "rejected"];

// src/routes/accounts.ts
var router = Router();
router.get("/accounts", route(async (_req, res) => {
  const result = await pool.query(
    `SELECT a.id, a.name, a.bank,
              COALESCE(SUM(t.amount_paise), 0) AS balance_paise
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
        GROUP BY a.id
        ORDER BY a.id`
  );
  const accounts = result.rows.map((r) => ({
    id: Number(r.id),
    // pg returns BIGINT as a string; account ids are small, safe to Number()
    name: r.name,
    bank: r.bank,
    balance_paise: Number(r.balance_paise)
  }));
  res.json({ accounts });
}));
router.get("/accounts/:id/balance", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  if (!await accountExists(accountId)) throw notFound("account id does not exist");
  const result = await pool.query(
    "SELECT COALESCE(SUM(amount_paise), 0) AS balance_paise FROM transactions WHERE account_id = $1",
    [accountId]
  );
  res.json({
    account_id: accountId,
    balance_paise: Number(result.rows[0].balance_paise)
  });
}));
router.get("/accounts/:id/transactions", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  if (!await accountExists(accountId)) {
    return res.status(404).json({ error: "account id does not exist" });
  }
  const result = await pool.query(
    `SELECT t.id, t.txn_date, t.txn_time, t.amount_paise, t.type, t.narration,
              t.transfer_status, t.counterparty_account_id, t.bank_balance_paise,
              COALESCE(SUM(al.amount_paise), 0) AS explained_paise,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', al.id::text, 'amount_paise', al.amount_paise,
                    'category_id', al.category_id, 'category_name', c.name,
                    'confidence', al.confidence, 'source', al.source
                  ) ORDER BY al.id
                ) FILTER (WHERE al.id IS NOT NULL),
                '[]'
              ) AS allocations
         FROM transactions t
         LEFT JOIN allocations al ON al.transaction_id = t.id
         LEFT JOIN categories c ON c.id = al.category_id
        WHERE t.account_id = $1
        GROUP BY t.id
        ORDER BY t.txn_date, t.statement_id, t.statement_seq`,
    [accountId]
  );
  const transactions = result.rows.map((r) => {
    const amount = Number(r.amount_paise);
    const explained = Number(r.explained_paise);
    return {
      id: r.id,
      // BIGINT PK — keep as STRING (JS loses precision past 2^53)
      txn_date: r.txn_date,
      txn_time: r.txn_time,
      amount_paise: amount,
      // safe: one txn won't exceed 2^53 paise
      type: r.type,
      narration: r.narration,
      transfer_status: r.transfer_status,
      counterparty_account_id: r.counterparty_account_id,
      // BIGINT|null — leave as string|null
      bank_balance_paise: r.bank_balance_paise == null ? null : Number(r.bank_balance_paise),
      explained_paise: explained,
      unexplained_paise: amount - explained,
      // derived, not stored
      allocations: r.allocations
      // pg parses json_agg into a JS array
    };
  });
  res.json({ account_id: accountId, transactions });
}));
router.post("/accounts/:id/transactions", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  const body = req.body;
  if (!await accountExists(accountId)) throw notFound("account id does not exist");
  if (!Array.isArray(body?.transactions) || body.transactions.length === 0) {
    res.status(400).json({ error: "`transactions` must be a non-empty array" });
    return;
  }
  const errors = [];
  body.transactions.forEach((t, i) => {
    if (t === null || typeof t !== "object") {
      errors.push(`row ${i}: must be an object`);
      return;
    }
    if (!Number.isInteger(t.amount_paise)) {
      errors.push(`row ${i}: amount_paise must be an integer (paise, signed)`);
    } else if (t.amount_paise === 0) {
      errors.push(`row ${i}: amount_paise must not be zero`);
    }
    if (typeof t.txn_date !== "string" || Number.isNaN(Date.parse(t.txn_date))) {
      errors.push(
        `row ${i}: txn_date must be a valid date string (YYYY-MM-DD)`
      );
    }
    if (!ALLOWED_TYPES.includes(t.type)) {
      errors.push(`row ${i}: type must be one of ${ALLOWED_TYPES.join(", ")}`);
    }
    if (t.bank_balance_paise != null && !Number.isInteger(t.bank_balance_paise)) {
      errors.push(
        `row ${i}: bank_balance_paise must be an integer if provided`
      );
    }
  });
  if (errors.length > 0) {
    res.status(400).json({ errors });
    return;
  }
  const stmt = body.statement ?? {};
  const imported = await withTransaction(async (client) => {
    const stmtResult = await client.query(
      `INSERT INTO statements (account_id, source, period_start, period_end, declared_count)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        accountId,
        stmt.source ?? null,
        stmt.period_start ?? null,
        stmt.period_end ?? null,
        stmt.declared_count ?? null
      ]
    );
    const statementId = stmtResult.rows[0].id;
    let inserted = 0;
    for (const [i, t] of body.transactions.entries()) {
      const result = await client.query(
        `INSERT INTO transactions
           (account_id, statement_id, statement_seq, txn_date, txn_time,
            amount_paise, type, narration, bank_balance_paise, import_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (import_hash) DO NOTHING`,
        [
          accountId,
          statementId,
          i,
          // statement_seq = row position within this import (parse order)
          t.txn_date,
          t.txn_time ?? null,
          t.amount_paise,
          t.type,
          t.narration ?? null,
          t.bank_balance_paise ?? null,
          transactionHash(accountId, t)
        ]
      );
      if (result.rowCount && result.rowCount > 0) inserted++;
    }
    return {
      statement_id: statementId,
      inserted,
      skipped: body.transactions.length - inserted
    };
  }).catch((err) => {
    console.error("import failed:", err);
    throw new HttpError(500, "import failed");
  });
  res.status(201).json(imported);
}));
router.get("/accounts/:id/reconcile", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  if (!await accountExists(accountId)) {
    return res.status(404).json({ error: "account does not exist" });
  }
  return res.status(200).json(await reconcileAccount(accountId));
}));
router.get("/anomalies", route(async (_req, res) => {
  const accts = await pool.query("SELECT id, name FROM accounts ORDER BY id");
  const accounts = [];
  for (const row of accts.rows) {
    const r = await reconcileAccount(Number(row.id));
    if (r.verifiable && !r.reconciled) {
      accounts.push({ account_name: row.name, ...r });
    }
  }
  res.json({ accounts });
}));

// src/routes/categories.ts
import { Router as Router2 } from "express";
var router2 = Router2();
router2.get("/categories", route(async (_req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.parent_id, p.name AS parent_name,
              (SELECT COUNT(*) FROM categories ch WHERE ch.parent_id = c.id)   AS children,
              (SELECT COUNT(*) FROM allocations al WHERE al.category_id = c.id) AS allocations,
              (SELECT COUNT(*) FROM rules r WHERE r.category_id = c.id)         AS rules
         FROM categories c
         LEFT JOIN categories p ON p.id = c.parent_id
        ORDER BY COALESCE(p.name, c.name), c.parent_id NULLS FIRST, c.name`
  );
  const categories = result.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    parent_id: r.parent_id == null ? null : Number(r.parent_id),
    parent_name: r.parent_name,
    // null for top-level rows
    children: Number(r.children),
    allocations: Number(r.allocations),
    rules: Number(r.rules)
  }));
  res.json({ categories });
}));
async function validateCategory(name, parentId, selfId) {
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, error: "name must be a non-empty string" };
  }
  if (name.trim().length > 60) {
    return { ok: false, error: "name must be 60 characters or fewer" };
  }
  if (parentId !== void 0 && parentId !== null) {
    if (!Number.isInteger(parentId)) {
      return { ok: false, error: "parent_id must be an integer or null" };
    }
    if (selfId !== null && parentId === selfId) {
      return { ok: false, error: "a category cannot be its own parent" };
    }
    const parent = await pool.query(
      "SELECT parent_id FROM categories WHERE id = $1",
      [parentId]
    );
    if (parent.rowCount === 0) {
      return { ok: false, error: "parent_id does not exist" };
    }
    if (parent.rows[0].parent_id !== null) {
      return {
        ok: false,
        error: "categories are two levels deep \u2014 pick a top-level parent"
      };
    }
    if (selfId !== null) {
      const kids = await pool.query(
        "SELECT 1 FROM categories WHERE parent_id = $1 LIMIT 1",
        [selfId]
      );
      if (kids.rowCount !== 0) {
        return {
          ok: false,
          error: "this category has sub-categories \u2014 move them out before nesting it"
        };
      }
    }
  }
  return { ok: true, name: name.trim() };
}
router2.post("/categories", route(async (req, res) => {
  const { name, parent_id } = req.body ?? {};
  const checked = await validateCategory(name, parent_id ?? null, null);
  if (!checked.ok) return res.status(400).json({ error: checked.error });
  try {
    const clash = await pool.query(
      "SELECT 1 FROM categories WHERE parent_id IS NOT DISTINCT FROM $1 AND lower(name) = lower($2)",
      [parent_id ?? null, checked.name]
    );
    if (clash.rowCount !== 0) {
      return res.status(409).json({ error: "a category with that name already exists here" });
    }
    const result = await pool.query(
      "INSERT INTO categories (name, parent_id) VALUES ($1, $2) RETURNING id",
      [checked.name, parent_id ?? null]
    );
    return res.status(201).json({ id: Number(result.rows[0].id) });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("a category with that name already exists here");
    throw error;
  }
}));
router2.patch("/categories/:id", route(async (req, res) => {
  const id = intParam(req.params.id, "category id");
  const body = req.body ?? {};
  const reparenting = Object.hasOwn(body, "parent_id");
  try {
    const existing = await pool.query(
      "SELECT name, parent_id FROM categories WHERE id = $1",
      [id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: "no category found" });
    }
    const current = existing.rows[0];
    const nextName = Object.hasOwn(body, "name") ? body.name : current.name;
    const nextParent = reparenting ? body.parent_id : current.parent_id === null ? null : Number(current.parent_id);
    const checked = await validateCategory(nextName, nextParent, id);
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const clash = await pool.query(
      `SELECT 1 FROM categories
        WHERE parent_id IS NOT DISTINCT FROM $1 AND lower(name) = lower($2) AND id <> $3`,
      [nextParent, checked.name, id]
    );
    if (clash.rowCount !== 0) {
      return res.status(409).json({ error: "a category with that name already exists here" });
    }
    await pool.query("UPDATE categories SET name = $1, parent_id = $2 WHERE id = $3", [
      checked.name,
      nextParent,
      id
    ]);
    return res.json({ id, name: checked.name, parent_id: nextParent });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("a category with that name already exists here");
    throw error;
  }
}));
router2.delete("/categories/:id", route(async (req, res) => {
  const id = intParam(req.params.id, "category id");
  const rawReassign = req.query.reassign_to;
  let reassignTo = null;
  if (rawReassign !== void 0) {
    if (typeof rawReassign !== "string" || !/^\d+$/.test(rawReassign)) {
      return res.status(400).json({ error: "reassign_to must be a positive integer" });
    }
    reassignTo = Number(rawReassign);
    if (reassignTo === id) {
      return res.status(400).json({ error: "cannot reassign a category to itself" });
    }
  }
  const result = await withTransaction(async (client) => {
    const found = await client.query(
      "SELECT name FROM categories WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (found.rowCount === 0) {
      throw notFound("no category found");
    }
    const kids = await client.query(
      "SELECT COUNT(*) AS n FROM categories WHERE parent_id = $1",
      [id]
    );
    if (Number(kids.rows[0].n) > 0) {
      throw conflict(
        `has ${kids.rows[0].n} sub-categor${kids.rows[0].n === "1" ? "y" : "ies"} \u2014 move or delete those first`
      );
    }
    const allocations = Number(
      (await client.query(
        "SELECT COUNT(*) AS n FROM allocations WHERE category_id = $1",
        [id]
      )).rows[0].n
    );
    const rules = Number(
      (await client.query("SELECT COUNT(*) AS n FROM rules WHERE category_id = $1", [id])).rows[0].n
    );
    if ((allocations > 0 || rules > 0) && reassignTo === null) {
      throw conflict("category is in use", {
        allocations,
        rules,
        hint: "delete again with ?reassign_to=<category_id> to move them"
      });
    }
    if (reassignTo !== null) {
      const target = await client.query("SELECT 1 FROM categories WHERE id = $1", [
        reassignTo
      ]);
      if (target.rowCount === 0) {
        throw badRequest("reassign_to does not exist");
      }
      await client.query(
        "UPDATE allocations SET category_id = $1 WHERE category_id = $2",
        [reassignTo, id]
      );
      await client.query("UPDATE rules SET category_id = $1 WHERE category_id = $2", [
        reassignTo,
        id
      ]);
    }
    await client.query("DELETE FROM categories WHERE id = $1", [id]);
    return {
      deleted: id,
      allocations_reassigned: reassignTo === null ? 0 : allocations,
      rules_reassigned: reassignTo === null ? 0 : rules
    };
  });
  return res.json(result);
}));

// src/routes/evidence.ts
import { Router as Router3 } from "express";

// src/evidence/merchants.ts
function normaliseNarration(narration) {
  if (narration === null) return "";
  return narration.replace(/[​-‍﻿]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
var MERCHANT_TOKENS = {
  splitwise: null,
  blinkit: ["blinkit", "grofers"],
  // Amazon marketplace invoices are issued by the SELLER, not by Amazon — a real invoice
  // corpus names Amazon Retail, Amazon Seller Services and a dozen third-party sellers.
  // But the BANK never sees any of them: the payment goes to Amazon, so the narration says
  // Amazon. The tokens belong to the payer-facing name.
  amazon: ["amazon", "amzn"]
};
function narrationIdentifies(narration, sourceType) {
  const tokens = MERCHANT_TOKENS[sourceType];
  if (tokens === null || tokens === void 0) return true;
  const text = normaliseNarration(narration);
  if (text === "") return false;
  return tokens.some((t) => text.includes(t));
}

// src/transfers/transfers.ts
var REFERENCE_RE = /(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/g;
function extractReferences(narration) {
  if (narration === null) return [];
  const found = [...narration.matchAll(REFERENCE_RE)].map((m) => m[0]);
  return [...new Set(found)];
}
function dayGap(a, b) {
  const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  return Math.round(ms / 864e5);
}
function findReferencePartner(leg, sharing, windowDays) {
  for (const reference of extractReferences(leg.narration)) {
    const others = (sharing.get(reference) ?? []).filter((r) => r.id !== leg.id);
    if (others.length !== 1) continue;
    const partner = others[0];
    if (partner.account_id === leg.account_id) continue;
    if (partner.amount_paise !== -leg.amount_paise) continue;
    if (dayGap(partner.txn_date, leg.txn_date) > windowDays) continue;
    return { partner, reference };
  }
  return null;
}
function indexByReference(rows) {
  const index = /* @__PURE__ */ new Map();
  for (const row of rows) {
    for (const reference of extractReferences(row.narration)) {
      const list = index.get(reference);
      if (list === void 0) index.set(reference, [row]);
      else list.push(row);
    }
  }
  return index;
}

// src/evidence/match.ts
var DEFAULT_WINDOW_DAYS = 3;
function matchToTransaction(request, candidates, windowDays = DEFAULT_WINDOW_DAYS) {
  const hits = candidates.filter(
    (c) => c.amount_paise === request.expectedPaise && dayGap(c.txn_date, request.date) <= windowDays && // The merchant filter, applied BEFORE the 1:1 test below rather than as a score after
    // it. That ordering is the whole point: a disqualified candidate must not be able to be
    // the unique hit that triggers an auto-accept. Absent `sourceType`, this is always true
    // and nothing changes.
    (request.sourceType === void 0 || narrationIdentifies(c.narration, request.sourceType))
  );
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) return { kind: "ambiguous", transactionIds: hits.map((h) => h.id) };
  return { kind: "matched", transactionId: hits[0].id, dayGap: dayGap(hits[0].txn_date, request.date) };
}
var DEFAULT_NEAR_DAYS = 10;
function nearMisses(request, candidates, windowDays = DEFAULT_WINDOW_DAYS, nearDays = DEFAULT_NEAR_DAYS) {
  return candidates.filter((c) => c.amount_paise === request.expectedPaise).filter(
    (c) => request.sourceType === void 0 || narrationIdentifies(c.narration, request.sourceType)
  ).map((c) => ({
    transactionId: c.id,
    txnDate: c.txn_date,
    dayGap: dayGap(c.txn_date, request.date),
    narration: c.narration,
    accountName: c.account_name ?? null
  })).filter((m) => m.dayGap > windowDays && m.dayGap <= nearDays).sort((a, b) => a.dayGap - b.dayGap);
}
function splitProportionally(totalPaise, weights) {
  if (weights.length === 0) return [];
  if (weights.length === 1) return [totalPaise];
  const totalWeight = weights.reduce((a, w) => a + Math.abs(w), 0);
  if (totalWeight === 0) {
    const even = Math.trunc(totalPaise / weights.length);
    const out2 = weights.map(() => even);
    out2[out2.length - 1] = totalPaise - even * (weights.length - 1);
    return out2;
  }
  const out = [];
  let assigned = 0;
  for (let i = 0; i < weights.length - 1; i++) {
    const share = Math.trunc(totalPaise * Math.abs(weights[i]) / totalWeight);
    out.push(share);
    assigned += share;
  }
  out.push(totalPaise - assigned);
  return out;
}
function resolvePrecedence(existing, authority = "auto") {
  if (existing.length === 0) return { action: "write" };
  const authored = existing.filter(
    (a) => a.source === "user" && a.confirmed_from_rule_id === null
  );
  if (authored.length > 0 && authority === "auto") {
    return {
      action: "conflict",
      reason: "a human authored this allocation directly",
      allocationIds: authored.map((a) => a.id)
    };
  }
  const otherEvidence = existing.filter((a) => a.source === "evidence");
  if (otherEvidence.length > 0) {
    return {
      action: "conflict",
      reason: "another external record already explains this transaction",
      allocationIds: otherEvidence.map((a) => a.id)
    };
  }
  return {
    action: "displace",
    allocationIds: existing.map((a) => a.id),
    authoredIds: authored.map((a) => a.id)
  };
}
function claimOn(existing) {
  if (existing.length === 0) return "free";
  const decision = resolvePrecedence(existing, "user");
  if (decision.action === "conflict") return "refused";
  if (decision.action === "write") return "free";
  return decision.authoredIds.length > 0 ? "yours" : "replaces";
}
function expectedCash(kind, costPaise, netPaise) {
  if (kind === "payment") {
    return netPaise === 0 ? null : -netPaise;
  }
  if (netPaise <= 0) return null;
  return -costPaise;
}

// src/rules/rules.ts
var RULE_FIELDS = ["narration", "amount_paise", "txn_date"];
var RULE_OPS = ["contains", "equals", "lt", "gt"];
var MATCH_MODES = ["all", "any"];
var OPS_BY_FIELD = {
  narration: ["contains", "equals"],
  amount_paise: ["equals", "lt", "gt"],
  txn_date: ["equals", "lt", "gt"]
};
function isRuleField(value) {
  return typeof value === "string" && RULE_FIELDS.includes(value);
}
function isRuleOp(value) {
  return typeof value === "string" && RULE_OPS.includes(value);
}
function isMatchMode(value) {
  return typeof value === "string" && MATCH_MODES.includes(value);
}
function normalise2(narration) {
  if (typeof narration !== "string") return "";
  return narration.toLowerCase().replace(/[-/*_.:,#|]+/g, " ").replace(/\d{6,}/g, " ").replace(/\s+/g, " ").trim();
}
function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function evaluateCondition(txn, condition) {
  const { field, op, value } = condition;
  if (!isRuleField(field) || !isRuleOp(op)) return false;
  if (!OPS_BY_FIELD[field].includes(op)) return false;
  switch (field) {
    case "narration": {
      if (typeof value !== "string") return false;
      const haystack = normalise2(txn.narration);
      const needle = normalise2(value);
      if (needle === "") return false;
      switch (op) {
        case "contains":
          return haystack.includes(needle);
        case "equals":
          return haystack === needle;
        case "lt":
        case "gt":
          return false;
      }
    }
    case "amount_paise": {
      const left = toNumber(txn.amount_paise);
      const right = toNumber(value);
      if (left === null || right === null) return false;
      switch (op) {
        case "equals":
          return left === right;
        case "lt":
          return left < right;
        case "gt":
          return left > right;
        case "contains":
          return false;
      }
    }
    case "txn_date": {
      if (typeof value !== "string") return false;
      switch (op) {
        case "equals":
          return txn.txn_date === value;
        case "lt":
          return txn.txn_date < value;
        case "gt":
          return txn.txn_date > value;
        case "contains":
          return false;
      }
    }
  }
}
function matches(txn, rule) {
  const { conditions, match_mode } = rule;
  if (!Array.isArray(conditions)) return false;
  if (!isMatchMode(match_mode)) return false;
  if (conditions.length === 0) return false;
  switch (match_mode) {
    case "all":
      return conditions.every((c) => evaluateCondition(txn, c));
    case "any":
      return conditions.some((c) => evaluateCondition(txn, c));
  }
}
function specificity(rule) {
  if (!Array.isArray(rule.conditions)) return 0;
  if (rule.match_mode === "any") return 1;
  return rule.conditions.length;
}
function compareRules(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const specificityA = specificity(a);
  const specificityB = specificity(b);
  if (specificityA !== specificityB) return specificityB - specificityA;
  return a.id - b.id;
}
function chooseWinner(txn, rules) {
  let winner = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matches(txn, rule)) continue;
    if (winner === null || compareRules(rule, winner) < 0) winner = rule;
  }
  return winner;
}
var RULE_CONFIDENCE = 0.8;
function decideAllocation(txn, remaining, rules) {
  if (remaining === 0) return null;
  const winner = chooseWinner(txn, rules);
  if (winner === null) return null;
  if (winner.category_id === null) return null;
  return {
    category_id: winner.category_id,
    amount_paise: remaining,
    rule_id: winner.id,
    confidence: RULE_CONFIDENCE
  };
}
function sameAllocation(existing, desired) {
  return existing.category_id === desired.category_id && existing.amount_paise === desired.amount_paise && existing.rule_id === desired.rule_id && existing.confidence === desired.confidence;
}

// src/rules/apply.ts
async function applyRules(client, accountId, transactionIds = null) {
  const ruleResult = await client.query(
    `SELECT id, conditions, match_mode, category_id, priority, enabled
       FROM rules
      WHERE enabled = true AND category_id IS NOT NULL`
  );
  const rules = ruleResult.rows.map((r) => ({
    id: Number(r.id),
    // BIGINT arrives as a string; the id tiebreak is numeric
    conditions: r.conditions,
    match_mode: r.match_mode,
    category_id: r.category_id === null ? null : Number(r.category_id),
    priority: Number(r.priority),
    enabled: r.enabled
  }));
  const txnResult = await client.query(
    `SELECT id, amount_paise, narration, txn_date
       FROM transactions
      WHERE ($1::bigint IS NULL OR account_id = $1)
        -- THE SCOPE THE BACKFILL NEEDS. Null means the whole ledger, exactly as before;
        -- a list means these rows and no others. An EMPTY list therefore examines
        -- nothing, which is the honest reading of "backfill these zero transactions"
        -- and is why no caller has to special-case it.
        AND ($2::bigint[] IS NULL OR id = ANY($2))
        AND ${EXPLAINABLE_SPEND}
      ORDER BY id
      FOR UPDATE`,
    [accountId, transactionIds]
  );
  const txns = txnResult.rows;
  const txnIds = txns.map((t) => t.id);
  const allocResult = txnIds.length === 0 ? { rows: [] } : await client.query(
    `SELECT id, transaction_id, category_id, amount_paise, confidence, source, rule_id
             FROM allocations
            WHERE transaction_id = ANY($1)`,
    [txnIds]
  );
  const allocationsByTxn = /* @__PURE__ */ new Map();
  for (const a of allocResult.rows) {
    const key2 = String(a.transaction_id);
    const list = allocationsByTxn.get(key2);
    if (list === void 0) allocationsByTxn.set(key2, [a]);
    else list.push(a);
  }
  let matched = 0;
  let created = 0;
  let removed = 0;
  let unchanged = 0;
  let skippedUserLocked = 0;
  for (const t of txns) {
    const existing = allocationsByTxn.get(String(t.id)) ?? [];
    if (existing.some((a) => a.source === "user")) {
      skippedUserLocked++;
      continue;
    }
    const nonRuleExplained = existing.filter((a) => a.source !== "rule").reduce((sum, a) => sum + Number(a.amount_paise), 0);
    const remaining = Number(t.amount_paise) - nonRuleExplained;
    const desired = decideAllocation(
      {
        narration: t.narration,
        amount_paise: t.amount_paise,
        txn_date: t.txn_date
      },
      remaining,
      rules
    );
    if (desired !== null) matched++;
    const actual = existing.filter((a) => a.source === "rule");
    if (desired !== null && actual.length === 1 && sameAllocation(
      {
        category_id: Number(actual[0].category_id),
        amount_paise: Number(actual[0].amount_paise),
        rule_id: actual[0].rule_id === null ? null : Number(actual[0].rule_id),
        confidence: Number(actual[0].confidence)
        // NUMERIC comes back as a string
      },
      desired
    )) {
      unchanged++;
      continue;
    }
    if (desired === null && actual.length === 0) continue;
    if (actual.length > 0) {
      const del = await client.query(
        "DELETE FROM allocations WHERE transaction_id = $1 AND source = 'rule'",
        [t.id]
      );
      removed += del.rowCount ?? 0;
    }
    if (desired !== null) {
      await client.query(
        `INSERT INTO allocations
           (transaction_id, amount_paise, category_id, confidence, source, rule_id)
         VALUES ($1, $2, $3, $4, 'rule', $5)`,
        [
          t.id,
          desired.amount_paise,
          desired.category_id,
          desired.confidence,
          desired.rule_id
        ]
      );
      created++;
    }
  }
  return {
    account_id: accountId,
    examined: txns.length,
    matched,
    created,
    removed,
    unchanged,
    skipped_user_locked: skippedUserLocked
  };
}

// src/evidence/line-allocations.ts
async function deriveForEvidence(client, evidenceId) {
  const none = {
    orders: 0,
    allocationsWritten: 0,
    refused: 0,
    displaced: 0,
    displacedPaise: 0,
    explainedPaise: 0,
    tradedDown: 0,
    backfilled: 0
  };
  const linked = await client.query(
    "SELECT transaction_id FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId]
  );
  if (linked.rowCount === 0) return none;
  const transactionIds = linked.rows.map((r) => r.transaction_id);
  const existing = await client.query(
    `SELECT id, source, confirmed_from_rule_id
       FROM allocations
      WHERE transaction_id = ANY($1) AND (evidence_id IS DISTINCT FROM $2)`,
    [transactionIds, evidenceId]
  );
  const decision = resolvePrecedence(existing.rows, "auto");
  if (decision.action === "conflict") return { ...none, refused: 1 };
  const lines = await client.query(
    `SELECT i.category_id, l.amount_paise
       FROM evidence_lines l
       JOIN items i ON i.id = l.item_id
      WHERE l.evidence_id = $1 AND l.kind = 'goods' AND i.category_id IS NOT NULL`,
    [evidenceId]
  );
  const wouldExplain = lines.rows.reduce((a, l) => a + Math.abs(Number(l.amount_paise)), 0);
  let displaced = 0;
  let displacedPaise = 0;
  if (decision.action === "displace" && decision.allocationIds.length > 0) {
    const held = await client.query(
      "SELECT COALESCE(sum(abs(amount_paise)), 0)::text AS total FROM allocations WHERE id = ANY($1)",
      [decision.allocationIds]
    );
    displaced = decision.allocationIds.length;
    displacedPaise = Number(held.rows[0].total);
  }
  const measured = {
    displaced,
    displacedPaise,
    explainedPaise: wouldExplain,
    tradedDown: wouldExplain < displacedPaise ? 1 : 0,
    // `deriveForEvidence` does not run the engine. `rederiveAndBackfill` overwrites this.
    backfilled: 0
  };
  await client.query(
    "DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'",
    [evidenceId]
  );
  if (decision.action === "displace" && decision.allocationIds.length > 0) {
    await client.query("DELETE FROM allocations WHERE id = ANY($1)", [decision.allocationIds]);
  }
  if (lines.rowCount === 0) {
    return { orders: 1, allocationsWritten: 0, refused: 0, ...measured };
  }
  const byCategory = /* @__PURE__ */ new Map();
  for (const l of lines.rows) {
    const key2 = l.category_id;
    byCategory.set(key2, (byCategory.get(key2) ?? 0) + Math.abs(Number(l.amount_paise)));
  }
  const amounts = await client.query(
    "SELECT id, amount_paise FROM transactions WHERE id = ANY($1)",
    [transactionIds]
  );
  let written = 0;
  const remaining = new Map(byCategory);
  for (const t of amounts.rows) {
    let room = Math.abs(Number(t.amount_paise));
    if (room <= 0) continue;
    const sign = Number(t.amount_paise) < 0 ? -1 : 1;
    for (const categoryId of [...remaining.keys()]) {
      if (room <= 0) break;
      const left = remaining.get(categoryId) ?? 0;
      if (left <= 0) continue;
      const give = Math.min(left, room);
      await client.query(
        // `confidence` is NOT NULL and 1.00 is what every other evidence allocation carries:
        // this is a recorded fact from a document, not an estimate. A `note` says where the
        // number came from, since an evidence row on a transaction is otherwise unexplained.
        `INSERT INTO allocations
           (transaction_id, amount_paise, category_id, confidence, source, evidence_id, note)
         VALUES ($1, $2, $3, 1.00, 'evidence', $4, $5)`,
        [t.id, sign * give, categoryId, evidenceId, "from the order's line items"]
      );
      remaining.set(categoryId, left - give);
      room -= give;
      written += 1;
    }
  }
  return { orders: 1, allocationsWritten: written, refused: 0, ...measured };
}
async function rederiveAndBackfill(client, evidenceId) {
  const transactionIds = await collectTransactionIds(client, evidenceId);
  const derived = await deriveForEvidence(client, evidenceId);
  return { ...derived, backfilled: await backfill(client, transactionIds) };
}
async function rederiveForItems(client, itemIds) {
  if (itemIds.length === 0) return emptyResult();
  const affected = await client.query(
    `SELECT DISTINCT evidence_id FROM evidence_lines WHERE item_id = ANY($1::bigint[])`,
    [itemIds]
  );
  const total = emptyResult();
  const touched = /* @__PURE__ */ new Set();
  for (const row of affected.rows) {
    for (const id of await collectTransactionIds(client, row.evidence_id)) {
      touched.add(id);
    }
    add(total, await deriveForEvidence(client, row.evidence_id));
  }
  total.backfilled = await backfill(client, [...touched]);
  return total;
}
async function backfill(client, transactionIds) {
  if (transactionIds.length === 0) return 0;
  const result = await applyRules(client, null, transactionIds);
  return result.created;
}
function emptyResult() {
  return {
    orders: 0,
    allocationsWritten: 0,
    refused: 0,
    displaced: 0,
    displacedPaise: 0,
    explainedPaise: 0,
    tradedDown: 0,
    backfilled: 0
  };
}
function add(total, one) {
  total.orders += one.orders;
  total.allocationsWritten += one.allocationsWritten;
  total.refused += one.refused;
  total.displaced += one.displaced;
  total.displacedPaise += one.displacedPaise;
  total.explainedPaise += one.explainedPaise;
  total.tradedDown += one.tradedDown;
  total.backfilled += one.backfilled;
}
async function collectTransactionIds(client, evidenceId) {
  const linked = await client.query(
    "SELECT transaction_id FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId]
  );
  return linked.rows.map((r) => r.transaction_id);
}

// src/items/items.ts
function stripMerchantNoise(description) {
  return description.replace(/\r/g, "").replace(/\bHSN\s*[:\-]\s*\d{4,8}\b/gi, " ").replace(/\(\s*HSN[-:\s]*\d{4,8}\s*\)/gi, " ").replace(/\|\s*B0[A-Z0-9]{8}\s*\(?[^)]*\)?\s*$/i, " ").replace(/\bB0[A-Z0-9]{8}\b/g, " ").replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").trim();
}
var VARIANT_TOKENS = [
  // 150g · 50 gm · 1kg · 300ml · 1 ltr · 500 mg
  /\b\d+(\.\d+)?\s*(g|gm|gms|gram|grams|kg|kgs|mg|ml|l|ltr|ltrs|litre|litres|liter|liters)\b/g,
  // pack of 4 · set of 2 · combo of 3
  /\b(pack|set|combo|pair)\s+of\s+\d+\b/g,
  // 4 x 100g style multipacks, and bare counts
  /\b\d+\s*[x×]\s*\d+(\.\d+)?\s*(g|gm|ml|kg|l)\b/g,
  /\b\d+\s*(pcs|pc|pieces|count|units?|tablets?|capsules?|sachets?)\b/g,
  // the container itself: Blinkit prints "(PET Bottle)", "(Pouch)", "(Can)"
  /\b(pet bottle|tetra pak|tetrapak|bottle|pouch|can|jar|tin|box|carton|sachet|packet|refill)\b/g
];
function canonicalName(description) {
  let s = stripMerchantNoise(description).toLowerCase().replace(/[​-‍﻿]/g, "");
  for (const re of VARIANT_TOKENS) s = s.replace(re, " ");
  return s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
function extractVariantAttributes(description) {
  const text = stripMerchantNoise(description).toLowerCase();
  const attrs = {};
  const sizes = [
    ...text.matchAll(
      /\b(\d+(?:\.\d+)?)\s*(kg|kgs|g|gm|gms|gram|grams|mg|ml|l|ltr|ltrs|litre|litres|liter|liters)\b/g
    )
  ];
  const size = sizes.at(-1);
  if (size) attrs.size = `${size[1]} ${size[2]}`;
  const pack = text.match(
    /\b(pet bottle|tetra ?pak|bottle|pouch|can|jar|tin|box|carton|sachet|packet|refill)\b/
  );
  if (pack) attrs.pack = pack[1].replace(/\s+/g, " ");
  const multi = text.match(/\b(?:pack|set|combo|pair)\s+of\s+(\d+)\b/);
  if (multi) attrs.pack_of = multi[1];
  return attrs;
}
var MAX_DIFFERING_TOKENS = 1;
var MIN_SHARED_TOKENS = 5;
var BARE_NUMBER = /^\d+$/;
function variantDiff(canonA, canonB) {
  const a = new Set(canonA.split(" ").filter(Boolean));
  const b = new Set(canonB.split(" ").filter(Boolean));
  const onlyA = [...a].filter((t) => !b.has(t));
  const onlyB = [...b].filter((t) => !a.has(t));
  const differing = [...onlyA, ...onlyB];
  const shared = [...a].filter((t) => b.has(t)).length;
  if (onlyA.length === 0 && onlyB.length === 0) {
    return { sameProduct: true, differing: [] };
  }
  if (onlyA.length > MAX_DIFFERING_TOKENS || onlyB.length > MAX_DIFFERING_TOKENS) {
    return { sameProduct: false, reason: "too many differing words", differing };
  }
  if (shared < MIN_SHARED_TOKENS) {
    return { sameProduct: false, reason: "the names have too little in common", differing };
  }
  if (differing.some((t) => BARE_NUMBER.test(t))) {
    return { sameProduct: false, reason: "differs by a bare number, which reads as a model", differing };
  }
  return { sameProduct: true, differing };
}
var AUTO_LINK_SIMILARITY = 88;
var PROPOSE_SIMILARITY = 55;
function resolveLine(aliasHit, candidates, canon) {
  if (aliasHit !== null) {
    return { action: "existing", itemId: aliasHit.itemId, confidence: 100, via: aliasHit.via };
  }
  const ranked = [...candidates].sort((a, b) => b.similarity - a.similarity);
  const explainable = (c) => canon !== void 0 && variantDiff(canon, c.canonicalName).sameProduct;
  const strong = ranked.filter(
    (c) => c.similarity >= AUTO_LINK_SIMILARITY && (c.hasConflictingSku !== true || explainable(c))
  );
  if (strong.length === 1) {
    return { action: "link", itemId: strong[0].itemId, confidence: strong[0].similarity, needsReview: true };
  }
  const propose = ranked.filter((c) => c.similarity >= PROPOSE_SIMILARITY);
  return {
    action: "create",
    // How confident we are that CREATING is right: with no near-miss at all, completely; with
    // a close one, much less. This is what a review screen sorts by.
    confidence: propose.length === 0 ? 100 : Math.max(0, 100 - propose[0].similarity),
    propose
  };
}

// src/items/store.ts
var CANDIDATE_LIMIT = 5;
async function findAlias(client, line, canon) {
  if (line.sku?.value) {
    const bySku = await client.query(
      `SELECT item_id FROM item_aliases
        WHERE source_type = $1 AND alias_kind = 'sku' AND alias_value = $2`,
      [line.sourceType, line.sku.value]
    );
    if (bySku.rowCount) return { itemId: bySku.rows[0].item_id, via: "sku" };
  }
  const byName = await client.query(
    `SELECT item_id FROM item_aliases
      WHERE source_type = $1 AND alias_kind = 'name' AND alias_value = $2`,
    [line.sourceType, canon]
  );
  if (byName.rowCount) return { itemId: byName.rows[0].item_id, via: "name" };
  return null;
}
async function findCandidates(client, canon, line) {
  const rows = await client.query(
    `SELECT i.id, i.canonical_name, (similarity(i.canonical_name, $1) * 100)::int AS sim,
            -- Does this candidate already carry a DIFFERENT id from the SAME merchant? If so
            -- the merchant is telling us these are two things, and no similarity score may
            -- overrule that. $3 is NULL when the incoming line has no SKU, and then nothing
            -- conflicts.
            EXISTS (
              SELECT 1 FROM item_aliases a
               WHERE a.item_id = i.id AND a.alias_kind = 'sku'
                 AND a.source_type = $2 AND a.alias_value IS DISTINCT FROM $3
            ) AS conflicting_sku
       FROM items i
      WHERE i.canonical_name % $1
      ORDER BY sim DESC, i.id
      LIMIT ${CANDIDATE_LIMIT}`,
    [canon, line.sourceType, line.sku?.value ?? null]
  );
  return rows.rows.map((r) => ({
    itemId: r.id,
    canonicalName: r.canonical_name,
    similarity: r.sim,
    hasConflictingSku: r.conflicting_sku
  }));
}
async function addAlias(client, itemId, line, canon, source, confidence) {
  const label2 = line.description.trim().slice(0, 500);
  const attributes = JSON.stringify(extractVariantAttributes(line.description));
  if (line.sku?.value) {
    await client.query(
      `INSERT INTO item_aliases (item_id, source_type, alias_kind, alias_value, source, confidence, label, attributes)
       VALUES ($1, $2, 'sku', $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (source_type, alias_kind, alias_value) DO NOTHING`,
      [itemId, line.sourceType, line.sku.value, source, confidence, label2, attributes]
    );
  }
  await client.query(
    `INSERT INTO item_aliases (item_id, source_type, alias_kind, alias_value, source, confidence, label, attributes)
     VALUES ($1, $2, 'name', $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (source_type, alias_kind, alias_value) DO NOTHING`,
    [itemId, line.sourceType, canon, source, confidence, label2, attributes]
  );
}
async function raiseProposals(client, itemId, propose) {
  let raised = 0;
  for (const c of propose) {
    const lo = BigInt(itemId) < BigInt(c.itemId) ? itemId : c.itemId;
    const hi = BigInt(itemId) < BigInt(c.itemId) ? c.itemId : itemId;
    if (lo === hi) continue;
    const r = await client.query(
      `INSERT INTO item_merge_proposals (lo_item_id, hi_item_id, similarity, source)
       VALUES ($1, $2, $3, 'trigram')
       ON CONFLICT (lo_item_id, hi_item_id) DO NOTHING`,
      [lo, hi, c.similarity]
    );
    raised += r.rowCount ?? 0;
  }
  return raised;
}
async function previewLine(client, line) {
  const canon = canonicalName(line.description);
  if (canon === "") return { resolution: { action: "create", confidence: 100, propose: [] }, canonical: "" };
  const aliasHit = await findAlias(client, line, canon);
  const candidates = aliasHit ? [] : await findCandidates(client, canon, line);
  return { resolution: resolveLine(aliasHit, candidates, canon), canonical: canon };
}
async function itemSummary(client, itemId) {
  const r = await client.query(
    `SELECT i.id, i.display_name, i.canonical_name, i.category_id, c.name AS category_name
       FROM items i LEFT JOIN categories c ON c.id = i.category_id WHERE i.id = $1`,
    [itemId]
  );
  return r.rowCount ? r.rows[0] : null;
}
async function resolveAndRecord(client, line) {
  const canon = canonicalName(line.description);
  if (canon === "") {
    throw new Error(`line description canonicalises to nothing: ${line.description.slice(0, 80)}`);
  }
  const aliasHit = await findAlias(client, line, canon);
  const candidates = aliasHit ? [] : await findCandidates(client, canon, line);
  const resolution = resolveLine(aliasHit, candidates, canon);
  if (resolution.action === "existing") {
    await addAlias(client, resolution.itemId, line, canon, "exact", 100);
    await client.query("UPDATE items SET updated_at = now() WHERE id = $1", [resolution.itemId]);
    return { itemId: resolution.itemId, resolution, created: false, proposalsRaised: 0 };
  }
  if (resolution.action === "link") {
    await addAlias(client, resolution.itemId, line, canon, "trigram", resolution.confidence);
    const sibling = candidates.find((c) => c.itemId === resolution.itemId);
    if (sibling) {
      const diff = variantDiff(canon, sibling.canonicalName);
      const mine = diff.differing.filter((t) => canon.split(" ").includes(t));
      if (mine.length > 0) {
        await client.query(
          `UPDATE item_aliases
              SET attributes = attributes || jsonb_build_object('variant', $3::text)
            WHERE item_id = $1 AND alias_kind = 'name' AND alias_value = $2`,
          [resolution.itemId, canon, mine.join(" ")]
        );
      }
    }
    await client.query("UPDATE items SET updated_at = now() WHERE id = $1", [resolution.itemId]);
    return { itemId: resolution.itemId, resolution, created: false, proposalsRaised: 0 };
  }
  const inserted = await client.query(
    "INSERT INTO items (canonical_name, display_name) VALUES ($1, $2) RETURNING id",
    [canon, line.description.trim()]
  );
  const itemId = inserted.rows[0].id;
  await addAlias(client, itemId, line, canon, "exact", 100);
  const proposalsRaised = await raiseProposals(client, itemId, resolution.propose);
  return { itemId, resolution, created: true, proposalsRaised };
}
async function setCategoryForMany(client, opts) {
  const params = [opts.categoryId, opts.categoryId === null ? null : 100];
  const where = [];
  if (opts.itemIds !== void 0) {
    params.push(opts.itemIds);
    where.push(`id = ANY($${params.length}::bigint[])`);
  } else {
    if (opts.q) {
      params.push(`%${opts.q.toLowerCase()}%`);
      where.push(`(canonical_name LIKE $${params.length} OR lower(display_name) LIKE $${params.length})`);
    }
    if (opts.unclassifiedOnly) where.push("category_id IS NULL");
  }
  if (where.length === 0) throw new Error("refusing to file every item \u2014 send item_ids or a filter");
  const done = await client.query(
    // `category_source` follows the id in and out. `items_category_has_source` CHECKs that the
    // two are null together — a category with no provenance is unreviewable — so writing
    // 'user' beside a cleared id is a constraint violation, not a stylistic slip. Same shape
    // and the same casts as `setItemCategory`, for the same reason recorded there.
    `UPDATE items
        SET category_id = $1,
            category_source = CASE WHEN $1::bigint IS NULL THEN NULL ELSE 'user' END,
            category_confidence = $2::smallint,
            updated_at = now()
      WHERE ${where.join(" AND ")}
      RETURNING id`,
    params
  );
  return {
    count: done.rowCount ?? 0,
    itemIds: done.rows.map((r) => Number(r.id))
  };
}
async function listItems(client, opts) {
  const where = [];
  const params = [];
  if (opts.q) {
    params.push(`%${opts.q.toLowerCase()}%`);
    where.push(`(i.canonical_name LIKE $${params.length} OR lower(i.display_name) LIKE $${params.length})`);
  }
  if (opts.unclassifiedOnly) where.push("i.category_id IS NULL");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await client.query(
    // MOST-BOUGHT FIRST, because the products worth classifying are the ones you buy again —
    // that is the entire economic argument for a catalogue. Most
    // recently touched, the old order, put whatever you happened to edit last at the top, which
    // is a fact about your session rather than about your shopping.
    //
    // The count is a CTE computed once per request rather than a correlated subquery per row.
    // It walks every confirmed payload, which is bounded by how much has been imported and is
    // ~400 rows here; if that stops being cheap the fix is a counter maintained by
    // `resolveAndRecord`, not a page whose order depends on which slice you asked for.
    `WITH seen AS (
       SELECT a.item_id, count(*)::int AS times
         FROM evidence e
         CROSS JOIN LATERAL jsonb_array_elements(e.payload->'invoices') inv
         CROSS JOIN LATERAL jsonb_array_elements(inv->'lines') ln
         JOIN item_aliases a
           ON a.source_type = e.source_type
          AND a.alias_kind = 'sku'
          AND a.alias_value = ln->>'sku'
        WHERE ln->>'kind' IS DISTINCT FROM 'fee'
        GROUP BY a.item_id
     )
     SELECT i.id, i.canonical_name, i.display_name, i.category_id,
            c.name AS category_name, i.category_source,
            (SELECT count(*)::int FROM item_aliases a WHERE a.item_id = i.id) AS alias_count,
            COALESCE(s.times, 0) AS times_seen,
            i.updated_at
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN seen s ON s.item_id = i.id
       ${clause}
      ORDER BY times_seen DESC, i.updated_at DESC, i.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.limit, opts.offset]
  );
  const total = await client.query(
    `SELECT count(*)::text AS count FROM items i ${clause}`,
    params
  );
  return { rows: rows.rows, total: Number(total.rows[0].count) };
}
async function getItem(client, id) {
  const item = await client.query(
    `SELECT i.*, c.name AS category_name
       FROM items i LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.id = $1`,
    [id]
  );
  if (item.rowCount === 0) return null;
  const aliases = await client.query(
    `SELECT id, source_type, alias_kind, alias_value, label, attributes, source, confidence, created_at
       FROM item_aliases WHERE item_id = $1 ORDER BY alias_kind, alias_value`,
    [id]
  );
  return { ...item.rows[0], aliases: aliases.rows };
}
async function setItemCategory(client, id, categoryId, source, confidence) {
  const r = await client.query(
    `UPDATE items
        SET category_id = $2,
            -- Casts are REQUIRED, not decoration: a bare $3/$4 inside a CASE has no inferred
            -- type, and Postgres refuses to assign an untyped parameter to a SMALLINT column
            -- (42804, "you will need to rewrite or cast"). The column type is only inferred
            -- for a direct col = $n assignment, not through an expression.
            category_source = CASE WHEN $2::bigint IS NULL THEN NULL ELSE $3::text END,
            category_confidence = CASE WHEN $2::bigint IS NULL THEN NULL ELSE $4::smallint END,
            updated_at = now()
      WHERE id = $1`,
    [id, categoryId, source, confidence]
  );
  return (r.rowCount ?? 0) > 0;
}
async function mergeItems(client, keeperId, loserId) {
  if (keeperId === loserId) return { ok: false, error: "an item cannot be merged into itself", aliasesMoved: 0 };
  const both = await client.query(
    "SELECT id, category_id FROM items WHERE id = ANY($1::bigint[])",
    [[keeperId, loserId]]
  );
  if (both.rowCount !== 2) return { ok: false, error: "one or both items do not exist", aliasesMoved: 0 };
  const moved = await client.query(
    `UPDATE item_aliases SET item_id = $1
      WHERE item_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM item_aliases k
           WHERE k.item_id = $1 AND k.source_type = item_aliases.source_type
             AND k.alias_kind = item_aliases.alias_kind
             AND k.alias_value = item_aliases.alias_value)`,
    [keeperId, loserId]
  );
  await client.query(
    `UPDATE items keeper
        SET category_id = loser.category_id,
            category_source = loser.category_source,
            category_confidence = loser.category_confidence
       FROM items loser
      WHERE keeper.id = $1 AND loser.id = $2
        AND keeper.category_id IS NULL AND loser.category_id IS NOT NULL`,
    [keeperId, loserId]
  );
  await client.query("DELETE FROM items WHERE id = $1", [loserId]);
  await client.query("UPDATE items SET updated_at = now() WHERE id = $1", [keeperId]);
  return { ok: true, aliasesMoved: moved.rowCount ?? 0 };
}
async function listProposals(client, opts) {
  const rows = await client.query(
    `SELECT p.id, p.similarity, p.source, p.status, p.created_at,
            lo.id AS lo_id, lo.display_name AS lo_name, lo.canonical_name AS lo_canonical,
            hi.id AS hi_id, hi.display_name AS hi_name, hi.canonical_name AS hi_canonical
       FROM item_merge_proposals p
       JOIN items lo ON lo.id = p.lo_item_id
       JOIN items hi ON hi.id = p.hi_item_id
      WHERE p.status = $1
      ORDER BY p.similarity DESC, p.id
      LIMIT $2 OFFSET $3`,
    [opts.status, opts.limit, opts.offset]
  );
  const total = await client.query(
    "SELECT count(*)::text AS count FROM item_merge_proposals WHERE status = $1",
    [opts.status]
  );
  return { rows: rows.rows, total: Number(total.rows[0].count) };
}
async function rejectProposal(client, id) {
  const r = await client.query(
    "UPDATE item_merge_proposals SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'open'",
    [id]
  );
  return (r.rowCount ?? 0) > 0;
}
async function getProposal(client, id) {
  const r = await client.query(
    "SELECT lo_item_id, hi_item_id, status FROM item_merge_proposals WHERE id = $1",
    [id]
  );
  return r.rowCount ? r.rows[0] : null;
}
async function itemStats(client) {
  const r = await client.query(
    `SELECT (SELECT count(*) FROM items)::text AS total,
            (SELECT count(*) FROM items WHERE category_id IS NULL)::text AS unclassified,
            (SELECT count(*) FROM item_aliases)::text AS aliases,
            (SELECT count(*) FROM item_merge_proposals WHERE status = 'open')::text AS open_proposals`
  );
  const row = r.rows[0];
  return {
    total: Number(row.total),
    unclassified: Number(row.unclassified),
    aliases: Number(row.aliases),
    open_proposals: Number(row.open_proposals),
    propose_similarity: PROPOSE_SIMILARITY
  };
}

// src/receipts/staging.ts
async function loadCandidates(client) {
  const rows = await client.query(
    `SELECT t.id, t.txn_date::text, t.amount_paise, t.narration, acc.name AS account_name
       FROM transactions t JOIN accounts acc ON acc.id = t.account_id`
  );
  return rows.rows.map((c) => ({ ...c, amount_paise: Number(c.amount_paise) }));
}
function isoDate(raw) {
  if (!raw) return null;
  const dotted = raw.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;
  return null;
}
function toRawLine(sourceType, line) {
  return {
    sourceType,
    description: line.description,
    // The template's own id — an ASIN for most things, an ISBN for a book. `upc` is the label
    // for "a merchant's global product number"; the kind only matters to a human reading it.
    sku: line.sku ? { kind: "asin", value: line.sku } : null
  };
}
async function listStaged(client, opts) {
  const staged = await client.query(
    `SELECT id, external_ref, source_type, record FROM artifacts
      WHERE parse_status = 'staged' AND record IS NOT NULL
      ORDER BY created_at DESC, id DESC`
  );
  const candidates = await loadCandidates(client);
  const orders = [];
  for (const row of staged.rows) {
    const record = row.record;
    const sourceType = row.source_type ?? record.source_type;
    const lines = [];
    let index = 0;
    let needsAttention = false;
    for (const invoice of record.invoices) {
      for (const line of invoice.lines) {
        const here = index++;
        if (line.kind === "fee") {
          lines.push({
            ...line,
            index: here,
            resolution: { action: "fee", item_id: null, item_name: null, needs_input: false, candidates: [] },
            category: null,
            canonical: null
          });
          continue;
        }
        const { resolution } = await previewLine(client, toRawLine(sourceType, line));
        let itemId = null;
        let itemName = null;
        let category = null;
        if (resolution.action !== "create") {
          itemId = resolution.itemId;
          const summary = await itemSummary(client, resolution.itemId);
          itemName = summary?.display_name ?? summary?.canonical_name ?? null;
          if (summary?.category_id && summary.category_name) {
            category = { id: summary.category_id, name: summary.category_name };
          }
        }
        const proposals = resolution.action === "create" ? resolution.propose : [];
        const needsInput = resolution.action === "link" || proposals.length > 0;
        if (needsInput) needsAttention = true;
        lines.push({
          ...line,
          index: here,
          resolution: {
            action: resolution.action,
            item_id: itemId,
            item_name: itemName,
            needs_input: needsInput,
            candidates: proposals.map((c2) => ({
              item_id: c2.itemId,
              name: c2.canonicalName,
              similarity: c2.similarity
            }))
          },
          category,
          canonical: canonicalName(line.description)
        });
      }
    }
    const outcome = matchToTransaction(
      {
        externalRef: record.external_ref,
        date: isoDate(record.order_date) ?? "",
        expectedPaise: -record.total_paise,
        sourceType
      },
      candidates
    );
    if (outcome.kind === "ambiguous") needsAttention = true;
    orders.push({
      artifact_id: row.id,
      external_ref: record.external_ref,
      source_type: sourceType,
      order_date: isoDate(record.order_date),
      total_paise: record.total_paise,
      invoice_count: record.invoices.length,
      needs_attention: needsAttention,
      match: {
        kind: outcome.kind,
        transaction: outcome.kind === "matched" ? candidates.find((c2) => c2.id === outcome.transactionId) ?? null : null
      },
      lines
    });
  }
  const counts = await client.query(
    `SELECT
       (SELECT count(*) FROM artifacts WHERE parse_status = 'staged')::text AS staged,
       (SELECT count(*) FROM artifacts WHERE parse_status IN ('unsupported','failed'))::text AS held,
       (SELECT coalesce(sum((record->>'total_paise')::bigint), 0)
          FROM artifacts WHERE parse_status = 'staged')::text AS total_paise,
       (SELECT count(*)
          FROM artifacts a
          CROSS JOIN LATERAL jsonb_array_elements(a.record->'invoices') AS inv
          CROSS JOIN LATERAL jsonb_array_elements(inv->'lines') AS ln
          LEFT JOIN item_aliases al
            ON al.source_type = a.source_type
           AND al.alias_kind = 'sku'
           AND al.alias_value = (ln->>'sku')
          LEFT JOIN items it ON it.id = al.item_id
         WHERE a.parse_status = 'staged'
           AND ln->>'kind' = 'goods'
           AND (it.id IS NULL OR it.category_id IS NULL))::text AS uncategorised`
  );
  const c = counts.rows[0];
  const held = await client.query(
    `SELECT id AS artifact_id, original_name, parse_status, parse_error, source_type
       FROM artifacts WHERE parse_status IN ('unsupported', 'failed')
      ORDER BY created_at DESC LIMIT 200`
  );
  return {
    summary: {
      staged: Number(c.staged),
      held: Number(c.held),
      total_paise: Number(c.total_paise),
      needs_attention: orders.filter((o) => o.needs_attention).length,
      uncategorised_lines: Number(c.uncategorised)
    },
    // Filter FIRST, then page — so "page 2 of what needs you" is page 2 of that list rather
    // than whatever survived filtering an arbitrary window.
    orders: (opts.attentionOnly ? orders.filter((o) => o.needs_attention) : orders).slice(opts.offset, opts.offset + opts.limit),
    held: held.rows
  };
}
async function listStagedItems(client, opts) {
  const staged = await client.query(
    `SELECT source_type, record FROM artifacts
      WHERE parse_status = 'staged' AND record IS NOT NULL
      ORDER BY created_at DESC, id DESC`
  );
  const grouped = /* @__PURE__ */ new Map();
  for (const row of staged.rows) {
    const record = row.record;
    const sourceType = row.source_type ?? record.source_type;
    for (const invoice of record.invoices) {
      for (const line of invoice.lines) {
        if (line.kind === "fee") continue;
        const canon = canonicalName(line.description);
        const key2 = `${sourceType}:${line.sku ?? `name:${canon}`}`;
        const existing = grouped.get(key2);
        if (existing) {
          existing.lines += 1;
          existing.paise += line.amount_paise;
          existing.orders.add(record.external_ref);
          if (line.description.length > existing.description.length) {
            existing.description = line.description;
          }
        } else {
          grouped.set(key2, {
            sourceType,
            sku: line.sku,
            description: line.description,
            lines: 1,
            paise: line.amount_paise,
            orders: /* @__PURE__ */ new Set([record.external_ref])
          });
        }
      }
    }
  }
  const items = [];
  let needsInput = 0;
  for (const [key2, g] of grouped) {
    const { resolution } = await previewLine(client, {
      sourceType: g.sourceType,
      description: g.description,
      sku: g.sku ? { kind: "asin", value: g.sku } : null
    });
    let itemId = null;
    let itemName = null;
    let category = null;
    if (resolution.action !== "create") {
      itemId = resolution.itemId;
      const summary = await itemSummary(client, resolution.itemId);
      itemName = summary?.display_name ?? summary?.canonical_name ?? null;
      if (summary?.category_id && summary.category_name) {
        category = { id: summary.category_id, name: summary.category_name };
      }
    }
    const proposals = resolution.action === "create" ? resolution.propose : [];
    const needs = resolution.action === "link" || proposals.length > 0;
    if (needs) needsInput++;
    items.push({
      key: key2,
      source_type: g.sourceType,
      sku: g.sku,
      description: g.description,
      canonical: canonicalName(g.description),
      line_count: g.lines,
      total_paise: g.paise,
      order_refs: [...g.orders].slice(0, 8),
      action: resolution.action,
      item_id: itemId,
      item_name: itemName,
      category,
      needs_input: needs,
      candidates: proposals.map((c) => ({
        item_id: c.itemId,
        name: c.canonicalName,
        similarity: c.similarity
      }))
    });
  }
  const needle = opts.q?.trim().toLowerCase();
  const filtered = items.filter((i) => {
    if (opts.needsInputOnly && !i.needs_input) return false;
    if (!needle) return true;
    return i.description.toLowerCase().includes(needle) || (i.item_name ?? "").toLowerCase().includes(needle) || (i.sku ?? "").toLowerCase().includes(needle);
  });
  filtered.sort((a, b) => b.line_count - a.line_count || b.total_paise - a.total_paise);
  return { items: filtered, total: items.length, needs_input: needsInput };
}
async function confirmOne(client, artifactId, overrides) {
  const row = await client.query(
    "SELECT external_ref, source_type, record, parse_status FROM artifacts WHERE id = $1",
    [artifactId]
  );
  if (row.rowCount === 0) throw new Error(`no artifact ${artifactId}`);
  const { record, parse_status } = row.rows[0];
  if (parse_status !== "staged" || !record) {
    throw new Error(`artifact ${artifactId} is ${parse_status}, not staged`);
  }
  const sourceType = row.rows[0].source_type ?? record.source_type;
  const evidence = await client.query(
    `INSERT INTO evidence (source_type, external_ref, evidence_date, amount_paise, description, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (source_type, external_ref) WHERE external_ref IS NOT NULL DO UPDATE
        SET evidence_date = EXCLUDED.evidence_date,
            amount_paise  = EXCLUDED.amount_paise,
            description   = EXCLUDED.description,
            payload       = EXCLUDED.payload
     RETURNING id`,
    [
      sourceType,
      record.external_ref,
      isoDate(record.order_date),
      // NEGATIVE: an invoice is money leaving. Storing the magnitude would make every order
      // look like income to anything that reads the sign.
      -record.total_paise,
      `${sourceType} order ${record.external_ref}`,
      JSON.stringify(record)
    ]
  );
  const evidenceId = evidence.rows[0].id;
  await client.query("DELETE FROM evidence_lines WHERE evidence_id = $1", [evidenceId]);
  let resolved = 0;
  let index = 0;
  for (const invoice of record.invoices) {
    for (const line of invoice.lines) {
      const here = index++;
      if (line.kind === "fee") {
        await client.query(
          `INSERT INTO evidence_lines (evidence_id, line_index, item_id, kind, amount_paise)
           VALUES ($1, $2, NULL, 'fee', $3)`,
          [evidenceId, here, line.amount_paise]
        );
        continue;
      }
      const canon = canonicalName(line.description);
      const override = overrides[`${sourceType}:${line.sku ?? `name:${canon}`}`];
      let itemId;
      if (override?.item_id) {
        await client.query(
          `INSERT INTO item_aliases (item_id, source_type, alias_kind, alias_value, source, confidence, label)
           VALUES ($1, $2, 'sku', $3, 'user', 100, $4)
           ON CONFLICT (source_type, alias_kind, alias_value) DO NOTHING`,
          [override.item_id, sourceType, line.sku ?? line.description.slice(0, 180), line.description.slice(0, 500)]
        );
        itemId = String(override.item_id);
      } else {
        itemId = (await resolveAndRecord(client, toRawLine(sourceType, line))).itemId;
      }
      await client.query(
        `INSERT INTO evidence_lines (evidence_id, line_index, item_id, kind, amount_paise)
         VALUES ($1, $2, $3, 'goods', $4)`,
        [evidenceId, here, itemId, line.amount_paise]
      );
      resolved++;
    }
  }
  const candidates = await loadCandidates(client);
  const outcome = matchToTransaction(
    {
      externalRef: record.external_ref,
      date: isoDate(record.order_date) ?? "",
      expectedPaise: -record.total_paise,
      sourceType
    },
    candidates
  );
  let matched = false;
  if (outcome.kind === "matched") {
    await client.query(
      `INSERT INTO evidence_transactions (evidence_id, transaction_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [evidenceId, outcome.transactionId]
    );
    matched = true;
  }
  const derived = await rederiveAndBackfill(client, evidenceId);
  await client.query(
    "UPDATE artifacts SET parse_status = 'parsed', external_ref = $2 WHERE id = $1",
    [artifactId, record.external_ref]
  );
  return {
    external_ref: record.external_ref,
    evidence_id: evidenceId,
    items_resolved: resolved,
    matched,
    allocations_written: derived.allocationsWritten,
    displaced: derived.displaced,
    displaced_paise: derived.displacedPaise,
    backfilled: derived.backfilled
  };
}
async function matchReceiptEvidence(client, sourceType) {
  const summary = {
    considered: 0,
    matched: 0,
    ambiguous: 0,
    noCandidate: 0,
    noCashExpected: 0,
    allocationsWritten: 0,
    partiallyAllocated: 0,
    conflicted: 0,
    displaced: 0,
    nearMissed: 0,
    backfilled: 0,
    // Filled as the sweep goes: a preview has to show WHAT matched, not only how many.
    conflicts: [],
    pairs: []
  };
  const unlinked = await client.query(
    `SELECT id, external_ref, evidence_date::text, amount_paise
       FROM evidence e
      WHERE e.source_type = $1
        AND NOT EXISTS (SELECT 1 FROM evidence_transactions x WHERE x.evidence_id = e.id)`,
    [sourceType]
  );
  if (unlinked.rowCount === 0) return summary;
  const candidates = await loadCandidates(client);
  for (const ev of unlinked.rows) {
    summary.considered++;
    const outcome = matchToTransaction(
      {
        externalRef: ev.external_ref,
        date: ev.evidence_date ?? "",
        // Already stored negative — an invoice is money leaving.
        expectedPaise: Number(ev.amount_paise),
        sourceType
      },
      candidates
    );
    if (outcome.kind === "ambiguous") {
      summary.ambiguous++;
      continue;
    }
    if (outcome.kind !== "matched") {
      summary.noCandidate++;
      continue;
    }
    await client.query(
      `INSERT INTO evidence_transactions (evidence_id, transaction_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [ev.id, outcome.transactionId]
    );
    const derived = await rederiveAndBackfill(client, ev.id);
    summary.pairs.push({
      evidenceId: ev.id,
      externalRef: ev.external_ref,
      description: null,
      evidenceDate: ev.evidence_date ?? "",
      amountPaise: Number(ev.amount_paise),
      transactionId: outcome.transactionId,
      txnDate: "",
      txnAmountPaise: Number(ev.amount_paise),
      narration: null,
      dayGap: outcome.dayGap
    });
    if (derived.refused > 0) {
      summary.conflicts.push({
        externalRef: ev.external_ref,
        transactionId: outcome.transactionId,
        reason: "something you wrote already explains that bank row"
      });
      summary.conflicted++;
    }
    summary.matched++;
    summary.allocationsWritten += derived.allocationsWritten;
    summary.displaced += derived.displaced;
    summary.backfilled += derived.backfilled;
  }
  return summary;
}

// src/receipts/records.ts
var SPLITWISE = "splitwise";
async function isReceipt(client, evidenceId) {
  const r = await client.query(
    "SELECT 1 FROM evidence WHERE id = $1 AND source_type <> $2",
    [evidenceId, SPLITWISE]
  );
  return (r.rowCount ?? 0) > 0;
}
function whatWasBought(row) {
  const goods = (row.payload?.invoices ?? []).flatMap((i) => i.lines ?? []).filter((l) => l.kind !== "fee" && typeof l.description === "string").map((l) => l.description.split(/[|(\n]/)[0].trim());
  if (goods.length === 0) {
    return { short: `${row.source_type} order ${row.external_ref ?? ""}`.trim(), full: null };
  }
  const short = goods.length === 1 ? goods[0] : `${goods[0]} + ${goods.length - 1} more`;
  return { short, full: goods.join("\n") };
}
async function listReceiptRecords(client, filter = {}) {
  const rows = await client.query(
    `SELECT ev.id, ev.source_type, ev.external_ref, ev.evidence_date::text,
            ev.amount_paise, ev.payload, ev.created_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'transactionId',  t.id::text,
                  'txnDate',        t.txn_date::text,
                  'txnAmountPaise', t.amount_paise,
                  'narration',      t.narration,
                  'accountName',    acc.name
                ) ORDER BY t.txn_date, t.id
              ) FILTER (WHERE t.id IS NOT NULL),
              '[]'
            ) AS linked
       FROM evidence ev
       LEFT JOIN evidence_transactions et ON et.evidence_id = ev.id
       LEFT JOIN transactions t          ON t.id = et.transaction_id
       LEFT JOIN accounts acc            ON acc.id = t.account_id
      WHERE ev.source_type <> $1
        AND ($2::text IS NULL OR ev.source_type = $2)
      GROUP BY ev.id
      ORDER BY ev.evidence_date DESC NULLS LAST, ev.id DESC`,
    [SPLITWISE, filter.source ?? null]
  );
  const candidates = await loadCandidates(client);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const claims = /* @__PURE__ */ new Map();
  for (const a of (await client.query(
    "SELECT transaction_id, id, source, confirmed_from_rule_id FROM allocations"
  )).rows) {
    const held = claims.get(a.transaction_id);
    if (held === void 0) claims.set(a.transaction_id, [a]);
    else held.push(a);
  }
  const withClaims = (list) => list.map((m) => ({ ...m, claim: claimOn(claims.get(m.transactionId) ?? []) }));
  const out = [];
  for (const ev of rows.rows) {
    const date = ev.evidence_date ?? new Date(ev.created_at).toISOString().slice(0, 10);
    const expected = Number(ev.amount_paise);
    const bought = whatWasBought(ev);
    const linked = ev.linked.map((l) => ({
      transactionId: l.transactionId,
      txnDate: l.txnDate,
      txnAmountPaise: Number(l.txnAmountPaise),
      narration: l.narration,
      accountName: l.accountName,
      dayGap: dayGap(l.txnDate, date)
    }));
    let state = "matched";
    let offer = [];
    let conflict2 = null;
    if (linked.length === 0) {
      const request = {
        externalRef: ev.external_ref ?? "",
        date,
        expectedPaise: expected,
        sourceType: ev.source_type
      };
      const outcome = matchToTransaction(request, candidates);
      const blocked = outcome.kind === "matched" ? resolvePrecedence(claims.get(outcome.transactionId) ?? [], "auto") : null;
      if (outcome.kind === "matched" && blocked?.action === "conflict") {
        const txn = byId.get(outcome.transactionId);
        state = "conflicted";
        conflict2 = blocked.reason;
        offer = withClaims([
          {
            transactionId: outcome.transactionId,
            txnDate: txn?.txn_date ?? "",
            dayGap: outcome.dayGap,
            narration: txn?.narration ?? null,
            accountName: txn?.account_name ?? null
          }
        ]);
      } else {
        offer = withClaims(nearMisses(request, candidates));
        state = offer.length > 0 ? "near" : "unmatched";
      }
    }
    if (filter.state !== void 0 && filter.state !== state) continue;
    out.push({
      evidenceId: ev.id,
      externalRef: ev.external_ref ?? "",
      description: bought.short,
      descriptionFull: bought.full,
      evidenceDate: date,
      amountPaise: Number(ev.amount_paise),
      expectedPaise: expected,
      sourceCategory: "",
      group: ev.source_type,
      state,
      linked,
      candidates: offer,
      conflict: conflict2,
      // A receipt's categories are PER LINE, filed on the Products page. There is no one
      // category for the order to pick, so the record-level picker never appears.
      categoryName: null,
      categoryId: null,
      canChoose: false,
      needsCategory: false
    });
  }
  return out;
}
async function listReceiptImports(client) {
  const records = await listReceiptRecords(client);
  const bySource = /* @__PURE__ */ new Map();
  for (const r of records) {
    const held = bySource.get(r.group);
    if (held === void 0) bySource.set(r.group, [r]);
    else held.push(r);
  }
  const last = await client.query(
    `SELECT source_type, MAX(created_at) AS last FROM evidence
      WHERE source_type <> $1 GROUP BY source_type`,
    [SPLITWISE]
  );
  const lastBy = new Map(last.rows.map((r) => [r.source_type, new Date(r.last).toISOString()]));
  return [...bySource.entries()].map(([source, mine]) => {
    const count = (state) => mine.filter((r) => r.state === state).length;
    return {
      source,
      group: source,
      records: mine.length,
      matched: count("matched"),
      near: count("near"),
      conflicted: count("conflicted"),
      unmatched: count("unmatched"),
      // Every order expected cash of ours. Nothing is consumption-only here.
      noCashExpected: 0,
      lastImportedAt: lastBy.get(source) ?? ""
    };
  });
}
async function linkReceipt(client, evidenceId, transactionIds) {
  if (!await isReceipt(client, evidenceId)) return { ok: false, error: "no such receipt" };
  if (transactionIds.length === 0) return { ok: false, error: "no transaction selected" };
  const txns = await client.query(
    "SELECT id, amount_paise FROM transactions WHERE id = ANY($1::bigint[])",
    [transactionIds]
  );
  if (txns.rowCount !== new Set(transactionIds).size) {
    return { ok: false, error: "one of those bank rows does not exist" };
  }
  if (txns.rows.some((t) => Number(t.amount_paise) >= 0)) {
    return { ok: false, error: "an order is money leaving \u2014 pick debits, not credits" };
  }
  const before = await client.query(
    "SELECT transaction_id FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId]
  );
  const previous = before.rows.map((r) => r.transaction_id);
  await client.query("DELETE FROM evidence_transactions WHERE evidence_id = $1", [evidenceId]);
  for (const id of new Set(transactionIds)) {
    await client.query(
      "INSERT INTO evidence_transactions (evidence_id, transaction_id) VALUES ($1, $2)",
      [evidenceId, id]
    );
  }
  const derived = await rederiveAndBackfill(client, evidenceId);
  if (derived.refused > 0) {
    const other = await client.query(
      `SELECT 1 FROM allocations
        WHERE transaction_id = ANY($1::bigint[]) AND source = 'evidence'
          AND evidence_id <> $2
        LIMIT 1`,
      [transactionIds, evidenceId]
    );
    if ((other.rowCount ?? 0) > 0) {
      throw new ReceiptLinkRefused(
        "another order already explains that bank row \u2014 unlink it there first"
      );
    }
  }
  const freed = previous.filter((id) => !transactionIds.includes(id));
  const refilled = freed.length > 0 ? (await applyRules(client, null, freed)).created : 0;
  return {
    ok: true,
    displaced: derived.displaced,
    displacedAuthored: 0,
    backfilled: derived.backfilled + refilled,
    allocationsWritten: derived.allocationsWritten,
    partial: false,
    scaledDown: false
  };
}
var ReceiptLinkRefused = class extends Error {
};
async function unlinkReceipt(client, evidenceId) {
  if (!await isReceipt(client, evidenceId)) return { ok: false, error: "no such record" };
  const links = await client.query(
    "DELETE FROM evidence_transactions WHERE evidence_id = $1 RETURNING transaction_id",
    [evidenceId]
  );
  if ((links.rowCount ?? 0) === 0) {
    return { ok: false, error: "this record is not linked to anything" };
  }
  const allocations = await client.query(
    "DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'",
    [evidenceId]
  );
  await applyRules(client, null, links.rows.map((r) => r.transaction_id));
  return {
    ok: true,
    transactionsUnlinked: links.rowCount ?? 0,
    allocationsRemoved: allocations.rowCount ?? 0
  };
}

// src/evidence/detect.ts
var SOURCE = "splitwise";
var EVIDENCE_COLUMNS = `id, external_ref, description, evidence_date::text, amount_paise, payload`;
var UNLINKED = `NOT EXISTS (
  SELECT 1 FROM evidence_transactions et WHERE et.evidence_id = evidence.id
)`;
async function loadContext(client, me) {
  const shared = await client.query(
    `SELECT c.id FROM categories c
       JOIN categories p ON p.id = c.parent_id
      WHERE c.name = 'Shared' AND p.name = 'Transfers' AND p.parent_id IS NULL`
  );
  if (shared.rowCount === 0) {
    throw new Error("category Transfers > Shared is missing (migration 005)");
  }
  const map = new Map(
    (await client.query(
      "SELECT source_category, category_id FROM source_category_map WHERE source_type = $1",
      [SOURCE]
    )).rows.map((r) => [r.source_category, r.category_id])
  );
  return { sharedId: shared.rows[0].id, map, me };
}
async function loadCandidates2(client) {
  const rows = await client.query(
    `SELECT t.id, t.txn_date::text, t.amount_paise, t.narration, acc.name AS account_name
       FROM transactions t JOIN accounts acc ON acc.id = t.account_id`
  );
  return rows.rows.map((c) => ({ ...c, amount_paise: Number(c.amount_paise) }));
}
async function applyMatch(client, ev, transactionIds, ctx, authority, categoryOverride = null) {
  const netPaise = ev.payload.nets_paise[ctx.me] ?? 0;
  const costPaise = Number(ev.amount_paise);
  const expected = expectedCash(ev.payload.kind, costPaise, netPaise);
  if (expected === null) {
    return { conflict: "this record expects no cash of ours", displaced: 0, displacedAuthored: 0, backfilled: 0, allocationsWritten: 0, partial: false };
  }
  if (transactionIds.length === 0) {
    return { conflict: "no transaction selected", displaced: 0, displacedAuthored: 0, backfilled: 0, allocationsWritten: 0, partial: false };
  }
  const existing = await client.query(
    `SELECT id, source, confirmed_from_rule_id
       FROM allocations
      WHERE transaction_id = ANY($1) AND (evidence_id IS DISTINCT FROM $2)`,
    [transactionIds, ev.id]
  );
  const decision = resolvePrecedence(existing.rows, authority);
  if (decision.action === "conflict") {
    return { conflict: decision.reason, displaced: 0, displacedAuthored: 0, backfilled: 0, allocationsWritten: 0, partial: false };
  }
  await client.query("DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'", [ev.id]);
  await client.query("DELETE FROM evidence_transactions WHERE evidence_id = $1", [ev.id]);
  let displaced = 0;
  let displacedAuthored = 0;
  if (decision.action === "displace" && decision.allocationIds.length > 0) {
    await client.query("DELETE FROM allocations WHERE id = ANY($1)", [decision.allocationIds]);
    displaced = decision.allocationIds.length;
    displacedAuthored = decision.authoredIds.length;
  }
  const amounts = await client.query(
    "SELECT id, amount_paise FROM transactions WHERE id = ANY($1)",
    [transactionIds]
  );
  const ordered = amounts.rows.map((r) => ({ id: r.id, amount: Number(r.amount_paise) }));
  for (const t of ordered) {
    await client.query(
      "INSERT INTO evidence_transactions (evidence_id, transaction_id) VALUES ($1, $2)",
      [ev.id, t.id]
    );
  }
  const weights = ordered.map((t) => t.amount);
  const linkedTotal = weights.reduce((a, w) => a + Math.abs(w), 0);
  const recordTotal = Math.abs(ev.payload.kind === "payment" ? expected : costPaise);
  const cap = Math.min(recordTotal, linkedTotal);
  const scaledDown = cap < recordTotal;
  const perTxn = splitProportionally(-cap, weights);
  const write = (transactionId, amount, categoryId2, note) => client.query(
    `INSERT INTO allocations
         (transaction_id, amount_paise, category_id, confidence, source, evidence_id, note)
       VALUES ($1, $2, $3, 1.00, 'evidence', $4, $5)`,
    [transactionId, amount, categoryId2, ev.id, note]
  );
  const categoryId = categoryOverride ?? ctx.map.get(ev.payload.source_category) ?? null;
  const ourShare = costPaise - netPaise;
  let written = 0;
  for (const [i, share] of perTxn.entries()) {
    if (share === 0) continue;
    const txnId = ordered[i].id;
    if (ev.payload.kind === "payment") {
      await write(txnId, share, ctx.sharedId, `splitwise settlement ${ev.external_ref}`);
      written++;
      continue;
    }
    const othersPart = recordTotal === 0 ? 0 : Math.trunc(share * netPaise / recordTotal);
    const ourPart = share - othersPart;
    if (othersPart !== 0) {
      await write(txnId, othersPart, ctx.sharedId, `others' share of ${ev.external_ref}`);
      written++;
    }
    if (categoryId !== null && ourPart !== 0) {
      await write(txnId, ourPart, categoryId, `our share of ${ev.external_ref}`);
      written++;
    }
  }
  const backfilled = (await applyRules(client, null, transactionIds)).created;
  return {
    displaced,
    displacedAuthored,
    backfilled,
    allocationsWritten: written,
    partial: ev.payload.kind === "expense" && categoryId === null && ourShare !== 0,
    scaledDown
  };
}
async function matchSplitwiseEvidence(client, me) {
  const summary = {
    considered: 0,
    matched: 0,
    ambiguous: 0,
    noCandidate: 0,
    noCashExpected: 0,
    allocationsWritten: 0,
    partiallyAllocated: 0,
    conflicted: 0,
    displaced: 0,
    backfilled: 0,
    nearMissed: 0,
    conflicts: [],
    pairs: []
  };
  const ctx = await loadContext(client, me);
  const pending = await client.query(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence
      WHERE source_type = $1 AND ${UNLINKED}
      ORDER BY evidence_date, id`,
    [SOURCE]
  );
  const candidates = await loadCandidates2(client);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  for (const ev of pending.rows) {
    const netPaise = ev.payload.nets_paise[me] ?? 0;
    const expected = expectedCash(ev.payload.kind, Number(ev.amount_paise), netPaise);
    if (expected === null) {
      summary.noCashExpected++;
      continue;
    }
    summary.considered++;
    const request = { externalRef: ev.external_ref, date: ev.evidence_date, expectedPaise: expected, sourceType: SOURCE };
    const outcome = matchToTransaction(request, candidates);
    if (outcome.kind === "ambiguous") {
      summary.ambiguous++;
      continue;
    }
    if (outcome.kind === "none") {
      if (nearMisses(request, candidates).length > 0) summary.nearMissed++;
      else summary.noCandidate++;
      continue;
    }
    const applied = await applyMatch(client, ev, [outcome.transactionId], ctx, "auto");
    if (applied.conflict) {
      summary.conflicted++;
      summary.conflicts.push({
        externalRef: ev.external_ref,
        transactionId: outcome.transactionId,
        reason: applied.conflict
      });
      continue;
    }
    summary.matched++;
    summary.displaced += applied.displaced;
    summary.backfilled += applied.backfilled;
    summary.allocationsWritten += applied.allocationsWritten;
    if (applied.partial) summary.partiallyAllocated++;
    const txn = byId.get(outcome.transactionId);
    summary.pairs.push({
      evidenceId: ev.id,
      externalRef: ev.external_ref,
      description: ev.description,
      evidenceDate: ev.evidence_date,
      amountPaise: Number(ev.amount_paise),
      transactionId: outcome.transactionId,
      txnDate: txn?.txn_date ?? "",
      txnAmountPaise: txn?.amount_paise ?? 0,
      narration: txn?.narration ?? null,
      dayGap: outcome.dayGap
    });
  }
  return summary;
}
async function listUnmatched(client, me, nearOnly = true) {
  const pending = await client.query(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence
      WHERE source_type = $1 AND ${UNLINKED}
      ORDER BY evidence_date, id`,
    [SOURCE]
  );
  const candidates = await loadCandidates2(client);
  const out = [];
  for (const ev of pending.rows) {
    const netPaise = ev.payload.nets_paise[me] ?? 0;
    const expected = expectedCash(ev.payload.kind, Number(ev.amount_paise), netPaise);
    if (expected === null) continue;
    const near = nearMisses(
      { externalRef: ev.external_ref, date: ev.evidence_date, expectedPaise: expected, sourceType: SOURCE },
      candidates
    );
    if (nearOnly && near.length === 0) continue;
    out.push({
      evidenceId: ev.id,
      externalRef: ev.external_ref,
      description: ev.description,
      evidenceDate: ev.evidence_date,
      amountPaise: Number(ev.amount_paise),
      expectedPaise: expected,
      sourceCategory: ev.payload.source_category,
      candidates: near
    });
  }
  return out;
}
var listNearMisses = (client, me) => listUnmatched(client, me, true);
async function linkEvidence(client, evidenceId, transactionIds, me, categoryId = null) {
  if (transactionIds.length === 0) return { ok: false, error: "select at least one transaction" };
  const unique = [...new Set(transactionIds)];
  const found = await client.query(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE id = $1 AND source_type = $2`,
    [evidenceId, SOURCE]
  );
  const ev = found.rows[0];
  if (ev === void 0) return { ok: false, error: "no such record" };
  const already = await client.query(
    "SELECT 1 FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId]
  );
  if ((already.rowCount ?? 0) > 0) return { ok: false, error: "this record is already linked" };
  const txns = await client.query("SELECT id FROM transactions WHERE id = ANY($1)", [unique]);
  if (txns.rowCount !== unique.length) return { ok: false, error: "no such transaction" };
  const applied = await applyMatch(
    client,
    ev,
    unique,
    await loadContext(client, me),
    "user",
    categoryId
  );
  if (applied.conflict) return { ok: false, error: applied.conflict };
  return {
    ok: true,
    displaced: applied.displaced,
    displacedAuthored: applied.displacedAuthored,
    backfilled: applied.backfilled,
    allocationsWritten: applied.allocationsWritten,
    partial: applied.partial,
    scaledDown: applied.scaledDown ?? false
  };
}
async function listRecords(client, me, filter = {}) {
  const rows = await client.query(
    `SELECT ev.id, ev.external_ref, ev.description, ev.evidence_date::text,
            ev.amount_paise, ev.payload,
            COALESCE(
              json_agg(
                json_build_object(
                  'transactionId',  t.id::text,
                  'txnDate',        t.txn_date::text,
                  'txnAmountPaise', t.amount_paise,
                  'narration',      t.narration,
                  'accountName',    acc.name
                ) ORDER BY t.txn_date, t.id
              ) FILTER (WHERE t.id IS NOT NULL),
              '[]'
            ) AS linked
       FROM evidence ev
       LEFT JOIN evidence_transactions et ON et.evidence_id = ev.id
       LEFT JOIN transactions t          ON t.id = et.transaction_id
       LEFT JOIN accounts acc            ON acc.id = t.account_id
      WHERE ev.source_type = $1
        AND ($2::text IS NULL OR ev.payload->>'group' = $2)
      GROUP BY ev.id
      ORDER BY ev.evidence_date DESC, ev.id DESC`,
    [SOURCE, filter.group ?? null]
  );
  const candidates = await loadCandidates2(client);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ctx = await loadContext(client, me);
  const categoryNames = new Map(
    (await client.query("SELECT id, name FROM categories")).rows.map(
      (c) => [c.id, c.name]
    )
  );
  const filed = /* @__PURE__ */ new Map();
  for (const a of (await client.query(
    `SELECT al.evidence_id, c.id, c.name
         FROM allocations al JOIN categories c ON c.id = al.category_id
        WHERE al.source = 'evidence' AND al.evidence_id IS NOT NULL AND al.category_id <> $1`,
    [ctx.sharedId]
  )).rows) {
    filed.set(a.evidence_id, { id: a.id, name: a.name });
  }
  const claims = /* @__PURE__ */ new Map();
  for (const a of (await client.query(
    "SELECT transaction_id, id, source, confirmed_from_rule_id FROM allocations"
  )).rows) {
    const held = claims.get(a.transaction_id);
    if (held === void 0) claims.set(a.transaction_id, [a]);
    else held.push(a);
  }
  const out = [];
  for (const ev of rows.rows) {
    const netPaise = ev.payload.nets_paise[me] ?? 0;
    const expected = expectedCash(ev.payload.kind, Number(ev.amount_paise), netPaise);
    if (expected === null) continue;
    const linked = ev.linked.map((l) => ({
      transactionId: l.transactionId,
      txnDate: l.txnDate,
      // json_build_object emits a BIGINT as a JSON number and pg hands it back parsed, but
      // narrowing once here keeps the rule the rest of this file follows: an amount is a
      // number by the time it leaves the module.
      txnAmountPaise: Number(l.txnAmountPaise),
      narration: l.narration,
      accountName: l.accountName,
      dayGap: dayGap(l.txnDate, ev.evidence_date)
    }));
    const request = {
      externalRef: ev.external_ref,
      date: ev.evidence_date,
      expectedPaise: expected,
      sourceType: SOURCE
    };
    let state = "matched";
    let offer = [];
    let conflict2 = null;
    const withClaims = (list) => list.map((m) => ({ ...m, claim: claimOn(claims.get(m.transactionId) ?? []) }));
    if (linked.length === 0) {
      const outcome = matchToTransaction(request, candidates);
      const blocked = outcome.kind === "matched" ? resolvePrecedence(claims.get(outcome.transactionId) ?? [], "auto") : null;
      if (outcome.kind === "matched" && blocked?.action === "conflict") {
        const txn = byId.get(outcome.transactionId);
        state = "conflicted";
        conflict2 = blocked.reason;
        offer = withClaims([
          {
            transactionId: outcome.transactionId,
            txnDate: txn?.txn_date ?? "",
            dayGap: outcome.dayGap,
            narration: txn?.narration ?? null,
            accountName: txn?.account_name ?? null
          }
        ]);
      } else {
        offer = withClaims(nearMisses(request, candidates));
        state = offer.length > 0 ? "near" : "unmatched";
      }
    }
    if (filter.state !== void 0 && filter.state !== state) continue;
    const mapped = ctx.map.get(ev.payload.source_category) ?? null;
    const filedHere = linked.length > 0 ? filed.get(ev.id) ?? null : null;
    const categoryId = filedHere?.id ?? (linked.length > 0 ? null : mapped);
    const categoryName = filedHere?.name ?? (linked.length > 0 || mapped === null ? null : categoryNames.get(mapped) ?? null);
    const ourShare = Number(ev.amount_paise) - netPaise;
    const hasShare = ev.payload.kind === "expense" && ourShare !== 0;
    const canChoose = hasShare && mapped === null;
    const needsCategory = canChoose && categoryName === null;
    out.push({
      evidenceId: ev.id,
      externalRef: ev.external_ref,
      description: ev.description,
      evidenceDate: ev.evidence_date,
      amountPaise: Number(ev.amount_paise),
      expectedPaise: expected,
      sourceCategory: ev.payload.source_category,
      group: ev.payload.group,
      state,
      linked,
      candidates: offer,
      conflict: conflict2,
      categoryName,
      categoryId,
      canChoose,
      needsCategory
    });
  }
  return out;
}
async function listImports(client, me) {
  const totals = await client.query(
    `SELECT payload->>'group' AS group, COUNT(*) AS records, MAX(created_at) AS last
       FROM evidence
      WHERE source_type = $1 AND payload->>'group' IS NOT NULL
      GROUP BY 1`,
    [SOURCE]
  );
  const records = await listRecords(client, me);
  const byGroup = /* @__PURE__ */ new Map();
  for (const r of records) {
    const held = byGroup.get(r.group);
    if (held === void 0) byGroup.set(r.group, [r]);
    else held.push(r);
  }
  return totals.rows.map((t) => {
    const mine = byGroup.get(t.group) ?? [];
    const count = (state) => mine.filter((r) => r.state === state).length;
    return {
      source: SOURCE,
      group: t.group,
      records: Number(t.records),
      matched: count("matched"),
      near: count("near"),
      conflicted: count("conflicted"),
      unmatched: count("unmatched"),
      // Everything the worklist skipped, which is exactly what it left out.
      noCashExpected: Number(t.records) - mine.length,
      // pg returns a TIMESTAMPTZ aggregate as a Date OBJECT, whatever the row type claims. The
      // sort below calls localeCompare on it — which had never run, because there has only
      // ever been one group; a second one would have made this endpoint throw. An ISO string
      // is what the type says and what the JSON always carried, so it is made true here.
      lastImportedAt: new Date(t.last).toISOString()
    };
  }).sort((a, b) => b.lastImportedAt.localeCompare(a.lastImportedAt));
}
async function unlinkEvidence(client, evidenceId) {
  const found = await client.query(
    "SELECT 1 FROM evidence WHERE id = $1 AND source_type = $2",
    [evidenceId, SOURCE]
  );
  if (found.rowCount === 0) return { ok: false, error: "no such record" };
  const links = await client.query(
    "DELETE FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId]
  );
  if (links.rowCount === 0) {
    return { ok: false, error: "this record is not linked to anything" };
  }
  const allocations = await client.query(
    "DELETE FROM allocations WHERE evidence_id = $1 AND source = 'evidence'",
    [evidenceId]
  );
  return {
    ok: true,
    transactionsUnlinked: links.rowCount ?? 0,
    allocationsRemoved: allocations.rowCount ?? 0
  };
}
async function categoriseEvidence(client, evidenceId, categoryId, me) {
  const found = await client.query(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE id = $1 AND source_type = $2`,
    [evidenceId, SOURCE]
  );
  const ev = found.rows[0];
  if (ev === void 0) return { ok: false, error: "no such record" };
  if (ev.payload.kind === "payment") {
    return { ok: false, error: "a settlement has no category \u2014 it is a transfer, not spending" };
  }
  const category = await client.query("SELECT 1 FROM categories WHERE id = $1", [categoryId]);
  if (category.rowCount === 0) return { ok: false, error: "no such category" };
  const linked = await client.query(
    "SELECT transaction_id FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId]
  );
  if (linked.rowCount === 0) {
    return { ok: false, error: "link this record to a payment first" };
  }
  const applied = await applyMatch(
    client,
    ev,
    linked.rows.map((r) => r.transaction_id),
    await loadContext(client, me),
    "user",
    categoryId
  );
  if (applied.conflict) return { ok: false, error: applied.conflict };
  return {
    ok: true,
    displaced: applied.displaced,
    displacedAuthored: applied.displacedAuthored,
    backfilled: applied.backfilled,
    allocationsWritten: applied.allocationsWritten,
    partial: applied.partial,
    scaledDown: applied.scaledDown ?? false
  };
}
async function rederiveEvidence(client, evidenceId, me) {
  const found = await client.query(
    `SELECT ${EVIDENCE_COLUMNS} FROM evidence WHERE id = $1 AND source_type = $2`,
    [evidenceId, SOURCE]
  );
  const ev = found.rows[0];
  if (ev === void 0) return { ok: false, error: "no such record" };
  const linked = await client.query(
    "SELECT transaction_id FROM evidence_transactions WHERE evidence_id = $1",
    [evidenceId]
  );
  if (linked.rowCount === 0) {
    return { ok: true, displaced: 0, displacedAuthored: 0, backfilled: 0, allocationsWritten: 0, partial: false, scaledDown: false };
  }
  const applied = await applyMatch(
    client,
    ev,
    linked.rows.map((r) => r.transaction_id),
    await loadContext(client, me),
    "auto"
  );
  if (applied.conflict) return { ok: false, error: applied.conflict };
  return {
    ok: true,
    displaced: applied.displaced,
    displacedAuthored: applied.displacedAuthored,
    backfilled: applied.backfilled,
    allocationsWritten: applied.allocationsWritten,
    partial: applied.partial,
    scaledDown: applied.scaledDown ?? false
  };
}

// src/splitwise/splitwise.ts
var FIXED_COLUMNS = ["Date", "Description", "Category", "Cost", "Currency"];
var PERSON_COLUMN_START = FIXED_COLUMNS.length;
var PAYMENT_CATEGORY = "payment";
var FOOTER_DESCRIPTION = "total balance";
function tokenizeCsv(text) {
  if (text.charCodeAt(0) === 65279) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
          continue;
        }
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (inQuotes) return null;
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
function toPaise(raw) {
  const s = raw.trim();
  if (s === "") return null;
  if (!/^-?(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/.test(s)) return null;
  const negative = s.startsWith("-");
  const [whole, frac = ""] = (negative ? s.slice(1) : s).replace(/,/g, "").split(".");
  const paise2 = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return negative ? -paise2 : paise2;
}
function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = /* @__PURE__ */ new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function parseSplitwiseExport(csv, me) {
  const errors = [];
  const warnings = [];
  const table = tokenizeCsv(csv);
  if (table === null) {
    return { ok: false, errors: ["file ends inside a quoted field \u2014 it is truncated"] };
  }
  const lines = table.map((cells, index) => ({ cells, line: index + 1 })).filter(({ cells }) => cells.some((c) => c.trim() !== ""));
  if (lines.length === 0) return { ok: false, errors: ["file is empty"] };
  const header = lines[0].cells.map((c) => c.trim());
  for (const [i, want] of FIXED_COLUMNS.entries()) {
    if (header[i] !== want) {
      errors.push(
        `header column ${i + 1} is "${header[i] ?? ""}", expected "${want}" \u2014 this does not look like a Splitwise group export`
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const people = header.slice(PERSON_COLUMN_START).filter((n) => n !== "");
  if (people.length === 0) {
    return { ok: false, errors: ["header has no person columns after Currency"] };
  }
  const duplicates = people.filter((n, i) => people.indexOf(n) !== i);
  if (duplicates.length > 0) {
    errors.push(`duplicate person column(s): ${[...new Set(duplicates)].join(", ")}`);
  }
  const meIndex = people.indexOf(me.trim());
  if (meIndex === -1) {
    errors.push(`"${me}" is not a person in this export \u2014 found: ${people.join(", ")}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const rows = [];
  const balances = [];
  let footerSeen = false;
  let seq = 0;
  for (let i = 1; i < lines.length; i++) {
    const { cells: raw, line } = lines[i];
    const where = `line ${line}`;
    if (raw.length !== header.length) {
      errors.push(`${where}: has ${raw.length} columns, header has ${header.length}`);
      continue;
    }
    const cells = raw.map((c) => c.trim());
    const [date, description, category, cost, currency] = cells;
    const netCells = cells.slice(PERSON_COLUMN_START);
    if (description.toLowerCase() === FOOTER_DESCRIPTION) {
      if (footerSeen) {
        errors.push(`${where}: a second "Total balance" row`);
        continue;
      }
      footerSeen = true;
      if (i !== lines.length - 1) warnings.push(`${where}: "Total balance" is not the last row`);
      for (const [p, person] of people.entries()) {
        const v = toPaise(netCells[p]);
        if (v === null) {
          errors.push(`${where}: balance for ${person} is not a number`);
          continue;
        }
        balances.push({ person, balancePaise: v });
      }
      continue;
    }
    seq++;
    if (!isValidDate(date)) {
      errors.push(`${where}: "${date}" is not a valid YYYY-MM-DD date`);
      continue;
    }
    if (currency === "") {
      errors.push(`${where}: currency is blank`);
      continue;
    }
    const costPaise = toPaise(cost);
    if (costPaise === null || costPaise <= 0) {
      errors.push(`${where}: cost "${cost}" is not a positive amount`);
      continue;
    }
    const netsPaise = {};
    let netsOk = true;
    for (const [p, person] of people.entries()) {
      const v = toPaise(netCells[p]);
      if (v === null) {
        errors.push(`${where}: share for ${person} is "${netCells[p]}", not a number`);
        netsOk = false;
        break;
      }
      netsPaise[person] = v;
    }
    if (!netsOk) continue;
    const netSum = Object.values(netsPaise).reduce((a, b) => a + b, 0);
    if (Math.abs(netSum) > people.length) {
      errors.push(`${where}: shares sum to ${netSum} paise, expected 0 \u2014 the row is inconsistent`);
      continue;
    }
    const oversized = Object.entries(netsPaise).find(([, v]) => Math.abs(v) > costPaise);
    if (oversized) {
      errors.push(
        `${where}: ${oversized[0]}'s share ${oversized[1]} exceeds the cost ${costPaise} \u2014 impossible`
      );
      continue;
    }
    rows.push({
      seq,
      date,
      description,
      category,
      currency,
      costPaise,
      netsPaise,
      netPaise: netsPaise[people[meIndex]],
      kind: category.toLowerCase() === PAYMENT_CATEGORY ? "payment" : "expense"
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  if (!footerSeen) {
    warnings.push('no "Total balance" row \u2014 the per-person totals could not be verified');
  } else {
    for (const { person, balancePaise } of balances) {
      const summed = rows.reduce((acc, r) => acc + (r.netsPaise[person] ?? 0), 0);
      if (summed !== balancePaise) {
        warnings.push(
          `${person}: rows sum to ${summed} paise but the footer states ${balancePaise} (difference ${summed - balancePaise}) \u2014 rows may be missing or filtered`
        );
      }
    }
  }
  const currencies = new Set(rows.map((r) => r.currency));
  if (currencies.size > 1) {
    warnings.push(`mixed currencies (${[...currencies].join(", ")}) \u2014 amounts are not comparable`);
  }
  if (rows.length === 0) warnings.push("no expense or payment rows found");
  return { ok: true, data: { people, rows, balances, warnings } };
}

// src/splitwise/plan.ts
var MAX_GROUP_LENGTH = 64;
function normaliseGroup(raw) {
  const cleaned = raw.normalize("NFC").replace(new RegExp("\\p{Cc}", "gu"), "").replace(/\|/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return [...cleaned].slice(0, MAX_GROUP_LENGTH).join("").trim();
}
function externalRef(group, row) {
  return [
    normaliseGroup(group),
    row.date,
    row.description.trim().toLowerCase().replace(/\s+/g, " "),
    row.costPaise
  ].join("|");
}
function planImport(rows, group, map) {
  const key2 = normaliseGroup(group);
  const plan = {
    group: key2,
    evidence: [],
    consumption: [],
    unclassified: [],
    unmappedCategories: [],
    stats: { paid: 0, owedByMe: 0, notMine: 0, payments: 0 }
  };
  const unmapped = /* @__PURE__ */ new Set();
  for (const row of rows) {
    const ref = externalRef(key2, row);
    plan.evidence.push({
      externalRef: ref,
      date: row.date,
      description: row.description,
      sourceCategory: row.category,
      costPaise: row.costPaise,
      netPaise: row.netPaise,
      kind: row.kind,
      payload: {
        cost_paise: row.costPaise,
        nets_paise: row.netsPaise,
        currency: row.currency,
        source_category: row.category,
        kind: row.kind,
        // The SAME string the ref was built from. These were the two that disagreed.
        group: key2
      }
    });
    if (row.kind === "payment") {
      plan.stats.payments++;
      continue;
    }
    if (row.netPaise > 0) {
      plan.stats.paid++;
      continue;
    }
    if (row.netPaise === 0) {
      plan.stats.notMine++;
      continue;
    }
    plan.stats.owedByMe++;
    if (!map.has(row.category)) unmapped.add(row.category);
    const categoryId = map.get(row.category) ?? null;
    if (categoryId === null) {
      plan.unclassified.push({
        externalRef: ref,
        sourceCategory: row.category,
        amountPaise: row.netPaise
      });
      continue;
    }
    plan.consumption.push({
      externalRef: ref,
      categoryId,
      amountPaise: row.netPaise,
      // already negative: consumed
      consumedOn: row.date
    });
  }
  plan.unmappedCategories = [...unmapped].sort();
  return plan;
}

// src/evidence/import.ts
var SOURCE2 = "splitwise";
function detectSource(text) {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const cells = firstLine.split(",").map((c) => c.trim());
  const splitwise2 = ["Date", "Description", "Category", "Cost", "Currency"];
  if (splitwise2.every((want, i) => cells[i] === want)) return SOURCE2;
  return null;
}
async function importEvidenceFile(client, text, opts) {
  const source = detectSource(text);
  if (source === null) {
    return {
      ok: false,
      errors: [
        "this file was not recognised \u2014 expected a Splitwise group export (Date, Description, Category, Cost, Currency, then one column per person)"
      ]
    };
  }
  const parsed = parseSplitwiseExport(text, opts.me);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const mapRows = await client.query(
    "SELECT source_category, category_id FROM source_category_map WHERE source_type = $1",
    [SOURCE2]
  );
  const map = new Map(
    mapRows.rows.map((r) => [
      r.source_category,
      r.category_id === null ? null : Number(r.category_id)
    ])
  );
  const plan = planImport(parsed.data.rows, opts.group, map);
  for (const e of plan.evidence) {
    await client.query(
      `INSERT INTO evidence
         (source_type, external_ref, evidence_date, amount_paise, description, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (source_type, external_ref) WHERE external_ref IS NOT NULL DO UPDATE
          SET evidence_date = EXCLUDED.evidence_date,
              amount_paise  = EXCLUDED.amount_paise,
              description   = EXCLUDED.description,
              payload       = EXCLUDED.payload`,
      [SOURCE2, e.externalRef, e.date, e.costPaise, e.description, JSON.stringify(e.payload)]
    );
  }
  const replaced = await client.query(
    `DELETE FROM consumption con
      USING evidence ev
      WHERE con.evidence_id = ev.id
        AND con.source = 'evidence'
        AND ev.source_type = $1
        AND ev.payload->>'group' = $2`,
    [SOURCE2, plan.group]
  );
  for (const c of plan.consumption) {
    await client.query(
      `INSERT INTO consumption (evidence_id, category_id, amount_paise, consumed_on, source)
       SELECT id, $2, $3, $4, 'evidence' FROM evidence
        WHERE source_type = $1 AND external_ref = $5`,
      [SOURCE2, c.categoryId, c.amountPaise, c.consumedOn, c.externalRef]
    );
  }
  return {
    ok: true,
    outcome: {
      source: SOURCE2,
      group: plan.group,
      warnings: parsed.data.warnings,
      rows: parsed.data.rows.length,
      stats: plan.stats,
      evidenceWritten: plan.evidence.length,
      consumptionWritten: plan.consumption.length,
      consumptionReplaced: replaced.rowCount ?? 0,
      unclassified: {
        count: plan.unclassified.length,
        amountPaise: plan.unclassified.reduce((a, u) => a + u.amountPaise, 0)
      },
      unmappedCategories: plan.unmappedCategories
    }
  };
}

// src/receipts/artifacts.ts
import { createHash as createHash3 } from "node:crypto";
function sha256Hex(bytes) {
  return createHash3("sha256").update(bytes).digest("hex");
}
var PDF_MAGIC = Buffer.from("%PDF-", "ascii");
var ZIP_MAGIC = Buffer.from([80, 75, 3, 4]);
var TEXTUAL_MIMES = /* @__PURE__ */ new Set(["text/plain"]);
function startsWith(bytes, magic) {
  return bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic);
}
function isTextual(bytes) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
function sniffMime(bytes) {
  if (startsWith(bytes, PDF_MAGIC)) return "application/pdf";
  if (startsWith(bytes, ZIP_MAGIC)) return "application/zip";
  if (isTextual(bytes)) return "text/plain";
  return "application/octet-stream";
}
async function storeArtifact(client, input) {
  const contentHash = sha256Hex(input.bytes);
  const inserted = await client.query(
    `INSERT INTO artifacts (content_hash, bytes, byte_size, mime, original_name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (content_hash) DO NOTHING
     RETURNING id`,
    [contentHash, input.bytes, input.bytes.length, input.mime, input.originalName ?? null]
  );
  if (inserted.rowCount === 1) {
    return {
      id: inserted.rows[0].id,
      contentHash,
      mime: input.mime,
      byteSize: input.bytes.length,
      parseStatus: "pending",
      duplicate: false
    };
  }
  const existing = await client.query(
    "SELECT id, mime, byte_size, parse_status FROM artifacts WHERE content_hash = $1",
    [contentHash]
  );
  const row = existing.rows[0];
  return {
    id: row.id,
    contentHash,
    mime: row.mime,
    byteSize: row.byte_size,
    parseStatus: row.parse_status,
    duplicate: true
  };
}
async function setParseStatus(client, id, status, detail = {}) {
  await client.query(
    `UPDATE artifacts
        SET parse_status = $2,
            source_type  = COALESCE($3, source_type),
            external_ref = COALESCE($4, external_ref),
            parse_error  = $5,
            parsed_at    = CASE WHEN $2 = 'pending' THEN NULL ELSE now() END
      WHERE id = $1`,
    [id, status, detail.sourceType ?? null, detail.externalRef ?? null, detail.error ?? null]
  );
}
async function listArtifacts(client, opts) {
  const where = opts.status ? "WHERE parse_status = $3" : "";
  const params = [opts.limit, opts.offset];
  if (opts.status) params.push(opts.status);
  const rows = await client.query(
    `SELECT id, content_hash, mime, byte_size, original_name, source_type,
            parse_status, parse_error, external_ref, created_at
       FROM artifacts ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    params
  );
  const total = await client.query(
    `SELECT count(*)::text AS count FROM artifacts ${opts.status ? "WHERE parse_status = $1" : ""}`,
    opts.status ? [opts.status] : []
  );
  return { rows: rows.rows, total: Number(total.rows[0].count) };
}

// src/evidence/sources.ts
var splitwise = {
  sourceType: "splitwise",
  label: "Splitwise",
  unavailable() {
    return process.env.SPLITWISE_ME ? null : "SPLITWISE_ME is not set \u2014 it names your column in the export";
  },
  sweep(client) {
    return matchSplitwiseEvidence(client, process.env.SPLITWISE_ME);
  }
};
var amazon = {
  sourceType: "amazon",
  label: "Amazon invoices",
  unavailable: () => null,
  sweep: (client) => matchReceiptEvidence(client, "amazon")
};
var EVIDENCE_SOURCES = [splitwise, amazon];
async function rematchEvidence(client, sourceType) {
  const sources = sourceType ? EVIDENCE_SOURCES.filter((s) => s.sourceType === sourceType) : EVIDENCE_SOURCES;
  const results = [];
  for (const source of sources) {
    const skipped = source.unavailable();
    if (skipped !== null) {
      results.push({ sourceType: source.sourceType, label: source.label, ran: false, skipped });
      continue;
    }
    results.push({
      sourceType: source.sourceType,
      label: source.label,
      ran: true,
      summary: await source.sweep(client)
    });
  }
  return results;
}
function isKnownSource(sourceType) {
  return EVIDENCE_SOURCES.some((s) => s.sourceType === sourceType);
}

// src/receipts/intake.ts
var LABELS = {
  blinkit: "a Blinkit invoice",
  amazon: "an Amazon invoice"
};
var label = (t) => LABELS[t];
async function intakePdf(client, artifactId, bytes) {
  const extracted = await extractPdf(bytes);
  if (!extracted.ok) {
    await setParseStatus(client, artifactId, "failed", {
      error: `${extracted.kind}: ${extracted.error}`
    });
    return {
      status: "failed",
      template: null,
      pages: null,
      tables: null,
      message: extracted.error
    };
  }
  const doc = extracted.document;
  const pages = doc.page_count;
  const tables = doc.pages.reduce((n, p) => n + p.tables.length, 0);
  const template = detectReceiptTemplate(doc.pages.map((p) => p.text).join("\n"));
  if (template === null) {
    await setParseStatus(client, artifactId, "unsupported", {
      error: `extracted ${pages} page(s) but no merchant template was recognised`
    });
    return {
      status: "unsupported",
      template: null,
      pages,
      tables,
      message: `read ${pages} page(s) and ${tables} table(s), but this is not a template we recognise`
    };
  }
  if (!PARSERS_AVAILABLE[template]) {
    await setParseStatus(client, artifactId, "unsupported", {
      sourceType: template,
      error: `recognised as ${template}, but no parser exists yet`
    });
    return {
      status: "unsupported",
      template,
      pages,
      tables,
      message: `recognised as ${label(template)} \u2014 ${pages} page(s), ${tables} table(s) \u2014 waiting for a parser`
    };
  }
  if (extracted.record) {
    await stageRecord(client, artifactId, template, extracted.record);
    const lines = extracted.record.invoices.reduce((n, inv) => n + inv.lines.length, 0);
    return {
      status: "staged",
      template,
      pages,
      tables,
      externalRef: extracted.record.external_ref,
      totalPaise: extracted.record.total_paise,
      message: `read order ${extracted.record.external_ref} \u2014 ${lines} line(s), ${formatRupees(extracted.record.total_paise)} \u2014 waiting for you to confirm`
    };
  }
  const kind = extracted.parseError?.kind ?? "unknown";
  const needsCode = kind === "credit_note" || kind === "not_an_invoice";
  const status = needsCode ? "unsupported" : "failed";
  await setParseStatus(client, artifactId, status, {
    sourceType: template,
    error: `${kind}: ${extracted.parseError?.error ?? "the parser returned no record"}`
  });
  return {
    status,
    template,
    pages,
    tables,
    message: extracted.parseError?.error ?? "the parser returned no record"
  };
}
function formatRupees(paise2) {
  return `Rs ${(paise2 / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}
async function stageRecord(client, artifactId, template, record) {
  await client.query(
    `UPDATE artifacts
        SET parse_status = 'staged',
            source_type  = $2,
            external_ref = $3,
            record       = $4::jsonb,
            parse_error  = NULL,
            parsed_at    = now()
      WHERE id = $1`,
    [artifactId, template, record.external_ref, JSON.stringify(record)]
  );
}

// src/splitwise/source-categories.ts
var SOURCE3 = "splitwise";
async function listSourceCategories(client, me) {
  const result = await client.query(
    `WITH seen AS (
       SELECT ev.payload->>'source_category' AS source_category,
              COUNT(*)                                             AS records,
              COUNT(*) FILTER (WHERE ev.payload->>'kind' = 'expense'
                                 AND (ev.payload->'nets_paise'->>$2)::bigint < 0)
                                                                   AS consumed_records,
              COALESCE(SUM(ABS((ev.payload->'nets_paise'->>$2)::bigint))
                       FILTER (WHERE ev.payload->>'kind' = 'expense'
                                 AND (ev.payload->'nets_paise'->>$2)::bigint < 0), 0)
                                                                   AS consumed_paise
         FROM evidence ev
        WHERE ev.source_type = $1
        GROUP BY 1
     ),
     vocabulary AS (
       SELECT source_category FROM seen
       UNION
       SELECT source_category FROM source_category_map WHERE source_type = $1
     )
     SELECT v.source_category,
            m.category_id,
            c.name        AS category_name,
            p.name        AS parent_name,
            (m.source_category IS NOT NULL) AS decided,
            m.note,
            COALESCE(s.records, 0)          AS records,
            COALESCE(s.consumed_records, 0) AS consumed_records,
            COALESCE(s.consumed_paise, 0)   AS consumed_paise
       FROM vocabulary v
       -- LEFT, not INNER: vocabulary is the union of seen-and-decided, so a category that has
       -- been decided but has not arrived in any import yet has no seen row at all.
       LEFT JOIN seen s ON s.source_category = v.source_category
       LEFT JOIN source_category_map m
              ON m.source_type = $1 AND m.source_category = v.source_category
       LEFT JOIN categories c ON c.id = m.category_id
       LEFT JOIN categories p ON p.id = c.parent_id
      -- Undecided first, then by what they are worth: the order is the worklist.
      ORDER BY (m.source_category IS NOT NULL), COALESCE(s.consumed_paise, 0) DESC,
               v.source_category`,
    [SOURCE3, me]
  );
  return result.rows.map((r) => ({
    sourceCategory: r.source_category,
    categoryId: r.category_id === null ? null : Number(r.category_id),
    categoryName: r.category_name,
    parentName: r.parent_name,
    decided: r.decided,
    note: r.note,
    records: Number(r.records),
    consumedRecords: Number(r.consumed_records),
    consumedPaise: Number(r.consumed_paise)
  }));
}
async function remapSourceCategory(client, sourceCategory, categoryId, me, note) {
  const name = sourceCategory.trim();
  if (name === "") return { ok: false, error: "which source category?" };
  if (categoryId !== null) {
    const exists = await client.query("SELECT 1 FROM categories WHERE id = $1", [categoryId]);
    if (exists.rowCount === 0) return { ok: false, error: "no such category" };
  }
  await client.query(
    `INSERT INTO source_category_map (source_type, source_category, category_id, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_type, source_category)
     DO UPDATE SET category_id = EXCLUDED.category_id, note = EXCLUDED.note`,
    [SOURCE3, name, categoryId, note ?? null]
  );
  const removed = await client.query(
    `DELETE FROM consumption con
      USING evidence ev
      WHERE con.evidence_id = ev.id
        AND con.source = 'evidence'
        AND ev.source_type = $1
        AND ev.payload->>'source_category' = $2`,
    [SOURCE3, name]
  );
  let rebuilt = 0;
  if (categoryId !== null) {
    const inserted = await client.query(
      `INSERT INTO consumption (evidence_id, category_id, amount_paise, consumed_on, source)
       SELECT ev.id, $3, (ev.payload->'nets_paise'->>$4)::bigint, ev.evidence_date, 'evidence'
         FROM evidence ev
        WHERE ev.source_type = $1
          AND ev.payload->>'source_category' = $2
          AND ev.payload->>'kind' = 'expense'
          AND (ev.payload->'nets_paise'->>$4)::bigint < 0`,
      [SOURCE3, name, categoryId, me]
    );
    rebuilt = inserted.rowCount ?? 0;
  }
  const affected = await client.query(
    `SELECT COUNT(*) AS n FROM evidence
      WHERE source_type = $1 AND payload->>'source_category' = $2`,
    [SOURCE3, name]
  );
  return {
    ok: true,
    consumptionRebuilt: rebuilt,
    recordsAffected: Number(affected.rows[0].n),
    // Re-linking is done by the caller, which owns the writer — see routes/evidence.ts.
    relinked: removed.rowCount ?? 0
  };
}
async function evidenceNeedingRederive(client, sourceCategory) {
  const rows = await client.query(
    `SELECT DISTINCT ev.id
       FROM evidence ev
       JOIN evidence_transactions et ON et.evidence_id = ev.id
      WHERE ev.source_type = $1
        AND ev.payload->>'source_category' = $2
        AND NOT EXISTS (
          SELECT 1 FROM allocations a
           WHERE a.evidence_id = ev.id AND a.source = 'user'
        )`,
    [SOURCE3, sourceCategory.trim()]
  );
  return rows.rows.map((r) => r.id);
}

// src/filters.ts
var ALLOCATION_SOURCES = ["user", "rule", "evidence"];
var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}
function scalar(value) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
function positiveInt(value) {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function parseFilters(query, startIndex = 1) {
  const clauses = [];
  const params = [];
  let n = startIndex;
  const add2 = (fragment, ...values) => {
    clauses.push(fragment);
    params.push(...values);
  };
  const from = scalar(query.from);
  if (from !== null) {
    if (!isIsoDate(from)) return { ok: false, error: "from must be YYYY-MM-DD" };
    add2(`AND t.txn_date >= $${n++}`, from);
  }
  const to = scalar(query.to);
  if (to !== null) {
    if (!isIsoDate(to)) return { ok: false, error: "to must be YYYY-MM-DD" };
    add2(`AND t.txn_date <= $${n++}`, to);
  }
  if (from !== null && to !== null && from > to) {
    return { ok: false, error: "from must not be after to" };
  }
  const accountId = scalar(query.account_id);
  if (accountId !== null) {
    const id = positiveInt(accountId);
    if (id === null) {
      return { ok: false, error: "account_id must be a positive integer" };
    }
    add2(`AND t.account_id = $${n++}`, id);
  }
  const categoryId = scalar(query.category_id);
  if (categoryId !== null) {
    const id = positiveInt(categoryId);
    if (id === null) {
      return { ok: false, error: "category_id must be a positive integer" };
    }
    add2(
      `AND EXISTS (
           SELECT 1 FROM allocations al
             JOIN categories c ON c.id = al.category_id
            WHERE al.transaction_id = t.id
              AND (c.id = $${n} OR c.parent_id = $${n})
         )`,
      id
    );
    n++;
  }
  const ruleId = scalar(query.rule_id);
  if (ruleId !== null) {
    const id = positiveInt(ruleId);
    if (id === null) {
      return { ok: false, error: "rule_id must be a positive integer" };
    }
    add2(
      `AND EXISTS (
           SELECT 1 FROM allocations al
            WHERE al.transaction_id = t.id AND al.rule_id = $${n++}
         )`,
      id
    );
  }
  const source = scalar(query.source);
  if (source !== null) {
    if (source === "unexplained") {
      add2(
        `AND t.amount_paise <> COALESCE(
             (SELECT SUM(al.amount_paise) FROM allocations al
               WHERE al.transaction_id = t.id), 0)`
      );
    } else if (ALLOCATION_SOURCES.includes(source)) {
      add2(
        `AND EXISTS (
             SELECT 1 FROM allocations al
              WHERE al.transaction_id = t.id AND al.source = $${n++}
           )`,
        source
      );
    } else {
      return {
        ok: false,
        error: `source must be one of ${ALLOCATION_SOURCES.join(", ")}, unexplained`
      };
    }
  }
  const q = scalar(query.q);
  if (q !== null) {
    const escaped = q.replace(/([\\%_])/g, "\\$1");
    add2(`AND t.narration ILIKE $${n++}`, `%${escaped}%`);
  }
  const direction = scalar(query.direction);
  if (direction !== null) {
    if (direction === "out") add2("AND t.amount_paise < 0");
    else if (direction === "in") add2("AND t.amount_paise > 0");
    else return { ok: false, error: "direction must be out or in" };
  }
  const spendOnly = scalar(query.spend_only);
  if (spendOnly !== null && spendOnly !== "true" && spendOnly !== "false") {
    return { ok: false, error: "spend_only must be true or false" };
  }
  return {
    ok: true,
    sql: clauses.length === 0 ? "" : "\n  " + clauses.join("\n  "),
    params
  };
}
var DEFAULT_LIMIT = 100;
var MAX_LIMIT = 500;
function parsePaging(query) {
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  const rawLimit = scalar(query.limit);
  if (rawLimit !== null) {
    const parsed = positiveInt(rawLimit);
    if (parsed === null || parsed > MAX_LIMIT) {
      return { ok: false, error: `limit must be a positive integer <= ${MAX_LIMIT}` };
    }
    limit = parsed;
  }
  const rawOffset = scalar(query.offset);
  if (rawOffset !== null) {
    if (!/^\d+$/.test(rawOffset)) {
      return { ok: false, error: "offset must be a non-negative integer" };
    }
    const parsed = Number(rawOffset);
    if (!Number.isSafeInteger(parsed)) {
      return { ok: false, error: "offset must be a non-negative integer" };
    }
    offset = parsed;
  }
  return { ok: true, limit, offset };
}
function isSpendOnly(query) {
  return scalar(query.spend_only) === "true";
}

// src/routes/evidence.ts
var router3 = Router3();
var STATES = ["matched", "near", "conflicted", "unmatched"];
function owner() {
  const me = process.env.SPLITWISE_ME;
  if (!me) throw badRequest("SPLITWISE_ME is not set \u2014 it names your column in the export");
  return me;
}
function artifactView(artifact, parseStatus) {
  return {
    id: artifact.id,
    content_hash: artifact.contentHash,
    mime: artifact.mime,
    byte_size: artifact.byteSize,
    parse_status: parseStatus,
    // The artifact-level idempotency layer ("you already uploaded this exact file"), surfaced.
    // NOT the correctness boundary — the same order downloaded twice can differ byte-for-byte, so
    // `false` here does not mean the record is new. `evidence_source_ref_uniq` decides that.
    duplicate_bytes: artifact.duplicate
  };
}
router3.post("/evidence/import", route(async (req, res) => {
  const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (bytes.length === 0) return res.status(400).json({ error: "the file is empty" });
  const dryRun = req.query.dry_run === "1" || req.query.dry_run === "true";
  const mime = sniffMime(bytes);
  const originalName = typeof req.query.filename === "string" ? req.query.filename : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const artifact = await storeArtifact(client, { bytes, mime, originalName });
    if (mime === "application/pdf") {
      const intake = await intakePdf(client, artifact.id, bytes);
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
      return res.status(202).json({
        committed: !dryRun,
        artifact: artifactView(artifact, intake.status),
        template: intake.template,
        pages: intake.pages,
        tables: intake.tables,
        message: `stored \u2014 ${intake.message}`
      });
    }
    if (!TEXTUAL_MIMES.has(mime)) {
      await setParseStatus(client, artifact.id, "unsupported", {
        error: `no parser reads ${mime} yet`
      });
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
      return res.status(202).json({
        committed: !dryRun,
        artifact: artifactView(artifact, "unsupported"),
        message: `stored, but nothing parses ${mime} yet \u2014 it will be here when a parser is`
      });
    }
    const text = bytes.toString("utf8");
    const detected = detectSource(text);
    if (detected === null) {
      await setParseStatus(client, artifact.id, "unsupported", {
        error: "no parser recognised this file"
      });
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
      return res.status(202).json({
        committed: !dryRun,
        artifact: artifactView(artifact, "unsupported"),
        message: "stored, but this file was not recognised \u2014 expected a Splitwise group export (Date, Description, Category, Cost, Currency, then one column per person)"
      });
    }
    const rawGroup = req.query.group;
    if (typeof rawGroup !== "string") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "group is required \u2014 it is part of a record's identity" });
    }
    const group = normaliseGroup(rawGroup);
    if (group === "") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "group is required \u2014 it is part of a record's identity" });
    }
    const me = owner();
    const imported = await importEvidenceFile(client, text, { group, me });
    if (!imported.ok) {
      await client.query("ROLLBACK");
      return res.status(422).json({ errors: imported.errors });
    }
    await setParseStatus(client, artifact.id, "parsed", { sourceType: detected });
    const match = await matchSplitwiseEvidence(client, me);
    const nearMisses2 = await listNearMisses(client, me);
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return res.status(dryRun ? 200 : 201).json({
      committed: !dryRun,
      artifact: artifactView(artifact, "parsed"),
      imported: imported.outcome,
      match,
      near_misses: nearMisses2
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    client.release();
  }
}));
router3.post("/evidence/rematch", route(async (req, res) => {
  const dryRun = req.query.dry_run === "1" || req.query.dry_run === "true";
  const raw = req.query.source_type;
  let sourceType;
  if (typeof raw === "string" && raw !== "") {
    if (!isKnownSource(raw)) throw badRequest(`unknown source_type: ${raw}`);
    sourceType = raw;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const results = await rematchEvidence(client, sourceType);
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return res.json({ committed: !dryRun, sources: results });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    client.release();
  }
}));
router3.get("/evidence/artifacts", route(async (req, res) => {
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });
  const raw = req.query.status;
  const STATUSES = ["pending", "parsed", "unsupported", "failed"];
  let status;
  if (typeof raw === "string" && raw !== "") {
    if (!STATUSES.includes(raw)) throw badRequest(`unknown status: ${raw}`);
    status = raw;
  }
  const client = await pool.connect();
  try {
    const { rows, total } = await listArtifacts(client, {
      status,
      limit: paging.limit,
      offset: paging.offset
    });
    return res.json({ artifacts: rows, total, limit: paging.limit, offset: paging.offset });
  } finally {
    client.release();
  }
}));
router3.post("/evidence/artifacts/:id/reparse", route(async (req, res) => {
  const id = intParam(req.params.id, "id");
  const dryRun = req.query.dry_run === "1" || req.query.dry_run === "true";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query(
      "SELECT id, bytes, mime FROM artifacts WHERE id = $1",
      [id]
    );
    if (row.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: `no artifact ${id}` });
    }
    const artifact = row.rows[0];
    if (artifact.mime !== "application/pdf") {
      await client.query("ROLLBACK");
      return res.status(422).json({
        error: `re-parse handles PDFs; this artifact is ${artifact.mime}. Re-upload a text export with ?group= instead \u2014 the group is part of a record's identity.`
      });
    }
    const intake = await intakePdf(client, artifact.id, artifact.bytes);
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return res.json({
      committed: !dryRun,
      artifact_id: artifact.id,
      parse_status: intake.status,
      template: intake.template,
      pages: intake.pages,
      tables: intake.tables,
      message: intake.message
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw err;
  } finally {
    client.release();
  }
}));
router3.get("/evidence/staged", route(async (req, res) => {
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });
  const attentionOnly = req.query.attention === "1" || req.query.attention === "true";
  const client = await pool.connect();
  try {
    const staged = await listStaged(client, {
      limit: paging.limit,
      offset: paging.offset,
      attentionOnly
    });
    return res.json({ ...staged, limit: paging.limit, offset: paging.offset });
  } finally {
    client.release();
  }
}));
router3.get("/evidence/staged/items", route(async (req, res) => {
  const q = typeof req.query.q === "string" && req.query.q.trim() !== "" ? req.query.q : void 0;
  const needsInputOnly = req.query.needs_input === "1" || req.query.needs_input === "true";
  const client = await pool.connect();
  try {
    return res.json(await listStagedItems(client, { q, needsInputOnly }));
  } finally {
    client.release();
  }
}));
router3.post("/evidence/staged/confirm", route(async (req, res) => {
  const body = req.body;
  const ids = body?.artifact_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw badRequest("artifact_ids must be a non-empty array");
  }
  if (ids.length > 500) throw badRequest("confirm at most 500 orders at a time");
  const overrides = body.overrides ?? {};
  const result = { landed: [], skipped: [], errors: [] };
  for (const raw of ids) {
    const id = String(raw);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const landed = await confirmOne(client, id, overrides);
      await client.query("COMMIT");
      result.landed.push({ artifact_id: id, ...landed });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not staged")) result.skipped.push({ artifact_id: id, reason: message });
      else result.errors.push({ artifact_id: id, error: message });
    } finally {
      client.release();
    }
  }
  return res.json(result);
}));
router3.get("/evidence/near-misses", route(async (_req, res) => {
  const client = await pool.connect();
  try {
    return res.status(200).json({ near_misses: await listNearMisses(client, owner()) });
  } finally {
    client.release();
  }
}));
router3.get("/evidence/unmatched", route(async (_req, res) => {
  const client = await pool.connect();
  try {
    return res.status(200).json({ unmatched: await listUnmatched(client, owner(), false) });
  } finally {
    client.release();
  }
}));
router3.post("/evidence/:id/match", route(async (req, res) => {
  const body = req.body ?? {};
  const raw = Array.isArray(body.transaction_ids) ? body.transaction_ids : body.transaction_id !== void 0 ? [body.transaction_id] : [];
  if (raw.length === 0) {
    return res.status(400).json({ error: "transaction_ids is required" });
  }
  const ids = raw.map((v) => String(v));
  if (!ids.every((v) => /^\d+$/.test(v))) {
    return res.status(400).json({ error: "transaction_ids must be positive integers" });
  }
  const evidenceId = intParam(req.params.id, "evidence id");
  const rawCategory = body.category_id;
  if (rawCategory !== void 0 && rawCategory !== null && !/^\d+$/.test(String(rawCategory))) {
    return res.status(400).json({ error: "category_id must be a positive integer" });
  }
  const categoryId = rawCategory === void 0 || rawCategory === null ? null : String(rawCategory);
  let result;
  try {
    result = await withTransaction(
      async (client) => await isReceipt(client, String(evidenceId)) ? linkReceipt(client, String(evidenceId), ids) : linkEvidence(client, String(evidenceId), ids, owner(), categoryId)
    );
  } catch (err) {
    if (err instanceof ReceiptLinkRefused) return res.status(409).json({ error: err.message });
    throw err;
  }
  if (!result.ok) return res.status(409).json({ error: result.error });
  return res.status(200).json(result);
}));
router3.get("/evidence/imports", route(async (_req, res) => {
  const client = await pool.connect();
  try {
    const imports = [...await listImports(client, owner()), ...await listReceiptImports(client)].sort((a, b) => b.lastImportedAt.localeCompare(a.lastImportedAt));
    return res.status(200).json({ imports });
  } finally {
    client.release();
  }
}));
router3.get("/evidence/records", route(async (req, res) => {
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });
  const rawState = req.query.state;
  if (rawState !== void 0 && !STATES.includes(rawState)) {
    return res.status(400).json({ error: `state must be one of ${STATES.join(", ")}` });
  }
  const rawGroup = req.query.group;
  if (rawGroup !== void 0 && typeof rawGroup !== "string") {
    return res.status(400).json({ error: "group must be a string" });
  }
  const group = rawGroup === void 0 ? void 0 : normaliseGroup(rawGroup);
  const rawSource = req.query.source;
  if (rawSource !== void 0 && (typeof rawSource !== "string" || !/^[a-z0-9-]+$/.test(rawSource))) {
    return res.status(400).json({ error: "source must be a source key like amazon" });
  }
  const receiptSource = rawSource !== void 0 && rawSource !== "splitwise" ? rawSource : null;
  const client = await pool.connect();
  try {
    const all = receiptSource !== null ? await listReceiptRecords(client, {
      source: receiptSource,
      state: rawState
    }) : await listRecords(client, owner(), {
      group,
      state: rawState
    });
    return res.status(200).json({
      records: all.slice(paging.offset, paging.offset + paging.limit),
      total: all.length,
      limit: paging.limit,
      offset: paging.offset
    });
  } finally {
    client.release();
  }
}));
router3.delete("/evidence/:id/match", route(async (req, res) => {
  const evidenceId = intParam(req.params.id, "evidence id");
  const result = await withTransaction(
    async (client) => await isReceipt(client, String(evidenceId)) ? unlinkReceipt(client, String(evidenceId)) : unlinkEvidence(client, String(evidenceId))
  );
  if (!result.ok) {
    return res.status(result.error === "no such record" ? 404 : 409).json({ error: result.error });
  }
  return res.status(200).json(result);
}));
router3.post("/evidence/:id/category", route(async (req, res) => {
  const evidenceId = intParam(req.params.id, "evidence id");
  const raw = req.body?.category_id;
  if (raw === void 0 || raw === null || !/^\d+$/.test(String(raw))) {
    return res.status(400).json({ error: "category_id must be a positive integer" });
  }
  const result = await withTransaction(
    (client) => categoriseEvidence(client, String(evidenceId), String(raw), owner())
  );
  if (!result.ok) {
    return res.status(result.error === "no such record" ? 404 : 409).json({ error: result.error });
  }
  return res.status(200).json(result);
}));
router3.get("/evidence/categories", route(async (_req, res) => {
  const client = await pool.connect();
  try {
    return res.status(200).json({ categories: await listSourceCategories(client, owner()) });
  } finally {
    client.release();
  }
}));
router3.post("/evidence/categories", route(async (req, res) => {
  const body = req.body ?? {};
  const sourceCategory = typeof body.source_category === "string" ? body.source_category : "";
  if (sourceCategory.trim() === "") {
    return res.status(400).json({ error: "source_category is required" });
  }
  const raw = body.category_id;
  if (raw !== null && !/^\d+$/.test(String(raw ?? ""))) {
    return res.status(400).json({ error: "category_id must be a positive integer, or null" });
  }
  const categoryId = raw === null ? null : Number(raw);
  const note = typeof body.note === "string" ? body.note : void 0;
  const me = owner();
  const result = await withTransaction(async (client) => {
    const stale = await evidenceNeedingRederive(client, sourceCategory);
    const remapped = await remapSourceCategory(client, sourceCategory, categoryId, me, note);
    if (!remapped.ok) return remapped;
    let relinked = 0;
    const refused = [];
    for (const id of stale) {
      const again = await rederiveEvidence(client, id, me);
      if (again.ok) relinked++;
      else refused.push(again.error);
    }
    return { ...remapped, relinked, refused };
  });
  if (!result.ok) {
    return res.status(result.error === "no such category" ? 404 : 400).json({ error: result.error });
  }
  return res.status(200).json(result);
}));

// src/routes/items.ts
import { Router as Router4 } from "express";
var router4 = Router4();
var CATEGORY_SOURCES = ["user", "llm", "seed", "hsn"];
router4.get("/items", route(async (req, res) => {
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });
  const q = typeof req.query.q === "string" && req.query.q.trim() !== "" ? req.query.q.trim() : void 0;
  const unclassifiedOnly = req.query.unclassified === "1" || req.query.unclassified === "true";
  const client = await pool.connect();
  try {
    const { rows, total } = await listItems(client, {
      q,
      unclassifiedOnly,
      limit: paging.limit,
      offset: paging.offset
    });
    return res.json({ items: rows, total, limit: paging.limit, offset: paging.offset });
  } finally {
    client.release();
  }
}));
router4.get("/items/stats", route(async (_req, res) => {
  const client = await pool.connect();
  try {
    return res.json(await itemStats(client));
  } finally {
    client.release();
  }
}));
router4.get("/items/proposals", route(async (req, res) => {
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });
  const raw = req.query.status;
  const status = typeof raw === "string" && raw !== "" ? raw : "open";
  if (!["open", "accepted", "rejected"].includes(status)) {
    throw badRequest(`unknown status: ${status}`);
  }
  const client = await pool.connect();
  try {
    const { rows, total } = await listProposals(client, {
      status,
      limit: paging.limit,
      offset: paging.offset
    });
    return res.json({ proposals: rows, total, limit: paging.limit, offset: paging.offset });
  } finally {
    client.release();
  }
}));
router4.get("/items/:id", route(async (req, res) => {
  const id = intParam(req.params.id, "id");
  const client = await pool.connect();
  try {
    const item = await getItem(client, id);
    if (item === null) throw notFound(`no item ${id}`);
    return res.json(item);
  } finally {
    client.release();
  }
}));
router4.post("/items/resolve", route(async (req, res) => {
  const body = req.body;
  if (typeof body?.source_type !== "string" || body.source_type.trim() === "") {
    throw badRequest("source_type is required");
  }
  if (typeof body?.description !== "string" || body.description.trim() === "") {
    throw badRequest("description is required");
  }
  let sku = null;
  if (body.sku != null) {
    const kind = body.sku.kind;
    const value = body.sku.value;
    if (kind !== "asin" && kind !== "upc") throw badRequest("sku.kind must be 'asin' or 'upc'");
    if (typeof value !== "string" || value.trim() === "") throw badRequest("sku.value is required");
    sku = { kind, value: value.trim() };
  }
  const result = await withTransaction(
    (client) => resolveAndRecord(client, {
      sourceType: body.source_type,
      description: body.description,
      sku
    })
  );
  return res.status(result.created ? 201 : 200).json(result);
}));
router4.patch("/items/:id", route(async (req, res) => {
  const id = intParam(req.params.id, "id");
  const body = req.body;
  if (!("category_id" in body) && !("display_name" in body)) {
    throw badRequest("nothing to change \u2014 send category_id and/or display_name");
  }
  return withTransaction(async (client) => {
    if ("category_id" in body) {
      const raw = body.category_id;
      let categoryId = null;
      if (raw !== null) {
        if (typeof raw !== "number" || !Number.isInteger(raw)) {
          throw badRequest("category_id must be an integer or null");
        }
        categoryId = raw;
      }
      const source = body.category_source ?? "user";
      if (!CATEGORY_SOURCES.includes(source)) {
        throw badRequest(`category_source must be one of ${CATEGORY_SOURCES.join(", ")}`);
      }
      if (categoryId !== null) {
        const exists = await client.query("SELECT 1 FROM categories WHERE id = $1", [categoryId]);
        if (exists.rowCount === 0) throw badRequest(`no category ${categoryId}`);
      }
      const ok = await setItemCategory(client, id, categoryId, source, categoryId === null ? null : 100);
      if (!ok) throw notFound(`no item ${id}`);
    }
    if ("display_name" in body) {
      if (typeof body.display_name !== "string" || body.display_name.trim() === "") {
        throw badRequest("display_name must be a non-empty string");
      }
      const r = await client.query(
        "UPDATE items SET display_name = $2, updated_at = now() WHERE id = $1",
        [id, body.display_name.trim()]
      );
      if (r.rowCount === 0) throw notFound(`no item ${id}`);
    }
    const rederived = "category_id" in body ? await rederiveForItems(client, [id]) : emptyResult();
    return res.json({ ...await getItem(client, id), rederived });
  });
}));
router4.post("/items/category", route(async (req, res) => {
  const body = req.body;
  if (!("category_id" in body)) throw badRequest("category_id is required (null clears it)");
  const raw = body.category_id;
  let categoryId = null;
  if (raw !== null) {
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      throw badRequest("category_id must be an integer or null");
    }
    categoryId = raw;
  }
  let itemIds;
  if (body.item_ids !== void 0) {
    if (!Array.isArray(body.item_ids) || body.item_ids.length === 0) {
      throw badRequest("item_ids must be a non-empty array");
    }
    itemIds = body.item_ids.map((v) => {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isInteger(n)) throw badRequest("item_ids must be integers");
      return n;
    });
  }
  const q = typeof body.q === "string" && body.q.trim() !== "" ? body.q.trim() : void 0;
  const unclassifiedOnly = body.unclassified === true;
  if (itemIds === void 0 && q === void 0 && !unclassifiedOnly) {
    throw badRequest("send item_ids, or a filter \u2014 refusing to file the whole catalogue");
  }
  return withTransaction(async (client) => {
    if (categoryId !== null) {
      const exists = await client.query("SELECT 1 FROM categories WHERE id = $1", [categoryId]);
      if (exists.rowCount === 0) throw badRequest(`no category ${categoryId}`);
    }
    const filed = await setCategoryForMany(client, { categoryId, itemIds, q, unclassifiedOnly });
    const rederived = await rederiveForItems(client, filed.itemIds);
    return res.json({ filed: filed.count, rederived });
  });
}));
router4.post("/items/:id/merge", route(async (req, res) => {
  const keeperId = intParam(req.params.id, "id");
  const raw = req.body?.merge_item_id;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw badRequest("merge_item_id must be an integer");
  }
  const result = await withTransaction((client) => mergeItems(client, keeperId, raw));
  if (!result.ok) throw badRequest(result.error ?? "merge failed");
  return res.json({ keeper_item_id: String(keeperId), merged_item_id: String(raw), aliases_moved: result.aliasesMoved });
}));
router4.post("/items/proposals/:id/accept", route(async (req, res) => {
  const id = intParam(req.params.id, "id");
  return withTransaction(async (client) => {
    const proposal = await getProposal(client, id);
    if (proposal === null) throw notFound(`no proposal ${id}`);
    if (proposal.status !== "open") throw badRequest(`proposal ${id} is already ${proposal.status}`);
    const result = await mergeItems(client, Number(proposal.lo_item_id), Number(proposal.hi_item_id));
    if (!result.ok) throw badRequest(result.error ?? "merge failed");
    const rederived = await rederiveForItems(client, [
      Number(proposal.lo_item_id),
      Number(proposal.hi_item_id)
    ]);
    return res.json({
      rederived,
      keeper_item_id: proposal.lo_item_id,
      merged_item_id: proposal.hi_item_id,
      aliases_moved: result.aliasesMoved
    });
  });
}));
router4.post("/items/proposals/:id/reject", route(async (req, res) => {
  const id = intParam(req.params.id, "id");
  return withTransaction(async (client) => {
    const ok = await rejectProposal(client, id);
    if (!ok) throw notFound(`no OPEN proposal ${id}`);
    return res.json({ id: String(id), status: "rejected" });
  });
}));

// src/routes/parse.ts
import { Router as Router5 } from "express";
var router5 = Router5();
var CANDIDATE_SQL = `
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
router5.get("/evidence/llm-parse/candidates", route(async (_req, res) => {
  if (DEMO_MODE) {
    return res.json({
      candidates: [],
      total: 0,
      fresh: 0,
      retryable: 0,
      model: RECEIPT_LLM.model,
      median_seconds: null,
      estimate_seconds: null
    });
  }
  const rows = await pool.query(
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
        ) last ON true`
    )}
     ORDER BY a.created_at DESC`
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
    last_failure: r.last_at === null ? null : {
      kind: r.last_kind,
      reason: isErrorKind(r.last_kind) ? explain(r.last_kind) : r.last_kind,
      detail: r.last_detail,
      at: r.last_at
    }
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
    estimate_seconds: median === null ? null : Math.round(fresh * median)
  });
}));
router5.post("/evidence/llm-parse", route(async (req, res) => {
  if (DEMO_MODE) {
    return res.status(501).json({
      error: "Reading documents with a model runs on YOUR machine \u2014 that is the privacy design, so it is unavailable in the hosted demo. Run Khata locally with Ollama to try it."
    });
  }
  const body = req.body ?? {};
  const wantsAll = body.all === true;
  const ids = body.artifact_ids;
  if (!wantsAll && !Array.isArray(ids)) {
    throw badRequest("pass `artifact_ids`, or `all: true` to queue every candidate");
  }
  if (Array.isArray(ids) && ids.length === 0) {
    throw badRequest("`artifact_ids` was empty \u2014 nothing to queue");
  }
  if (Array.isArray(ids) && !ids.every((id) => typeof id === "string" && /^\d+$/.test(id))) {
    throw badRequest("every artifact id must be a numeric string");
  }
  const result = await withTransaction(async (client) => {
    const rows = await client.query(
      wantsAll ? `SELECT a.id ${CANDIDATE_SQL} ORDER BY a.created_at DESC` : `SELECT a.id ${CANDIDATE_SQL} AND a.id = ANY($1::bigint[]) ORDER BY a.created_at DESC`,
      wantsAll ? [] : [ids.map(String)]
    );
    if (rows.rowCount === 0) return null;
    const enq = await enqueueBatch(client, "llm_receipt", rows.rows.map((r) => r.id));
    return enq;
  });
  if (result === null) {
    return res.status(409).json({
      error: "nothing to queue \u2014 every document named is already readable, staged, or in flight"
    });
  }
  const median = await medianJobSeconds();
  return res.status(201).json({
    batch_id: result.batchId,
    queued: result.enqueued,
    skipped: result.alreadyQueued,
    consented: false,
    estimate_seconds: median === null ? null : Math.round(result.enqueued * median),
    message: `${result.enqueued} document(s) will be read by the local model. Nothing leaves this machine. Confirm to start.`
  });
}));
router5.post("/evidence/llm-parse/:batchId/consent", route(async (req, res) => {
  const batchId = String(intParam(req.params.batchId, "batch id"));
  const started = await withTransaction(async (client) => {
    const exists = await client.query("SELECT 1 FROM parse_batches WHERE id = $1", [batchId]);
    if (exists.rowCount === 0) throw notFound("no such batch");
    return consent(client, batchId);
  });
  return res.json({ batch_id: batchId, consented: true, already: !started });
}));
router5.get("/evidence/parse-progress", route(async (_req, res) => {
  const batches = await listActiveBatches(10);
  const median = await medianJobSeconds();
  const failures = await pool.query(
    `SELECT j.batch_id, j.artifact_id, a.original_name, j.error_kind, j.error_detail
       FROM parse_jobs j
       JOIN artifacts a ON a.id = j.artifact_id
      WHERE j.state = 'failed'
        AND j.batch_id = ANY($1::bigint[])
      ORDER BY j.finished_at DESC
      LIMIT 100`,
    [batches.map((b) => b.batchId)]
  );
  const running = await pool.query(
    `SELECT j.batch_id, a.original_name, j.attempts, j.started_at
       FROM parse_jobs j
       JOIN artifacts a ON a.id = j.artifact_id
      WHERE j.state = 'running' AND j.batch_id = ANY($1::bigint[])`,
    [batches.map((b) => b.batchId)]
  );
  return res.json({
    batches: batches.map((b) => ({
      ...b,
      estimate_seconds: median === null ? null : Math.round((b.queued + b.running) * median),
      reading: running.rows.filter((r) => r.batch_id === b.batchId).map((r) => ({ original_name: r.original_name, attempt: Number(r.attempts), started_at: r.started_at })),
      failures: failures.rows.filter((f) => f.batch_id === b.batchId).map((f) => ({
        artifact_id: f.artifact_id,
        original_name: f.original_name,
        kind: f.error_kind,
        reason: isErrorKind(f.error_kind) ? explain(f.error_kind) : f.error_kind,
        detail: f.error_detail
      }))
    })),
    median_seconds: median
  });
}));
async function medianJobSeconds() {
  const res = await pool.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (
              ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at))
            ) AS median
       FROM parse_jobs
      WHERE state = 'done' AND started_at IS NOT NULL AND finished_at IS NOT NULL`
  );
  const median = res.rows[0]?.median;
  if (median === null || median === void 0) return null;
  const n = Number(median);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// src/routes/reports.ts
import { Router as Router6 } from "express";

// src/consumption.ts
var CONSUMPTION_ROWS = `
    -- 1. Consumption you PAID FOR, already sliced as allocations.
    --    excluded_from_spend removes the shared bucket: the part of a bill you fronted
    --    for other people is money that moved, and is not something you consumed. That
    --    flag is why this is a join on categories rather than a hardcoded category name \u2014
    --    a name matched in code is a lexical trap (a category named "debit" matches every
    --    narration that says "UPI-Debit").
    SELECT t.txn_date AS consumed_on, al.category_id, al.amount_paise,
           t.account_id, 'bank'::text AS kind, t.id AS transaction_id,
           NULL::bigint AS evidence_id, t.narration AS detail, al.source
      FROM allocations al
      JOIN transactions t   ON t.id = al.transaction_id
      JOIN categories cat   ON cat.id = al.category_id
      LEFT JOIN categories par ON par.id = cat.parent_id
     -- The flag counts on the category OR ITS PARENT. Allocations point at leaves
     -- (Income > Salary, Transfers > Shared), so checking only the leaf would mean
     -- flagging a parent did nothing, and every child added later would have to be
     -- remembered separately. Flagging the parent covers the subtree, now and in future.
     WHERE NOT cat.excluded_from_spend
       AND NOT COALESCE(par.excluded_from_spend, false)
       AND ${EXPLAINABLE_SPEND}

    UNION ALL

    -- 2. Consumption SOMEONE ELSE paid for. No transaction exists, which is the whole
    --    reason this table is separate from allocations \u2014 see the migration comment in
    --    005_consumption.sql for why a nullable allocations.transaction_id was rejected.
    SELECT con.consumed_on, con.category_id, con.amount_paise,
           NULL::bigint AS account_id, 'paid_for_you'::text AS kind, NULL::bigint AS transaction_id,
           con.evidence_id, ev.description AS detail, con.source
      FROM consumption con
      LEFT JOIN evidence ev ON ev.id = con.evidence_id
`;
function unaccounted(t) {
  return t.consumed_paise - (t.money_out_paise - t.unexplained_paise - t.fronted_paise + t.paid_for_you_paise - t.received_paise);
}

// src/routes/reports.ts
var router6 = Router6();
router6.get("/reports/by-category", route(async (req, res) => {
  const filters = parseFilters(req.query, 1);
  if (!filters.ok) return res.status(400).json({ error: filters.error });
  const where = `WHERE ${EXPLAINABLE_SPEND} ${filters.sql}`;
  const byCategory = await pool.query(
    `SELECT c.id, c.name, c.parent_id, p.name AS parent_name,
              COALESCE(SUM(al.amount_paise) FILTER (WHERE al.source = 'user'), 0)     AS confirmed_paise,
              COALESCE(SUM(al.amount_paise) FILTER (WHERE al.source = 'rule'), 0)     AS provisional_paise,
              COALESCE(SUM(al.amount_paise) FILTER (WHERE al.source = 'evidence'), 0) AS evidence_paise,
              COALESCE(SUM(al.amount_paise), 0)                                       AS total_paise,
              COUNT(DISTINCT al.transaction_id)                                       AS transactions
         FROM allocations al
         JOIN transactions t ON t.id = al.transaction_id
         JOIN categories c ON c.id = al.category_id
         LEFT JOIN categories p ON p.id = c.parent_id
         ${where}
        GROUP BY c.id, p.name
        ORDER BY SUM(ABS(al.amount_paise)) DESC`,
    filters.params
  );
  const totals = await pool.query(
    `WITH per_txn AS (
         SELECT t.id, t.amount_paise,
                COALESCE(SUM(al.amount_paise), 0) AS explained
           FROM transactions t
           LEFT JOIN allocations al ON al.transaction_id = t.id
           ${where}
          GROUP BY t.id
       )
       SELECT COALESCE(SUM(amount_paise) FILTER (WHERE amount_paise < 0), 0) AS out_paise,
              COALESCE(SUM(amount_paise) FILTER (WHERE amount_paise > 0), 0) AS in_paise,
              -- ABS per transaction BEFORE summing: an unexplained 500 debit and an
              -- unexplained 500 credit are 1000 unexplained, not zero.
              COALESCE(SUM(ABS(amount_paise - explained)), 0)                AS unexplained_paise,
              -- Split by direction. The summary tiles compare against "money out", and
              -- mixing an unexplained salary credit into that total makes four numbers
              -- that look like they should reconcile and cannot.
              COALESCE(SUM(ABS(amount_paise - explained))
                       FILTER (WHERE amount_paise < 0), 0)                   AS unexplained_out_paise,
              COALESCE(SUM(ABS(amount_paise - explained))
                       FILTER (WHERE amount_paise > 0), 0)                   AS unexplained_in_paise,
              COUNT(*)                                                        AS transactions
         FROM per_txn`,
    filters.params
  );
  const t = totals.rows[0];
  res.json({
    categories: byCategory.rows.map((r) => ({
      category_id: Number(r.id),
      category_name: r.name,
      parent_id: r.parent_id === null ? null : Number(r.parent_id),
      parent_name: r.parent_name,
      confirmed_paise: Number(r.confirmed_paise),
      provisional_paise: Number(r.provisional_paise),
      evidence_paise: Number(r.evidence_paise),
      total_paise: Number(r.total_paise),
      transactions: Number(r.transactions)
    })),
    out_paise: Number(t.out_paise),
    in_paise: Number(t.in_paise),
    unexplained_paise: Number(t.unexplained_paise),
    unexplained_out_paise: Number(t.unexplained_out_paise),
    unexplained_in_paise: Number(t.unexplained_in_paise),
    transactions: Number(t.transactions)
  });
}));
router6.get("/reports/by-rule", route(async (req, res) => {
  const filters = parseFilters(req.query, 1);
  if (!filters.ok) return res.status(400).json({ error: filters.error });
  const spendClause = isSpendOnly(req.query) ? `AND ${EXPLAINABLE_SPEND}` : "";
  const result = await pool.query(
    `SELECT r.id, r.name, r.conditions, r.match_mode, r.category_id,
              c.name AS category_name, r.priority, r.enabled,
              COUNT(x.allocation_id)                       AS allocations,
              COUNT(DISTINCT x.transaction_id)             AS transactions,
              COALESCE(SUM(ABS(x.amount_paise)), 0)        AS money_paise,
              COALESCE(SUM(x.amount_paise), 0)             AS net_paise,
              -- Split so a rule can say how much of its work is still a guess and how much
              -- you have claimed. Same total, two states \u2014 the whole point of the model.
              COUNT(x.allocation_id) FILTER (WHERE x.source = 'rule') AS provisional_allocations,
              COUNT(x.allocation_id) FILTER (WHERE x.source = 'user') AS confirmed_allocations,
              MIN(x.txn_date)                              AS first_seen,
              MAX(x.txn_date)                              AS last_seen
         FROM rules r
         LEFT JOIN categories c ON c.id = r.category_id
         LEFT JOIN (
           -- A rule's impact is everything it EXPLAINED, whether or not you have since
           -- claimed it. Counting only source='rule' made a heavily-confirmed ledger
           -- report every rule as dead: confirming nulls rule_id, so 253 confirmations in
           -- one action took all 20 rules to zero. The work happened; it was just claimed.
           --
           -- COALESCE picks whichever link the row carries \u2014 rule_id while the engine owns
           -- it, confirmed_from_rule_id once a human has. The two are mutually exclusive by
           -- CHECK, so no row is ever counted twice.
           SELECT al.id AS allocation_id,
                  COALESCE(al.rule_id, al.confirmed_from_rule_id) AS rule_id,
                  al.source, al.amount_paise, al.transaction_id, t.txn_date
             FROM allocations al
             JOIN transactions t ON t.id = al.transaction_id
            WHERE (al.source = 'rule' OR al.confirmed_from_rule_id IS NOT NULL)
                  ${spendClause} ${filters.sql}
         ) x ON x.rule_id = r.id
        GROUP BY r.id, c.name
        ORDER BY COALESCE(SUM(ABS(x.amount_paise)), 0) DESC, r.id ASC`,
    filters.params
  );
  const rules = result.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    conditions: r.conditions,
    match_mode: r.match_mode,
    category_id: r.category_id === null ? null : Number(r.category_id),
    category_name: r.category_name,
    priority: Number(r.priority),
    enabled: r.enabled,
    // COUNT returns BIGINT, so these arrive as strings like every other BIGINT.
    allocations: Number(r.allocations),
    transactions: Number(r.transactions),
    provisional_allocations: Number(r.provisional_allocations),
    confirmed_allocations: Number(r.confirmed_allocations),
    money_paise: Number(r.money_paise),
    // magnitude — "how much did this touch"
    net_paise: Number(r.net_paise),
    // signed — separates an income rule from a spend one
    first_seen: r.first_seen,
    last_seen: r.last_seen
  }));
  res.json({ rules });
}));
router6.get("/summary", route(async (_req, res) => {
  const result = await pool.query(
    `WITH per_txn AS (
         SELECT t.id, t.amount_paise, t.type, t.transfer_status,
                COALESCE(SUM(al.amount_paise), 0) AS explained,
                COALESCE(
                  SUM(al.amount_paise) FILTER (WHERE al.source = 'rule'), 0
                ) AS provisional
           FROM transactions t
           LEFT JOIN allocations al ON al.transaction_id = t.id
          GROUP BY t.id
       )
       SELECT
         (SELECT COALESCE(SUM(amount_paise), 0) FROM transactions) AS net_paise,
         -- ABS per transaction, THEN sum: a \u20B9500 unexplained debit and a \u20B9500
         -- unexplained credit are \u20B91000 of unexplained money, not zero.
         COALESCE(SUM(ABS(amount_paise - explained))
                  FILTER (WHERE ${EXPLAINABLE_SPEND}), 0) AS unexplained_paise,
         -- Same EXPLAINABLE_SPEND gate as the unexplained figure above. It was missing
         -- here, so a
         -- rule allocation left on an opening balance or a confirmed transfer kept
         -- counting after the engine had stopped considering that row at all \u2014 two
         -- tiles on one strip disagreeing about what money is.
         COALESCE(SUM(ABS(provisional))
                  FILTER (WHERE ${EXPLAINABLE_SPEND}), 0) AS provisional_paise
       FROM per_txn`
  );
  const row = result.rows[0];
  res.json({
    net_paise: Number(row.net_paise),
    unexplained_paise: Number(row.unexplained_paise),
    provisional_paise: Number(row.provisional_paise)
  });
}));
router6.get("/reports/by-month", route(async (req, res) => {
  const filters = parseFilters(req.query, 1);
  if (!filters.ok) return res.status(400).json({ error: filters.error });
  const result = await pool.query(
    `WITH per_txn AS (
         SELECT t.id,
                t.txn_date,
                t.amount_paise,
                COALESCE(SUM(al.amount_paise), 0) AS explained,
                COALESCE(SUM(al.amount_paise) FILTER (WHERE al.source = 'rule'), 0) AS provisional,
                COALESCE(SUM(al.amount_paise) FILTER (WHERE al.source = 'user'), 0) AS confirmed
           FROM transactions t
           LEFT JOIN allocations al ON al.transaction_id = t.id
          WHERE ${EXPLAINABLE_SPEND} ${filters.sql}
          GROUP BY t.id
       )
       SELECT to_char(txn_date, 'YYYY-MM')                                  AS month,
              COALESCE(SUM(ABS(amount_paise)) FILTER (WHERE amount_paise < 0), 0) AS out_paise,
              COALESCE(SUM(ABS(provisional)) FILTER (WHERE amount_paise < 0), 0)  AS provisional_paise,
              COALESCE(SUM(ABS(confirmed))   FILTER (WHERE amount_paise < 0), 0)  AS confirmed_paise,
              COALESCE(SUM(ABS(amount_paise - explained))
                       FILTER (WHERE amount_paise < 0), 0)                        AS unexplained_paise,
              COUNT(*) FILTER (WHERE amount_paise < 0)                            AS transactions
         FROM per_txn
        GROUP BY 1
        HAVING COUNT(*) FILTER (WHERE amount_paise < 0) > 0
        ORDER BY 1`,
    filters.params
  );
  return res.json({
    months: result.rows.map((r) => ({
      month: r.month,
      out_paise: Number(r.out_paise),
      provisional_paise: Number(r.provisional_paise),
      confirmed_paise: Number(r.confirmed_paise),
      unexplained_paise: Number(r.unexplained_paise),
      transactions: Number(r.transactions)
    }))
  });
}));
router6.get("/reports/consumption", route(async (req, res) => {
  const f = consumptionFilters(req.query);
  if (!f.ok) return res.status(400).json({ error: f.error });
  const params = [f.from, f.to, f.accountId];
  const byCategory = await pool.query(
    `WITH rows AS (${CONSUMPTION_ROWS})
     SELECT c.id, c.name, c.parent_id, p.name AS parent_name,
            COALESCE(SUM(-rows.amount_paise), 0) AS consumed_paise,
            COUNT(*)                             AS entries
       FROM rows
       JOIN categories c ON c.id = rows.category_id
       LEFT JOIN categories p ON p.id = c.parent_id
      WHERE ${ROWS_IN_SCOPE}
      GROUP BY c.id, p.name
      ORDER BY SUM(-rows.amount_paise) DESC`,
    params
  );
  const side = await pool.query(
    `WITH rows AS (${CONSUMPTION_ROWS})
     SELECT COALESCE(SUM(-amount_paise) FILTER (WHERE kind = 'paid_for_you'), 0)         AS paid_for_you,
            COALESCE(SUM(amount_paise)  FILTER (WHERE kind = 'bank' AND amount_paise > 0), 0) AS received,
            COALESCE(SUM(-amount_paise), 0)                                             AS consumed
       FROM rows
      WHERE ${ROWS_IN_SCOPE}`,
    params
  );
  const money = await pool.query(
    `WITH per_txn AS (
         SELECT t.id, t.amount_paise,
                COALESCE(SUM(al.amount_paise), 0) AS explained,
                COALESCE(SUM(al.amount_paise) FILTER (
                  WHERE cat.excluded_from_spend OR COALESCE(par.excluded_from_spend, false)
                ), 0) AS fronted
           FROM transactions t
           LEFT JOIN allocations al ON al.transaction_id = t.id
           LEFT JOIN categories cat ON cat.id = al.category_id
           LEFT JOIN categories par ON par.id = cat.parent_id
          WHERE ${EXPLAINABLE_SPEND} AND t.amount_paise < 0
            AND ($1::date IS NULL OR t.txn_date >= $1::date)
            AND ($2::date IS NULL OR t.txn_date <= $2::date)
            AND ($3::bigint IS NULL OR t.account_id = $3::bigint)
          GROUP BY t.id
       )
     SELECT COALESCE(SUM(-amount_paise), 0)                  AS money_out,
            COALESCE(SUM(ABS(amount_paise - explained)), 0) AS unexplained,
            COALESCE(SUM(-fronted), 0)                      AS fronted
       FROM per_txn`,
    params
  );
  const unclassified = await pool.query(
    `SELECT COALESCE(SUM(ABS((ev.payload->'nets_paise'->>$4)::bigint)), 0) AS paise
       FROM evidence ev
      WHERE ev.source_type = 'splitwise'
        AND ev.payload->>'kind' = 'expense'
        AND (ev.payload->'nets_paise'->>$4)::bigint < 0
        AND (SELECT m.category_id FROM source_category_map m
              WHERE m.source_type = 'splitwise'
                AND m.source_category = ev.payload->>'source_category') IS NULL
        AND ($1::date IS NULL OR ev.evidence_date >= $1::date)
        AND ($2::date IS NULL OR ev.evidence_date <= $2::date)
        AND $3::bigint IS NULL`,
    [...params, process.env.SPLITWISE_ME ?? ""]
  );
  const terms = {
    money_out_paise: Number(money.rows[0].money_out),
    unexplained_paise: Number(money.rows[0].unexplained),
    fronted_paise: Number(money.rows[0].fronted),
    paid_for_you_paise: Number(side.rows[0].paid_for_you),
    received_paise: Number(side.rows[0].received),
    consumed_paise: Number(side.rows[0].consumed)
  };
  return res.json({
    categories: byCategory.rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      parent_id: r.parent_id === null ? null : Number(r.parent_id),
      parent_name: r.parent_name,
      consumed_paise: Number(r.consumed_paise),
      entries: Number(r.entries)
    })),
    terms,
    // Non-zero only if the ledger breaks an invariant the formula relies on. Shown, never
    // rounded away: a formula that "adds up" by fiat is the thing this view exists to replace.
    unaccounted_paise: unaccounted(terms),
    unclassified_paise: Number(unclassified.rows[0].paise)
  });
}));
router6.get("/reports/consumption/entries", route(async (req, res) => {
  const f = consumptionFilters(req.query);
  if (!f.ok) return res.status(400).json({ error: f.error });
  const categoryId = intParam(req.query.category_id, "category_id");
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });
  const params = [f.from, f.to, f.accountId, categoryId];
  const rows = await pool.query(
    `WITH rows AS (${CONSUMPTION_ROWS})
     SELECT rows.consumed_on, rows.kind, rows.detail, rows.source, -rows.amount_paise AS consumed_paise,
            acc.name AS account_name, rows.transaction_id, rows.evidence_id,
            COUNT(*) OVER () AS total
       FROM rows
       LEFT JOIN accounts acc ON acc.id = rows.account_id
      WHERE ${ROWS_IN_SCOPE} AND rows.category_id = $4
      ORDER BY rows.consumed_on DESC, rows.transaction_id DESC NULLS LAST, rows.evidence_id DESC
      LIMIT $5 OFFSET $6`,
    [...params, paging.limit, paging.offset]
  );
  return res.json({
    entries: rows.rows.map((r) => ({
      date: r.consumed_on,
      kind: r.kind,
      detail: r.detail,
      source: r.source,
      consumed_paise: Number(r.consumed_paise),
      account_name: r.account_name,
      transaction_id: r.transaction_id === null ? null : String(r.transaction_id),
      evidence_id: r.evidence_id === null ? null : String(r.evidence_id)
    })),
    total: rows.rows.length === 0 ? 0 : Number(rows.rows[0].total),
    limit: paging.limit,
    offset: paging.offset
  });
}));
var ROWS_IN_SCOPE = `
  ($1::date IS NULL OR rows.consumed_on >= $1::date)
  AND ($2::date IS NULL OR rows.consumed_on <= $2::date)
  -- What a flatmate paid touched no account of yours, so picking an account leaves it out.
  AND ($3::bigint IS NULL OR rows.account_id = $3::bigint)`;
function consumptionFilters(query) {
  const one = (v) => typeof v === "string" && v !== "" ? v : null;
  const from = one(query.from);
  const to = one(query.to);
  if (from !== null && !isIsoDate(from)) return { ok: false, error: "from must be YYYY-MM-DD" };
  if (to !== null && !isIsoDate(to)) return { ok: false, error: "to must be YYYY-MM-DD" };
  if (from !== null && to !== null && from > to) {
    return { ok: false, error: "from must not be after to" };
  }
  const rawAccount = one(query.account_id);
  if (rawAccount !== null && !/^\d+$/.test(rawAccount)) {
    return { ok: false, error: "account_id must be a positive integer" };
  }
  return { ok: true, from, to, accountId: rawAccount === null ? null : Number(rawAccount) };
}

// src/routes/rules.ts
import { Router as Router7 } from "express";

// src/rules/mining.ts
var STOPWORDS = /* @__PURE__ */ new Set([
  "upi",
  "imps",
  "neft",
  "rtgs",
  "debit",
  "credit",
  "payment",
  "paymen",
  "paid",
  "pay",
  "paying",
  "from",
  "for",
  "you",
  "are",
  "the",
  "and",
  "ref",
  "txn",
  "trf",
  "transfer",
  "pos",
  "xxxxx",
  "xxxx",
  "inr",
  "acct",
  "account",
  "bank",
  "banking",
  "net",
  "mob",
  // Corporate boilerplate: part of a registered name, never the thing bought.
  "ltd",
  "limited",
  "pvt",
  "private",
  "india",
  "indian",
  "services",
  "service",
  "serv",
  "solutions",
  "technologies",
  "enterprises",
  "retail",
  "com",
  // NARRATION boilerplate, and the nastiest kind because it reads as meaningful.
  // "UPI REQUEST FROM <merchant> BRANCH ATM SERVICE" is a template some banks stamp onto
  // ordinary UPI merchant payments — verified on dozens of rows in a real ledger, Amazon Pay
  // and otherwise. A `contains: atm` rule fires on all of them and labels Amazon Pay
  // groceries as cash withdrawals. These words describe the FORM of the message.
  // Cost: a genuine cash-withdrawal rule must be written by hand. Right trade on this data.
  "atm",
  "branch",
  "request",
  // Bank / PSP handles.
  "ybl",
  "utib",
  "yesb",
  "sbin",
  "ibl",
  "kkbk",
  "hdfc",
  "hdfcbank",
  "axl",
  "axis",
  "axisbank",
  "okpayaxis",
  "oksbi",
  "okaxis",
  "okhdfcbank",
  "okicici",
  "ptybl",
  "ptmupi",
  "yblupi",
  "cnrb",
  "punb",
  "barb",
  "ioba",
  "idib",
  "ubin",
  "icic",
  "icicibank",
  "sbi"
]);
function isRailNoise(word) {
  if (word.startsWith("@")) return true;
  const at = word.indexOf("@");
  if (at !== -1) {
    const local = word.slice(0, at);
    if (local.length <= 2 || /^\d+$/.test(local)) return true;
  }
  if (/^[a-z]{4}0/.test(word)) return true;
  return false;
}
var isNoise = (word) => STOPWORDS.has(word) || isRailNoise(word);
function candidateTokens(narration) {
  const words = normalise2(narration).split(" ").filter((w) => w.length > 2 && !/^\d+$/.test(w));
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i < words.length; i++) {
    const uni = words[i];
    if (!isNoise(uni)) out.add(uni);
    if (i + 1 < words.length) {
      const next = words[i + 1];
      if (isRailNoise(uni) && isRailNoise(next)) continue;
      if (!isNoise(uni) || !isNoise(next)) out.add(uni + " " + next);
    }
  }
  return [...out];
}
function merchantHint(narration) {
  return candidateTokens(narration).filter((token) => !token.includes(" ")).join(" ");
}
var asRule = (value) => ({
  conditions: [{ field: "narration", op: "contains", value }],
  match_mode: "all"
});
function mineCandidates(unexplained, ledger, existingRules, options = {}) {
  const minHits = options.minHits ?? 3;
  const maxBreadth = options.maxBreadth ?? 1;
  const limit = options.limit ?? 40;
  const freq = /* @__PURE__ */ new Map();
  for (const t of unexplained) {
    for (const token of candidateTokens(t.narration)) {
      let bucket = freq.get(token);
      if (!bucket) freq.set(token, bucket = /* @__PURE__ */ new Set());
      bucket.add(t.id);
    }
  }
  const candidates = [];
  for (const [value, ids] of freq) {
    if (ids.size < minHits) continue;
    if (normalise2(value) === "") continue;
    const rule = asRule(value);
    const realHits = unexplained.filter((t) => matches(t, rule));
    if (realHits.length < minHits) continue;
    const ledgerHits = ledger.filter((t) => matches(t, rule));
    const breadth = ledger.length === 0 ? 0 : ledgerHits.length / ledger.length;
    if (breadth > maxBreadth) continue;
    const explained = ledgerHits.filter((t) => t.categories.length > 0);
    const counts = /* @__PURE__ */ new Map();
    for (const t of explained) {
      for (const c of t.categories) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const spreadDetail = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count }));
    const collision = existingRules.find(
      (r) => realHits.length > 0 && realHits.every((t) => matches(t, r))
    );
    candidates.push({
      value,
      words: value.split(" ").length,
      unexplainedHits: realHits.length,
      ledgerHits: ledgerHits.length,
      breadth: Number(breadth.toFixed(3)),
      explainedHits: explained.length,
      spread: spreadDetail.length,
      spreadDetail: spreadDetail.slice(0, 4),
      collidesWith: collision ? collision.name : null,
      ids: realHits.map((t) => t.id)
    });
  }
  const bySignature = /* @__PURE__ */ new Map();
  for (const c of candidates.sort((a, b) => a.words - b.words)) {
    const signature = [...c.ids].sort().join(",");
    if (!bySignature.has(signature)) bySignature.set(signature, c);
  }
  return [...bySignature.values()].sort(
    (a, b) => a.spread - b.spread || b.unexplainedHits - a.unexplainedHits || a.value.localeCompare(b.value)
  ).slice(0, limit);
}

// src/routes/rules.ts
var router7 = Router7();
function validateConditions(conditions) {
  if (!Array.isArray(conditions)) return "conditions must be an array";
  if (conditions.length === 0) return "conditions must not be empty";
  for (const [i, c] of conditions.entries()) {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      return `condition ${i}: must be an object`;
    }
    const { field, op, value } = c;
    if (!isRuleField(field)) {
      return `condition ${i}: field must be one of ${RULE_FIELDS.join(", ")}`;
    }
    if (!isRuleOp(op)) {
      return `condition ${i}: op must be one of ${RULE_OPS.join(", ")}`;
    }
    if (!OPS_BY_FIELD[field].includes(op)) {
      return `condition ${i}: op '${op}' is not valid on field '${field}'`;
    }
    switch (field) {
      case "narration":
        if (typeof value !== "string" || value.trim() === "") {
          return `condition ${i}: value must be a non-empty string`;
        }
        break;
      case "amount_paise":
        if (!Number.isInteger(value)) {
          return `condition ${i}: value must be an integer (paise)`;
        }
        break;
      case "txn_date":
        if (!isIsoDate(value)) {
          return `condition ${i}: value must be a real date (YYYY-MM-DD)`;
        }
        break;
    }
  }
  return null;
}
router7.get("/rules/vocabulary", (_req, res) => {
  res.json({
    fields: RULE_FIELDS,
    ops: RULE_OPS,
    match_modes: MATCH_MODES,
    ops_by_field: OPS_BY_FIELD
  });
});
router7.post("/rules", route(async (req, res) => {
  const { name, conditions, match_mode, category_id, priority, enabled } = req.body ?? {};
  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "name must be a non-empty string" });
  }
  const conditionError = validateConditions(conditions);
  if (conditionError !== null) {
    return res.status(400).json({ error: conditionError });
  }
  const mode = match_mode ?? "all";
  if (!isMatchMode(mode)) {
    return res.status(400).json({ error: `match_mode must be one of ${MATCH_MODES.join(", ")}` });
  }
  if (!Number.isInteger(category_id)) {
    return res.status(400).json({ error: "category_id must be an integer" });
  }
  const rulePriority = priority ?? 0;
  if (!Number.isInteger(rulePriority)) {
    return res.status(400).json({ error: "priority must be an integer" });
  }
  const isEnabled = enabled ?? true;
  if (typeof isEnabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }
  try {
    const cat = await pool.query("SELECT 1 FROM categories WHERE id = $1", [
      category_id
    ]);
    if (cat.rowCount === 0) {
      return res.status(400).json({ error: "category_id does not exist" });
    }
    const result = await pool.query(
      `INSERT INTO rules (name, conditions, match_mode, category_id, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        name.trim(),
        JSON.stringify(conditions),
        mode,
        category_id,
        rulePriority,
        isEnabled
      ]
    );
    return res.status(201).json({ id: Number(result.rows[0].id) });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("a rule with that name already exists");
    throw error;
  }
}));
router7.patch("/rules/:id", route(async (req, res) => {
  const ruleId = intParam(req.params.id, "rule id");
  const body = req.body ?? {};
  try {
    const result = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT name, conditions, match_mode, category_id, priority, enabled
         FROM rules WHERE id = $1 FOR UPDATE`,
        [ruleId]
      );
      if (existing.rowCount === 0) {
        throw notFound("no rule found");
      }
      const current = existing.rows[0];
      const next = {
        name: Object.hasOwn(body, "name") ? body.name : current.name,
        conditions: Object.hasOwn(body, "conditions") ? body.conditions : current.conditions,
        match_mode: Object.hasOwn(body, "match_mode") ? body.match_mode : current.match_mode,
        category_id: Object.hasOwn(body, "category_id") ? body.category_id : Number(current.category_id),
        priority: Object.hasOwn(body, "priority") ? body.priority : Number(current.priority),
        enabled: Object.hasOwn(body, "enabled") ? body.enabled : current.enabled
      };
      if (typeof next.name !== "string" || next.name.trim() === "") {
        throw badRequest("name must be a non-empty string");
      }
      const conditionError = validateConditions(next.conditions);
      if (conditionError !== null) {
        throw badRequest(conditionError);
      }
      if (!isMatchMode(next.match_mode)) {
        throw badRequest(`match_mode must be one of ${MATCH_MODES.join(", ")}`);
      }
      if (!Number.isInteger(next.category_id)) {
        throw badRequest("category_id must be an integer");
      }
      if (!Number.isInteger(next.priority)) {
        throw badRequest("priority must be an integer");
      }
      if (typeof next.enabled !== "boolean") {
        throw badRequest("enabled must be a boolean");
      }
      const cat = await client.query("SELECT 1 FROM categories WHERE id = $1", [
        next.category_id
      ]);
      if (cat.rowCount === 0) {
        throw badRequest("category_id does not exist");
      }
      const matchingChanged = JSON.stringify(next.conditions) !== JSON.stringify(current.conditions) || next.match_mode !== current.match_mode || next.category_id !== Number(current.category_id) || next.priority !== Number(current.priority) || next.enabled !== current.enabled;
      let removed = 0;
      if (matchingChanged) {
        const swept = await client.query(
          "DELETE FROM allocations WHERE rule_id = $1 AND source = 'rule'",
          [ruleId]
        );
        removed = swept.rowCount ?? 0;
      }
      await client.query(
        `UPDATE rules SET name = $1, conditions = $2, match_mode = $3,
              category_id = $4, priority = $5, enabled = $6
        WHERE id = $7`,
        [
          next.name.trim(),
          JSON.stringify(next.conditions),
          next.match_mode,
          next.category_id,
          next.priority,
          next.enabled,
          ruleId
        ]
      );
      return {
        id: ruleId,
        allocations_removed: removed,
        // The caller has to re-run the engine to get the new guesses. Saying so beats a
        // silent auto-apply: applying is a whole-ledger write and should be a decision.
        reapply_needed: matchingChanged
      };
    });
    return res.json(result);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("a rule with that name already exists");
    throw error;
  }
}));
router7.delete("/rules/:id", route(async (req, res) => {
  const ruleId = intParam(req.params.id, "rule id");
  const result = await withTransaction(async (client) => {
    const found = await client.query(
      "SELECT 1 FROM rules WHERE id = $1 FOR UPDATE",
      [ruleId]
    );
    if (found.rowCount === 0) {
      throw notFound("no rule found");
    }
    const swept = await client.query(
      "DELETE FROM allocations WHERE rule_id = $1",
      [ruleId]
    );
    await client.query("DELETE FROM rules WHERE id = $1", [ruleId]);
    return {
      deleted: ruleId,
      allocations_removed: swept.rowCount ?? 0
    };
  });
  return res.json(result);
}));
router7.get("/rules", route(async (_req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.name, r.conditions, r.match_mode, r.category_id,
              c.name AS category_name, r.priority, r.enabled
         FROM rules r
         LEFT JOIN categories c ON c.id = r.category_id
        ORDER BY r.priority DESC, r.id ASC`
  );
  const rules = result.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    conditions: r.conditions,
    // pg parses JSONB into a JS value already
    match_mode: r.match_mode,
    category_id: r.category_id == null ? null : Number(r.category_id),
    category_name: r.category_name,
    // null if the rule assigns no category
    priority: r.priority,
    enabled: r.enabled
  }));
  res.json({ rules });
}));
router7.post("/rules/apply", route(async (req, res) => {
  const rawAccountId = req.query.account_id;
  const accountId = rawAccountId === void 0 ? null : intParam(rawAccountId, "account_id");
  if (accountId !== null && !await accountExists(accountId)) {
    throw notFound("account id does not exist");
  }
  const result = await withTransaction((client) => applyRules(client, accountId));
  return res.json(result);
}));
router7.get("/rules/candidates", route(async (req, res) => {
  const rawMinHits = req.query.min_hits;
  let minHits = 3;
  if (rawMinHits !== void 0) {
    if (typeof rawMinHits !== "string" || !/^\d+$/.test(rawMinHits)) {
      throw badRequest("min_hits must be a positive integer");
    }
    minHits = Number(rawMinHits);
    if (minHits < 2 || minHits > 100) {
      throw badRequest("min_hits must be between 2 and 100");
    }
  }
  const ledgerResult = await pool.query(
    `SELECT t.id, t.narration, t.amount_paise, t.txn_date,
            COALESCE(SUM(al.amount_paise), 0) AS explained_paise,
            COALESCE(
              json_agg(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL),
              '[]'
            ) AS categories
       FROM transactions t
       LEFT JOIN allocations al ON al.transaction_id = t.id
       LEFT JOIN categories  c  ON c.id = al.category_id
      WHERE ${EXPLAINABLE_SPEND}
      GROUP BY t.id`
  );
  const ledger = [];
  const unexplained = [];
  for (const r of ledgerResult.rows) {
    const txn = {
      id: r.id,
      // BIGINT PK — keep as string
      narration: r.narration,
      amount_paise: Number(r.amount_paise),
      txn_date: r.txn_date,
      categories: r.categories
    };
    ledger.push(txn);
    if (Number(r.amount_paise) !== Number(r.explained_paise)) unexplained.push(txn);
  }
  const rulesResult = await pool.query(
    "SELECT name, conditions, match_mode FROM rules WHERE enabled = true"
  );
  const candidates = mineCandidates(unexplained, ledger, rulesResult.rows, { minHits });
  return res.json({
    candidates,
    unexplained_total: unexplained.length,
    ledger_total: ledger.length,
    covered: new Set(candidates.flatMap((c) => c.ids)).size
  });
}));
router7.post("/rules/preview", route(async (req, res) => {
  const { conditions, match_mode } = req.body ?? {};
  const conditionError = validateConditions(conditions);
  if (conditionError !== null) throw badRequest(conditionError);
  const mode = match_mode ?? "all";
  if (!isMatchMode(mode)) {
    throw badRequest(`match_mode must be one of ${MATCH_MODES.join(", ")}`);
  }
  const result = await pool.query(
    `SELECT t.id, a.name AS account_name, t.txn_date, t.amount_paise, t.type,
            t.transfer_status, t.narration,
            COALESCE(SUM(al.amount_paise), 0) AS explained_paise,
            COALESCE(
              json_agg(
                json_build_object(
                  'amount_paise', al.amount_paise, 'category_id', al.category_id,
                  'category_name', c.name, 'source', al.source
                ) ORDER BY al.id
              ) FILTER (WHERE al.id IS NOT NULL),
              '[]'
            ) AS allocations
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN allocations al ON al.transaction_id = t.id
       LEFT JOIN categories  c  ON c.id = al.category_id
      WHERE ${EXPLAINABLE_SPEND}
      GROUP BY t.id, a.id
      ORDER BY t.txn_date DESC, t.id`
  );
  const rule = { conditions, match_mode: mode };
  const transactions = result.rows.filter((r) => matches(r, rule)).map((r) => {
    const amount = Number(r.amount_paise);
    const explained = Number(r.explained_paise);
    return {
      id: r.id,
      account_name: r.account_name,
      txn_date: r.txn_date,
      amount_paise: amount,
      type: r.type,
      transfer_status: r.transfer_status,
      narration: r.narration,
      explained_paise: explained,
      allocations: r.allocations,
      unexplained_paise: amount - explained
    };
  });
  const userLocked = transactions.filter(
    (t) => t.allocations.some((al) => al.source === "user")
  ).length;
  return res.json({
    transactions,
    total: transactions.length,
    user_locked: userLocked,
    would_explain: transactions.filter(
      (t) => t.allocations.length === 0 || t.unexplained_paise !== 0
    ).length
  });
}));

// src/routes/transactions.ts
import { Router as Router8 } from "express";

// src/llm/llm.ts
import { createHash as createHash4 } from "node:crypto";
var LLM_MODEL = CATEGORY_LLM.model;
var PROMPT_VERSION = "v2";
var UNKNOWN = "Unknown";
var cache2 = /* @__PURE__ */ new Map();
function key(merchant, labels) {
  const { model, think, temperature, numCtx, numPredict, extraOptions } = CATEGORY_LLM;
  const settings = JSON.stringify({ think, temperature, numCtx, numPredict, extraOptions });
  return createHash4("sha256").update([model, PROMPT_VERSION, settings, merchant, labels.length, labels.join("|")].join("\0")).digest("hex");
}
function buildPrefix(labels) {
  return "You categorise Indian bank transactions. Choose exactly one category.\n\nCategories:\n" + labels.map((l) => "- " + l).join("\n") + "\n\nThe text is a merchant fragment taken from a UPI narration. Choose " + UNKNOWN + "\nwhen you do not recognise the merchant \u2014 " + UNKNOWN + " is a correct answer and is\nbetter than a guess.\n\n";
}
var LlmUnavailable = class extends Error {
};
async function ask(merchant, labels, prefix) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CATEGORY_LLM.timeoutMs);
  try {
    const res = await fetch(CATEGORY_LLM.host + "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // model, think, temperature, num_predict (40) and anything in CATEGORY_LLM_OPTIONS.
        //
        // `think` DEFAULTS TO FALSE, and that default is KEPT on measurement rather than on the
        // original reasoning. It was here because qwen3 would not stop reasoning. That is not
        // why it stays: the `format` grammar below forces the first token to be `{`, so a
        // reasoning preamble has nowhere to go either way, and both modes answer in 7-9 tokens
        // on gemma4:26b. The flag costs nothing and buys nothing in TIME.
        //
        // It stays because of the ANSWERS. A/B over 10 merchants (2026-09-05, gemma4:26b,
        // this prompt): 8 identical, and both that differed were worse with reasoning on —
        // BLINKIT went Groceries -> Food delivery, MYGATE went Rent -> Unknown. Ten merchants
        // is a smell rather than a verdict, so re-measure before trusting it further; it is
        // recorded here so the next person knows it was measured and not assumed.
        //
        // Turning it on (CATEGORY_LLM_THINK=true) also needs CATEGORY_LLM_NUM_PREDICT raised:
        // 40 tokens is enough for `{"category": "..."}` and nowhere near enough for a
        // reasoning preamble, which would be cut off and read as Unknown.
        ...ollamaRequestBase(CATEGORY_LLM),
        prompt: prefix + 'Merchant: "' + merchant + '"\n',
        format: {
          type: "object",
          properties: { category: { type: "string", enum: labels } },
          required: ["category"]
        }
      }),
      signal: ctl.signal
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new LlmUnavailable(diagnoseOllamaRefusal(res.status, body, CATEGORY_LLM).message);
    }
    const out = await res.json();
    if (typeof out.response !== "string") throw new LlmUnavailable("malformed model response");
    let parsed;
    try {
      parsed = JSON.parse(out.response);
    } catch {
      return UNKNOWN;
    }
    const category = parsed.category;
    if (typeof category !== "string" || !labels.includes(category)) return UNKNOWN;
    return category;
  } catch (err) {
    if (err instanceof LlmUnavailable) throw err;
    if (ctl.signal.aborted) {
      throw new LlmUnavailable(
        `the local model took longer than ${Math.round(CATEGORY_LLM.timeoutMs / 1e3)}s \u2014 raise CATEGORY_LLM_TIMEOUT_MS on a slow machine`
      );
    }
    throw new LlmUnavailable(
      "could not reach the local model at " + CATEGORY_LLM.host + " \u2014 is Ollama running?"
    );
  } finally {
    clearTimeout(timer);
  }
}
async function suggestCategories(items, labels) {
  const out = /* @__PURE__ */ new Map();
  if (items.length === 0 || labels.length === 0) return out;
  const withUnknown = labels.includes(UNKNOWN) ? labels : [...labels, UNKNOWN];
  const prefix = buildPrefix(withUnknown);
  for (const item of items) {
    if (item.merchant.trim() === "") continue;
    const cacheKey2 = key(item.merchant, withUnknown);
    let answer = cache2.get(cacheKey2);
    if (answer === void 0) {
      answer = await ask(item.merchant, withUnknown, prefix);
      cache2.set(cacheKey2, answer);
    }
    if (answer !== UNKNOWN) out.set(item.id, answer);
  }
  return out;
}

// src/routes/transactions.ts
var router8 = Router8();
router8.post("/transactions/:id/allocations", route(async (req, res) => {
  const txnId = intParam(req.params.id, "transaction id");
  const allocations = req.body?.allocations;
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return res.status(400).json({ error: "`allocations` must be a non-empty array" });
  }
  for (const a of allocations) {
    if (a === null || typeof a !== "object") {
      return res.status(400).json({ error: "each allocation must be an object" });
    }
    if (!Number.isInteger(a.amount_paise) || a.amount_paise === 0) {
      return res.status(400).json({ error: "amount_paise must be a non-zero integer" });
    }
    if (a.category_id == null) {
      return res.status(400).json({ error: "category_id is required" });
    }
  }
  const newSum = allocations.reduce((s, a) => s + a.amount_paise, 0);
  const result = await withTransaction(async (client) => {
    const txnResult = await client.query(
      "SELECT amount_paise FROM transactions WHERE id = $1 FOR UPDATE",
      [txnId]
    );
    if (txnResult.rowCount === 0) {
      throw notFound("no transaction found");
    }
    const txnAmount = Number(txnResult.rows[0].amount_paise);
    const categoryIds = allocations.map((a) => a.category_id);
    const catResult = await client.query(
      "SELECT id FROM categories WHERE id = ANY($1)",
      [categoryIds]
    );
    if (catResult.rowCount !== new Set(categoryIds).size) {
      throw badRequest("one or more category_id do not exist");
    }
    for (const a of allocations) {
      if (Math.sign(a.amount_paise) !== Math.sign(txnAmount)) {
        throw badRequest("allocation sign must match the transaction");
      }
    }
    if (Math.abs(newSum) > Math.abs(txnAmount)) {
      throw badRequest("allocations exceed the transaction amount");
    }
    await client.query("DELETE FROM allocations WHERE transaction_id = $1", [
      txnId
    ]);
    for (const a of allocations) {
      await client.query(
        `INSERT INTO allocations (transaction_id, amount_paise, category_id, confidence, source)
         VALUES ($1, $2, $3, $4, 'user')`,
        [txnId, a.amount_paise, a.category_id, 1]
      );
    }
    return {
      transaction_id: String(txnId),
      inserted: allocations.length,
      unexplained_paise: txnAmount - newSum
    };
  });
  return res.status(200).json(result);
}));
router8.get("/transactions", route(async (req, res) => {
  const filters = parseFilters(req.query, 1);
  if (!filters.ok) return res.status(400).json({ error: filters.error });
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });
  const spendClause = isSpendOnly(req.query) ? `AND ${EXPLAINABLE_SPEND}` : "";
  const near = req.query.near;
  if (near !== void 0 && !isIsoDate(near)) {
    return res.status(400).json({ error: "near must be YYYY-MM-DD" });
  }
  const countResult = await pool.query(
    `SELECT COUNT(*) AS total
         FROM transactions t
        WHERE 1=1 ${spendClause} ${filters.sql}`,
    filters.params
  );
  const result = await pool.query(
    // Lighter than the drill-in: just the explained total per txn (no nested allocations).
    // LEFT JOIN allocations + GROUP BY t.id, a.id (both PKs → other columns are free).
    `SELECT t.id, t.account_id, a.name AS account_name, a.bank,
              t.txn_date, t.txn_time, t.amount_paise, t.type, t.narration,
              t.transfer_status, t.counterparty_account_id, t.bank_balance_paise,
              COALESCE(SUM(al.amount_paise), 0) AS explained_paise,
              -- Split the explained total by provenance so the ledger can show the
              -- three states apart. FILTER is the aggregate-level WHERE: it feeds
              -- only matching rows to THIS sum, without a second pass over the join.
              COALESCE(
                SUM(al.amount_paise) FILTER (WHERE al.source = 'rule'), 0
              ) AS provisional_paise,
              -- Nested slices, so a row in the ledger can be expanded and explained
              -- without a second request. FILTER + COALESCE turns "no children" into an
              -- empty array rather than [null].
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', al.id::text, 'amount_paise', al.amount_paise,
                    'category_id', al.category_id, 'category_name', c.name,
                    'confidence', al.confidence, 'source', al.source,
                    -- The two columns are two FACTS: source alone cannot
                    -- tell a row a person authored from one they accepted from a rule, and
                    -- that is exactly the distinction resolvePrecedence decides on. The
                    -- manual matcher needs it to say whether linking would REPLACE what is
                    -- already there or be REFUSED by it.
                    'confirmed_from_rule_id', al.confirmed_from_rule_id
                  ) ORDER BY al.id
                ) FILTER (WHERE al.id IS NOT NULL),
                '[]'
              ) AS allocations
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN allocations al ON al.transaction_id = t.id
         LEFT JOIN categories c ON c.id = al.category_id
        WHERE 1=1 ${spendClause} ${filters.sql}
        GROUP BY t.id, a.id
        -- NEWEST FIRST. It was ascending, which put the pager's "Newer" button on the
        -- side that walks towards older rows and made page 1 of a three-month import the
        -- three months you least wanted to see. Every tiebreak after the date is still
        -- there and still total, so the ordering is a function of the data \u2014 a page whose
        -- contents shuffle between identical requests looks exactly like data loss.
        ORDER BY ${near === void 0 ? "" : `ABS(t.txn_date - $${filters.params.length + 3}::date),`}
                 t.txn_date DESC, t.account_id, t.statement_id, t.statement_seq, t.id
        LIMIT $${filters.params.length + 1} OFFSET $${filters.params.length + 2}`,
    near === void 0 ? [...filters.params, paging.limit, paging.offset] : [...filters.params, paging.limit, paging.offset, near]
  );
  const transactions = result.rows.map((r) => {
    const amount = Number(r.amount_paise);
    const explained = Number(r.explained_paise);
    return {
      id: r.id,
      // BIGINT PK — keep as string
      account_id: Number(r.account_id),
      account_name: r.account_name,
      bank: r.bank,
      txn_date: r.txn_date,
      txn_time: r.txn_time,
      amount_paise: amount,
      type: r.type,
      narration: r.narration,
      transfer_status: r.transfer_status,
      counterparty_account_id: r.counterparty_account_id,
      bank_balance_paise: r.bank_balance_paise == null ? null : Number(r.bank_balance_paise),
      explained_paise: explained,
      provisional_paise: Number(r.provisional_paise),
      allocations: r.allocations,
      // pg parses json_agg into a JS array
      unexplained_paise: amount - explained
      // derived
    };
  });
  res.json({
    transactions,
    total: Number(countResult.rows[0].total),
    limit: paging.limit,
    offset: paging.offset
  });
}));
router8.post("/transactions/suggest", route(async (req, res) => {
  if (DEMO_MODE) {
    return res.status(501).json({
      error: "Category suggestions run a model on YOUR machine \u2014 that is the privacy design, so they are unavailable in the hosted demo. Run Khata locally with Ollama to try them."
    });
  }
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw badRequest("`ids` must be a non-empty array");
  }
  if (ids.length > 100) {
    throw badRequest("at most 100 ids per request");
  }
  for (const id of ids) {
    if (typeof id !== "string" || !/^\d+$/.test(id)) {
      throw badRequest("every id must be a numeric string");
    }
  }
  const txnResult = await pool.query(
    `SELECT id, narration FROM transactions
      WHERE id = ANY($1::bigint[]) AND ${EXPLAINABLE_SPEND}`,
    [ids]
  );
  const catResult = await pool.query(
    `SELECT c.id, c.name, p.name AS parent_name
       FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
      ORDER BY COALESCE(p.name, c.name), c.parent_id NULLS FIRST, c.name`
  );
  const byLabel = /* @__PURE__ */ new Map();
  const labels = [];
  for (const row of catResult.rows) {
    const label2 = row.parent_name ? row.parent_name + " > " + row.name : row.name;
    if (!byLabel.has(label2)) {
      byLabel.set(label2, Number(row.id));
      labels.push(label2);
    }
  }
  const items = txnResult.rows.map((r) => ({
    id: String(r.id),
    merchant: merchantHint(r.narration)
  }));
  let answers;
  try {
    answers = await suggestCategories(items, labels);
  } catch (err) {
    if (err instanceof LlmUnavailable) {
      return res.status(503).json({ error: err.message });
    }
    throw err;
  }
  const suggestions = [...answers.entries()].map(([id, label2]) => ({
    transaction_id: id,
    category_id: byLabel.get(label2) ?? null,
    category_name: label2
  }));
  return res.json({
    suggestions,
    asked: items.filter((i) => i.merchant.trim() !== "").length,
    model: LLM_MODEL
  });
}));
router8.post("/transactions/confirm", route(async (req, res) => {
  const ids = req.body?.transaction_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw badRequest("`transaction_ids` must be a non-empty array");
  }
  for (const id of ids) {
    if (typeof id !== "string" || !/^\d+$/.test(id)) {
      throw badRequest("every transaction id must be a numeric string");
    }
  }
  const result = await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE allocations al
          SET source = 'user',
              rule_id = NULL,
              -- rule_id says "a rule owns this and the engine manages it", which stops
              -- being true the moment you claim the row. confirmed_from_rule_id says "a
              -- rule proposed this and a human accepted it" \u2014 history, not ownership.
              -- Two facts, two columns; collapsing them is what took every rule in
              -- /reports/by-rule to zero the first time hundreds of rows were confirmed at once.
              confirmed_from_rule_id = r.id,
              confidence = 1,
              note = COALESCE(al.note || ' | ', '') || 'confirmed from rule: ' || r.name
         FROM rules r
        WHERE al.rule_id = r.id
          AND al.source = 'rule'
          AND al.transaction_id = ANY($1::bigint[])
        RETURNING al.transaction_id`,
      [ids]
    );
    return {
      confirmed: updated.rowCount ?? 0,
      transactions: new Set(updated.rows.map((r) => String(r.transaction_id))).size
    };
  });
  return res.json(result);
}));

// src/routes/transfers.ts
import { Router as Router9 } from "express";

// src/transfers/detect.ts
var TRANSFER_WINDOW_DAYS = 2;
var noCounts = () => ({
  resolved: 0,
  pending: 0,
  suspected: 0,
  by_reference: 0,
  by_keyword: 0
});
async function nextTransferGroup(client) {
  const r = await client.query("SELECT nextval('transfer_group_seq') AS g");
  return r.rows[0].g;
}
async function anyUserAllocation(client, ids) {
  const r = await client.query(
    "SELECT 1 FROM allocations WHERE transaction_id = ANY($1) AND source = 'user' LIMIT 1",
    [ids]
  );
  return r.rowCount !== 0;
}
async function linkLegs(client, groupId, status, evidence, legId, legAccountId, partnerId, partnerAccountId) {
  if (status === "resolved") {
    await client.query(
      `DELETE FROM allocations
        WHERE transaction_id = ANY($1) AND source = 'rule'`,
      [[legId, partnerId]]
    );
  }
  await client.query(
    `UPDATE transactions SET transfer_status = $1, transfer_group_id = $2,
            counterparty_account_id = $3, transfer_evidence = $4 WHERE id = $5`,
    [status, groupId, partnerAccountId, evidence, legId]
  );
  await client.query(
    `UPDATE transactions SET transfer_status = $1, transfer_group_id = $2,
            counterparty_account_id = $3, transfer_evidence = $4 WHERE id = $5`,
    [status, groupId, legAccountId, evidence, partnerId]
  );
}
async function releaseProposal(client, legId) {
  const row = (await client.query(
    `SELECT transfer_status, transfer_group_id FROM transactions
        WHERE id = $1 FOR UPDATE`,
    [legId]
  )).rows[0];
  if (row === void 0) return;
  if (row.transfer_status !== "suspected" && row.transfer_status !== "pending") return;
  const clear = `SET transfer_status = NULL, transfer_group_id = NULL,
                     counterparty_account_id = NULL, transfer_evidence = NULL`;
  if (row.transfer_group_id === null) {
    await client.query(`UPDATE transactions ${clear} WHERE id = $1`, [legId]);
  } else {
    await client.query(`UPDATE transactions ${clear} WHERE transfer_group_id = $1`, [
      row.transfer_group_id
    ]);
  }
}
var OPEN_LEG = `transfer_status IS DISTINCT FROM 'resolved'
              AND transfer_status IS DISTINCT FROM 'rejected'`;
async function referencePass(client, accountId, claimed) {
  const counts = noCounts();
  const openRows = (await client.query(
    `SELECT id, account_id, amount_paise, txn_date, narration
         FROM transactions
        WHERE narration IS NOT NULL AND type <> 'opening_balance' AND ${OPEN_LEG}
        ORDER BY id`
  )).rows.map((r) => ({
    id: String(r.id),
    account_id: Number(r.account_id),
    amount_paise: Number(r.amount_paise),
    // BIGINT arrives as a string
    txn_date: r.txn_date,
    narration: r.narration
  }));
  const index = indexByReference(openRows);
  const legs = openRows.filter(
    (r) => r.account_id === accountId && r.amount_paise < 0
  );
  for (const leg of legs) {
    if (claimed.has(leg.id)) continue;
    const match = findReferencePartner(leg, index, TRANSFER_WINDOW_DAYS);
    if (match === null) continue;
    if (claimed.has(match.partner.id)) continue;
    await releaseProposal(client, leg.id);
    await releaseProposal(client, match.partner.id);
    const locked = await anyUserAllocation(client, [leg.id, match.partner.id]);
    const status = locked ? "suspected" : "resolved";
    const groupId = await nextTransferGroup(client);
    await linkLegs(
      client,
      groupId,
      status,
      `reference:${match.reference}`,
      leg.id,
      leg.account_id,
      match.partner.id,
      match.partner.account_id
    );
    claimed.add(leg.id);
    claimed.add(match.partner.id);
    if (status === "resolved") {
      counts.resolved++;
      counts.by_reference++;
    } else {
      counts.suspected++;
    }
  }
  return counts;
}
async function keywordPass(client, accountId, claimed) {
  const counts = noCounts();
  const legs = (await client.query(
    `SELECT id, account_id, amount_paise, txn_date, narration
         FROM transactions
        WHERE account_id = $1 AND narration IS NOT NULL AND ${OPEN_LEG}
        ORDER BY id
        FOR UPDATE`,
    [accountId]
  )).rows;
  const keywords = (await client.query(
    `SELECT account_id, lower(keyword) AS keyword
         FROM account_keywords
        WHERE account_id <> $1 AND kind IN ('account_number', 'upi_handle')`,
    [accountId]
  )).rows;
  if (keywords.length === 0) return counts;
  for (const leg of legs) {
    if (claimed.has(String(leg.id))) continue;
    const narration = String(leg.narration).toLowerCase();
    const match = keywords.find((k) => narration.includes(k.keyword));
    if (match === void 0) continue;
    const counterpartyId = Number(match.account_id);
    const partners = (await client.query(
      `SELECT id FROM transactions
          WHERE account_id = $1 AND amount_paise = $2
            AND txn_date BETWEEN $3::date - $4::int AND $3::date + $4::int
            AND ${OPEN_LEG}
          ORDER BY abs($3::date - txn_date), id`,
      [counterpartyId, -Number(leg.amount_paise), leg.txn_date, TRANSFER_WINDOW_DAYS]
    )).rows.filter((p) => !claimed.has(String(p.id)));
    if (partners.length === 0) {
      await client.query(
        `UPDATE transactions SET transfer_status = 'pending',
           counterparty_account_id = $1, transfer_evidence = $2 WHERE id = $3`,
        [counterpartyId, `keyword:${match.keyword}`, leg.id]
      );
      counts.pending++;
      continue;
    }
    const partner = partners[0];
    const locked = await anyUserAllocation(client, [String(leg.id), String(partner.id)]);
    const status = partners.length === 1 && !locked ? "resolved" : "suspected";
    await releaseProposal(client, String(leg.id));
    await releaseProposal(client, String(partner.id));
    const groupId = await nextTransferGroup(client);
    await linkLegs(
      client,
      groupId,
      status,
      `keyword:${match.keyword}`,
      leg.id,
      Number(leg.account_id),
      partner.id,
      counterpartyId
    );
    claimed.add(String(leg.id));
    claimed.add(String(partner.id));
    if (status === "resolved") {
      counts.resolved++;
      counts.by_keyword++;
    } else {
      counts.suspected++;
    }
  }
  return counts;
}
async function amountDatePass(client, accountId, claimed) {
  const counts = noCounts();
  const legs = (await client.query(
    `SELECT id, account_id, amount_paise, txn_date
         FROM transactions
        WHERE account_id = $1 AND transfer_status IS NULL AND amount_paise < 0
          AND type <> 'opening_balance'
        ORDER BY id
        FOR UPDATE`,
    [accountId]
  )).rows;
  for (const leg of legs) {
    if (claimed.has(String(leg.id))) continue;
    const candidates = (await client.query(
      `SELECT id, account_id FROM transactions
          WHERE account_id <> $1 AND amount_paise = $2
            AND txn_date BETWEEN $3::date - $4::int AND $3::date + $4::int
            AND transfer_status IS NULL
            AND type <> 'opening_balance'
          ORDER BY abs($3::date - txn_date), id`,
      [accountId, -Number(leg.amount_paise), leg.txn_date, TRANSFER_WINDOW_DAYS]
    )).rows.filter((c) => !claimed.has(String(c.id)));
    if (candidates.length === 0) continue;
    const partner = candidates[0];
    const groupId = await nextTransferGroup(client);
    await linkLegs(
      client,
      groupId,
      "suspected",
      "amount+date",
      leg.id,
      Number(leg.account_id),
      partner.id,
      Number(partner.account_id)
    );
    claimed.add(String(leg.id));
    claimed.add(String(partner.id));
    counts.suspected++;
  }
  return counts;
}
var PASSES = [referencePass, keywordPass, amountDatePass];
async function detectTransfers(client, accountIds, claimed) {
  const totals = noCounts();
  for (const pass of PASSES) {
    for (const accountId of accountIds) {
      const counts = await pass(client, accountId, claimed);
      totals.resolved += counts.resolved;
      totals.pending += counts.pending;
      totals.suspected += counts.suspected;
      totals.by_reference += counts.by_reference;
      totals.by_keyword += counts.by_keyword;
    }
  }
  return totals;
}

// src/routes/transfers.ts
var router9 = Router9();
router9.get("/transfers", route(async (req, res) => {
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });
  const rawStatus = req.query.status;
  let status = null;
  if (rawStatus !== void 0) {
    if (typeof rawStatus !== "string" || !TRANSFER_STATUSES.includes(rawStatus)) {
      return res.status(400).json({ error: `status must be one of ${TRANSFER_STATUSES.join(", ")}` });
    }
    status = rawStatus;
  }
  const groupKey = `COALESCE('g:' || t.transfer_group_id::text, 'txn:' || t.id::text)`;
  const statusClause = status === null ? "" : "AND t.transfer_status = $1";
  const statusParams = status === null ? [] : [status];
  const counts = await pool.query(
    `SELECT t.transfer_status AS status,
              COUNT(DISTINCT ${groupKey}) AS groups
         FROM transactions t
        WHERE t.transfer_status IS NOT NULL
        GROUP BY t.transfer_status`
  );
  const groups = await pool.query(
    `SELECT ${groupKey} AS key, MIN(t.txn_date) AS when_at
         FROM transactions t
        WHERE t.transfer_status IS NOT NULL ${statusClause}
        GROUP BY ${groupKey}
        ORDER BY MIN(t.txn_date) DESC, key DESC
        LIMIT $${statusParams.length + 1} OFFSET $${statusParams.length + 2}`,
    [...statusParams, paging.limit, paging.offset]
  );
  const keys = groups.rows.map((r) => r.key);
  const legs = keys.length === 0 ? { rows: [] } : await pool.query(
    `SELECT ${groupKey} AS key, t.id, t.account_id, a.name AS account_name,
                    t.txn_date, t.amount_paise, t.narration, t.type,
                    t.transfer_status, t.transfer_group_id, t.transfer_evidence,
                    t.counterparty_account_id, ca.name AS counterparty_name
               FROM transactions t
               JOIN accounts a ON a.id = t.account_id
               LEFT JOIN accounts ca ON ca.id = t.counterparty_account_id
              WHERE ${groupKey} = ANY($1)
              ORDER BY t.amount_paise, t.id`,
    [keys]
  );
  const byKey = /* @__PURE__ */ new Map();
  for (const l of legs.rows) {
    const list = byKey.get(l.key);
    const leg = {
      id: l.id,
      account_id: Number(l.account_id),
      account_name: l.account_name,
      txn_date: l.txn_date,
      amount_paise: Number(l.amount_paise),
      narration: l.narration,
      type: l.type,
      transfer_status: l.transfer_status,
      transfer_evidence: l.transfer_evidence,
      counterparty_account_id: l.counterparty_account_id === null ? null : Number(l.counterparty_account_id),
      counterparty_name: l.counterparty_name
    };
    if (list === void 0) byKey.set(l.key, [leg]);
    else list.push(leg);
  }
  const totalRow = await pool.query(
    `SELECT COUNT(DISTINCT ${groupKey}) AS n
         FROM transactions t
        WHERE t.transfer_status IS NOT NULL ${statusClause}`,
    statusParams
  );
  res.json({
    groups: groups.rows.map((g) => {
      const groupLegs = byKey.get(g.key) ?? [];
      return {
        key: g.key,
        // Only a real group can be confirmed or rejected — those routes address a
        // group id. A lone pending leg has none, and the UI must not offer buttons
        // that cannot work.
        transfer_group_id: g.key.startsWith("g:") ? Number(g.key.slice(2)) : null,
        status: groupLegs[0]?.transfer_status ?? null,
        // Why this link exists. Both legs always carry the same value, so the group's
        // is the first leg's.
        evidence: groupLegs[0]?.transfer_evidence ?? null,
        txn_date: g.when_at,
        // The magnitude the pair moved. Legs are signed and opposite, so summing them
        // would report every transfer as zero.
        amount_paise: Math.abs(groupLegs[0]?.amount_paise ?? 0),
        legs: groupLegs
      };
    }),
    total: Number(totalRow.rows[0].n),
    limit: paging.limit,
    offset: paging.offset,
    counts: Object.fromEntries(
      counts.rows.map((r) => [r.status, Number(r.groups)])
    )
  });
}));
router9.get("/keywords", route(async (_req, res) => {
  const result = await pool.query(
    `SELECT k.id, k.account_id, a.name AS account_name, k.keyword, k.kind
         FROM account_keywords k
         JOIN accounts a ON a.id = k.account_id
        ORDER BY k.account_id, k.id`
  );
  res.json({
    keywords: result.rows.map((r) => ({
      id: Number(r.id),
      account_id: Number(r.account_id),
      account_name: r.account_name,
      keyword: r.keyword,
      kind: r.kind
    }))
  });
}));
router9.delete("/accounts/:id/keywords/:keywordId", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  const keywordId = intParam(req.params.keywordId, "keyword id");
  const result = await pool.query(
    "DELETE FROM account_keywords WHERE id = $1 AND account_id = $2",
    [keywordId, accountId]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: "no keyword found on that account" });
  }
  return res.json({ deleted: keywordId });
}));
router9.post("/accounts/:id/keywords", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  const { keyword, kind } = req.body ?? {};
  if (!await accountExists(accountId)) throw notFound("account id does not exist");
  if (typeof keyword !== "string" || keyword.trim() === "") {
    return res.status(400).json({ error: "keyword must be a non-empty string" });
  }
  if (!KEYWORD_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of ${KEYWORD_KINDS.join(", ")}` });
  }
  const result = await pool.query(
    `INSERT INTO account_keywords (account_id, keyword, kind)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id, keyword) DO NOTHING
       RETURNING id`,
    [accountId, keyword.trim(), kind]
  );
  if (result.rowCount === 0) {
    return res.status(200).json({ status: "already exists" });
  }
  return res.status(201).json({ id: result.rows[0].id });
}));
router9.get("/accounts/:id/keywords", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  if (!await accountExists(accountId)) {
    return res.status(404).json({ error: "account id does not exist" });
  }
  const result = await pool.query(
    "SELECT id, keyword, kind FROM account_keywords WHERE account_id = $1 ORDER BY id",
    [accountId]
  );
  res.json({ account_id: accountId, keywords: result.rows });
}));
router9.post("/accounts/:id/detect-transfers", route(async (req, res) => {
  const accountId = intParam(req.params.id, "account id");
  if (!await accountExists(accountId)) throw notFound("account id does not exist");
  const result = await withTransaction(async (client) => {
    const counts = await detectTransfers(client, [accountId], /* @__PURE__ */ new Set());
    return { account_id: accountId, ...counts };
  });
  return res.json(result);
}));
router9.post("/transfers/detect", route(async (_req, res) => {
  const result = await withTransaction(async (client) => {
    const accounts = (await client.query("SELECT id FROM accounts ORDER BY id")).rows;
    const ids = accounts.map((a) => Number(a.id));
    const totals = await detectTransfers(client, ids, /* @__PURE__ */ new Set());
    return { accounts: ids.length, ...totals };
  });
  return res.json(result);
}));
router9.post("/transfers/:groupId/confirm", route(async (req, res) => {
  const groupId = intParam(req.params.groupId, "group id");
  const result = await withTransaction(async (client) => {
    const legs = (await client.query(
      `SELECT id FROM transactions
          WHERE transfer_group_id = $1 AND transfer_status = 'suspected'
          ORDER BY id FOR UPDATE`,
      [groupId]
    )).rows;
    if (legs.length === 0) {
      throw notFound("no suspected transfer with that group id");
    }
    const ids = legs.map((l) => l.id);
    const swept = await client.query(
      "DELETE FROM allocations WHERE transaction_id = ANY($1) AND source = 'rule'",
      [ids]
    );
    const userHeld = await client.query(
      "SELECT COUNT(*) AS n FROM allocations WHERE transaction_id = ANY($1)",
      [ids]
    );
    await client.query(
      `UPDATE transactions SET transfer_status = 'resolved', transfer_evidence = 'confirmed'
        WHERE id = ANY($1)`,
      [ids]
    );
    return {
      transfer_group_id: groupId,
      legs: legs.length,
      rule_allocations_removed: swept.rowCount ?? 0,
      user_allocations_kept: Number(userHeld.rows[0].n)
    };
  });
  return res.json(result);
}));
router9.post("/transfers/:groupId/reject", route(async (req, res) => {
  const groupId = intParam(req.params.groupId, "group id");
  const result = await pool.query(
    `UPDATE transactions
          SET transfer_status = 'rejected', transfer_group_id = NULL,
              counterparty_account_id = NULL, transfer_evidence = NULL
        WHERE transfer_group_id = $1 AND transfer_status = 'suspected'`,
    [groupId]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: "no suspected transfer with that group id" });
  }
  return res.json({ transfer_group_id: groupId, legs: result.rowCount });
}));
router9.post("/transactions/:id/unlink-transfer", route(async (req, res) => {
  const txnId = intParam(req.params.id, "transaction id");
  const result = await withTransaction(async (client) => {
    const row = (await client.query(
      "SELECT transfer_group_id FROM transactions WHERE id = $1 FOR UPDATE",
      [txnId]
    )).rows[0];
    if (row === void 0) {
      throw notFound("no transaction found");
    }
    const result2 = row.transfer_group_id === null ? await client.query(
      `UPDATE transactions SET transfer_status = NULL,
               counterparty_account_id = NULL, transfer_evidence = NULL WHERE id = $1`,
      [txnId]
    ) : await client.query(
      `UPDATE transactions SET transfer_status = NULL, transfer_group_id = NULL,
               counterparty_account_id = NULL, transfer_evidence = NULL
             WHERE transfer_group_id = $1`,
      [row.transfer_group_id]
    );
    return { cleared: result2.rowCount ?? 0 };
  });
  return res.json(result);
}));

// src/server.ts
var PORT = Number(process.env.PORT) || 3e3;
var UPLOAD_LIMIT = "10mb";
var DEMO_MODE = process.env.DEMO_MODE === "1";
var app = express();
app.use(express.json());
app.use("/evidence/import", express.raw({ type: "*/*", limit: UPLOAD_LIMIT }));
app.get("/health", (_req, res) => {
  res.json({ ok: true, demo: DEMO_MODE });
});
app.use(router);
app.use(router2);
app.use(router3);
app.use(router4);
app.use(router5);
app.use(router6);
app.use(router7);
app.use(router8);
app.use(router9);
if (process.env.SERVE_WEB === "1") {
  const dist = path2.resolve(import.meta.dirname, "../web/dist");
  app.use(express.static(dist));
  app.get(/.*/, (req, res, next) => {
    if (req.accepts("html") && !req.accepts("json")) {
      return res.sendFile(path2.join(dist, "index.html"));
    }
    return next();
  });
}
app.use(notFoundHandler);
app.use(errorHandler);
if (import.meta.filename === process.argv[1]) {
  app.listen(PORT, () => {
    console.log(`listening on http://localhost:${PORT}`);
  });
  if (!DEMO_MODE) {
    const worker = startWorker({ handler: runLlmReceiptJob });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => {
        void worker.stop().finally(() => process.exit(0));
      });
    }
  }
}

// src/vercel-entry.ts
var vercel_entry_default = app;
export {
  vercel_entry_default as default
};
