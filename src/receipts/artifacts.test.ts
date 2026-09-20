import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isTextual, sha256Hex, sniffMime } from "./artifacts.ts";

// The byte prefixes below are the REAL signatures of the formats this app ingests, taken from
// real sample files. A made-up prefix would test a fiction.
const pdf = (rest = "1.4\n%\xd0\xd4\xc5\xd8\n") => Buffer.from(`%PDF-${rest}`, "binary");
const zip = (rest = "\x14\x00\x00\x00") => Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from(rest, "binary"),
]);

describe("sha256Hex", () => {
  it("returns 64 lowercase hex characters, which is what the CHECK constraint demands", () => {
    const hash = sha256Hex(Buffer.from("Date,Description,Category,Cost,Currency\n"));
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("is stable for the same bytes — this is what makes the unique index a dedupe", () => {
    const bytes = Buffer.from("the same file, uploaded twice");
    assert.equal(sha256Hex(bytes), sha256Hex(Buffer.from("the same file, uploaded twice")));
    assert.equal(sha256Hex(bytes), sha256Hex(bytes));
  });

  it("differs on a one-byte change", () => {
    assert.notEqual(sha256Hex(Buffer.from("total 168.00")), sha256Hex(Buffer.from("total 168.01")));
  });

  it("hashes the empty buffer without throwing (the CHECK on byte_size rejects it, not this)", () => {
    assert.match(sha256Hex(Buffer.alloc(0)), /^[0-9a-f]{64}$/);
  });
});

describe("sniffMime", () => {
  it("recognises a PDF by its leading %PDF-", () => {
    assert.equal(sniffMime(pdf()), "application/pdf");
  });

  it("recognises a ZIP, which is what an xlsx actually is", () => {
    assert.equal(sniffMime(zip()), "application/zip");
  });

  it("calls a Splitwise export text", () => {
    const csv = Buffer.from("Date,Description,Category,Cost,Currency\n2026-09-02,Milk,Groceries,60,INR\n");
    assert.equal(sniffMime(csv), "text/plain");
  });

  it("ignores what the file is CALLED — the bytes decide", () => {
    // The exact trap content sniffing exists for: a PDF renamed .csv must not reach a CSV parser.
    // sniffMime never sees a filename, so this is really a statement about the API's shape.
    assert.equal(sniffMime(pdf()), "application/pdf");
  });

  it("does not mistake a PDF for text — %PDF- is printable ASCII, so order matters", () => {
    // A PDF header IS valid text. If isTextual ran first, every PDF would be decoded to a
    // string and corrupted. This test fails the moment someone reorders sniffMime.
    const header = Buffer.from("%PDF-1.4\n", "ascii");
    assert.ok(isTextual(header), "the header alone really is valid UTF-8");
    assert.equal(sniffMime(header), "application/pdf");
  });

  it("falls back to octet-stream rather than guessing", () => {
    assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "application/octet-stream");
  });
});

describe("isTextual", () => {
  it("accepts UTF-8 beyond ASCII — the Amazon template contains a rupee sign", () => {
    assert.ok(isTextual(Buffer.from("Sprite Zero 300ml ₹38.10", "utf8")));
  });

  it("rejects a lone NUL byte, the oldest binary marker there is", () => {
    assert.equal(isTextual(Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69])), false);
  });

  it("rejects invalid UTF-8 instead of substituting U+FFFD", () => {
    // 0x80 is a continuation byte with nothing to continue. A non-fatal decoder turns this
    // into a replacement character and returns success — silent, irreversible corruption,
    // and exactly what `fatal: true` exists to prevent.
    assert.equal(isTextual(Buffer.from([0x41, 0x80, 0x42])), false);
  });

  it("rejects bytes that are only VALID in another encoding", () => {
    // 0xA9 is © in latin-1 and invalid on its own in UTF-8. Decoding this as UTF-8 would
    // corrupt it, so the honest answer is that it is not text WE can read.
    assert.equal(isTextual(Buffer.from([0xa9])), false);
  });

  it("accepts an empty buffer (vacuously valid UTF-8)", () => {
    assert.ok(isTextual(Buffer.alloc(0)));
  });
});
