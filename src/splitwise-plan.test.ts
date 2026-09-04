import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { parseSplitwiseExport, type SplitwiseRow } from "./splitwise.ts";
import { type CategoryMap, externalRef, planImport } from "./splitwise-plan.ts";

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
