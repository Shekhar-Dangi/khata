// The job handler: one artifact's bytes in, one staged order or one named reason out.
//
// This is the only place the three halves of the model
// path meet — convert, read, verify — and it is deliberately thin. Everything it does that is
// worth arguing about lives in the module that owns it: the budget in `to_markdown.py`, the
// prompt and the grammar in `receipt-llm.ts`, the four checks in `receipt-verify.ts`.
//
// IT WRITES NOTHING BUT `artifacts`, and it writes the SAME shape and the SAME status the
// deterministic path writes — `parse_status = 'staged'` with a `ParsedRecord` in `record`.
// That is the whole reason the review screen needs no changes: a staged order is a staged
// order, and nothing downstream has to learn that a model read this one. The `source_type` it
// records is what routes it into its merchant's group on the Sources page, exactly as before.
//
// NOTHING REACHES THE LEDGER HERE. Staged means waiting for a person, which is the line
// the two-phase import draws and the model path does not get to cross it. A model that read an
// invoice wrongly and convincingly is stopped by a human looking at it, and that human is the
// last check after the four automatic ones.

import type { PoolClient } from "pg";

import type { ParsedLine, ParsedRecord } from "../pdf-extract.ts";
import { ParseFailure } from "./worker.ts";
import type { ClaimedJob } from "./queue.ts";
import { extractMarkdown } from "./markdown-extract.ts";
import { LlmParseFailure, type LlmRecord, readInvoice } from "./read.ts";
import { detectReceiptTemplate } from "../templates.ts";
import { verify } from "./verify.ts";

/**
 * Read one artifact with the model and stage the result.
 *
 * Every failure throws `ParseFailure` with an `ErrorKind`, so the worker records a value the
 * retry policy can dispatch on rather than a message somebody has to pattern-match.
 */
export async function runLlmReceiptJob(client: PoolClient, job: ClaimedJob): Promise<void> {
  const row = await client.query<{ bytes: Buffer; mime: string; parse_status: string }>(
    "SELECT bytes, mime, parse_status FROM artifacts WHERE id = $1",
    [job.artifactId],
  );
  const artifact = row.rows[0];
  if (artifact === undefined) {
    throw new ParseFailure("corrupt", "the artifact no longer exists");
  }
  // Somebody landed this while it sat in the queue — a deterministic parser was written, or a
  // person confirmed it by hand. Not an error, and not work: doing it again would stage an
  // order that is already in the ledger.
  if (artifact.parse_status === "parsed") {
    throw new ParseFailure("duplicate_order", "this document was already landed");
  }
  if (artifact.mime !== "application/pdf") {
    throw new ParseFailure("unreadable_mime", `the model path reads PDFs, not ${artifact.mime}`);
  }

  // 1. CONVERT. Out of process, killed on a timer — see markdown-extract.ts for what that
  //    bounds and what it does not.
  const md = await extractMarkdown(artifact.bytes);
  if (!md.ok) throw new ParseFailure(md.kind, md.error);

  // 2. READ.
  let record: LlmRecord;
  try {
    record = await readInvoice(md.markdown);
  } catch (err) {
    if (err instanceof LlmParseFailure) throw new ParseFailure(err.kind, err.message);
    throw new ParseFailure("unknown", err instanceof Error ? err.message : String(err));
  }

  // 3. BELIEVE, OR DO NOT. The order matters: nothing is written before this passes.
  const verdict = verify(record, md.markdown);
  if (!verdict.ok) throw new ParseFailure(verdict.kind, verdict.reason);

  // 4. WHOSE DOCUMENT IS THIS — decided deterministically, NOT by the model.
  //
  //    Found on the first real run: asked for the merchant, the model answered with the SELLER's
  //    legal name, "BLINK COMMERCE PRIVATE LIMITED". Used as `source_type`, that would file a
  //    model-read Blinkit order in a different group from every other Blinkit order, and split
  //    the product catalogue with it, since aliases are keyed by source. It would also defeat
  //    the duplicate check below, which matches on source. The merchant is an IDENTITY, and
  //    `detectReceiptTemplate` already answers it from the legal-entity markers every such
  //    invoice prints — so the model's own guess is used only when no template recognises the
  //    document, and then only after the legal-form noise is stripped.
  const sourceType = detectReceiptTemplate(md.markdown) ?? merchantSlug(record.merchant);

  // 5. IS IT ALREADY HERE? Checked against the LEDGER, not just the staging area, and checked
  //    AFTER the model has run because the order reference is what the model just read. A
  //    duplicate is a permanent outcome rather than a failure to retry — succeeding would be
  //    the bug.
  const landed = await client.query(
    "SELECT 1 FROM evidence WHERE external_ref = $1 AND source_type = $2",
    [record.external_ref, sourceType],
  );
  if ((landed.rowCount ?? 0) > 0) {
    throw new ParseFailure("duplicate_order", `order ${record.external_ref} is already in your ledger`);
  }

  await client.query(
    `UPDATE artifacts
        SET parse_status = 'staged',
            source_type  = $2,
            external_ref = $3,
            record       = $4::jsonb,
            parse_error  = NULL,
            parsed_at    = now()
      WHERE id = $1`,
    [
      job.artifactId,
      sourceType,
      record.external_ref,
      JSON.stringify(toParsedRecord({ ...record, merchant: sourceType }, verdict.warnings)),
    ],
  );
}

