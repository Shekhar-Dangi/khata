import { Pool } from "pg";

// A connection POOL keeps a small set of DB connections open and reuses them.
// Why not just open a connection per query? Because each new connection to Postgres
// costs a TCP handshake + authentication — slow if you do it on every request.
// The pool hands you an already-open connection, you use it, and it goes back in the pool.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
