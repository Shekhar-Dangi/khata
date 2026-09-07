// The two-phase import: what is waiting for a person, and what happens when they say yes.
//
// the design. `artifacts` is the INBOX and `evidence` is the LEDGER, and this module
// is the door between them. Uploading fills the inbox — bytes stored, order parsed, arithmetic
// checked — and nothing else moves until someone confirms. That line is what lets the review
// survive a page refresh, lets 200 orders land today and 10 next week, and means confirming
// re-uploads nothing.

import type { PoolClient } from "pg";

import { type Candidate, matchToTransaction } from "./evidence-match.ts";
import { canonicalName } from "./items.ts";
import { itemSummary, previewLine, resolveAndRecord } from "./items-store.ts";
import type { ParsedLine, ParsedRecord } from "./pdf-extract.ts";

export type LineResolutionView = {
  /**
   * 'fee' is its own action rather than a flavour of 'create'.
   *
   * It was 'create' with nulls hung off it, and every screen that rendered an action
   * therefore announced "New product" beside "Cash/Pay on Delivery fee" — offering to file a
   * delivery charge in the product catalogue. A state that has to be special-cased by every
   * reader is a state that will eventually not be.
   */
  action: "existing" | "link" | "create" | "fee";
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
  /**
   * The invoice's words reduced to the key the catalogue is actually addressed by — quantity
   * and pack form stripped, per the owner decision recorded on `canonicalName`.
   *
   * Sent because it is the ONLY way a person can see WHY two lines resolved to one product or
   * failed to: the raw strings differ, the resolution says "existing", and without the key in
   * between the answer is unexplainable. Null for a fee, which never reaches the catalogue.
   */
  canonical: string | null;
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
  // EVERY staged record, not a page of them — then the page is sliced below.
  //
  // The summary has to count what is actually waiting, and `needs_attention` can only be known
  // by RESOLVING an order's lines. Paging in SQL made that number change as you paged: the
  // same inbox reported "1 need you" on one page size and "0" on another, which is worse than
  // no number at all.
  //
  // The cost is bounded by how much is staged, and staged is a queue a person is actively
  // emptying rather than an archive: ~500 indexed lookups for the whole 221-order corpus. If
  // that ever stops being true the fix is a resolution cache keyed by canonical name, not a
  // summary that quietly describes a different set from the one on screen.
  const staged = await client.query<{ id: string; external_ref: string; source_type: string | null; record: ParsedRecord }>(
    `SELECT id, external_ref, source_type, record FROM artifacts
      WHERE parse_status = 'staged' AND record IS NOT NULL
      ORDER BY created_at DESC, id DESC`,
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
            resolution: { action: "fee", item_id: null, item_name: null, needs_input: false, candidates: [] },
            category: null,
            canonical: null,
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
          canonical: canonicalName(line.description),
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

  // The summary spans EVERYTHING staged, not the page being shown. A header that counted only
  // the current page would quietly change as you paged, which is the opposite of what a
  // summary is for.
  //
  // `uncategorised_lines` answers the question the screen leads with — "will confirming
  // categorise anything?" — so it counts the goods lines ABOUT TO LAND that would have no
  // category, not the catalogue at large. A line lands uncategorised when its product is new
  // (no alias yet) or when the product it resolves to has no category. Fee lines never reach
  // the catalogue and are excluded.
  const counts = await client.query<{ staged: string; held: string; total_paise: string; uncategorised: string }>(
    `SELECT
       (SELECT count(*) FROM artifacts WHERE parse_status = 'staged')::text AS staged,
       (SELECT count(*) FROM artifacts WHERE parse_status IN ('unsupported','failed'))::text AS held,
       (SELECT coalesce(sum((record->>'total_paise')::bigint), 0)
          FROM artifacts WHERE parse_status = 'staged')::text AS total_paise,
       (SELECT count(*)
          FROM artifacts a
          CROSS JOIN LATERAL jsonb_array_elements(a.record->'invoices') AS inv
          CROSS JOIN LATERAL jsonb_array_elements(inv->'lines') AS ln
          LEFT JOIN item_aliases al
            ON al.source_type = a.source_type
           AND al.alias_kind = 'sku'
           AND al.alias_value = (ln->>'sku')
          LEFT JOIN items it ON it.id = al.item_id
         WHERE a.parse_status = 'staged'
           AND ln->>'kind' = 'goods'
           AND (it.id IS NULL OR it.category_id IS NULL))::text AS uncategorised`,
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
      uncategorised_lines: Number(c.uncategorised),
    },
    // Filter FIRST, then page — so "page 2 of what needs you" is page 2 of that list rather
    // than whatever survived filtering an arbitrary window.
    orders: (opts.attentionOnly ? orders.filter((o) => o.needs_attention) : orders)
      .slice(opts.offset, opts.offset + opts.limit),
    held: held.rows,
  };
}

