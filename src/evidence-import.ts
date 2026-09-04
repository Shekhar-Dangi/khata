// Importing an external record file into the ledger — the DB half of the parsers.
//
// Lives in src/ rather than in the script that used to hold it, so the HTTP route and the
// CLI are both thin callers of one implementation. The rule: the
// logic is a pure function, and the UI and the CLI are both thin callers. Two copies would
// drift on exactly the thing that matters — what counts as a duplicate.

import type { PoolClient } from "pg";

import { parseSplitwiseExport } from "./splitwise.ts";
import { type CategoryMap, planImport } from "./splitwise-plan.ts";

const SOURCE = "splitwise";

/**
 * Which parser handles this file, by CONTENT rather than by filename.
 *
 * Filenames are user-controlled and meaningless, and a file renamed on
 * the way out of a phone would silently pick the wrong parser. The header signature is the
 * thing the format actually guarantees.
 *
 * Returns null when nothing recognises it, which is a real answer — the artifact is stored
 * unparsed and listed for review rather than forced through a parser that will mangle it.
 */
export function detectSource(text: string): "splitwise" | null {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const cells = firstLine.split(",").map((c) => c.trim());
  const splitwise = ["Date", "Description", "Category", "Cost", "Currency"];
  if (splitwise.every((want, i) => cells[i] === want)) return SOURCE;
  return null;
}

export type ImportOutcome = {
  source: "splitwise";
  group: string;
  /** Non-fatal notes from the parser — a footer that does not reconcile, mixed currencies. */
  warnings: string[];
  rows: number;
  stats: { paid: number; owedByMe: number; notMine: number; payments: number };
  evidenceWritten: number;
  consumptionWritten: number;
  consumptionReplaced: number;
  /** Real consumption we cannot categorise yet, because the source category has no mapping. */
  unclassified: { count: number; amountPaise: number };
  /** Source categories with no row in the map at all — these need a decision. */
  unmappedCategories: string[];
};

export type ImportResult =
  | { ok: true; outcome: ImportOutcome }
  | { ok: false; errors: string[] };

/**
 * Parse a Splitwise export and land it as evidence + consumption.
 *
 * Idempotent: evidence UPSERTs on its natural key, and consumption for this group is
 * regenerated rather than appended. Re-importing the same file twice leaves the same rows.
 */
export async function importEvidenceFile(
  client: PoolClient,
  text: string,
  opts: { group: string; me: string },
): Promise<ImportResult> {
  const source = detectSource(text);
  if (source === null) {
    return {
      ok: false,
      errors: [
        "this file was not recognised — expected a Splitwise group export " +
          "(Date, Description, Category, Cost, Currency, then one column per person)",
      ],
    };
  }

  const parsed = parseSplitwiseExport(text, opts.me);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const mapRows = await client.query<{ source_category: string; category_id: string | null }>(
    "SELECT source_category, category_id FROM source_category_map WHERE source_type = $1",
    [SOURCE],
  );
  // pg returns BIGINT as a STRING, because a bigint does not fit a JS number. The narrowing
  // happens exactly once, here, rather than being left to compare unequal against a number
  // somewhere downstream.
  const map: CategoryMap = new Map(
    mapRows.rows.map((r) => [
      r.source_category,
      r.category_id === null ? null : Number(r.category_id),
    ]),
  );

  // The raw group goes IN; `plan.group` — the normalised name the rows were actually keyed
  // by — is what comes out and what everything below uses. Scoping the sweep with a
  // differently-spelled version of the same name would delete nothing and then insert,
  // doubling a group's consumption on every re-import instead of replacing it.
  const plan = planImport(parsed.data.rows, opts.group, map);

  for (const e of plan.evidence) {
    // UPSERT, not insert-or-ignore. A Splitwise expense is a shared editable document —
    // unlike a bank transaction, someone can change it after the fact — so pinning the
    // first version we ever saw would be wrong. Each export is a full snapshot; newest wins.
    await client.query(
      `INSERT INTO evidence
         (source_type, external_ref, evidence_date, amount_paise, description, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (source_type, external_ref) WHERE external_ref IS NOT NULL DO UPDATE
          SET evidence_date = EXCLUDED.evidence_date,
              amount_paise  = EXCLUDED.amount_paise,
              description   = EXCLUDED.description,
              payload       = EXCLUDED.payload`,
      [SOURCE, e.externalRef, e.date, e.costPaise, e.description, JSON.stringify(e.payload)],
    );
  }

  // Regenerate consumption for THIS group, scoped the way the rules engine scopes its sweep.
  // Two things it must not do: touch another group's rows, and touch a row a human wrote.
  // `source = 'evidence'` protects the second — a 'user' row is a decision, and re-importing
  // is not allowed to overwrite a decision.
  const replaced = await client.query(
    `DELETE FROM consumption con
      USING evidence ev
      WHERE con.evidence_id = ev.id
        AND con.source = 'evidence'
        AND ev.source_type = $1
        AND ev.payload->>'group' = $2`,
    [SOURCE, plan.group],
  );

  for (const c of plan.consumption) {
    await client.query(
      `INSERT INTO consumption (evidence_id, category_id, amount_paise, consumed_on, source)
       SELECT id, $2, $3, $4, 'evidence' FROM evidence
        WHERE source_type = $1 AND external_ref = $5`,
      [SOURCE, c.categoryId, c.amountPaise, c.consumedOn, c.externalRef],
    );
  }

  return {
    ok: true,
    outcome: {
      source: SOURCE,
      group: plan.group,
      warnings: parsed.data.warnings,
      rows: parsed.data.rows.length,
      stats: plan.stats,
      evidenceWritten: plan.evidence.length,
      consumptionWritten: plan.consumption.length,
      consumptionReplaced: replaced.rowCount ?? 0,
      unclassified: {
        count: plan.unclassified.length,
        amountPaise: plan.unclassified.reduce((a, u) => a + u.amountPaise, 0),
      },
      unmappedCategories: plan.unmappedCategories,
    },
  };
}
