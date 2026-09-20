import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  AUTO_LINK_SIMILARITY,
  PROPOSE_SIMILARITY,
  type Candidate,
  canonicalName,
  extractVariantAttributes,
  resolveLine,
  stripMerchantNoise,
  variantDiff,
} from "./items.ts";

// Description strings below keep the SHAPE of real ones from a real invoice corpus and the
// Blinkit samples — the brand words and product ids are synthetic where they came from a
// personal order. Invented shapes would test a fiction: every trap here was found in the data.

describe("stripMerchantNoise", () => {
  it("removes the Amazon ASIN tail and the HSN line", () => {
    assert.equal(
      stripMerchantNoise("Example Dairy Pouch Curd, 400 G | B0XXXXXXX1 ( B0XXXXXXX1 )\nHSN:04039090"),
      "Example Dairy Pouch Curd, 400 G",
    );
  });

  it("removes a TRUNCATED ASIN tail, which is why 22% of ASINs had several names", () => {
    // The corpus printed this same product three ways, cut at three column widths. Without
    // this rule those are three items for one ASIN.
    const cuts = [
      "Example Dairy Pouch Curd, 400 G | B0XXXXXXX1 ( B0XXXXXXX1 )",
      "Example Dairy Pouch Curd, 400 G | B0XXXXXXX1 ( B0XXXXXXX1",
      "Example Dairy Pouch Curd, 400 G | B0XXXXXXX1 (",
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
    // Settles the open question of whether two sizes are one item. Nothing is lost:
    // each size keeps its own alias row and label, so "which one did I buy" still answers.
    assert.equal(canonicalName("Example Dairy Curd, 400 G"), canonicalName("Example Dairy Curd, 1 KG"));
  });

  it("groups the real coffee case DETERMINISTICALLY, with no similarity threshold", () => {
    // Measured on the corpus: two sizes of one coffee, under two different ASINs, previously
    // met only as a 93%-similarity guess, because 4 characters differ inside 100 of shared
    // marketing copy. With size stripped they are the same string, so they meet as an exact
    // alias hit.
    const a = "Example Brand Instant Coffee Powder | 150g Pouch | 70% Coffee 30% Chicory";
    const b = "Example Brand Instant Coffee Powder | 50gm Pouch | 70% Coffee 30% Chicory";
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
    const amazon = canonicalName("Coca-Cola Zero Sugar, No Calories Soft Drink Can, 300 Ml - Cola | B0XXXXXXX3 ( B0XXXXXXX3 )");
    assert.notEqual(blinkit, amazon);
  });

  it("strips zero-width characters, which would otherwise split one product in two", () => {
    assert.equal(canonicalName("Sprite​ Zero"), canonicalName("Sprite Zero"));
  });

  it("is stable under repeated application", () => {
    const once = canonicalName("Example Bakery Chocolate Brownie, 120 g | B0XXXXXXX4 ( B0XXXXXXX4 )");
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
    // Measured: this exact rule is what stopped four flavours of one supplement collapsing into one
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

describe("extractVariantAttributes", () => {
  it("keeps the size instead of discarding it", () => {
    assert.deepEqual(
      extractVariantAttributes("Bisleri With Added Minerals Water, 10 L | B0XXXXXXX5"),
      { size: "10 l" },
    );
  });

  it("keeps size AND pack together", () => {
    assert.deepEqual(
      extractVariantAttributes("Coca-Cola Zero Sugar, No Calories Soft Drink PET Bottle, 750ml"),
      { size: "750 ml", pack: "pet bottle" },
    );
  });

  it("reads a multipack count", () => {
    assert.equal(
      extractVariantAttributes("Sunfeast YiPPee! Noodles (Pack of 4), 270g").pack_of,
      "4",
    );
  });

  it("takes the PACK size, not an ingredient quantity mentioned earlier", () => {
    // Real shape: "3g Glucose Monohydrate" is the dose, "50g" is the tub. Taking the first
    // match labelled all four flavours "3 g", which is the ingredient, not what was bought.
    const mix = "Acme Hydration+ Electrolytes | 3g Glucose Monohydrate + Sodium | Zero Sugar | 50g | Cola";
    assert.equal(extractVariantAttributes(mix).size, "50 g");
  });

  it("reports NOTHING rather than guessing when there is nothing to prove", () => {
    // Flavour and colour are open sets. They come from variantDiff, not from here.
    assert.deepEqual(extractVariantAttributes("Bata Men's Lace-up Formal Shoes - Black"), {});
  });
});

describe("variantDiff - the frictionless cases", () => {
  it("groups the two Coca-Cola Zeros with NO differing tokens at all", () => {
    // The case that must never need a click. Size and pack strip away; the leftover "cola" is
    // already present in "coca cola", so as token SETS the two are identical.
    const a = canonicalName("Coca-Cola Zero Sugar, No Calories Soft Drink PET Bottle, 750ml");
    const b = canonicalName("Coca-Cola Zero Sugar, No Calories Soft Drink Can, 300 Ml - Cola");
    const v = variantDiff(a, b);
    assert.equal(v.sameProduct, true);
    assert.deepEqual(v.differing, []);
  });

  it("groups the four flavours of one electrolyte mix and names the differing word", () => {
    const base = "Acme Hydration+ Electrolytes | 3g Glucose Monohydrate + Sodium, Potassium, Calcium, Magnesium | Boosts Muscle Growth, Hydration, Energy and Recovery | Zero Sugar | 100% Veg | 50g | ";
    const v = variantDiff(canonicalName(base + "Cola"), canonicalName(base + "Lemon"));
    assert.equal(v.sameProduct, true);
    assert.deepEqual(v.differing.sort(), ["cola", "lemon"]);
  });

  it("groups Bisleri 5 L with Bisleri 10 L", () => {
    const a = canonicalName("Bisleri With Added Minerals Water, 10 L");
    const b = canonicalName("Bisleri Water bottle with added minerals, 5 L");
    assert.equal(variantDiff(a, b).sameProduct, true);
  });
});

describe("variantDiff - the guards", () => {
  it("REFUSES a bare-number difference: iPhone 15 is not iPhone 16", () => {
    // A number with no unit is a model, not a measurement. Anything that WAS a measurement has
    // already been stripped by canonicalName, so a surviving bare number is suspicious.
    const v = variantDiff(
      canonicalName("Apple iPhone 15 Smartphone Black Titanium Unlocked"),
      canonicalName("Apple iPhone 16 Smartphone Black Titanium Unlocked"),
    );
    assert.equal(v.sameProduct, false);
    assert.match(v.sameProduct === false ? v.reason : "", /bare number/);
  });

  it("REFUSES when the names share too little: Amul Butter is not Amul Cheese", () => {
    const v = variantDiff(canonicalName("Amul Butter"), canonicalName("Amul Cheese"));
    assert.equal(v.sameProduct, false);
    assert.match(v.sameProduct === false ? v.reason : "", /too little in common/);
  });

  it("REFUSES when more than one word differs on a side", () => {
    const a = "brand product alpha beta gamma delta epsilon";
    const b = "brand product alpha beta gamma zeta eta";
    assert.equal(variantDiff(a, b).sameProduct, false);
  });

  it("is symmetric", () => {
    const a = canonicalName("Acme Hydration Electrolytes Zero Sugar Hundred Veg Cola");
    const b = canonicalName("Acme Hydration Electrolytes Zero Sugar Hundred Veg Lemon");
    assert.equal(variantDiff(a, b).sameProduct, variantDiff(b, a).sameProduct);
  });
});

describe("resolveLine with a variant-aware candidate", () => {
  it("auto-groups a conflicting SKU when the difference is explainable", () => {
    const canon = "acme hydration electrolytes zero sugar hundred veg cola";
    const r = resolveLine(null, [{
      itemId: "3",
      canonicalName: "acme hydration electrolytes zero sugar hundred veg lemon",
      similarity: 94,
      hasConflictingSku: true,
    }], canon);
    assert.equal(r.action, "link");
  });

  it("still refuses when the difference is NOT explainable", () => {
    const canon = "apple iphone 15 smartphone black titanium unlocked";
    const r = resolveLine(null, [{
      itemId: "3",
      canonicalName: "apple iphone 16 smartphone black titanium unlocked",
      similarity: 96,
      hasConflictingSku: true,
    }], canon);
    assert.equal(r.action, "create");
  });
});
