// Splitwise group-export parser — pure, DB-free, no dependencies.
//
// This file does ONE thing:
// turn the bytes of an export into validated records. It deliberately does NOT:
//
//   - map the source's category onto ours (that is a table, downstream, and keeping it out
//     of here means changing the map never requires re-parsing anything)
//   - decide what is an expense vs a receivable (that needs the bank: the export carries
//     only a net figure per person, and the bank is what shows who actually paid)
//   - touch the database
//
// It is TypeScript rather than Python — unlike the PDF/xlsx statement parsers in `ingest/`,
// which are there because they need pdfplumber and openpyxl. A CSV needs no library, so
// there is no reason to cross a language boundary and lose the test suite.

/** One expense or settlement row. Money is integer paise throughout, never a float. */
export type SplitwiseRow = {
  /** 1-based position among data rows — for error messages, and a tiebreak for the natural key. */
  seq: number;
  /** YYYY-MM-DD, validated as a real calendar date. */
  date: string;
  description: string;
  /** The RAW source category. Unmapped on purpose — see the header comment. */
  category: string;
  currency: string;
  /** Always positive. */
  costPaise: number;
  /** Every participant's net, by name. Positive = they gave value. */
  netsPaise: Record<string, number>;
  /** The caller's own net, lifted out of `netsPaise` for convenience. */
  netPaise: number;
  /**
   * A settlement is `Category = Payment` and is NOT an expense: it moves money between
   * people rather than recording consumption. Counting one as spend double-counts, because
   * the consumption was already recorded when the underlying expenses happened.
   */
  kind: "expense" | "payment";
};

export type SplitwiseBalance = { person: string; balancePaise: number };

export type SplitwiseExport = {
  people: string[];
  rows: SplitwiseRow[];
  /** From the `Total balance` footer. Empty if the export had none. */
  balances: SplitwiseBalance[];
  /**
   * Non-fatal. The data is usable; something is worth a human's attention. Kept separate
   * from errors on the same principle as reconciliation: a mismatch is REPORTED, never
   * allowed to silently corrupt, and never used to block an otherwise valid import.
   */
  warnings: string[];
};

export type ParseResult =
  | { ok: true; data: SplitwiseExport }
  | { ok: false; errors: string[] };

/** The five fixed columns, in order, before the per-person columns begin. */
const FIXED_COLUMNS = ["Date", "Description", "Category", "Cost", "Currency"] as const;
const PERSON_COLUMN_START = FIXED_COLUMNS.length;

/** Splitwise's own marker for a settle-up. Its category vocabulary is closed, so a user
 *  cannot create a category that collides with this. */
const PAYMENT_CATEGORY = "payment";

/** The footer row's Description. Its numeric cells hold a SPACE, not an empty string. */
const FOOTER_DESCRIPTION = "total balance";

/**
 * RFC 4180-ish CSV tokenizer.
 *
 * Written by hand rather than split(',') because a description containing a comma —
 * "Dinner, drinks and cab" — is quoted in the file, and a naive split shifts every column
 * after it. On a money file that means amounts landing in the wrong person's column, which
 * is a silent wrong answer rather than a crash.
 *
 * Handles: quoted fields, "" as an escaped quote inside one, embedded commas and newlines,
 * CRLF and LF, and a UTF-8 BOM (a browser-generated export commonly carries one, and an
 * unstripped BOM makes the first header cell "﻿Date" — which then fails to match
 * "Date" for reasons invisible in any diff).
 *
 * Returns null if a quoted field is never closed, which means the file is truncated.
 */
function tokenizeCsv(text: string): string[][] | null {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; continue; }  // "" -> literal "
        inQuotes = false;
        continue;
      }
      field += ch;                       // includes \r and \n: they are data inside quotes
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;           // only reached OUTSIDE quotes, so CRLF is safe here
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }

  if (inQuotes) return null;
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Decimal string -> integer paise, or null if it is not a well-formed amount.
 *
 * Never multiplies a float. `4000.00 * 100` is not reliably 400000 in IEEE 754, and a
 * rounding error in a ledger is the kind of bug you find months later in a total that is
 * off by a rupee. Split on the decimal point and do integer arithmetic instead.
 *
 * Returns null — NOT 0 — for a blank or whitespace-only cell. This is the single most
 * important line in the file: the `Total balance` footer's numeric cells contain a SPACE,
 * and `Number(" ")` is 0 rather than NaN. A parser that used Number() would not fail on the
 * footer, it would quietly emit a zero-cost expense carrying everyone's running balances as
 * their shares.
 *
 * Strict on shape by design. Thousands separators are accepted because a large INR amount
 * plausibly carries them, but anything else (a currency symbol, three decimal places, an
 * exponent) is rejected rather than coerced — on money, failing loudly beats guessing.
 */
