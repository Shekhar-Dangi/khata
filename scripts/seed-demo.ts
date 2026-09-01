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
  const fresh = !(await tableExists("transactions"));

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

  console.log(fresh ? "fresh database — applying schema" : "existing schema — reseeding data");
  if (fresh) await run("schema.sql");

  // Order matters: seed.sql recreates the accounts the mock rows reference by id, and
  // categories must exist before rules can point at them.
  await run("seed.sql");
  await run("categories.sql");
  await run("mock.sql");
  await run("rules.sql");

  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM transactions");
  console.log(`\nseeded: ${rows[0].n} transactions\n`);
  await pool.end();
}

main().catch(async (err) => {
  console.error("\nFAILED: " + (err instanceof Error ? err.message : String(err)));
  await pool.end().catch(() => {});
  process.exit(1);
});
