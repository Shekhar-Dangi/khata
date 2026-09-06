// The two-phase import: what is waiting for a person, and what happens when they say yes.
//
// the design. `artifacts` is the INBOX and `evidence` is the LEDGER, and this module
// is the door between them. Uploading fills the inbox — bytes stored, order parsed, arithmetic
// checked — and nothing else moves until someone confirms. That line is what lets the review
// survive a page refresh, lets 200 orders land today and 10 next week, and means confirming
// re-uploads nothing.

import type { PoolClient } from "pg";

import { type Candidate, matchToTransaction } from "./evidence-match.ts";
import { itemSummary, previewLine, resolveAndRecord } from "./items-store.ts";
import type { ParsedLine, ParsedRecord } from "./pdf-extract.ts";

export type LineResolutionView = {
  action: "existing" | "link" | "create";
  item_id: string | null;
  item_name: string | null;
  /** True when a person should look before this lands. */
  needs_input: boolean;
  candidates: { item_id: string; name: string; similarity: number }[];
};

export type StagedLineView = ParsedLine & {
  index: number;
  resolution: LineResolutionView;
  category: { id: string; name: string } | null;
};

export type StagedOrderView = {
  artifact_id: string;
  external_ref: string;
  source_type: string | null;
  order_date: string | null;
  total_paise: number;
  invoice_count: number;
  needs_attention: boolean;
  match: {
    kind: "matched" | "ambiguous" | "none";
    transaction: Candidate | null;
  };
  lines: StagedLineView[];
};

/**
 * Every transaction, once per request.
 *
 * The same choice `evidence-detect.ts` makes and for the same reason: at this size, filtering
 * in the pure matcher is cheaper than a query per order, and it keeps the amount, date and
 * merchant rules in exactly ONE place instead of half in SQL and half in TypeScript.
 */
async function loadCandidates(client: PoolClient): Promise<Candidate[]> {
  const rows = await client.query<Candidate>(
    `SELECT t.id, t.txn_date::text, t.amount_paise, t.narration, acc.name AS account_name
       FROM transactions t JOIN accounts acc ON acc.id = t.account_id`,
  );
  return rows.rows.map((c) => ({ ...c, amount_paise: Number(c.amount_paise) }));
}

/** ISO date from the templates' own formats: "08.08.2026" and "02-Sep-2026". */
function isoDate(raw: string | null): string | null {
  if (!raw) return null;
  const dotted = raw.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;
  return null;
}

function toRawLine(sourceType: string, line: ParsedLine) {
  return {
    sourceType,
    description: line.description,
    // The template's own id — an ASIN for most things, an ISBN for a book. `upc` is the label
    // for "a merchant's global product number"; the kind only matters to a human reading it.
    sku: line.sku ? ({ kind: "asin" as const, value: line.sku }) : null,
  };
}

/**
 * What is waiting to be confirmed.
 *
 * Resolution is computed HERE rather than read from something stored at upload time, because
 * the catalogue moves between the two phases — see `previewLine`. Paging bounds the cost.
 */
