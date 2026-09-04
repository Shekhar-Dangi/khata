// Link imported Splitwise records to the bank transactions that paid for them, and write
// the allocations that split those transactions.
//
//   npm run match:splitwise -- --me "Your Name" [--dry-run]
//
// Safe to re-run: already-linked records are skipped, so a second run finds only what the
// first could not. Design in the design.

import { pool } from "../src/db.ts";
import { matchSplitwiseEvidence } from "../src/evidence-detect.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const me = arg("me");
const dryRun = process.argv.includes("--dry-run");
if (!me) {
  console.error('usage: match-splitwise --me "Your Name" [--dry-run]');
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const s = await matchSplitwiseEvidence(client, me);

  // --dry-run still does the work, then throws it away. The alternative is a second code
  // path that only pretends to match, which would be the one place a bug could hide from
  // every test — a rollback exercises exactly what a real run does.
  if (dryRun) await client.query("ROLLBACK");
  else await client.query("COMMIT");

  console.log(`\n  records needing a bank row : ${s.considered}`);
  console.log(`    matched                  : ${s.matched}`);
  console.log(`    ambiguous (queued)       : ${s.ambiguous}`);
  console.log(`    no candidate found       : ${s.noCandidate}`);
  console.log(`  records expecting no cash  : ${s.noCashExpected}  (someone else paid)`);
  console.log(`  allocations written        : ${s.allocationsWritten}`);
  if (s.partiallyAllocated > 0) {
    console.log(`    of which partial         : ${s.partiallyAllocated}  ` +
      `(category unmapped — our share left as unexplained remainder)`);
  }
  console.log(dryRun ? "\n--dry-run: rolled back\n" : "");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
  await pool.end();
}
