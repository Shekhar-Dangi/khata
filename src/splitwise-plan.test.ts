import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { parseSplitwiseExport, type SplitwiseRow } from "./splitwise.ts";
import {
  type CategoryMap,
  MAX_GROUP_LENGTH,
  externalRef,
  normaliseGroup,
  planImport,
} from "./splitwise-plan.ts";

const FIXTURE = readFileSync(
  path.join(import.meta.dirname, "fixtures", "splitwise-sample.csv"),
  "utf8",
);
const ME = "Test User Three";
const GROUP = "test-group";

const GROCERIES = 11;
const DINING = 12;
const TAXI = 13;

/** Mirrors the seeded map: real ids for known categories, null for the catch-all. */
const MAP: CategoryMap = new Map<string, number | null>([
  ["Groceries", GROCERIES],
  ["Dining out", DINING],
  ["Taxi", TAXI],
  ["General", null], // deliberately unmappable
  ["Payment", null],
]);

function fixtureRows(): SplitwiseRow[] {
  const result = parseSplitwiseExport(FIXTURE, ME);
  assert.ok(result.ok);
  return result.data.rows;
}

describe("externalRef", () => {
  const row = (over: Partial<SplitwiseRow> = {}) =>
    ({ date: "2026-01-05", description: "Coffee", costPaise: 20000, ...over }) as SplitwiseRow;

  it("is stable across whitespace and case in the description", () => {
    assert.equal(
      externalRef("G", row({ description: "  weekly   Groceries " })),
      externalRef("g", row({ description: "Weekly Groceries" })),
    );
  });

  it("separates two rows that differ only by description", () => {
    assert.notEqual(externalRef(GROUP, row({ description: "Coffee" })),
                    externalRef(GROUP, row({ description: "Snacks" })));
  });

  it("separates the same expense in two different groups", () => {
    assert.notEqual(externalRef("flat", row()), externalRef("trip", row()));
  });
});

describe("planImport", () => {
  it("keeps every row as evidence, including ones the owner is not part of", () => {
    // 8 rows: 7 expenses + 1 settlement, one of which the owner has no share in. Dropping
    // that one would make the footer balances impossible to re-derive from the database.
    const plan = planImport(fixtureRows(), GROUP, MAP);
    assert.equal(plan.evidence.length, 8);
    assert.equal(plan.stats.notMine, 1);
  });

  it("writes consumption ONLY for expenses someone else paid for", () => {
    const plan = planImport(fixtureRows(), GROUP, MAP);
    // Fixture: net<0 on the 3,000 groceries, the 176 taxi, and the 250 General row.
    // General is unmappable, so two consumption rows and one unclassified.
    assert.equal(plan.stats.owedByMe, 3);
    assert.equal(plan.consumption.length, 2);
    assert.equal(plan.unclassified.length, 1);
  });

  it("never writes consumption for an expense the owner paid for", () => {
    // The double-count guard: these get their consumption from allocations once the bank
    // row matches. A stopgap row here would survive the match and be counted twice.
    const plan = planImport(fixtureRows(), GROUP, MAP);
    const paidRefs = new Set(
      plan.evidence.filter((e) => e.kind === "expense" && e.netPaise > 0).map((e) => e.externalRef),
    );
    assert.equal(paidRefs.size, 3);
    for (const c of plan.consumption) {
      assert.ok(!paidRefs.has(c.externalRef), `consumption written for a row we paid: ${c.externalRef}`);
    }
  });

  it("never writes consumption for a settlement", () => {
    const plan = planImport(fixtureRows(), GROUP, MAP);
    assert.equal(plan.stats.payments, 1);
    const settlements = new Set(
      plan.evidence.filter((e) => e.kind === "payment").map((e) => e.externalRef),
    );
    for (const c of plan.consumption) assert.ok(!settlements.has(c.externalRef));
  });

  it("keeps consumption signed as consumed, matching allocations", () => {
    const plan = planImport(fixtureRows(), GROUP, MAP);
    for (const c of plan.consumption) assert.ok(c.amountPaise < 0, "consumed must be negative");
    const groceries = plan.consumption.find((c) => c.categoryId === GROCERIES);
    assert.equal(groceries?.amountPaise, -150000); // half of the 3,000 the flatmate paid
    assert.equal(groceries?.consumedOn, "2026-01-08");
  });

  it("reports an unmappable category as unclassified rather than dropping it", () => {
    const plan = planImport(fixtureRows(), GROUP, MAP);
    assert.equal(plan.unclassified[0].sourceCategory, "General");
    assert.equal(plan.unclassified[0].amountPaise, -12500);
    // 'General' has a row in the map, so it is a settled decision, not a review item.
    assert.deepEqual(plan.unmappedCategories, []);
  });

  it("queues a category with NO row in the map as needing a decision", () => {
    const partial: CategoryMap = new Map([["Groceries", GROCERIES]]);
    const plan = planImport(fixtureRows(), GROUP, partial);
    // Taxi and General are both uncategorised here, but only Taxi is UNKNOWN.
    assert.deepEqual(plan.unmappedCategories, ["General", "Taxi"]);
    assert.equal(plan.unclassified.length, 2);
  });

  it("distinguishes never-seen from deliberately-unmappable", () => {
    // The distinction that stops 'General' sitting in the review queue forever.
    const rows = fixtureRows().filter((r) => r.category === "General");
    const seen = planImport(rows, GROUP, new Map([["General", null]]));
    const unseen = planImport(rows, GROUP, new Map());
    assert.deepEqual(seen.unmappedCategories, []);
    assert.deepEqual(unseen.unmappedCategories, ["General"]);
    // Both still report the amount — the money is real either way.
    assert.equal(seen.unclassified.length, 1);
    assert.equal(unseen.unclassified.length, 1);
  });

  it("accounts for every row exactly once", () => {
    const plan = planImport(fixtureRows(), GROUP, MAP);
    const { paid, owedByMe, notMine, payments } = plan.stats;
    assert.equal(paid + owedByMe + notMine + payments, plan.evidence.length);
    assert.equal(plan.consumption.length + plan.unclassified.length, owedByMe);
  });
});

