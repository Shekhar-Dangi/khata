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
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
