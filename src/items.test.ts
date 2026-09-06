import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  AUTO_LINK_SIMILARITY,
  PROPOSE_SIMILARITY,
  type Candidate,
  canonicalName,
  resolveLine,
  stripMerchantNoise,
} from "./items.ts";

// Description strings below are REAL, taken from the 252-invoice corpus and the Blinkit
// samples. Invented ones would test a fiction — every trap here was found in the data.

describe("stripMerchantNoise", () => {
  it("removes the Amazon ASIN tail and the HSN line", () => {
    assert.equal(
      stripMerchantNoise("Milky Mist Pouch Curd, 400 G | B0BG6CT9ZV ( B0BG6CT9ZV )\nHSN:04039090"),
      "Milky Mist Pouch Curd, 400 G",
    );
  });

  it("removes a TRUNCATED ASIN tail, which is why 22% of ASINs had several names", () => {
    // The corpus printed this same product three ways, cut at three column widths. Without
    // this rule those are three items for one ASIN.
    const cuts = [
      "Milky Mist Pouch Curd, 400 G | B0BG6CT9ZV ( B0BG6CT9ZV )",
      "Milky Mist Pouch Curd, 400 G | B0BG6CT9ZV ( B0BG6CT9ZV",
      "Milky Mist Pouch Curd, 400 G | B0BG6CT9ZV (",
    ];
    const canon = cuts.map(canonicalName);
    assert.equal(new Set(canon).size, 1, `expected one canonical name, got ${JSON.stringify(canon)}`);
  });

  it("removes Blinkit's parenthesised HSN", () => {
    assert.equal(
      stripMerchantNoise("Coca-Cola Zero Sugar Soft Drink(PET Bottle) (HSN-22029990)"),
      "Coca-Cola Zero Sugar Soft Drink(PET Bottle)",
    );
  });
});

describe("canonicalName", () => {
  it("folds case, punctuation and spacing", () => {
    // The 200g goes with it — size is a variant, not identity (see the next test).
    assert.equal(canonicalName("Asal  Chapathi,  200g"), "asal chapathi");
  });

  it("STRIPS size, so two pack sizes are one product — the owner's decision, 2026-09-06", () => {
    // Settles the open question the design left unanswered. Nothing is lost:
    // each size keeps its own alias row and label, so "which one did I buy" still answers.
    assert.equal(canonicalName("Milky Mist Curd, 400 G"), canonicalName("Milky Mist Curd, 1 KG"));
  });

  it("groups the real coffee case DETERMINISTICALLY, with no similarity threshold", () => {
    // Measured on the corpus: these two ASINs (B07MJGXCLW, B0D7ZT6149) previously met only as
    // a 93%-similarity guess, because 4 characters differ inside 100 of shared marketing copy.
    // With size stripped they are the same string, so they meet as an exact alias hit.
    const a = "Continental Coffee Xtra Instant Coffee Powder | 150g Pouch | 70% Coffee 30% Chicory";
    const b = "Continental Coffee Xtra Instant Coffee Powder | 50gm Pouch | 70% Coffee 30% Chicory";
    assert.equal(canonicalName(a), canonicalName(b));
  });

  it("strips pack FORM as well as size", () => {
    assert.equal(
      canonicalName("Coca-Cola Zero Sugar Soft Drink(PET Bottle) (HSN-22029990)"),
      canonicalName("Coca-Cola Zero Sugar Soft Drink(Can) (HSN-22021010)"),
    );
  });

  it("does not strip digits that are part of a NAME", () => {
    // "7Up" and "100 Pipers" are products, not quantities. Only a digit followed by a unit is
    // a variant token, which is why the patterns require one.
    assert.ok(canonicalName("7Up Soft Drink").includes("7up"));
    assert.ok(canonicalName("Maggi 2-Minute Noodles").includes("2"));
  });

  it("still separates the two Coke Zeros, whose names genuinely differ", () => {
    // Blinkit prints "Coca-Cola Zero Sugar Soft Drink"; Amazon prints "Coca-Cola Zero Sugar,
    // No Calories Soft Drink ... - Cola". Different words, so different products here — and
    // they are different MERCHANTS anyway, and name aliases are merchant-scoped, so no
    // cross-merchant grouping could happen even if they matched.
    const blinkit = canonicalName("Coca-Cola Zero Sugar Soft Drink(PET Bottle) (HSN-22029990)");
    const amazon = canonicalName("Coca-Cola Zero Sugar, No Calories Soft Drink Can, 300 Ml - Cola | B07G1CKCDH ( B07G1CKCDH )");
    assert.notEqual(blinkit, amazon);
  });

  it("strips zero-width characters, which would otherwise split one product in two", () => {
    assert.equal(canonicalName("Sprite​ Zero"), canonicalName("Sprite Zero"));
  });

  it("is stable under repeated application", () => {
    const once = canonicalName("Britannia Cakes Fudge It Chocolate Brownie, 120 g | B08DM8W66Y ( B08DM8W66Y )");
    assert.equal(canonicalName(once), once);
  });
});

