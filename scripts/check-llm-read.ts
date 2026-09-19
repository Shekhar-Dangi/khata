// Can the local model actually read a real invoice, and do the checks catch it when it cannot?
//
//   node --env-file=.env scripts/check-llm-read.ts data/private/some-invoice.pdf [--pdfplumber]
//
// Runs the REAL path the worker runs: docling markdown, then the model, then the four checks.
// Pass --pdfplumber to feed the model pdfplumber's text instead, for comparison.
//
// READS NOTHING FROM THE LEDGER AND WRITES NOTHING ANYWHERE. The invoice goes to the local
// model on loopback and nowhere else, which is the design and not a deployment detail.

import { readFileSync } from "node:fs";

import { RECEIPT_LLM } from "../src/receipt-llm-config.ts";
import { extractMarkdown } from "../src/markdown-extract.ts";
import { extractPdf } from "../src/pdf-extract.ts";
import { LlmParseFailure, readInvoice } from "../src/receipt-llm.ts";
import { verify } from "../src/receipt-verify.ts";
import { detectReceiptTemplate } from "../src/receipt-templates.ts";
import { merchantSlug } from "../src/receipt-llm-job.ts";

const path = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!path) throw new Error("usage: check-llm-read.ts <invoice.pdf> [--pdfplumber]");
const usePlumber = process.argv.includes("--pdfplumber");
const bytes = readFileSync(path);

const rupees = (paise: number) => "Rs " + (paise / 100).toFixed(2);

async function toMarkdown(): Promise<string> {
  if (!usePlumber) {
    const md = await extractMarkdown(bytes);
    if (!md.ok) throw new Error(`conversion failed: ${md.kind} ${md.error}`);
    return md.markdown;
  }
  const extracted = await extractPdf(bytes);
  if (!extracted.ok) throw new Error(`extraction failed: ${extracted.kind} ${extracted.error}`);
  const NL = String.fromCharCode(10);
  return extracted.document.pages
    .map((p) => {
      const tables = p.tables
        .map((t) =>
          t.map((row) => "| " + row.map((c) => (c ?? "").split(NL).join(" ")).join(" | ") + " |").join(NL),
        )
        .join(NL + NL);
      return `## Page ${p.index}${NL}${NL}${p.text}${NL}${NL}${tables}`;
    })
    .join(NL + NL);
}

const t0 = Date.now();
const markdown = await toMarkdown();
const convertSeconds = (Date.now() - t0) / 1000;

console.log(`model     ${RECEIPT_LLM.model}  ctx ${RECEIPT_LLM.numCtx}  out ${RECEIPT_LLM.numPredict}  think ${RECEIPT_LLM.think}  timeout ${RECEIPT_LLM.timeoutMs / 1000}s`);
console.log(`document  ${path.split(/[\\/]/).pop()}`);
console.log(`extractor ${usePlumber ? "pdfplumber" : "docling"}  ${convertSeconds.toFixed(1)}s`);
console.log(`markdown  ${markdown.length} chars (budget ${RECEIPT_LLM.maxMarkdownChars})`);

const t1 = Date.now();
try {
  const record = await readInvoice(markdown);
  console.log(`read      ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log("");
  console.log(`  merchant   ${record.merchant}   -> source_type ${detectReceiptTemplate(markdown) ?? merchantSlug(record.merchant) + " (slug, no template)"}`);
  console.log(`  order      ${record.external_ref}`);
  console.log(`  date       ${record.order_date}`);
  console.log(`  total      ${rupees(record.total_paise)}`);
  console.log(`  invoice?   ${record.is_invoice}   credit note? ${record.is_credit_note}`);
  for (const inv of record.invoices) {
    const sum = inv.lines.reduce((a, l) => a + l.amount_paise, 0);
    console.log(`  invoice ${inv.invoice_number}  stated ${rupees(inv.total_paise)}  lines sum ${rupees(sum)}`);
    for (const l of inv.lines) {
      console.log(`     ${l.kind.padEnd(5)} x${String(l.qty).padEnd(2)} ${rupees(l.amount_paise).padStart(11)}  ${l.description.slice(0, 70)}`);
    }
  }

  const verdict = verify(record, markdown);
  console.log("");
  console.log(`  VERDICT    ${verdict.ok ? "ACCEPTED" : "REJECTED"}`);
  if (!verdict.ok) console.log(`  reason     ${verdict.kind}: ${verdict.reason}`);
  for (const w of verdict.warnings) console.log(`  warning    ${w}`);
} catch (err) {
  console.log(`read      ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  if (err instanceof LlmParseFailure) console.log(`FAILED    ${err.kind}: ${err.message}`);
  else throw err;
}