export type StagedItemView = {
  /** Stable across a page reload: the merchant's own id, or the canonical name. */
  key: string;
  source_type: string;
  sku: string | null;
  /** The fullest description seen for this product across the staged set. */
  description: string;
  /** That description reduced to the key the catalogue is addressed by. See StagedLineView. */
  canonical: string;
  /** How many staged LINES resolve to this product, and what they are worth. */
  line_count: number;
  total_paise: number;
  /** Which orders it appears in — so a person can see it is not a one-off. */
  order_refs: string[];
  action: "existing" | "link" | "create";
  item_id: string | null;
  item_name: string | null;
  category: { id: string; name: string } | null;
  needs_input: boolean;
  candidates: { item_id: string; name: string; similarity: number }[];
};

/**
 * Every PRODUCT the staged set will touch, once.
 *
 * The unit of work is the product, not the line. 365 goods lines across the real corpus
 * resolve to 234 distinct products, and a category is a property of the product — so filing
 * them per line means answering the same question up to a dozen times and getting a different
 * answer on the twelfth. Fees never appear here at all: they are money, not merchandise.
 *
 * `q` filters on the description, server-side, because the catalogue is not shipped to a
 * browser.
 */
export async function listStagedItems(
  client: PoolClient,
  opts: { q?: string; needsInputOnly?: boolean },
): Promise<{ items: StagedItemView[]; total: number; needs_input: number }> {
  const staged = await client.query<{ source_type: string | null; record: ParsedRecord }>(
    `SELECT source_type, record FROM artifacts
      WHERE parse_status = 'staged' AND record IS NOT NULL
      ORDER BY created_at DESC, id DESC`,
  );

  // Group first, resolve second. Resolving per LINE would repeat the same lookups once per
  // sighting — 365 times instead of 234 — and could return different answers for one product
  // within a single response, since each resolution sees the catalogue as the previous one
  // left it.
  const grouped = new Map<string, {
    sourceType: string; sku: string | null; description: string;
    lines: number; paise: number; orders: Set<string>;
  }>();

  for (const row of staged.rows) {
    const record = row.record;
    const sourceType = row.source_type ?? record.source_type;
    for (const invoice of record.invoices) {
      for (const line of invoice.lines) {
        if (line.kind === "fee") continue;
        const canon = canonicalName(line.description);
        const key = `${sourceType}:${line.sku ?? `name:${canon}`}`;
        const existing = grouped.get(key);
        if (existing) {
          existing.lines += 1;
          existing.paise += line.amount_paise;
          existing.orders.add(record.external_ref);
          // Keep the FULLEST description seen. Amazon truncates the same product at different
          // column widths, and the longest one is the least lossy thing to show a person.
          if (line.description.length > existing.description.length) {
            existing.description = line.description;
          }
        } else {
          grouped.set(key, {
            sourceType, sku: line.sku, description: line.description,
            lines: 1, paise: line.amount_paise, orders: new Set([record.external_ref]),
          });
        }
      }
    }
  }

  const items: StagedItemView[] = [];
  let needsInput = 0;
  for (const [key, g] of grouped) {
    const { resolution } = await previewLine(client, {
      sourceType: g.sourceType,
      description: g.description,
      sku: g.sku ? { kind: "asin", value: g.sku } : null,
    });

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
    const proposals = resolution.action === "create" ? resolution.propose : [];
    const needs = resolution.action === "link" || proposals.length > 0;
    if (needs) needsInput++;

    items.push({
      key,
      source_type: g.sourceType,
      sku: g.sku,
      description: g.description,
      canonical: canonicalName(g.description),
      line_count: g.lines,
      total_paise: g.paise,
      order_refs: [...g.orders].slice(0, 8),
      action: resolution.action,
      item_id: itemId,
      item_name: itemName,
      category,
      needs_input: needs,
      candidates: proposals.map((c) => ({
        item_id: c.itemId, name: c.canonicalName, similarity: c.similarity,
      })),
    });
  }

  const needle = opts.q?.trim().toLowerCase();
  const filtered = items.filter((i) => {
    if (opts.needsInputOnly && !i.needs_input) return false;
    if (!needle) return true;
    return i.description.toLowerCase().includes(needle)
      || (i.item_name ?? "").toLowerCase().includes(needle)
      || (i.sku ?? "").toLowerCase().includes(needle);
  });
  // Most-bought first: the products worth filing are the ones you buy repeatedly, which is the
  // entire economic argument for a catalogue.
  filtered.sort((a, b) => b.line_count - a.line_count || b.total_paise - a.total_paise);

  return { items: filtered, total: items.length, needs_input: needsInput };
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
  /**
   * Keyed by PRODUCT, not by line: "amazon:B0BG6CT9ZV".
   *
   * A decision belongs to the product, so making it once has to apply to every line and every
   * order that product appears in. Keying by line meant answering the same question up to
   * twelve times, and the twelfth answer silently winning wherever it differed.
   */
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
      // Same key the items view emits, so a decision made there reaches every sighting.
      const canon = canonicalName(line.description);
      const override = overrides[`${sourceType}:${line.sku ?? `name:${canon}`}`];
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
