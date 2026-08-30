import type { ErrorRequestHandler, RequestHandler } from "express";
import type { PoolClient } from "pg";

import { pool } from "./db.ts";

// ── shared HTTP plumbing ─────────────────────────────────────────────────────
// The bits every route file needs, so no route file grows its own version.
//
// All of it is in use: `errorHandler` and `notFoundHandler` from server.ts, the rest from
// the route files. The 33 hand-written try/catch blocks and the 10 hand-rolled
// BEGIN/ROLLBACK/release blocks are gone; the four try/catch blocks that remain each map
// Postgres's unique_violation to a 409, which is a real decision rather than boilerplate.

/**
 * Run `fn` inside a database transaction, and get the connection back afterwards
 * whatever happens.
 *
 * Ten routes used to hand-roll this: `pool.connect()`, `BEGIN`, the work, `COMMIT`, a
 * `catch` with `ROLLBACK`, a `finally` with `release()`. Six lines of ceremony around one
 * line of intent, repeated ten times — and the failure mode of getting it wrong is not a
 * visible error. A missed `release()` **leaks a pool connection**: the request succeeds,
 * the next one succeeds, and some time later the pool is exhausted and every request
 * hangs with no error message anywhere. The nastiest bugs are the ones whose symptom is
 * separated from their cause by an hour.
 *
 * Note the ROLLBACK is itself wrapped. If the connection died mid-transaction, ROLLBACK
 * throws too — and an unguarded rollback-in-a-catch replaces the real error with a
 * useless one, which is how you lose the stack trace that would have told you what
 * actually broke.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
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
      // Swallowed on purpose: the ORIGINAL error is the one worth reporting.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * An error that already knows what HTTP status it deserves.
 *
 * Throw it from anywhere — including from inside `withTransaction`, where it rolls back
 * on the way out — and the central handler turns it into the right response. That is the
 * point: a helper three calls deep can refuse a request without having to be handed `res`,
 * and without inventing a return-value convention for "no result, but not an error
 * either".
 */
export class HttpError extends Error {
  status: number;
  /** Extra fields merged into the JSON body — counts, hints, whatever the caller needs. */
  detail: Record<string, unknown>;

  constructor(status: number, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

export const badRequest = (message: string, detail?: Record<string, unknown>) =>
  new HttpError(400, message, detail);
export const notFound = (message: string) => new HttpError(404, message);
export const conflict = (message: string, detail?: Record<string, unknown>) =>
  new HttpError(409, message, detail);

/**
 * Is this Postgres's unique_violation?
 *
 * 23505. Catching it is not defensive noise — it is the only correct way to handle a
 * uniqueness race. Checking "does this name exist?" and then inserting is two statements
 * with a gap between them, and under any concurrency the row can appear in that gap; the
 * constraint is the only thing that actually enforces it. So: try the insert, and turn the
 * violation into the 409 the caller deserves.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === "23505";
}

/**
 * Parse a route parameter that must be a positive integer.
 *
 * `Number("abc")` is NaN and `Number("")` is 0, and **neither throws** — so an unchecked
 * `Number(req.params.id)` reaches Postgres as NaN and comes back as a 500 with a database
 * error in the logs, when what the caller actually sent was a bad request.
 *
 * `/^\d+$/` rather than `Number.isInteger(Number(x))`, because the latter accepts "1.0",
 * " 1 ", "0x10" and "1e3" — all of which are integers to `Number` and none of which is an
 * id anybody typed.
 *
 * The parameter is `unknown` because this guards route params AND query params, and
 * Express types those differently (`string | string[]`, and `ParsedQs` besides). A
 * non-string simply fails the shape test rather than being coerced — the same discipline
 * `filters.ts` applies to every query value.
 */
export function intParam(raw: unknown, what = "id"): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw badRequest(`${what} must be a positive integer`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw badRequest(`${what} must be a positive integer`);
  return n;
}

/**
 * Wrap an async handler so a rejected promise reaches the error handler.
 *
 * Express 5 already forwards async rejections, so this is belt-and-braces rather than
 * strictly required — but it is one line and it makes the intent visible at every route:
 * this handler may throw, and something downstream will deal with it.
 */
export function route(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * The one place a request turns into an error response.
 *
 * Four arguments is what makes Express treat a function as an error handler — drop one
 * and it silently becomes ordinary middleware that never runs. It is not a style choice
 * and TypeScript will not save you, which is why this is typed as `ErrorRequestHandler`.
 *
 * The log line names the request rather than the operation. The 33 hand-written catch
 * blocks each carried their own label ("rule insert failed:"), and losing that would make
 * the logs worse — so the method and URL go in instead, which identifies the failure at
 * least as precisely and cannot fall out of date with the code the way a string does.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // express.json() rejects a malformed body before any handler sees it.
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "request body is not valid JSON" });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...err.detail });
    return;
  }

  // Anything unrecognised is ours, not the caller's. The real detail stays in OUR logs
  // and never reaches the client — an error message is an excellent place to leak a
  // schema, a file path, or a connection string.
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  res.status(500).json({ error: "internal error" });
};

/** Anything unmatched. Registered after every router, before the error handler. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "not found" });
};
