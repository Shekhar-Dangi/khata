import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";

// The migration runner.
//
// A database cannot be deployed, only evolved: `db/schema.sql` describes where we want to
// be, and `db/migrations/*.sql` are the only legal route from wherever a given database
// actually is. This file applies that route, exactly once per migration, and records what
// it did IN THE DATABASE — because a record kept anywhere else (a file, a CI variable,
// your memory) can drift from the thing it describes, and a record that can drift is worse
// than none, since you will trust it.
//
// Usage:
//   npm run migrate            apply everything pending
//   npm run migrate status     show applied / pending, change nothing
//   npm run migrate baseline <file>
//                              record every migration up to and including <file> as
//                              applied WITHOUT running it — for adopting this tool on a
//                              database whose schema is already up to date

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "db", "migrations");

// Any bigint. It names a lock that means nothing to Postgres and everything to us:
// "someone is migrating this database right now". Derived from the app name so two
// different apps sharing a cluster cannot collide.
const LOCK_KEY = 8_314_271_004n;

type Applied = { filename: string; checksum: string; applied_at: Date };

/**
 * Hash the migration's CONTENT, not its bytes.
 *
 * Line endings are not content. Git's `core.autocrlf` checks this repo out with CRLF on
 * Windows and LF on Linux, so the identical migration file has different bytes on two
 * machines — and an un-normalised hash would make the runner refuse to start on CI with
 * "this applied migration has been edited". It has not been edited; it has been checked
 * out. Normalise first, and the checksum means what it claims to mean.
 */
const sha256 = (s: string) =>
  createHash("sha256").update(s.replace(/\r\n/g, "\n")).digest("hex");

/**
 * A SINGLE connection, not a pool — and this is load-bearing.
 *
 * `pg_advisory_lock` is scoped to a SESSION, i.e. to one connection. With a pool, the lock
 * could be taken on one connection while the migrations run on another, so the lock would
 * be guarding nothing at all while appearing to work perfectly. A serial migration run
 * wants exactly one connection anyway.
 */
async function connect(): Promise<Client> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Run via `npm run migrate` so .env is loaded.");
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

/**
 * The ledger. `filename` is the PRIMARY KEY, which is not incidental: it is a
 * database-enforced guarantee that a migration cannot be recorded twice, even if two
 * runners somehow race past the advisory lock.
 *
 * `checksum` exists so that EDITING an applied migration is caught. The filename is the
 * identity, so an edited file would otherwise be skipped forever — leaving two databases
 * both claiming to be at "002" with different schemas, and nothing able to notice.
 */
async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function readMigrations(): Promise<{ filename: string; sql: string }[]> {
  let names: string[];
  try {
    names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith(".sql"));
  } catch {
    console.error(`No migrations directory at ${MIGRATIONS_DIR}`);
    process.exit(1);
  }
  // Lexicographic order IS the intended order, because the files are zero-padded
  // (001, 002 … 010). Migrations are a sequence, not a set: 002 is not a description of a
  // change, it is a description of a change FROM a specific starting point.
  names.sort();
  return Promise.all(
    names.map(async (filename) => ({
      filename,
      sql: await readFile(path.join(MIGRATIONS_DIR, filename), "utf8"),
    })),
  );
}

async function readLedger(client: Client): Promise<Map<string, Applied>> {
  const { rows } = await client.query<Applied>(
    "SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename",
  );
  return new Map(rows.map((r) => [r.filename, r]));
}

/**
 * Refuse to do anything if an already-applied file has changed on disk.
 *
 * This is the check that makes "never edit an applied migration" enforceable rather than
 * merely advised. Without it the edit is silent, and silence is the whole problem.
 */
