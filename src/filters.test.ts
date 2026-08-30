import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isIsoDate, parseFilters, parsePaging } from "./filters.ts";

describe("isIsoDate", () => {
  it("accepts a real date", () => {
    assert.equal(isIsoDate("2026-08-27"), true);
    assert.equal(isIsoDate("2026-01-01"), true);
    assert.equal(isIsoDate("2026-12-31"), true);
  });

  // The reason this function exists. Date.parse("2026-06-31") is NOT NaN — it rolls the
  // day forward and returns a timestamp — so the obvious implementation lets an
  // impossible date through to Postgres, which answers with a 500.
  it("rejects a day the month does not have", () => {
    assert.equal(isIsoDate("2026-06-31"), false); // June has 30
    assert.equal(isIsoDate("2026-02-30"), false);
    assert.equal(isIsoDate("2026-04-31"), false);
  });

  it("knows which years are leap years", () => {
    assert.equal(isIsoDate("2024-02-29"), true); // divisible by 4
    assert.equal(isIsoDate("2025-02-29"), false);
    assert.equal(isIsoDate("2000-02-29"), true); // divisible by 400
    assert.equal(isIsoDate("1900-02-29"), false); // divisible by 100, not 400
  });

  it("rejects an impossible month", () => {
    assert.equal(isIsoDate("2026-13-01"), false);
    assert.equal(isIsoDate("2026-00-10"), false);
  });

  it("rejects day zero", () => {
    assert.equal(isIsoDate("2026-08-00"), false);
  });

  // Being liberal here would mean two callers disagreeing about what a range covers.
  it("rejects everything that is not the ISO shape", () => {
    for (const bad of ["March 3", "2026", "27-08-2026", "2026-8-27", "", "  ", null, 20260827]) {
      assert.equal(isIsoDate(bad), false, `expected ${String(bad)} to be rejected`);
    }
  });
});

describe("parseFilters — dates", () => {
  it("turns from/to into parameterised clauses", () => {
    const r = parseFilters({ from: "2026-08-01", to: "2026-08-31" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.params.length, 2);
    assert.deepEqual(r.params, ["2026-08-01", "2026-08-31"]);
    // Every value reaches SQL as a placeholder; nothing is concatenated in.
    assert.match(r.sql, /t\.txn_date >= \$1/);
    assert.match(r.sql, /t\.txn_date <= \$2/);
  });

  it("allows an open-ended range at either end", () => {
    for (const q of [{ from: "2026-08-01" }, { to: "2026-08-31" }]) {
      const r = parseFilters(q);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.params.length, 1);
    }
  });

  it("rejects an impossible date rather than passing it to the database", () => {
    const r = parseFilters({ from: "2026-06-31" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /YYYY-MM-DD/);
  });

  it("rejects a backwards range", () => {
    const r = parseFilters({ from: "2026-08-31", to: "2026-08-01" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /must not be after/);
  });

  it("accepts a single-day range", () => {
    const r = parseFilters({ from: "2026-08-14", to: "2026-08-14" });
    assert.equal(r.ok, true);
  });

  it("ignores absent and blank dates instead of coercing them", () => {
    const r = parseFilters({ from: "", to: undefined });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.sql, "");
  });

  // Express gives query values as string | string[] | ParsedQs. ?from=a&from=b arrives as
  // an array, and coercing that to a string is how you get a filter nobody asked for.
  it("refuses a repeated parameter rather than coercing the array", () => {
    const r = parseFilters({ from: ["2026-08-01", "2026-08-02"] });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.sql, "");
  });

  it("numbers placeholders from startIndex so a caller's own params survive", () => {
    const r = parseFilters({ from: "2026-08-01" }, 3);
    assert.equal(r.ok, true);
    if (r.ok) assert.match(r.sql, /\$3/);
  });
});

describe("parsePaging", () => {
  it("defaults to 100 from the top", () => {
    const r = parsePaging({});
    assert.deepEqual(r, { ok: true, limit: 100, offset: 0 });
  });

  it("takes a valid limit and offset", () => {
    assert.deepEqual(parsePaging({ limit: "10", offset: "20" }), {
      ok: true,
      limit: 10,
      offset: 20,
    });
  });

  // offset 0 is legal and limit 0 is not, which is why they use different validators.
  it("allows offset 0 but not limit 0", () => {
    assert.equal(parsePaging({ offset: "0" }).ok, true);
    assert.equal(parsePaging({ limit: "0" }).ok, false);
  });

  it("caps the limit", () => {
    assert.equal(parsePaging({ limit: "501" }).ok, false);
    assert.equal(parsePaging({ limit: "500" }).ok, true);
  });

  // Number("") is 0 and Number("abc") is NaN, and neither throws.
  it("rejects anything that is not digits", () => {
    for (const bad of ["abc", "-1", "1.5", "1e3", "0x10", "٥"]) {
      assert.equal(parsePaging({ limit: bad }).ok, false, `limit=${bad}`);
    }
  });

  // Surrounding whitespace is trimmed, not rejected: scalar() does that for every filter,
  // so "%20 5" from a hand-edited URL means 5 here exactly as it does everywhere else.
  it("trims surrounding whitespace", () => {
    assert.deepEqual(parsePaging({ limit: " 5 " }), { ok: true, limit: 5, offset: 0 });
  });

  // A BLANK parameter is not a bad one — `?limit=` is what an empty form field sends, and
  // it means "I did not choose", not "choose zero". scalar() folds it to absent, so the
  // default applies. Rejecting it would 400 the request for a field left untouched.
  it("treats a blank parameter as absent, not as an error", () => {
    assert.deepEqual(parsePaging({ limit: "", offset: "" }), {
      ok: true,
      limit: 100,
      offset: 0,
    });
  });
});
