// Undo a Splitwise import completely, so the whole journey can be walked again from a clean
// state while the UI is built.
//
//   npm run purge:splitwise -- [--group <name>] [--dry-run]
//
// Removes ONLY what importing and matching created. Never touches transactions, rules, or an
// allocation a human made.

import { pool } from "../src/db.ts";
import { normaliseGroup } from "../src/splitwise-plan.ts";

const SOURCE = "splitwise";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

// Through the same normaliser the importer used, or `--group Flat` scopes to a spelling the
// database does not hold and the purge silently removes nothing while reporting success.
const raw = arg("group");
const group = raw === undefined ? undefined : normaliseGroup(raw);
const dryRun = process.argv.includes("--dry-run");
const scope = group ? " AND ev.payload->>'group' = $2" : "";
const params: unknown[] = group ? [SOURCE, group] : [SOURCE];

const client = await pool.connect();
try {
  await client.query("BEGIN");

  // Order matters only for the report; `consumption.evidence_id` cascades on delete, and
  // allocations are removed explicitly because that FK does NOT cascade — an evidence row
  // vanishing out from under a live allocation would be a far worse default.
  const allocations = await client.query(
    `DELETE FROM allocations a USING evidence ev
      WHERE a.evidence_id = ev.id AND a.source = 'evidence' AND ev.source_type = $1${scope}`,
    params,
  );
  const consumption = await client.query(
    `DELETE FROM consumption c USING evidence ev
      WHERE c.evidence_id = ev.id AND ev.source_type = $1${scope}`,
    params,
  );
  const evidence = await client.query(
    `DELETE FROM evidence ev WHERE ev.source_type = $1${scope}`,
    params,
  );

  if (dryRun) await client.query("ROLLBACK");
  else await client.query("COMMIT");

  console.log(`\n  evidence allocations removed : ${allocations.rowCount}`);
  console.log(`  consumption rows removed     : ${consumption.rowCount}`);
  console.log(`  evidence records removed     : ${evidence.rowCount}`);

  // The one thing a purge CANNOT undo, said plainly rather than left to be discovered.
  //
  // Matching displaces the guesses it outranks by DELETING them, so a
  // rule allocation the import overrode is already gone and nothing here brings it back.
  // Re-running the rules engine regenerates it as `source = 'rule'` — provisional again,
  // because whether it was previously confirmed is not recorded anywhere once the row is
  // deleted.
  console.log(
    `\n  NOTE: allocations DISPLACED by matching are not restored — that information is\n` +
    `  gone once the row is deleted. Run POST /rules/apply to regenerate them as\n` +
    `  provisional, then confirm whichever you had confirmed before.`,
  );
  console.log(dryRun ? "\n--dry-run: rolled back\n" : "");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
  await pool.end();
}