// The group is the first field of the natural key AND the key the Sources screen groups
// imports by. Those used to be two different strings — `externalRef` lowercased it and
// `payload.group` kept whatever the caller passed — so "Flat" and "flat" were one record and
// two imports. These tests exist to keep them one string.
describe("normaliseGroup", () => {
  it("folds the spellings of one name together", () => {
    for (const spelling of ["Flat", "FLAT", "  flat  ", "flat\t", "  FLAT\n"]) {
      assert.equal(normaliseGroup(spelling), "flat", `${JSON.stringify(spelling)} should fold`);
    }
  });

  it("collapses runs of whitespace, the way the description already is", () => {
    assert.equal(normaliseGroup("my   flat  a101"), "my flat a101");
  });

  // Not cosmetic: the same NAME reaching the key as two different byte sequences is the
  // duplicate this function exists to prevent.
  it("folds the two spellings of a composed character", () => {
    const composed = "test-groupā"; // ā as one code point
    const decomposed = "test-groupā"; // a + combining macron
    assert.equal(normaliseGroup(composed), normaliseGroup(decomposed));
  });

  // A NUL cannot be stored in a Postgres text column at all, so this is the difference
  // between a normalised name and a 500 on import.
  it("drops control characters", () => {
    // Written as escapes, not literal bytes: a NUL in a source file makes git treat the
    // whole file as binary, and a test whose diff nobody can read is worse than no test.
    assert.equal(normaliseGroup("fl\u0000a\u0007t"), "flat");
  });

  // The separator of the composite key. A group containing one would shift every field
  // after it, so two different rows could produce the same ref.
  it("removes the field separator rather than letting it into the key", () => {
    assert.ok(!normaliseGroup("a|b").includes("|"));
    assert.equal(normaliseGroup("a|b"), "a b");
  });

  it("caps the length, so the unique index cannot refuse the row", () => {
    assert.equal(normaliseGroup("x".repeat(500)).length, MAX_GROUP_LENGTH);
  });

  // `slice` cuts UTF-16 units and can halve a surrogate pair, leaving a lone surrogate that
  // Postgres rejects as invalid UTF-8. Counting code points is what avoids that.
  it("caps by code point, never leaving half a character", () => {
    const capped = normaliseGroup("😀".repeat(100));
    assert.equal([...capped].length, MAX_GROUP_LENGTH);
    assert.ok(!/[\uD800-\uDFFF]/.test(capped.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")));
  });

  // Both entry points call it, so it has to survive being applied twice.
  it("is idempotent", () => {
    for (const raw of ["  Flat A|101 ", "😀".repeat(100), "x".repeat(500), "a\u0000b"]) {
      assert.equal(normaliseGroup(normaliseGroup(raw)), normaliseGroup(raw));
    }
  });

  it("answers empty for a name that was only ever separators and space", () => {
    // The route tests THIS value rather than the raw string: "  |  " is a non-empty string
    // and an empty group name.
    assert.equal(normaliseGroup("  |  "), "");
  });
});

describe("planImport — the group it keys by", () => {
  it("reports the normalised name rather than what it was handed", () => {
    const plan = planImport(fixtureRows(), "  Test-Group  ", MAP);
    assert.equal(plan.group, "test-group");
  });

  // The bug this replaces exactly: the ref was lowercased and the payload was not, so the
  // same import could split into two batches in the UI.
  it("puts the SAME string in the payload as in the ref", () => {
    const plan = planImport(fixtureRows(), "Test-Group", MAP);
    for (const e of plan.evidence) {
      assert.equal(e.payload.group, plan.group);
      assert.equal(e.externalRef.split("|")[0], plan.group);
    }
  });

  it("keys two spellings of one group to the same rows", () => {
    const upper = planImport(fixtureRows(), "TEST-GROUP", MAP);
    const lower = planImport(fixtureRows(), "test-group", MAP);
    assert.deepEqual(
      upper.evidence.map((e) => e.externalRef),
      lower.evidence.map((e) => e.externalRef),
    );
    assert.deepEqual(
      upper.evidence.map((e) => e.payload.group),
      lower.evidence.map((e) => e.payload.group),
    );
  });
});
