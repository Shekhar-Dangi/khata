// What happens to a stored PDF: extract it, work out whose template it is, record the answer.
//
// ONE implementation, called by BOTH the upload route and the re-parse route, for a direct
// reason: what must not happen is business logic accumulating inside a script and then being
// re-implemented behind a route; that is how two paths drift into disagreeing about dedupe. Here
// the thing they would drift on is what an artifact's parse_status means, which is the state a
// re-run reads to decide what to do.

import type { PoolClient } from "pg";

import { setParseStatus } from "./artifacts.ts";
import { type ParsedRecord, extractPdf } from "./pdf-extract.ts";
import { PARSERS_AVAILABLE, type ReceiptTemplate, detectReceiptTemplate } from "./receipt-templates.ts";

/**
 * How a template is named to a person. Separate from the internal id because "a amazon
 * invoice" is the kind of thing that makes an app feel unfinished, and because the display
 * name and the database value should be free to differ.
 */
const LABELS: Record<ReceiptTemplate, string> = {
  blinkit: "a Blinkit invoice",
  amazon: "an Amazon invoice",
};
const label = (t: ReceiptTemplate) => LABELS[t];

export type PdfIntake = {
  /** Mirrors what was written to the artifact row. */
  status: "staged" | "parsed" | "unsupported" | "failed";
  /** Which merchant's template, when it was recognised. */
  template: ReceiptTemplate | null;
  /** Structure worth showing a person even when nothing can parse it yet. */
  pages: number | null;
  tables: number | null;
  /** Present once an order has been read out of the document. */
  externalRef?: string;
  totalPaise?: number;
  message: string;
};

/**
 * Extract a stored PDF and record what we learned about it.
 *
 * The two failure states are kept genuinely distinct, because a re-run reads them:
 *
 *   failed        something RAN and could not produce a record — a scan, an encrypted file, a
 *                 corrupt one, a timeout. Re-running unchanged will fail the same way; what
 *                 changes the outcome is a different file or a fixed extractor.
 *   unsupported   nothing ran, because no code exists for this yet. Re-running AFTER a parser
 *                 lands is exactly the right move, and is free.
 *
 * Collapsing them would make the re-parse worklist a list of things to retry pointlessly.
 */
export async function intakePdf(
  client: PoolClient,
  artifactId: string,
  bytes: Buffer,
): Promise<PdfIntake> {
  const extracted = await extractPdf(bytes);

  if (!extracted.ok) {
    await setParseStatus(client, artifactId, "failed", {
      error: `${extracted.kind}: ${extracted.error}`,
    });
    return {
      status: "failed",
      template: null,
      pages: null,
      tables: null,
      message: extracted.error,
    };
  }

  const doc = extracted.document;
  const pages = doc.page_count;
  const tables = doc.pages.reduce((n, p) => n + p.tables.length, 0);

  // Detection reads the LINEARISED text, which is all it needs: a legal entity's name has to
  // appear somewhere, not in the right column.
  const template = detectReceiptTemplate(doc.pages.map((p) => p.text).join("\n"));

  if (template === null) {
    await setParseStatus(client, artifactId, "unsupported", {
      error: `extracted ${pages} page(s) but no merchant template was recognised`,
    });
    return {
      status: "unsupported",
      template: null,
      pages,
      tables,
      message: `read ${pages} page(s) and ${tables} table(s), but this is not a template we recognise`,
    };
  }

  if (!PARSERS_AVAILABLE[template]) {
    // The gap the artifact store exists for: RECOGNISED but not yet READABLE. Recording the
    // template now means the worklist can say "3 Blinkit invoices waiting" rather than "3
    // files", and the re-parse after Phase B needs no new information.
    await setParseStatus(client, artifactId, "unsupported", {
      sourceType: template,
      error: `recognised as ${template}, but no parser exists yet`,
    });
    return {
      status: "unsupported",
      template,
      pages,
      tables,
      message: `recognised as ${label(template)} — ${pages} page(s), ${tables} table(s) — waiting for a parser`,
    };
  }

  // A parser ran. Whether it produced a record is a separate question from whether it worked:
  // the reconcile gate lives inside the child, so a record that comes back has already been
  // proved to add up, and a parse that did not adds up to `parseError` instead.
  if (extracted.record) {
    await stageRecord(client, artifactId, template, extracted.record);
    const lines = extracted.record.invoices.reduce((n, inv) => n + inv.lines.length, 0);
    return {
      status: "staged",
      template,
      pages,
      tables,
      externalRef: extracted.record.external_ref,
      totalPaise: extracted.record.total_paise,
      message:
        `read order ${extracted.record.external_ref} — ${lines} line(s), ` +
        `${formatRupees(extracted.record.total_paise)} — waiting for you to confirm`,
    };
  }

  // No record. WHICH of the two failure states depends on whether code needs WRITING or
  // FIXING — migration 011 draws that line, and a re-parse worklist reads it. A credit note
  // and a delivery challan are documents nothing can read YET; a reconcile mismatch or an
  // unreadable amount is code that ran and got it wrong.
  const kind = extracted.parseError?.kind ?? "unknown";
  const needsCode = kind === "credit_note" || kind === "not_an_invoice";
  const status = needsCode ? "unsupported" : "failed";
  await setParseStatus(client, artifactId, status, {
    sourceType: template,
    error: `${kind}: ${extracted.parseError?.error ?? "the parser returned no record"}`,
  });
  return {
    status,
    template,
    pages,
    tables,
    message: extracted.parseError?.error ?? "the parser returned no record",
  };
}

/** Rupees for a person, from paise. Kept local — the API speaks paise everywhere else. */
function formatRupees(paise: number): string {
  return `Rs ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
}

/**
 * Hold a parsed order against its artifact, pending confirmation.
 *
 * `external_ref` goes on the artifact as well as into the record. Duplicated on purpose: it is
 * how a re-upload of the SAME ORDER in different bytes is recognised before anything is landed,
 * and how the confirm step finds its way back without parsing the JSON.
 */
async function stageRecord(
  client: PoolClient,
  artifactId: string,
  template: ReceiptTemplate,
  record: ParsedRecord,
): Promise<void> {
  await client.query(
    `UPDATE artifacts
        SET parse_status = 'staged',
            source_type  = $2,
            external_ref = $3,
            record       = $4::jsonb,
            parse_error  = NULL,
            parsed_at    = now()
      WHERE id = $1`,
    [artifactId, template, record.external_ref, JSON.stringify(record)],
  );
}
