import { createServer, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";

import { pool } from "./db.ts";

const PORT = Number(process.env.PORT) || 3000;

async function readJSONBody(req: IncomingMessage): Promise<any> {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8");
  return JSON.parse(raw);
}

// Fingerprint a transaction by its identifying fields, so re-imports can be deduped.
// Same fields -> same hash, every time (deterministic). Paired with a UNIQUE constraint.
function transactionHash(accountId: number, t: any): string {
  const key = [accountId, t.txn_date, t.txn_time ?? "", t.amount_paise, t.narration ?? ""].join("|");
  return createHash("sha256").update(key).digest("hex");
}

// createServer takes ONE function that runs on every incoming request.
//   req = the incoming request  (method, url, headers, and the body as a stream)
//   res = the response we build (status code, headers, body) and send back
const server = createServer(async (req, res) => {
  // A trivial "is the server alive?" endpoint — our worked example. Study it.
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const transactionMatch =
    req.method === "POST"
      ? req.url?.match(/^\/accounts\/(\d+)\/transactions$/)
      : null;

  if (transactionMatch) {
    const accountId = Number(transactionMatch[1]);

    // Step 2: read + parse the body (bad JSON -> 400).
    let body: any;
    try {
      body = await readJSONBody(req);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "request body is not valid JSON" }));
      return;
    }

    // Step 3: validate the WHOLE batch BEFORE touching the DB (all-or-nothing).
    // L0 envelope:
    if (!Array.isArray(body?.transactions) || body.transactions.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "`transactions` must be a non-empty array" }),
      );
      return;
    }

    // Per-row checks. Collect ALL errors (no break) so the client sees everything.
    const ALLOWED_TYPES = ["opening_balance", "transfer", "regular"];
    const errors: string[] = [];
    body.transactions.forEach((t: any, i: number) => {
      if (t === null || typeof t !== "object") {
        errors.push(`row ${i}: must be an object`);
        return; // skip this row's remaining checks, keep checking the others
      }
      // amount_paise: integer (this single check rejects missing/string/float) and non-zero.
      if (!Number.isInteger(t.amount_paise)) {
        errors.push(`row ${i}: amount_paise must be an integer (paise, signed)`);
      } else if (t.amount_paise === 0) {
        errors.push(`row ${i}: amount_paise must not be zero`);
      }
      // txn_date: a parseable date string.
      if (typeof t.txn_date !== "string" || Number.isNaN(Date.parse(t.txn_date))) {
        errors.push(`row ${i}: txn_date must be a valid date string (YYYY-MM-DD)`);
      }
      // type: one of the allowed values.
      if (!ALLOWED_TYPES.includes(t.type)) {
        errors.push(`row ${i}: type must be one of ${ALLOWED_TYPES.join(", ")}`);
      }
    });
    if (errors.length > 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errors }));
      return;
    }

    // Step 4: insert the whole batch in ONE transaction (all-or-nothing).
    // ON CONFLICT (import_hash) DO NOTHING makes re-import idempotent: a row we've
    // already seen is silently skipped instead of erroring or double-counting.
    const client = await pool.connect(); // one connection, held for the transaction
    try {
      await client.query("BEGIN");
      let inserted = 0;
      for (const t of body.transactions) {
        const result = await client.query(
          `INSERT INTO transactions
             (account_id, txn_date, txn_time, amount_paise, type, narration, import_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (import_hash) DO NOTHING`,
          [
            accountId, t.txn_date, t.txn_time ?? null, t.amount_paise,
            t.type, t.narration ?? null, transactionHash(accountId, t),
          ],
        );
        if (result.rowCount && result.rowCount > 0) inserted++; // rowCount 0 = skipped dupe
      }
      await client.query("COMMIT");
      const skipped = body.transactions.length - inserted;
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ inserted, skipped }));
    } catch (err) {
      await client.query("ROLLBACK"); // anything failed -> undo the WHOLE batch
      console.error("import failed:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "import failed" }));
    } finally {
      client.release(); // ALWAYS return the connection to the pool
    }
    return;
  }

  // GET /accounts/:id/balance — compute the account's balance from its transactions.
  const balanceMatch =
    req.method === "GET"
      ? req.url?.match(/^\/accounts\/(\d+)\/balance$/)
      : null;
  if (balanceMatch) {
    const accountId = balanceMatch[1]; // the captured digits from the URL
    const result = await pool.query(
      // $1 is a PARAMETER: the value travels separately and can never be executed
      // as SQL. COALESCE(..., 0) turns "no transactions" (SUM = NULL) into 0.
      "SELECT COALESCE(SUM(amount_paise), 0) AS balance_paise FROM transactions WHERE account_id = $1",
      [accountId],
    );
    // result.rows is the data; BIGINT comes back as a string, so convert to a number.
    const balancePaise = Number(result.rows[0].balance_paise);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        account_id: Number(accountId),
        balance_paise: balancePaise,
      }),
    );
    return;
  }

  // OBSERVATION ENDPOINT — logs the request body as it streams in, chunk by chunk.
  if (req.method === "POST" && req.url === "/observe") {
    const t0 = Date.now();
    console.log(
      `\n[+0ms] handler fired — headers are in. content-length=${req.headers["content-length"] ?? "(none)"}`,
    );
    let chunkCount = 0;
    let totalBytes = 0;
    // req is a Readable STREAM. Each 'data' event = one chunk the kernel handed us.
    req.on("data", (chunk) => {
      chunkCount++;
      totalBytes += chunk.length;
      console.log(
        `[+${Date.now() - t0}ms]   chunk #${chunkCount}: ${chunk.length} bytes (running total ${totalBytes})`,
      );
    });
    // 'end' fires when the whole body has arrived.
    req.on("end", () => {
      console.log(
        `[+${Date.now() - t0}ms] end — ${chunkCount} chunk(s), ${totalBytes} bytes total`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ chunks: chunkCount, bytes: totalBytes }));
    });
    return;
  }

  // Nothing matched → 404.
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
});