function verifyChecksums(
  files: { filename: string; sql: string }[],
  ledger: Map<string, Applied>,
): void {
  const onDisk = new Map(files.map((f) => [f.filename, f]));
  const changed: string[] = [];
  const missing: string[] = [];

  for (const [filename, applied] of ledger) {
    const file = onDisk.get(filename);
    if (file === undefined) {
      missing.push(filename);
    } else if (sha256(file.sql) !== applied.checksum) {
      changed.push(filename);
    }
  }

  if (missing.length > 0) {
    console.warn(
      `warning: applied but no longer on disk: ${missing.join(", ")}\n` +
        "  The database says these ran. Deleting a migration does not un-apply it.",
    );
  }
  if (changed.length > 0) {
    console.error(
      `refusing to run — these applied migrations have been edited:\n` +
        changed.map((f) => `  ${f}`).join("\n") +
        "\n\nThe filename is the identity, so an edited file is skipped forever and this\n" +
        "database silently diverges from every other one at the same version.\n" +
        "Revert the edit and add a new migration instead.",
    );
    process.exit(1);
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

async function status(client: Client): Promise<void> {
  const files = await readMigrations();
  const ledger = await readLedger(client);
  verifyChecksums(files, ledger);

  if (files.length === 0) return console.log("no migrations found");
  for (const { filename } of files) {
    const applied = ledger.get(filename);
    console.log(
      applied
        ? `  applied  ${filename}  ${applied.applied_at.toISOString().slice(0, 19).replace("T", " ")}`
        : `  PENDING  ${filename}`,
    );
  }
  const pending = files.filter((f) => !ledger.has(f.filename)).length;
  console.log(pending === 0 ? "\nup to date" : `\n${pending} pending`);
}

async function apply(client: Client): Promise<void> {
  const files = await readMigrations();
  const ledger = await readLedger(client);
  verifyChecksums(files, ledger);

  const pending = files.filter((f) => !ledger.has(f.filename));
  if (pending.length === 0) return console.log("up to date — nothing to apply");

  for (const { filename, sql } of pending) {
    process.stdout.write(`  applying ${filename} … `);
    try {
      // ONE transaction containing both the migration and its record.
      //
      // Not two. If applying and recording were separate, a crash between them would
      // leave the migration applied but not recorded, and the next run would apply it a
      // second time — which is survivable for defensive DDL and silent corruption for a
      // data migration. The fix is not a smaller window; it is no window.
      //
      // This is only possible because Postgres has TRANSACTIONAL DDL. In MySQL or Oracle
      // a CREATE/ALTER implicitly commits, so a migration that fails halfway leaves a
      // state that exists in no migration file.
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
        [filename, sha256(sql)],
      );
      await client.query("COMMIT");
      console.log("ok");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.log("FAILED");
      console.error(`\n${filename} failed and was rolled back in full:\n`, error);
      console.error("\nNothing after it was attempted. Fix the file and run again.");
      process.exit(1);
    }
  }
  console.log(`\napplied ${pending.length} migration(s)`);
}

/**
 * Record migrations as applied WITHOUT running them.
 *
 * The one command that lies to the ledger, and it exists for one honest reason: adopting
 * this tool on a database whose schema is ALREADY up to date. Khata's 001 and 002 were
 * applied by hand before this runner existed. Re-running them would work — both are
 * written defensively — but relying on that is exactly the trap: `IF NOT EXISTS` makes a
 * migration safe to RETRY, not safe to RE-APPLY, and 002 carries a data backfill.
 *
 * Takes a filename and marks everything up to and including it, because "already applied"
 * is always a prefix of the sequence.
 */
async function baseline(client: Client, through: string): Promise<void> {
  const files = await readMigrations();
  const index = files.findIndex((f) => f.filename === through);
  if (index === -1) {
    console.error(
      `no such migration: ${through}\navailable:\n` +
        files.map((f) => `  ${f.filename}`).join("\n"),
    );
    process.exit(1);
  }

  const ledger = await readLedger(client);
  const toMark = files.slice(0, index + 1).filter((f) => !ledger.has(f.filename));
  if (toMark.length === 0) return console.log("already recorded — nothing to do");

  console.log("recording as applied WITHOUT running:");
  await client.query("BEGIN");
  for (const { filename, sql } of toMark) {
    await client.query(
      "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
      [filename, sha256(sql)],
    );
    console.log(`  ${filename}`);
  }
  await client.query("COMMIT");
  console.log(
    `\nrecorded ${toMark.length}. Verify the schema matches db/schema.sql — this command\n` +
      "asserted that it does; it did not check.",
  );
}

// ── entry point ──────────────────────────────────────────────────────────────

const [command = "apply", arg] = process.argv.slice(2);
const client = await connect();
let locked = false;

try {
  // `try_` rather than the blocking `pg_advisory_lock`: a second runner should say so and
  // exit, not hang. On a deploy that boots three instances at once this is the normal
  // case, not an edge one.
  const { rows } = await client.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS ok",
    [LOCK_KEY.toString()],
  );
  locked = rows[0]!.ok;
  if (!locked) {
    console.error("another migration run holds the lock on this database — exiting");
    process.exit(1);
  }

  await ensureLedger(client);

  switch (command) {
    case "apply":
      await apply(client);
      break;
    case "status":
      await status(client);
      break;
    case "baseline":
      if (!arg) {
        console.error("usage: npm run migrate baseline <filename>");
        process.exit(1);
      }
      await baseline(client, arg);
      break;
    default:
      console.error(`unknown command: ${command}\nusage: migrate [apply|status|baseline <file>]`);
      process.exit(1);
  }
} finally {
  // Advisory locks are released when the session ends anyway, so this is belt-and-braces
  // — but a long-lived process that forgets would hold it until the connection drops.
  if (locked) await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY.toString()]);
  await client.end();
}
