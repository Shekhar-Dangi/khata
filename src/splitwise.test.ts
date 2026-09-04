import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { parseSplitwiseExport, toPaise } from "./splitwise.ts";

const FIXTURE = readFileSync(
  path.join(import.meta.dirname, "fixtures", "splitwise-sample.csv"),
  "utf8",
);
const ME = "Test User Three";

/** Parse the fixture and fail loudly with the actual errors if it did not parse. */
function parseFixture(csv = FIXTURE, me = ME) {
  const result = parseSplitwiseExport(csv, me);
  assert.ok(result.ok, `expected a successful parse, got: ${JSON.stringify(result)}`);
  return result.data;
}

/** Swap one cell of the fixture, to build a corrupt variant from a known-good file. */
function editCell(csv: string, line: number, column: number, value: string): string {
  const lines = csv.split("\n");
  const cells = lines[line].split(",");
  cells[column] = value;
  lines[line] = cells.join(",");
  return lines.join("\n");
}

describe("toPaise", () => {
  it("converts decimals without floating-point multiplication", () => {
    assert.equal(toPaise("4000.00"), 400000);
    assert.equal(toPaise("176.00"), 17600);
    assert.equal(toPaise("0.01"), 1);
    assert.equal(toPaise("-580.50"), -58050);
    assert.equal(toPaise("1,234.56"), 123456);
    assert.equal(toPaise("100"), 10000);
  });

  it("pads a single decimal place rather than reading it as paise", () => {
    assert.equal(toPaise("1.5"), 150); // one rupee fifty, NOT one rupee five paise
  });

  it("returns null for a whitespace-only cell — the footer trap", () => {
    // This is the whole reason toPaise exists instead of Number(). Number(" ") is 0, so a
    // naive parser turns the Total balance footer into a zero-cost expense.
    assert.equal(Number(" "), 0);
    assert.equal(toPaise(" "), null);
    assert.equal(toPaise(""), null);
  });

  it("rejects malformed amounts rather than coercing them", () => {
    for (const bad of ["₹100", "1.234", "abc", "1e3", "--5", "1,23.00", "0x10"]) {
      assert.equal(toPaise(bad), null, `expected null for ${bad}`);
    }
  });
});

