import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  dayGap,
  extractReferences,
  findReferencePartner,
  indexByReference,
  type Leg,
} from "./transfers.ts";

// Narration shapes below are the REAL formats seen on HDFC, Indian Bank and Slice
// statements, with the digits changed. Made-up shapes would test a fiction.
const leg = (over: Partial<Leg> = {}): Leg => ({
  id: "1",
  account_id: 1,
  amount_paise: -50000,
  txn_date: "2026-08-14",
  narration: "UPI-XXXXXXXXXXXX0000-BANK0000002-100000000001-UPI SEND MONEY",
  ...over,
});

describe("extractReferences", () => {
  it("pulls a delimited 12-digit reference out of a UPI narration", () => {
    assert.deepEqual(
      extractReferences("UPI-XXXXXXXXXXXX0000-BANK0000002-100000000001-UPI SEND MONEY"),
      ["100000000001"],
    );
  });

  it("finds the same reference in the other leg's differently-shaped narration", () => {
    assert.deepEqual(
      extractReferences(
        "UPI-Credit-100000000001-A NAME-BANK0000001-9999999999@bank-UPI Send Money",
      ),
      ["100000000001"],
    );
  });

  it("handles the Indian Bank slash-delimited format", () => {
    assert.deepEqual(
      extractReferences("BANK0000003/A NAME/XXXXX/handle@ybl/UPI/100000000002"),
      ["100000000002"],
    );
  });

  // The whole point of the boundaries. A 17-digit NEFT UTR contains several 12-digit
  // substrings; treating one as a reference would pair unrelated rows.
  it("does not find a reference inside a longer digit run", () => {
    assert.deepEqual(
      extractReferences("TRANSFER FROM 12345678902 NEFT/HDFC/BANKN12345678901234567/D"),
      [],
    );
  });

  it("does not find a reference glued to letters", () => {
    assert.deepEqual(extractReferences("RZP123456789012PAYMENT"), []);
  });

  it("rejects 11 and 13 digit runs", () => {
    assert.deepEqual(extractReferences("A-12345678901-B"), []);
    assert.deepEqual(extractReferences("A-1234567890123-B"), []);
  });

  it("returns nothing for an absent narration", () => {
    assert.deepEqual(extractReferences(null), []);
  });

  it("dedupes a reference quoted twice in one narration", () => {
    assert.deepEqual(
      extractReferences("UPI-100000000001-SOMETHING-100000000001-END"),
      ["100000000001"],
    );
  });

  // The regex is a module-level literal with /g, which carries `lastIndex` between uses.
  // If this ever returns [] on the second call, someone replaced matchAll with exec.
  it("is not stateful across calls", () => {
    const narration = "UPI-A-100000000001-B";
    assert.deepEqual(extractReferences(narration), ["100000000001"]);
    assert.deepEqual(extractReferences(narration), ["100000000001"]);
  });
});

describe("dayGap", () => {
  it("is zero for the same day and symmetric", () => {
    assert.equal(dayGap("2026-08-14", "2026-08-14"), 0);
    assert.equal(dayGap("2026-08-14", "2026-08-16"), 2);
    assert.equal(dayGap("2026-08-16", "2026-08-14"), 2);
  });

  it("counts across a month boundary", () => {
    assert.equal(dayGap("2026-07-31", "2026-08-02"), 2);
  });
});

describe("indexByReference", () => {
  it("groups every row that quotes a reference", () => {
    const a = leg({ id: "1" });
    const b = leg({ id: "2", account_id: 3, amount_paise: 50000 });
    const index = indexByReference([a, b]);
    assert.deepEqual(index.get("100000000001")?.map((r) => r.id), ["1", "2"]);
  });

  it("skips rows with no reference rather than indexing them under nothing", () => {
    const index = indexByReference([leg({ narration: "ATM WITHDRAWAL" })]);
    assert.equal(index.size, 0);
  });
});

describe("findReferencePartner", () => {
  const debit = leg({ id: "1", account_id: 1, amount_paise: -50000 });
  const credit = leg({
    id: "2",
    account_id: 3,
    amount_paise: 50000,
    narration: "UPI-Credit-100000000001-A NAME-BANK0000001-UPI Send Money",
  });

  it("pairs the two legs of a real transfer", () => {
    const match = findReferencePartner(debit, indexByReference([debit, credit]), 2);
    assert.equal(match?.partner.id, "2");
    assert.equal(match?.reference, "100000000001");
  });

  it("finds nothing when the reference appears only on this leg", () => {
    assert.equal(findReferencePartner(debit, indexByReference([debit]), 2), null);
  });

  // A case that actually occurs in real statements. Auto-resolving here would hide
  // real spending on a coincidence; it has to fall through to a proposal instead.
  it("refuses to guess when a reference is on three rows", () => {
    const third = leg({ id: "3", account_id: 2, amount_paise: 50000 });
    const index = indexByReference([debit, credit, third]);
    assert.equal(findReferencePartner(debit, index, 2), null);
  });

  it("refuses a partner in the same account", () => {
    const sameAccount = { ...credit, account_id: 1 };
    const index = indexByReference([debit, sameAccount]);
    assert.equal(findReferencePartner(debit, index, 2), null);
  });

  it("refuses a partner of a different amount", () => {
    const wrongAmount = { ...credit, amount_paise: 49900 };
    const index = indexByReference([debit, wrongAmount]);
    assert.equal(findReferencePartner(debit, index, 2), null);
  });

  it("refuses two debits, however well they match", () => {
    const alsoDebit = { ...credit, amount_paise: -50000 };
    const index = indexByReference([debit, alsoDebit]);
    assert.equal(findReferencePartner(debit, index, 2), null);
  });

  it("refuses a partner outside the window", () => {
    const late = { ...credit, txn_date: "2026-08-20" };
    const index = indexByReference([debit, late]);
    assert.equal(findReferencePartner(debit, index, 2), null);
  });

  it("accepts a partner at the edge of the window", () => {
    const edge = { ...credit, txn_date: "2026-08-16" };
    const index = indexByReference([debit, edge]);
    assert.equal(findReferencePartner(debit, index, 2)?.partner.id, "2");
  });

  it("tries every reference on the leg, not just the first", () => {
    const twoRefs = leg({
      id: "1",
      narration: "UPI-999999999999-FEE-100000000001-UPI SEND MONEY",
    });
    // 999999999999 has no partner; 100000000001 does.
    const index = indexByReference([twoRefs, credit]);
    assert.equal(findReferencePartner(twoRefs, index, 2)?.reference, "100000000001");
  });
});