export async function listStaged(
  client: PoolClient,
  opts: { limit: number; offset: number; attentionOnly: boolean },
): Promise<{ summary: Record<string, number>; orders: StagedOrderView[]; held: unknown[] }> {
  const staged = await client.query<{ id: string; external_ref: string; source_type: string | null; record: ParsedRecord }>(
    `SELECT id, external_ref, source_type, record FROM artifacts
      WHERE parse_status = 'staged' AND record IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    [opts.limit, opts.offset],
  );

  const candidates = await loadCandidates(client);
  const orders: StagedOrderView[] = [];

  for (const row of staged.rows) {
    const record = row.record;
    const sourceType = row.source_type ?? record.source_type;
    const lines: StagedLineView[] = [];
    let index = 0;
    let needsAttention = false;

    for (const invoice of record.invoices) {
      for (const line of invoice.lines) {
        const here = index++;
        // A fee is money, not merchandise. It never reaches the catalogue, so there is
        // nothing to resolve and nothing for a person to decide.
        if (line.kind === "fee") {
          lines.push({
            ...line, index: here,
            resolution: { action: "create", item_id: null, item_name: null, needs_input: false, candidates: [] },
            category: null,
          });
          continue;
        }

        const { resolution } = await previewLine(client, toRawLine(sourceType, line));
        let itemId: string | null = null;
        let itemName: string | null = null;
        let category: { id: string; name: string } | null = null;

        if (resolution.action !== "create") {
          itemId = resolution.itemId;
          const summary = await itemSummary(client, resolution.itemId);
          itemName = summary?.display_name ?? summary?.canonical_name ?? null;
          if (summary?.category_id && summary.category_name) {
            category = { id: summary.category_id, name: summary.category_name };
          }
        }

        // "Needs input" is narrow ON PURPOSE. A new product is not a question — it is the
        // ordinary case, and 230 of 230 items arrived that way. What deserves a person is a
        // FUZZY link, or a create that had near-misses we were not sure enough to take.
        const proposals = resolution.action === "create" ? resolution.propose : [];
        const needsInput = resolution.action === "link" || proposals.length > 0;
        if (needsInput) needsAttention = true;

        lines.push({
          ...line, index: here,
          resolution: {
            action: resolution.action,
            item_id: itemId,
            item_name: itemName,
            needs_input: needsInput,
            candidates: proposals.map((c) => ({
              item_id: c.itemId, name: c.canonicalName, similarity: c.similarity,
            })),
          },
          category,
        });
      }
    }

    // An invoice is money LEAVING, so the bank should show a debit of the order total.
    // `sourceType` carries the merchant filter — without it an Amazon order can auto-accept a
    // Flipkart debit of the same amount, which the design measured happening.
    const outcome = matchToTransaction(
      {
        externalRef: record.external_ref,
        date: isoDate(record.order_date) ?? "",
        expectedPaise: -record.total_paise,
        sourceType,
      },
      candidates,
    );
    // AMBIGUOUS needs a person: two bank rows fit and only they can say which. "None" does
    // NOT — most Amazon orders here were paid from the Amazon Pay wallet and will never have a
    // bank row, and the rest resolve themselves when the month's
    // statement is imported. Flagging those would mark almost every order as needing attention
    // and make the attention filter useless, which is the one thing this screen cannot afford.
    if (outcome.kind === "ambiguous") needsAttention = true;

    orders.push({
      artifact_id: row.id,
      external_ref: record.external_ref,
      source_type: sourceType,
      order_date: isoDate(record.order_date),
      total_paise: record.total_paise,
      invoice_count: record.invoices.length,
      needs_attention: needsAttention,
      match: {
        kind: outcome.kind,
        transaction:
          outcome.kind === "matched"
            ? candidates.find((c) => c.id === outcome.transactionId) ?? null
            : null,
      },
      lines,
    });
  }

  const counts = await client.query<{ staged: string; held: string; total_paise: string; uncategorised: string }>(
    `SELECT
       (SELECT count(*) FROM artifacts WHERE parse_status = 'staged')::text AS staged,
       (SELECT count(*) FROM artifacts WHERE parse_status IN ('unsupported','failed'))::text AS held,
       (SELECT coalesce(sum((record->>'total_paise')::bigint), 0)
          FROM artifacts WHERE parse_status = 'staged')::text AS total_paise,
       (SELECT count(*) FROM items WHERE category_id IS NULL)::text AS uncategorised`,
  );
  const c = counts.rows[0];

  const held = await client.query(
    `SELECT id AS artifact_id, original_name, parse_status, parse_error, source_type
       FROM artifacts WHERE parse_status IN ('unsupported', 'failed')
      ORDER BY created_at DESC LIMIT 200`,
  );

  return {
    summary: {
      staged: Number(c.staged),
      held: Number(c.held),
      total_paise: Number(c.total_paise),
      needs_attention: orders.filter((o) => o.needs_attention).length,
      uncategorised_items: Number(c.uncategorised),
    },
    orders: opts.attentionOnly ? orders.filter((o) => o.needs_attention) : orders,
    held: held.rows,
  };
}

export type ConfirmOverride = { item_id?: string; create_new?: boolean };

export type ConfirmResult = {
  landed: { artifact_id: string; external_ref: string; evidence_id: string; items_resolved: number }[];
  skipped: { artifact_id: string; reason: string }[];
  errors: { artifact_id: string; error: string }[];
};

/**
 * Land staged orders in the ledger.
 *
 * ONE TRANSACTION PER ORDER, managed by the caller. The unit of atomicity is the ORDER because
 * that is the person's unit: one bad order must not undo two hundred good ones, and a rollback
 * of a long confirm is worse than the failure that caused it.
 *
 * Idempotent. `evidence_source_ref_uniq` makes a second confirm of the same order a no-op
 * rather than a duplicate, so a double-click or a browser retry is safe — and the artifact
 * moving to 'parsed' means it stops appearing in the review.
 */
export async function confirmOne(
  client: PoolClient,
  artifactId: string,
  overrides: Record<string, ConfirmOverride>,
): Promise<{ external_ref: string; evidence_id: string; items_resolved: number }> {
  const row = await client.query<{ external_ref: string; source_type: string | null; record: ParsedRecord; parse_status: string }>(
    "SELECT external_ref, source_type, record, parse_status FROM artifacts WHERE id = $1",
    [artifactId],
  );
  if (row.rowCount === 0) throw new Error(`no artifact ${artifactId}`);
  const { record, parse_status } = row.rows[0];
  if (parse_status !== "staged" || !record) {
    throw new Error(`artifact ${artifactId} is ${parse_status}, not staged`);
  }
  const sourceType = row.rows[0].source_type ?? record.source_type;

  // UPSERT on the natural key, the same way the Splitwise importer does. An order re-uploaded
  // as different bytes — Amazon regenerates PDFs — is the SAME order, and must update rather
  // than duplicate.
  const evidence = await client.query<{ id: string }>(
    `INSERT INTO evidence (source_type, external_ref, evidence_date, amount_paise, description, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (source_type, external_ref) WHERE external_ref IS NOT NULL DO UPDATE
        SET evidence_date = EXCLUDED.evidence_date,
            amount_paise  = EXCLUDED.amount_paise,
            description   = EXCLUDED.description,
            payload       = EXCLUDED.payload
     RETURNING id`,
    [
      sourceType,
      record.external_ref,
      isoDate(record.order_date),
      // NEGATIVE: an invoice is money leaving. Storing the magnitude would make every order
      // look like income to anything that reads the sign.
      -record.total_paise,
      `${sourceType} order ${record.external_ref}`,
      JSON.stringify(record),
    ],
  );

  let resolved = 0;
  for (const invoice of record.invoices) {
    for (const line of invoice.lines) {
      if (line.kind === "fee") continue; // fees are money, never catalogue entries
      const key = `${artifactId}:${resolved}`;
      const override = overrides[key];
      if (override?.item_id) {
        // A person pointed this line at a product. That is a DECISION, so the alias is written
        // with source 'user' — the strongest provenance, and one a re-run must never overwrite.
        await client.query(
          `INSERT INTO item_aliases (item_id, source_type, alias_kind, alias_value, source, confidence, label)
           VALUES ($1, $2, 'sku', $3, 'user', 100, $4)
           ON CONFLICT (source_type, alias_kind, alias_value) DO NOTHING`,
          [override.item_id, sourceType, line.sku ?? line.description.slice(0, 180), line.description.slice(0, 500)],
        );
      } else {
        await resolveAndRecord(client, toRawLine(sourceType, line));
      }
      resolved++;
    }
  }

  await client.query(
    "UPDATE artifacts SET parse_status = 'parsed', external_ref = $2 WHERE id = $1",
    [artifactId, record.external_ref],
  );

  return { external_ref: record.external_ref, evidence_id: evidence.rows[0].id, items_resolved: resolved };
}
