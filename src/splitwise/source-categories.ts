// The source's vocabulary, and how it translates into ours.
//
// `source_category_map` is the flywheel's fourth instance, after merchants, people and items:
// an unknown string is surfaced with counts, a person decides once, and the decision applies
// BACKWARDS. This module is the "decides once, applies backwards" half — the map is data, so
// learning a category is a row, not a deploy.
//
// A mapping can be in two states, and they are not the same:
//
//   no row at all      -> never seen. Belongs in the queue; asking is the point.
//   row, category NULL -> deliberately unmappable. Do NOT ask again.
//
// `General` is the second kind. It is a catch-all — anything from an appliance to a repair
// visit to a snack — so any single mapping is wrong for most of it — which is why the
// per-record picker in web/src/sources/CategoryChoice.tsx exists alongside this.

import type { PoolClient } from "pg";

const SOURCE = "splitwise";

export type SourceCategory = {
  sourceCategory: string;
  /** null when the map has no answer — see `decided` for whether that was a choice. */
  categoryId: number | null;
  categoryName: string | null;
  parentName: string | null;
  /** A row exists. false means never seen, which is the state that deserves a prompt. */
  decided: boolean;
  note: string | null;
  /** How many imported records carry this source category, and what they are worth. */
  records: number;
  /** Records where someone else paid — the ones a mapping turns into consumption. */
  consumedRecords: number;
  consumedPaise: number;
};

/**
 * Every source category the ledger has actually SEEN, plus every one already decided.
 *
 * Both halves matter. Only-seen would hide a decision made about a category that has not
 * arrived yet; only-decided would hide exactly the categories that need a decision. The union
 * is the vocabulary this ledger has to have an opinion about.
 *
 * Counts come from `evidence`, not from the map, because "how much does this cost me to leave
 * undecided" is the question that makes one row worth answering before another.
 */
export async function listSourceCategories(
  client: PoolClient,
  me: string,
): Promise<SourceCategory[]> {
  const result = await client.query<{
    source_category: string;
    category_id: string | null;
    category_name: string | null;
    parent_name: string | null;
    decided: boolean;
    note: string | null;
    records: string;
    consumed_records: string;
    consumed_paise: string;
  }>(
    `WITH seen AS (
       SELECT ev.payload->>'source_category' AS source_category,
              COUNT(*)                                             AS records,
              COUNT(*) FILTER (WHERE ev.payload->>'kind' = 'expense'
                                 AND (ev.payload->'nets_paise'->>$2)::bigint < 0)
                                                                   AS consumed_records,
              COALESCE(SUM(ABS((ev.payload->'nets_paise'->>$2)::bigint))
                       FILTER (WHERE ev.payload->>'kind' = 'expense'
                                 AND (ev.payload->'nets_paise'->>$2)::bigint < 0), 0)
                                                                   AS consumed_paise
         FROM evidence ev
        WHERE ev.source_type = $1
        GROUP BY 1
     ),
     vocabulary AS (
       SELECT source_category FROM seen
       UNION
       SELECT source_category FROM source_category_map WHERE source_type = $1
     )
     SELECT v.source_category,
            m.category_id,
            c.name        AS category_name,
            p.name        AS parent_name,
            (m.source_category IS NOT NULL) AS decided,
            m.note,
            COALESCE(s.records, 0)          AS records,
            COALESCE(s.consumed_records, 0) AS consumed_records,
            COALESCE(s.consumed_paise, 0)   AS consumed_paise
       FROM vocabulary v
       -- LEFT, not INNER: vocabulary is the union of seen-and-decided, so a category that has
       -- been decided but has not arrived in any import yet has no seen row at all.
       LEFT JOIN seen s ON s.source_category = v.source_category
       LEFT JOIN source_category_map m
              ON m.source_type = $1 AND m.source_category = v.source_category
       LEFT JOIN categories c ON c.id = m.category_id
       LEFT JOIN categories p ON p.id = c.parent_id
      -- Undecided first, then by what they are worth: the order is the worklist.
      ORDER BY (m.source_category IS NOT NULL), COALESCE(s.consumed_paise, 0) DESC,
               v.source_category`,
    [SOURCE, me],
  );

  // pg returns BIGINT as a STRING. Narrowed once, here, rather than compared against a number
  // somewhere downstream and found unequal.
  return result.rows.map((r) => ({
    sourceCategory: r.source_category,
    categoryId: r.category_id === null ? null : Number(r.category_id),
    categoryName: r.category_name,
    parentName: r.parent_name,
    decided: r.decided,
    note: r.note,
    records: Number(r.records),
    consumedRecords: Number(r.consumed_records),
    consumedPaise: Number(r.consumed_paise),
  }));
}