export function toPaise(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  if (!/^-?(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/.test(s)) return null;

  const negative = s.startsWith("-");
  const [whole, frac = ""] = (negative ? s.slice(1) : s).replace(/,/g, "").split(".");
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return negative ? -paise : paise;
}

/**
 * YYYY-MM-DD, and a REAL date. The regex alone accepts 2026-02-30; round-tripping through
 * Date catches it, because JS rolls that over to March 2 rather than rejecting it.
 */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Parse a Splitwise group export.
 *
 * @param csv  the file's text
 * @param me   which person column is the ledger owner's. Matched EXACTLY against the header
 *             (trimmed): guessing here would silently attribute someone else's shares.
 */
export function parseSplitwiseExport(csv: string, me: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const table = tokenizeCsv(csv);
  if (table === null) {
    return { ok: false, errors: ["file ends inside a quoted field — it is truncated"] };
  }

  // Blank lines are structural noise: the real export puts one between the header and the
  // data, and trailing ones are an artefact of however the file was saved.
  //
  // The ORIGINAL line number is carried alongside, not recomputed from the filtered index.
  // Every error below quotes it, and an error message pointing at the wrong line is worse
  // than one with no line at all — it sends you to look at a row that is fine.
  const lines = table
    .map((cells, index) => ({ cells, line: index + 1 }))
    .filter(({ cells }) => cells.some((c) => c.trim() !== ""));
  if (lines.length === 0) return { ok: false, errors: ["file is empty"] };

  // ---- header -------------------------------------------------------------------------
  const header = lines[0].cells.map((c) => c.trim());

  for (const [i, want] of FIXED_COLUMNS.entries()) {
    if (header[i] !== want) {
      errors.push(
        `header column ${i + 1} is "${header[i] ?? ""}", expected "${want}" — ` +
          `this does not look like a Splitwise group export`,
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const people = header.slice(PERSON_COLUMN_START).filter((n) => n !== "");
  if (people.length === 0) {
    return { ok: false, errors: ["header has no person columns after Currency"] };
  }

  // Two people with the same display name would make every share ambiguous, and picking
  // the first is a coin flip on someone's money.
  const duplicates = people.filter((n, i) => people.indexOf(n) !== i);
  if (duplicates.length > 0) {
    errors.push(`duplicate person column(s): ${[...new Set(duplicates)].join(", ")}`);
  }

  // Located BY NAME, never by position: the number of people varies per group, and a
  // fixed index happens to work on one export and silently reads a flatmate's share on
  // the next.
  const meIndex = people.indexOf(me.trim());
  if (meIndex === -1) {
    errors.push(`"${me}" is not a person in this export — found: ${people.join(", ")}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  // ---- rows ---------------------------------------------------------------------------
  const rows: SplitwiseRow[] = [];
  const balances: SplitwiseBalance[] = [];
  let footerSeen = false;
  let seq = 0;

  for (let i = 1; i < lines.length; i++) {
    const { cells: raw, line } = lines[i];
    const where = `line ${line}`; // the real file line, so it matches a text editor

    // A ragged row means the file was edited, truncated, or split on the wrong delimiter.
    // Every column after the gap would be shifted, so this can never be a warning.
    if (raw.length !== header.length) {
      errors.push(`${where}: has ${raw.length} columns, header has ${header.length}`);
      continue;
    }

    const cells = raw.map((c) => c.trim());
    const [date, description, category, cost, currency] = cells;
    const netCells = cells.slice(PERSON_COLUMN_START);

    // The footer is identified by its DESCRIPTION, never by its numbers looking odd — see
    // the note in toPaise about why its cells parse as 0 rather than failing.
    if (description.toLowerCase() === FOOTER_DESCRIPTION) {
      if (footerSeen) { errors.push(`${where}: a second "Total balance" row`); continue; }
      footerSeen = true;
      if (i !== lines.length - 1) warnings.push(`${where}: "Total balance" is not the last row`);

      for (const [p, person] of people.entries()) {
        const v = toPaise(netCells[p]);
        if (v === null) { errors.push(`${where}: balance for ${person} is not a number`); continue; }
        balances.push({ person, balancePaise: v });
      }
      continue;
    }

    seq++;

    // Early `continue` on each fault, rather than accumulating into an `ok` flag. Two
    // reasons, and the first is the important one: a flag cannot narrow `costPaise` from
    // `number | null`, so the code below would need a non-null assertion — silencing the
    // very null check that is doing the work here. An early exit narrows properly and the
    // compiler keeps checking. (Secondarily: one message per broken row beats four, when
    // the row is unusable either way. Every bad ROW is still reported.)
    if (!isValidDate(date)) { errors.push(`${where}: "${date}" is not a valid YYYY-MM-DD date`); continue; }
    if (currency === "") { errors.push(`${where}: currency is blank`); continue; }

    // `=== null` and not `!costPaise`: a cost of 0 is falsy but is a DIFFERENT fault from
    // an unparseable one, and both are reported here only because both are fatal. Reaching
    // for truthiness on a numeric field is how a legitimate zero gets treated as missing.
    const costPaise = toPaise(cost);
    if (costPaise === null || costPaise <= 0) {
      errors.push(`${where}: cost "${cost}" is not a positive amount`);
      continue;
    }

    const netsPaise: Record<string, number> = {};
    let netsOk = true;
    for (const [p, person] of people.entries()) {
      const v = toPaise(netCells[p]);
      if (v === null) {
        errors.push(`${where}: share for ${person} is "${netCells[p]}", not a number`);
        netsOk = false;
        break;
      }
      netsPaise[person] = v;
    }
    if (!netsOk) continue;

    // ---- accounting invariants, per row ------------------------------------------------
    //
    // These are what make a CSV trustworthy. Unlike an xlsx there is no container checksum,
    // so every integrity guarantee has to be reconstructed from the content itself.

    // A closed system: every rupee one person is up, another is down. If this fails the row
    // is corrupt, or a column was dropped.
    const netSum = Object.values(netsPaise).reduce((a, b) => a + b, 0);
    // Splitwise splits 1000/3 as 333.33/333.33/333.34, so a well-formed row lands exactly on
    // zero. Allow one paise per participant anyway — a rounding artefact upstream should not
    // block an import, but anything larger is a real fault.
    if (Math.abs(netSum) > people.length) {
      errors.push(`${where}: shares sum to ${netSum} paise, expected 0 — the row is inconsistent`);
      continue;
    }

    // net = paid − owed, and both are bounded by the cost, so |net| can never exceed it.
    const oversized = Object.entries(netsPaise).find(([, v]) => Math.abs(v) > costPaise);
    if (oversized) {
      errors.push(
        `${where}: ${oversized[0]}'s share ${oversized[1]} exceeds the cost ${costPaise} — impossible`,
      );
      continue;
    }

    rows.push({
      seq,
      date,
      description,
      category,
      currency,
      costPaise,
      netsPaise,
      netPaise: netsPaise[people[meIndex]],
      kind: category.toLowerCase() === PAYMENT_CATEGORY ? "payment" : "expense",
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  // ---- file-level checksum --------------------------------------------------------------
  //
  // The strongest integrity check available on this format, and the reason it is a WARNING
  // rather than an error: an export filtered to a date range can legitimately carry
  // all-time balances that do not match the rows shown. Same stance as the reconciliation
  // walk — report the discrepancy and localise it; never silently corrupt, never block.
  if (!footerSeen) {
    warnings.push('no "Total balance" row — the per-person totals could not be verified');
  } else {
    for (const { person, balancePaise } of balances) {
      const summed = rows.reduce((acc, r) => acc + (r.netsPaise[person] ?? 0), 0);
      if (summed !== balancePaise) {
        warnings.push(
          `${person}: rows sum to ${summed} paise but the footer states ${balancePaise} ` +
            `(difference ${summed - balancePaise}) — rows may be missing or filtered`,
        );
      }
    }
  }

  const currencies = new Set(rows.map((r) => r.currency));
  if (currencies.size > 1) {
    warnings.push(`mixed currencies (${[...currencies].join(", ")}) — amounts are not comparable`);
  }

  if (rows.length === 0) warnings.push("no expense or payment rows found");

  return { ok: true, data: { people, rows, balances, warnings } };
}
