/**
 * seed-demo.ts — build a demo database from generated data.
 *
 *   npm run seed:demo            # against DATABASE_URL
 *   npm run seed:demo -- --force # required if the target already holds data
 *
 * This is the ONLY safe way to populate a deployment, and the guard is the point.
 * `scripts/smoke.sh` is documented as unsafe because its cleanup is a full re-seed, and a
 * re-seed pointed at the wrong DATABASE_URL destroys real statements. So this refuses to
 * run against a database that already has transactions unless you say --force, and it says
 * how many it would have destroyed.
 *
 * It applies, in order: schema (fresh DB only), accounts, categories, mock transactions,
 * starter rules. The rules ENGINE is not run here — it lives behind POST /rules/apply and
 * is coupled to the HTTP layer, so the deploy calls it once after boot. Duplicating it in
 * a second place is exactly the drift this codebase keeps guarding against.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { pool } from "../src/db.ts";

const FORCE = process.argv.includes("--force");
/**
 * Drop the schema and build it again from db/schema.sql.
 *
 * WHY IT HAS TO EXIST. Seeding only applies the schema to a database that has no tables, so a
 * deployment seeded months ago keeps whatever schema it was born with. Every table added
 * since then is simply missing, and the endpoints that need one answer 500: that is exactly
 * what happened to the hosted demo, which was seeded before the catalogue, the artifact store
 * and the queue existed. Migrations are the route for a database holding real data. A demo
 * holds generated data, so the honest fix is to build it again.
 */
const REBUILD = process.argv.some((a) => a === "--rebuild" || a.startsWith("--rebuild="));
/**
 * The database name typed after `--rebuild=`, which must match the one actually connected to.
 *
 * WHY A PASSWORD FOR THE DOOR. `--rebuild` drops every table, and the only thing deciding
 * WHICH database that happens to is a connection string passed on a command line. Setting it
 * to the wrong one is not a hypothetical: it destroyed a real ledger, because nothing in the
 * output named the target until after the tables were gone. Typing the name is a second,
 * independent statement of intent that a copied command cannot make for you.
 */
const REBUILD_NAME = process.argv
  .find((a) => a.startsWith("--rebuild="))
  ?.slice("--rebuild=".length);
const HERE = import.meta.dirname;
const sqlFile = (name: string) => path.resolve(HERE, "..", "db", name);

async function run(file: string): Promise<void> {
  const sql = await readFile(sqlFile(file), "utf8");
  await pool.query(sql);
  console.log(`  applied db/${file}`);
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query("SELECT to_regclass($1) AS t", [`public.${name}`]);
  return rows[0].t !== null;
}

async function main() {
  // WHERE, before anything else and whatever the outcome. A destructive command that does not
  // say what it is about to destroy leaves the person running it checking the wrong thing.
  const target = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset");
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  console.log(`target: ${target.username}@${target.hostname}:${target.port || "5432"}/${dbName}\n`);

  let fresh = !(await tableExists("transactions"));

  if (REBUILD && !FORCE) {
    console.error("\n--rebuild DROPS every table. It needs --force as well.\n");
    process.exit(1);
  }

  if (REBUILD && REBUILD_NAME !== dbName) {
    console.error(
      `\nRefusing to rebuild: name the database you mean.\n\n` +
        `  --rebuild=${dbName}\n\n` +
        `This connection points at ${dbName} on ${target.hostname}. Every table in it would be\n` +
        `dropped. If that is a database holding statements you care about, the answer is no:\n` +
        `db/migrations and \`npm run migrate\` are how a real database moves forward.\n`,
    );
    process.exit(1);
  }

  if (!fresh) {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM transactions");
    const existing = rows[0].n as number;
    if (existing > 0 && !FORCE) {
      console.error(
        `\nRefusing to seed: this database already holds ${existing} transactions.\n` +
          `Seeding REPLACES them. If that is genuinely what you want, re-run with --force.\n`,
      );
      process.exit(1);
    }
    if (existing > 0) {
      console.log(`  --force given; replacing ${existing} existing transactions`);
    }
  }

  if (REBUILD && !fresh) {
    // The whole schema, not table by table: the point is to end up with exactly what
    // schema.sql describes, and a list of DROPs maintained by hand is a list that goes stale
    // the same way the schema it is trying to replace did.
    console.log("  --rebuild given; dropping the schema");
    try {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    } catch (e) {
      // Managed Postgres often hands you a role that OWNS the tables without owning the
      // schema they sit in, and dropping a schema you do not own is refused however much
      // you are allowed to do inside it. Dropping the tables themselves needs only what
      // that role already has.
      if (!(e instanceof Error) || !/must be owner|permission denied/i.test(e.message)) throw e;
      console.log(`  cannot drop the schema (${e.message}); dropping its tables instead`);
      await pool.query(`
        DO $$
        DECLARE t RECORD;
        BEGIN
          FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
          LOOP
            EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', t.tablename);
          END LOOP;
        END $$;`);
    }
    fresh = true;
  }

  console.log(fresh ? "fresh database — applying schema" : "existing schema — reseeding data");
  if (fresh) await run("schema.sql");

  // Order matters: seed.sql recreates the accounts the mock rows reference by id, and
  // categories must exist before rules can point at them.
  await run("seed.sql");
  await run("categories.sql");
  await run("mock.sql");
  // AFTER mock.sql, which TRUNCATEs. These are the rows no starter rule matches; without
  // them the demo's unexplained band is three transactions and the chart draws two colours
  // where the model has three.
  await run("demo-unexplained.sql");
  await run("rules.sql");
  // AFTER the transactions, because the orders in it are attached to rows mock.sql inserts.
  await run("demo-evidence.sql");

  const counts = await pool.query(
    `SELECT (SELECT COUNT(*) FROM transactions) AS txns,
            (SELECT COUNT(*) FROM items)        AS items,
            (SELECT COUNT(*) FROM evidence)     AS evidence,
            (SELECT COUNT(*) FROM artifacts WHERE parse_status = 'staged') AS staged`,
  );
  const c = counts.rows[0];
  console.log(
    `\nseeded: ${c.txns} transactions, ${c.items} products, ${c.evidence} records, ` +
      `${c.staged} orders waiting in the inbox\n`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error("\nFAILED: " + (err instanceof Error ? err.message : String(err)));
  await pool.end().catch(() => {});
  process.exit(1);
});