/**
 * A stable key from a merchant name the model read, for a document no template recognises.
 *
 * Best-effort, and it says so: "ZEPTO MARKETPLACE PVT LTD" and "Zepto Marketplace Private
 * Limited" both become `zepto-marketplace`, but a merchant printing its name two genuinely
 * different ways will still split in two. The real fix is one line — add the merchant's legal
 * name to `SIGNATURES` in receipt-templates.ts — and it needs no parser: detection alone is
 * enough to give every model-read document from that merchant the same canonical key.
 */
export function merchantSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/\b(private|pvt|limited|ltd|llp|inc|india|co)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "unrecognised" : slug;
}

/**
 * The model's answer in the shape the rest of the app already speaks.
 *
 * The fields a model is NOT asked for — hsn, unit_paise, net_paise, tax_paise, discount_paise
 * — are null rather than guessed. `resolveLine` does not need them, `deriveForEvidence`
 * allocates on `amount_paise` alone, and asking a model for a tax breakdown it would have to
 * infer is how a plausible number ends up in a column that reads as fact. A null says "not
 * known"; a computed number would say "measured", and only one of those is true.
 *
 * WARNINGS TRAVEL WITH THE RECORD. `ParsedRecord.warnings` already exists and the review
 * screen already reads it, so a coverage flag reaches the person who has to decide — which is
 * the only place a soft check is worth anything.
 */
function toParsedRecord(record: LlmRecord, warnings: string[]): ParsedRecord {
  return {
    source_type: record.merchant,
    external_ref: record.external_ref,
    order_date: record.order_date,
    total_paise: record.total_paise,
    invoices: record.invoices.map((inv) => ({
      invoice_number: inv.invoice_number,
      seller_name: inv.seller_name,
      invoice_date: inv.invoice_date,
      total_paise: inv.total_paise,
      lines: inv.lines.map((l): ParsedLine => ({
        kind: l.kind,
        invoice_number: inv.invoice_number,
        description: l.description,
        sku: l.sku,
        hsn: null,
        qty: l.qty,
        amount_paise: l.amount_paise,
        unit_paise: null,
        net_paise: null,
        tax_paise: null,
        discount_paise: null,
      })),
    })),
    payment: [],
    // Said plainly on every such order, because a person reviewing it should know which of the
    // two paths read it without having to look anything up.
    warnings: ["read by the local model, not by a parser", ...warnings],
  };
}
