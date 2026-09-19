import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { LlmRecord } from "./receipt-llm.ts";
import { COVERAGE_FLOOR, coverageOf, verify } from "./receipt-verify.ts";

// A document that says what the record below claims. Amounts printed as they would be.
const DOC = `
# Tax Invoice
BLINK COMMERCE PRIVATE LIMITED
Invoice Number : TTD1-990001
Order Id : 404-0000001-0000001

| Sr | Item Description                | Qty | Amount |
|----|---------------------------------|-----|--------|
| 1  | Heritage Farm Fresh Toned Milk  | 2   | 44.38  |
| 2  | Safal Frozen Green Peas 500 g   | 1   | 123.62 |
Total 168.00
`;

const record = (over: Partial<LlmRecord> = {}): LlmRecord => ({
  is_invoice: true,
  is_credit_note: false,
  merchant: "blinkit",
  external_ref: "404-0000001-0000001",
  order_date: "2026-09-01",
  total_paise: 16800,
  invoices: [
    {
      invoice_number: "TTD1-990001",
      seller_name: "BLINK COMMERCE PRIVATE LIMITED",
      invoice_date: "2026-09-01",
      total_paise: 16800,
      lines: [
        { kind: "goods", description: "Heritage Farm Fresh Toned Milk", sku: null, qty: 2, amount_paise: 4438 },
        { kind: "goods", description: "Safal Frozen Green Peas 500 g", sku: null, qty: 1, amount_paise: 12362 },
      ],
    },
  ],
  ...over,
});

describe("verify — the happy path", () => {
  it("accepts a record that adds up and is grounded", () => {
    const v = verify(record(), DOC);
    assert.equal(v.ok, true);
  });
});

describe("verify — is this even an invoice", () => {
  it("refuses a document the model says is not an invoice", () => {
    const v = verify(record({ is_invoice: false }), DOC);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.kind, "not_an_invoice");
  });

  it("holds a credit note rather than calling it broken", () => {
    // 29 of the corpus are credit notes. They are read correctly and cannot be represented
    // yet, which is a different thing from a failed parse.
    const v = verify(record({ is_credit_note: true }), DOC);
    assert.equal(v.ok === false && v.kind, "credit_note");
  });

  it("asks that question FIRST", () => {
    // A warranty card whose lines sum to its stated zero would pass every arithmetic check.
    const notInvoice = record({ is_invoice: false, total_paise: 0, invoices: [] });
    const v = verify(notInvoice, DOC);
    assert.equal(v.ok === false && v.kind, "not_an_invoice");
  });
});

describe("verify — arithmetic", () => {
  it("rejects lines that do not sum to the invoice total", () => {
    const r = record();
    r.invoices[0].total_paise = 16900;
    r.total_paise = 16900;
    const v = verify(r, DOC);
    assert.equal(v.ok === false && v.kind, "does_not_reconcile");
    // The message must name both numbers — that is what makes it actionable.
    assert.match(v.ok === false ? v.reason : "", /168\.00/);
    assert.match(v.ok === false ? v.reason : "", /169\.00/);
  });

  it("rejects invoice totals that do not sum to the order total", () => {
    const r = record({ total_paise: 20000 });
    const v = verify(r, DOC);
    assert.equal(v.ok === false && v.kind, "does_not_reconcile");
    assert.match(v.ok === false ? v.reason : "", /order/);
  });

  it("has no tolerance — one paise is a failure", () => {
    // Deliberate. Every original sample reconciled exactly, so drift means a mis-read row,
    // and a tolerance would convert a loud bug into a quiet one.
    const r = record();
    r.invoices[0].lines[0].amount_paise = 4439;
    assert.equal(verify(r, DOC).ok, false);
  });

  it("checks each invoice separately, not just the order", () => {
    // Two invoices whose errors cancel would pass an order-level check alone.
    const r = record({ total_paise: 16800 });
    r.invoices = [
      { ...r.invoices[0], invoice_number: "A", total_paise: 10000,
        lines: [{ kind: "goods", description: "Heritage Farm Fresh Toned Milk", sku: null, qty: 1, amount_paise: 9000 }] },
      { ...r.invoices[0], invoice_number: "B", total_paise: 6800,
        lines: [{ kind: "goods", description: "Safal Frozen Green Peas 500 g", sku: null, qty: 1, amount_paise: 7800 }] },
    ];
    const v = verify(r, DOC);
    assert.equal(v.ok === false && v.kind, "does_not_reconcile");
  });
});

describe("verify — groundedness", () => {
  it("catches an invented line even when the arithmetic works", () => {
    // THE CHECK NOTHING ELSE CAN DO. A hallucinated row that makes the sums work is
    // indistinguishable from a real one to every other test here.
    const r = record();
    r.invoices[0].lines = [
      { kind: "goods", description: "Organic Quinoa Premium Selection", sku: null, qty: 1, amount_paise: 16800 },
    ];
    const v = verify(r, DOC);
    assert.equal(v.ok === false && v.kind, "hallucinated_lines");
  });

  it("tolerates case, punctuation and whitespace differences", () => {
    const r = record();
    r.invoices[0].lines[0].description = "HERITAGE  FARM-FRESH   TONED MILK";
    assert.equal(verify(r, DOC).ok, true);
  });

  it("accepts a long description re-flowed by the converter", () => {
    // Only the leading run has to match, because a converter may break a long line anywhere.
    const r = record();
    r.invoices[0].lines[1].description = "Safal Frozen Green Peas 500 g Pouch Fresh Pack";
    assert.equal(verify(r, DOC).ok, true);
  });

  it("does NOT accept a short description on a leading-words match", () => {
    // Two or three words match by accident far too easily, so short ones must match whole.
    const r = record();
    r.invoices[0].lines[0].description = "Heritage Farm Organic";
    assert.equal(verify(r, DOC).ok, false);
  });

  it("rejects an empty description", () => {
    const r = record();
    r.invoices[0].lines[0].description = "   ";
    const v = verify(r, DOC);
    assert.equal(v.ok === false && v.kind, "hallucinated_lines");
  });
});

describe("verify — completeness", () => {
  it("rejects a missing order reference", () => {
    assert.equal(verify(record({ external_ref: "  " }), DOC).ok, false);
  });

  it("rejects a record with no invoices", () => {
    assert.equal(verify(record({ invoices: [] }), DOC).ok, false);
  });

  it("rejects a zero order total", () => {
    const r = record({ total_paise: 0 });
    r.invoices[0].total_paise = 0;
    r.invoices[0].lines = [];
    assert.equal(verify(r, DOC).ok, false);
  });
});

describe("coverage", () => {
  it("is null when the document prints no amounts", () => {
    assert.equal(coverageOf(record(), "no numbers here at all"), null);
  });

  it("is high when every printed amount is claimed", () => {
    const c = coverageOf(record(), DOC);
    assert.ok(c !== null && c > COVERAGE_FLOOR, `coverage=${c}`);
  });

  it("warns rather than failing when amounts go unclaimed", () => {
    const noisy = DOC + "\n" + Array.from({ length: 30 }, (_, i) => `Fee ${i}.99`).join("\n");
    const v = verify(record(), noisy);
    // Still accepted — an invoice quotes plenty of numbers that are not line items.
    assert.equal(v.ok, true);
    assert.ok(v.warnings.some((w) => w.includes("claimed by a line")), JSON.stringify(v.warnings));
  });
});
