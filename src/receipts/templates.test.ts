import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { detectReceiptTemplate } from "./templates.ts";

// The fixtures are the REAL structure of the four sample invoices with the identity scrubbed
// out (ingest/receipts/make_fixtures.py). Reading them here is the point of generating them:
// the test exercises text that a real Blinkit and a real Amazon template actually produced,
// without this repo — which is public-bound — ever holding a name or an address.
type Fixture = { page_count: number; char_count: number; pages: { text: string }[] };

function fixture(name: string): Fixture {
  const file = path.resolve(import.meta.dirname, "..", "fixtures", "receipts", `${name}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Fixture;
}

const allText = (f: Fixture) => f.pages.map((p) => p.text).join("\n");

describe("detectReceiptTemplate, on the real samples", () => {
  it("recognises both Blinkit invoices", () => {
    assert.equal(detectReceiptTemplate(allText(fixture("blinkit-01"))), "blinkit");
    assert.equal(detectReceiptTemplate(allText(fixture("blinkit-02"))), "blinkit");
  });

  it("recognises both Amazon invoices", () => {
    assert.equal(detectReceiptTemplate(allText(fixture("amazon-01"))), "amazon");
    assert.equal(detectReceiptTemplate(allText(fixture("amazon-02"))), "amazon");
  });

  it("recognises a Blinkit order from the Hyperpure seller alone", () => {
    // One order is split across two legal sellers, and the second
    // invoice never names Blink Commerce. A detector keyed only on the first name would fail
    // on exactly half of every Blinkit order.
    const hyperpure = fixture("blinkit-02").pages.find((p) =>
      p.text.includes("ZOMATO HYPERPURE"),
    );
    assert.ok(hyperpure, "the sample really does contain a Hyperpure invoice");
    assert.equal(detectReceiptTemplate(hyperpure.text), "blinkit");
  });

  it("carries only SYNTHETIC order ids — redaction preserves shape, not identity", () => {
    // Guards the redaction itself, not the detector. Fixtures deliberately KEEP the real
    // format (404-NNNNNNN-NNNNNNN) so shape-dependent parser code can be tested against them;
    // what must never survive is a real VALUE. So the assertion is that every order id present
    // is one of the generated ones, not that none exists.
    for (const name of ["blinkit-01", "blinkit-02", "amazon-01", "amazon-02", "amazon-03"]) {
      const text = allText(fixture(name));
      for (const id of text.match(/\b\d{3}-\d{7}-\d{7}\b/g) ?? []) {
        assert.match(id, /^404-000000\d-0000001$/, `${name} carries a real-looking order id`);
      }
    }
  });
});

describe("detectReceiptTemplate, when it should refuse", () => {
  it("returns null for text with no merchant marker", () => {
    assert.equal(detectReceiptTemplate("Tax Invoice\nTotal 168.00\n"), null);
  });

  it("returns null for the empty string", () => {
    assert.equal(detectReceiptTemplate(""), null);
  });

  it("returns null when TWO templates match, rather than picking the first", () => {
    // Never silently guess. Two matches means the markers are wrong or a document quotes
    // another merchant; taking the first would hand the basket to a parser that misreads it.
    const both = "BLINK COMMERCE PRIVATE LIMITED and Amazon Retail India Private Limited";
    assert.equal(detectReceiptTemplate(both), null);
  });

  it("is case-insensitive, because templates are not consistent about it", () => {
    assert.equal(detectReceiptTemplate("blink commerce private limited"), "blinkit");
    assert.equal(detectReceiptTemplate("BLINK COMMERCE PRIVATE LIMITED"), "blinkit");
  });

  it("recognises the former company name still printed in Blinkit's own footer", () => {
    assert.equal(detectReceiptTemplate("Grofers India Private Limited"), "blinkit");
  });
});