describe("resolveLine", () => {
  const cand = (id: string, similarity: number): Candidate => ({
    itemId: id, canonicalName: `item ${id}`, similarity,
  });

  it("returns the existing item when an alias already points at one — no fuzz at all", () => {
    const r = resolveLine({ itemId: "7", via: "sku" }, [cand("9", 99)]);
    assert.deepEqual(r, { action: "existing", itemId: "7", confidence: 100, via: "sku" });
  });

  it("prefers the alias even when a better-scoring candidate exists", () => {
    // The alias is a DECISION already made. A similarity score must never overrule one.
    const r = resolveLine({ itemId: "7", via: "name" }, [cand("9", 100)]);
    assert.equal(r.action, "existing");
    assert.equal(r.action === "existing" && r.itemId, "7");
  });

  it("links a single strong candidate, but marks it for review", () => {
    const r = resolveLine(null, [cand("3", AUTO_LINK_SIMILARITY)]);
    assert.equal(r.action, "link");
    assert.equal(r.action === "link" && r.needsReview, true);
    assert.equal(r.action === "link" && r.itemId, "3");
  });

  it("CREATES rather than choosing when two candidates are both strong", () => {
    // Two strong matches means the catalogue already holds a duplicate. Picking the better one
    // makes that permanent; both get proposed instead.
    const r = resolveLine(null, [cand("3", 97), cand("4", 95)]);
    assert.equal(r.action, "create");
    assert.equal(r.action === "create" && r.propose.length, 2);
  });

  it("creates and proposes for a borderline candidate", () => {
    const r = resolveLine(null, [cand("3", PROPOSE_SIMILARITY + 5)]);
    assert.equal(r.action, "create");
    assert.equal(r.action === "create" && r.propose.length, 1);
  });

  it("creates with full confidence and no proposals when nothing is close", () => {
    const r = resolveLine(null, [cand("3", PROPOSE_SIMILARITY - 1)]);
    assert.deepEqual(r, { action: "create", confidence: 100, propose: [] });
  });

  it("creates with full confidence when there are no candidates at all", () => {
    assert.deepEqual(resolveLine(null, []), { action: "create", confidence: 100, propose: [] });
  });

  it("reports LOWER confidence in creating when a near-miss is closer", () => {
    const loose = resolveLine(null, [cand("3", 60)]);
    const tight = resolveLine(null, [cand("3", 85)]);
    assert.ok(
      (loose.action === "create" ? loose.confidence : 0) >
        (tight.action === "create" ? tight.confidence : 0),
      "a closer near-miss should make us LESS sure that creating is right",
    );
  });

  it("REFUSES to auto-link a candidate the merchant gave a different SKU", () => {
    // Measured: this exact rule is what stopped four GNC Creatine flavours collapsing into one
    // item at 94% similarity. The merchant issuing two ids is the merchant saying two things,
    // and no score may overrule it — the pair becomes a proposal instead.
    const r = resolveLine(null, [{ ...cand("3", 96), hasConflictingSku: true }]);
    assert.equal(r.action, "create");
    assert.equal(r.action === "create" && r.propose.length, 1);
  });

  it("does not depend on the order candidates arrive in", () => {
    const a = resolveLine(null, [cand("3", 60), cand("4", 92)]);
    const b = resolveLine(null, [cand("4", 92), cand("3", 60)]);
    assert.deepEqual(a, b);
    assert.equal(a.action, "link");
  });
});