describe("parseSplitwiseExport", () => {
  it("parses the fixture: 8 data rows, 3 people, footer excluded", () => {
    const data = parseFixture();
    assert.deepEqual(data.people, ["Test User One", "Test User Two", "Test User Three"]);
    assert.equal(data.rows.length, 8);
    assert.equal(data.balances.length, 3);
  });

  it("reconciles every person's rows against the stated footer balance", () => {
    // The single most valuable assertion here: it catches a dropped row, a sign error, and
    // the footer being parsed as an expense, all at once.
    const data = parseFixture();
    assert.deepEqual(data.warnings, []);
    for (const { person, balancePaise } of data.balances) {
      const summed = data.rows.reduce((a, r) => a + r.netsPaise[person], 0);
      assert.equal(summed, balancePaise, `${person} does not reconcile`);
    }
  });

  it("classifies a Category = Payment row as a settlement, not an expense", () => {
    const data = parseFixture();
    const payments = data.rows.filter((r) => r.kind === "payment");
    assert.equal(payments.length, 1);
    assert.equal(payments[0].description, "Settle up");
    assert.equal(data.rows.filter((r) => r.kind === "expense").length, 7);
  });

  it("reads the caller's own column by name", () => {
    // Same file, different owner: every net flips to that person's perspective.
    const mine = parseFixture().rows;
    const theirs = parseFixture(FIXTURE, "Test User Two").rows;
    assert.equal(mine[0].netPaise, 200000);
    assert.equal(theirs[0].netPaise, -200000);
  });

  it("keeps the raw source category and does not map it", () => {
    const data = parseFixture();
    assert.deepEqual(
      [...new Set(data.rows.map((r) => r.category))].sort(),
      ["Dining out", "General", "Groceries", "Payment", "Taxi"],
    );
  });

  it("keeps two same-day same-cost rows apart", () => {
    const sameDay = parseFixture().rows.filter((r) => r.date === "2026-01-22");
    assert.equal(sameDay.length, 2);
    assert.deepEqual(sameDay.map((r) => r.description), ["Coffee", "Snacks"]);
  });

  it("numbers rows for error messages without counting the footer", () => {
    const data = parseFixture();
    assert.deepEqual(data.rows.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("handles CRLF, a UTF-8 BOM, and quoted fields containing commas", () => {
    const csv =
      "﻿Date,Description,Category,Cost,Currency,Alice,Bob\r\n" +
      '2026-01-05,"Dinner, drinks and a cab",Dining out,1000.00,INR,500.00,-500.00\r\n';
    const result = parseSplitwiseExport(csv, "Alice");
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.data.people[0], "Alice"); // BOM did not corrupt the header
    assert.equal(result.data.rows[0].description, "Dinner, drinks and a cab");
    assert.equal(result.data.rows[0].costPaise, 100000);
  });

  it("accepts a doubled quote as an escaped quote", () => {
    const csv =
      "Date,Description,Category,Cost,Currency,Alice,Bob\n" +
      '2026-01-05,"He said ""hi""",General,100.00,INR,50.00,-50.00\n';
    const result = parseSplitwiseExport(csv, "Alice");
    assert.ok(result.ok);
    assert.equal(result.data.rows[0].description, 'He said "hi"');
  });
});

describe("parseSplitwiseExport — rejects corrupt files", () => {
  const cases: [string, string, RegExp][] = [
    ["an empty file", "", /empty/],
    [
      "a file that is not a Splitwise export",
      "Txn Date,Narration,Debit,Credit\n2026-01-01,something,10,0\n",
      /does not look like a Splitwise group export/,
    ],
    [
      "a header with no people",
      "Date,Description,Category,Cost,Currency\n",
      /no person columns/,
    ],
    [
      "a truncated quoted field",
      'Date,Description,Category,Cost,Currency,Alice,Bob\n2026-01-05,"unclosed,General,1.00,INR,0.50,-0.50\n',
      /truncated/,
    ],
    [
      "two people with the same name",
      "Date,Description,Category,Cost,Currency,Alice,Alice\n",
      /duplicate person column/,
    ],
  ];

  for (const [name, csv, expected] of cases) {
    it(`rejects ${name}`, () => {
      const result = parseSplitwiseExport(csv, "Alice");
      assert.equal(result.ok, false);
      assert.ok(
        result.errors.some((e) => expected.test(e)),
        `expected an error matching ${expected}, got: ${result.errors.join(" | ")}`,
      );
    });
  }

  it("rejects an owner who is not in the export, and lists who is", () => {
    const result = parseSplitwiseExport(FIXTURE, "Someone Else");
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /Test User One, Test User Two, Test User Three/);
  });

  it("rejects a ragged row rather than shifting every column after the gap", () => {
    const csv = FIXTURE.replace(
      "2026-01-20,Auto,Taxi,176.00,INR,0.00,176.00,-176.00",
      "2026-01-20,Auto,Taxi,176.00,INR,0.00,176.00",
    );
    const result = parseSplitwiseExport(csv, ME);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /has 7 columns, header has 8/);
  });

  it("reports the TRUE file line, not the index after blank lines are dropped", () => {
    // The fixture has a blank line 2, so its first data row is file line 3. An error message
    // that said "row 2" would send you to look at a line that is fine.
    const result = parseSplitwiseExport(editCell(FIXTURE, 2, 3, "0.00"), ME);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /^line 3:/);
  });

  it("rejects a date that looks well-formed but does not exist", () => {
    const result = parseSplitwiseExport(editCell(FIXTURE, 2, 0, "2026-02-30"), ME);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /not a valid YYYY-MM-DD date/);
  });

  it("rejects shares that do not sum to zero", () => {
    // Break the accounting identity: one participant's share altered on its own.
    const result = parseSplitwiseExport(editCell(FIXTURE, 2, 6, "-1999.00"), ME);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /shares sum to .* expected 0/);
  });

  it("rejects a share larger than the cost", () => {
    const csv =
      "Date,Description,Category,Cost,Currency,Alice,Bob\n" +
      "2026-01-05,Impossible,General,100.00,INR,500.00,-500.00\n";
    const result = parseSplitwiseExport(csv, "Alice");
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /exceeds the cost/);
  });

  it("rejects a non-positive cost", () => {
    const result = parseSplitwiseExport(editCell(FIXTURE, 2, 3, "0.00"), ME);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /is not a positive amount/);
  });
});

describe("parseSplitwiseExport — warns without blocking", () => {
  it("warns when the rows do not reconcile against the footer", () => {
    // A row removed: still a well-formed file, so it parses — but the totals disagree and
    // the warning says by exactly how much, the way the reconciliation walk does.
    const csv = FIXTURE.replace("2026-01-20,Auto,Taxi,176.00,INR,0.00,176.00,-176.00\n", "");
    const result = parseSplitwiseExport(csv, ME);
    assert.ok(result.ok);
    assert.equal(result.data.rows.length, 7);
    assert.ok(result.data.warnings.some((w) => /rows sum to .* footer states/.test(w)));
  });

  it("warns when there is no footer to verify against", () => {
    const csv = FIXTURE.replace(/^2026-01-31,Total balance.*$/m, "");
    const result = parseSplitwiseExport(csv, ME);
    assert.ok(result.ok);
    assert.ok(result.data.warnings.some((w) => /could not be verified/.test(w)));
  });

  it("warns on mixed currencies", () => {
    const csv =
      "Date,Description,Category,Cost,Currency,Alice,Bob\n" +
      "2026-01-05,Rupees,General,100.00,INR,50.00,-50.00\n" +
      "2026-01-06,Dollars,General,100.00,USD,50.00,-50.00\n";
    const result = parseSplitwiseExport(csv, "Alice");
    assert.ok(result.ok);
    assert.ok(result.data.warnings.some((w) => /mixed currencies/.test(w)));
  });
});
