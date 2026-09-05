import { Pool, types } from "pg";

// Return DATE columns (OID 1082) as raw 'YYYY-MM-DD' strings, not JS Date objects.
// By default pg parses DATE -> Date at local midnight, which JSON-serializes as a
// timezone-shifted ISO timestamp (e.g. 2026-07-03 IST -> "2026-07-02T18:30:00Z").
// We store and compare dates as plain strings, so keep them that way end-to-end.
types.setTypeParser(1082, (value) => value);

// A connection POOL keeps a small set of DB connections open and reuses them.
// Why not just open a connection per query? Because each new connection to Postgres
// costs a TCP handshake + authentication — slow if you do it on every request.
// The pool hands you an already-open connection, you use it, and it goes back in the pool.
//
// `max` is configurable because the right answer depends on how the process is RUN, not on
// what the code does. A long-running server wants a handful of connections it keeps warm.
// A serverless function is the opposite case: many short-lived instances, each with its own
// pool, all pointing at one Postgres — which exhausts connection slots long before it
// exhausts anything else. There the answer is a small max per instance plus a connection
// POOLER in front of the database (Neon's `-pooler` host), and the pooler does the real
// multiplexing.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
});

// WITHOUT THIS, ONE DROPPED IDLE CONNECTION KILLS THE SERVER.
//
// A pooled connection sitting idle can fail with nothing in flight on it: Postgres restarts,
// an admin runs pg_terminate_backend, a laptop sleeps, a firewall reaps an idle socket. `pg`
// reports that by emitting `error` ON THE POOL — and an EventEmitter with no `error` listener
// does not log a warning, it throws. So the whole process dies, taking every in-flight request
// with it, for an event that concerns one connection nobody was using.
//
// It is invisible in development for a long time because it needs an idle connection AND a
// disturbance, and then it looks like the server "just stopped".
//
// Logged and swallowed deliberately. There is nothing to do about it: the pool discards the
// broken client itself and opens a fresh one on the next request, so recovery is automatic and
// the only thing missing was staying alive to see it. A request that was actually USING that
// connection still fails on its own promise and still reaches the error handler — this path is
// only about the idle ones.
pool.on("error", (err) => {
  console.error("[pg] idle client error — the pool will replace it:", err.message);
});
