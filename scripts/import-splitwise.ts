// Import a Splitwise group export into the ledger.
//
//   npm run import:splitwise -- <file.csv> --me "Your Name" [--group <name>] [--dry-run]
//
// The group defaults to the filename stem, which is where the group name actually lives —
// the export does not name the group inside the file. It is part of the natural key, so
// pass --group explicitly if you ever rename the file.
//
// Local-only, like ingest/ingest.py.

import { readFileSync } from "node:fs";
import path from "node:path";

import { pool } from "../src/db.ts";
import { parseSplitwiseExport } from "../src/splitwise.ts";
import { type CategoryMap, planImport } from "../src/splitwise-plan.ts";

const SOURCE = "splitwise";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const rupees = (paise: number) =>
  `${paise < 0 ? "-" : ""}${(Math.abs(paise) / 100).toFixed(2).padStart(10)}`;

async function main() {
  const file = process.argv[2];
  const me = arg("me");
  const dryRun = process.argv.includes("--dry-run");
  if (!file || !me) {
    console.error('usage: import-splitwise <file.csv> --me "Your Name" [--group <name>] [--dry-run]');
    process.exit(1);
  }
  const group = arg("group") ?? path.basename(file).replace(/\.csv$/i, "");

  // ---- parse -----------------------------------------------------------------------------
  const parsed = parseSplitwiseExport(readFileSync(file, "utf8"), me);
  if (!parsed.ok) {
    console.error(`could not parse ${path.basename(file)}:`);
    for (const e of parsed.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  for (const w of parsed.data.warnings) console.warn(`! ${w}`);

  // ---- plan ------------------------------------------------------------------------------
  const mapRows = await pool.query<{ source_category: string; category_id: string | null }>(
    "SELECT source_category, category_id FROM source_category_map WHERE source_type = $1",
    [SOURCE],
  );
  // pg returns BIGINT as a STRING, because a bigint does not fit a JS number. Number() here
  // is safe only because these are category ids in the low thousands — and it must happen
  // exactly once, here, rather than being left to compare unequal against a number later.
  const map: CategoryMap = new Map(
    mapRows.rows.map((r) => [r.source_category, r.category_id === null ? null : Number(r.category_id)]),
  );

  const plan = planImport(parsed.data.rows, group, map);

  console.log(`\n${path.basename(file)} — group "${group}", as ${me}`);
  console.log(`  ${parsed.data.rows.length} rows: ${plan.stats.paid} you paid, ` +
    `${plan.stats.owedByMe} someone else paid for you, ${plan.stats.notMine} not yours, ` +
    `${plan.stats.payments} settlement(s)`);

  if (plan.unmappedCategories.length > 0) {
    console.log(`\n  categories with no mapping yet — these need a decision:`);
    for (const c of plan.unmappedCategories) console.log(`    ${c}`);
  }
  if (plan.unclassified.length > 0) {
    const total = plan.unclassified.reduce((a, u) => a + u.amountPaise, 0);
    console.log(`\n  ${rupees(total)} of consumption is UNCLASSIFIED ` +
      `(${plan.unclassified.length} row(s)) — real money, not yet categorised`);
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written\n");
    return;
  }

  // ---- write -----------------------------------------------------------------------------
  const client = await pool.connect();
  let evidenceWritten = 0;
  let consumptionWritten = 0;
  try {
    await client.query("BEGIN");

    for (const e of plan.evidence) {
      // UPSERT, not insert-or-ignore. A Splitwise expense is a shared editable document —
      // unlike a bank transaction, someone can change it after the fact — so pinning
      // the first version we ever saw would be wrong. Each export is a full snapshot, so
      // the newest one wins.
      await client.query(
        `INSERT INTO evidence (source_type, external_ref, evidence_date, amount_paise, description, payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source_type, external_ref) WHERE external_ref IS NOT NULL DO UPDATE
            SET evidence_date = EXCLUDED.evidence_date,
                amount_paise  = EXCLUDED.amount_paise,
                description   = EXCLUDED.description,
                payload       = EXCLUDED.payload`,
        [SOURCE, e.externalRef, e.date, e.costPaise, e.description, JSON.stringify(e.payload)],
      );
      evidenceWritten++;
    }

    // Regenerate consumption for THIS group's evidence, scoped the way the rules engine
    // scopes its sweep. Two things this must not do: touch another group's rows, and touch
    // a row a human wrote. `source = 'evidence'` is what protects the second — a 'user' row
    // is a decision and re-importing is not allowed to overwrite a decision.
    const deleted = await client.query(
      `DELETE FROM consumption con
        USING evidence ev
        WHERE con.evidence_id = ev.id
          AND con.source = 'evidence'
          AND ev.source_type = $1
          AND ev.payload->>'group' = $2`,
      [SOURCE, plan.group],
    );

    for (const c of plan.consumption) {
      await client.query(
        `INSERT INTO consumption (evidence_id, category_id, amount_paise, consumed_on, source)
         SELECT id, $2, $3, $4, 'evidence' FROM evidence
          WHERE source_type = $1 AND external_ref = $5`,
        [SOURCE, c.categoryId, c.amountPaise, c.consumedOn, c.externalRef],
      );
      consumptionWritten++;
    }

    await client.query("COMMIT");
    console.log(`\n  evidence rows written/updated : ${evidenceWritten}`);
    console.log(`  consumption rows replaced     : ${deleted.rowCount} -> ${consumptionWritten}\n`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

await main();
await pool.end();