export type RemapResult =
  | { ok: true; consumptionRebuilt: number; recordsAffected: number; relinked: number }
  | { ok: false; error: string };

/**
 * Decide (or un-decide) what one source category means, and apply it to what is already here.
 *
 * A mapping that only affected future imports would be a setting, not a decision — the whole
 * value of learning a category once is that every row already carrying it stops being
 * unclassified. So this rewrites what the old answer produced.
 *
 * WHAT IT MAY REWRITE, and what it must not:
 *
 *   consumption, source='evidence'   rebuilt from the new mapping
 *   allocations, source='evidence'   re-derived, by re-linking through the same writer
 *   anything source='user'           NEVER — a person's own answer outranks the map, and
 *                                    web/src/sources/CategoryChoice.tsx writes exactly that
 *
 * That last line is the same override invariant as everywhere else. Someone who answered a
 * `General` record by hand has said something more specific than any map row can, and a
 * mapping arriving later must not quietly undo it.
 */
export async function remapSourceCategory(
  client: PoolClient,
  sourceCategory: string,
  categoryId: number | null,
  me: string,
  note?: string,
): Promise<RemapResult> {
  const name = sourceCategory.trim();
  if (name === "") return { ok: false, error: "which source category?" };

  if (categoryId !== null) {
    // Checked here rather than left to the foreign key: a violation surfaces as an internal
    // error, which blames us for what is the caller's typo.
    const exists = await client.query("SELECT 1 FROM categories WHERE id = $1", [categoryId]);
    if (exists.rowCount === 0) return { ok: false, error: "no such category" };
  }

  await client.query(
    `INSERT INTO source_category_map (source_type, source_category, category_id, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_type, source_category)
     DO UPDATE SET category_id = EXCLUDED.category_id, note = EXCLUDED.note`,
    [SOURCE, name, categoryId, note ?? null],
  );

  // ---- consumption: rebuilt from the map -------------------------------------------------
  //
  // Deleted then re-inserted rather than UPDATEd, because a mapping can go BACK to null and an
  // update has no way to express "this row should no longer exist".
  const removed = await client.query(
    `DELETE FROM consumption con
      USING evidence ev
      WHERE con.evidence_id = ev.id
        AND con.source = 'evidence'
        AND ev.source_type = $1
        AND ev.payload->>'source_category' = $2`,
    [SOURCE, name],
  );

  let rebuilt = 0;
  if (categoryId !== null) {
    // The rule for what becomes consumption — an EXPENSE the owner did not pay for — is
    // `planImport`'s, and this is the second place it is written. They must agree; the pair is
    // covered by src/source-categories.test.ts, which runs the plan and this predicate over
    // the same fixture and asserts they pick the same rows.
    const inserted = await client.query(
      `INSERT INTO consumption (evidence_id, category_id, amount_paise, consumed_on, source)
       SELECT ev.id, $3, (ev.payload->'nets_paise'->>$4)::bigint, ev.evidence_date, 'evidence'
         FROM evidence ev
        WHERE ev.source_type = $1
          AND ev.payload->>'source_category' = $2
          AND ev.payload->>'kind' = 'expense'
          AND (ev.payload->'nets_paise'->>$4)::bigint < 0`,
      [SOURCE, name, categoryId, me],
    );
    rebuilt = inserted.rowCount ?? 0;
  }

  const affected = await client.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM evidence
      WHERE source_type = $1 AND payload->>'source_category' = $2`,
    [SOURCE, name],
  );

  return {
    ok: true,
    consumptionRebuilt: rebuilt,
    recordsAffected: Number(affected.rows[0].n),
    // Re-linking is done by the caller, which owns the writer — see routes/evidence.ts.
    relinked: removed.rowCount ?? 0,
  };
}

/**
 * Records whose ALLOCATIONS still came from the map for this source category, and so need
 * re-deriving after it changes.
 *
 * Excludes anything a person answered themselves: `categoriseEvidence` writes those with
 * `source = 'user'`, and re-deriving one would replace their answer with the map's — the one
 * thing the engine's most important invariant forbids: a machine re-run never overwrites a
 * human decision.
 */
export async function evidenceNeedingRederive(
  client: PoolClient,
  sourceCategory: string,
): Promise<string[]> {
  const rows = await client.query<{ id: string }>(
    `SELECT DISTINCT ev.id
       FROM evidence ev
       JOIN evidence_transactions et ON et.evidence_id = ev.id
      WHERE ev.source_type = $1
        AND ev.payload->>'source_category' = $2
        AND NOT EXISTS (
          SELECT 1 FROM allocations a
           WHERE a.evidence_id = ev.id AND a.source = 'user'
        )`,
    [SOURCE, sourceCategory.trim()],
  );
  return rows.rows.map((r) => r.id);
}
