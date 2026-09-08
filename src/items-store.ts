// The DB half of the product catalogue — the counterpart to the pure src/items.ts, the same
// way evidence-detect.ts is the DB half of evidence-match.ts.
//
// Everything that decides WHETHER two things are the same product lives in items.ts and is
// tested without a database. This file does lookups, writes, and the one genuinely stateful
// operation: merging two items into one.

import type { PoolClient } from "pg";

import {
  PROPOSE_SIMILARITY,
  type Candidate,
  type RawLine,
  type Resolution,
  canonicalName,
  extractVariantAttributes,
  resolveLine,
  variantDiff,
} from "./items.ts";

/** How many trigram neighbours to consider. Beyond a handful they are all noise. */
const CANDIDATE_LIMIT = 5;

export type ResolvedItem = {
  itemId: string;
  resolution: Resolution;
  /** True when this call brought the item into existence. */
  created: boolean;
  /** Merge questions this call raised, if any. */
  proposalsRaised: number;
};

/** An alias already pointing somewhere — tiers 1 and 2, exact and free. */
async function findAlias(
  client: PoolClient,
  line: RawLine,
  canon: string,
): Promise<{ itemId: string; via: "sku" | "name" } | null> {
  // SKU first: it is the merchant's own id, and the corpus showed 22% of ASINs printing under
  // more than one name — so where a SKU exists it is strictly better evidence than the string.
  if (line.sku?.value) {
    const bySku = await client.query<{ item_id: string }>(
      `SELECT item_id FROM item_aliases
        WHERE source_type = $1 AND alias_kind = 'sku' AND alias_value = $2`,
      [line.sourceType, line.sku.value],
    );
    if (bySku.rowCount) return { itemId: bySku.rows[0].item_id, via: "sku" };
  }
  const byName = await client.query<{ item_id: string }>(
    `SELECT item_id FROM item_aliases
      WHERE source_type = $1 AND alias_kind = 'name' AND alias_value = $2`,
    [line.sourceType, canon],
  );
  if (byName.rowCount) return { itemId: byName.rows[0].item_id, via: "name" };
  return null;
}

/**
 * Trigram neighbours, best first.
 *
 * `%` is pg_trgm's similarity operator and is what makes the GIN index usable; it applies the
 * server's own threshold, which is looser than ours, so the real cut happens in the pure
 * `resolveLine`. Two filters would be two places to change a policy.
 */
async function findCandidates(
  client: PoolClient,
  canon: string,
  line: RawLine,
): Promise<Candidate[]> {
  const rows = await client.query<{
    id: string; canonical_name: string; sim: number; conflicting_sku: boolean;
  }>(
    `SELECT i.id, i.canonical_name, (similarity(i.canonical_name, $1) * 100)::int AS sim,
            -- Does this candidate already carry a DIFFERENT id from the SAME merchant? If so
            -- the merchant is telling us these are two things, and no similarity score may
            -- overrule that. $3 is NULL when the incoming line has no SKU, and then nothing
            -- conflicts.
            EXISTS (
              SELECT 1 FROM item_aliases a
               WHERE a.item_id = i.id AND a.alias_kind = 'sku'
                 AND a.source_type = $2 AND a.alias_value IS DISTINCT FROM $3
            ) AS conflicting_sku
       FROM items i
      WHERE i.canonical_name % $1
      ORDER BY sim DESC, i.id
      LIMIT ${CANDIDATE_LIMIT}`,
    [canon, line.sourceType, line.sku?.value ?? null],
  );
  return rows.rows.map((r) => ({
    itemId: r.id,
    canonicalName: r.canonical_name,
    similarity: r.sim,
    hasConflictingSku: r.conflicting_sku,
  }));
}

async function addAlias(
  client: PoolClient,
  itemId: string,
  line: RawLine,
  canon: string,
  source: "exact" | "trigram" | "user",
  confidence: number,
): Promise<void> {
  // The label is what the merchant actually printed, kept per ALIAS rather than per item.
  // It is what makes grouping sizes lossless: the item says "Continental Coffee", the alias
  // says which pouch (migration 013).
  const label = line.description.trim().slice(0, 500);
  // Size and pack, kept rather than discarded (migration 014). Deterministic -- the same
  // regexes canonicalName uses to strip them.
  const attributes = JSON.stringify(extractVariantAttributes(line.description));
  // ON CONFLICT DO NOTHING, not an upsert. If a raw string already points somewhere, that is
  // an EXISTING decision — possibly a person's — and quietly repointing it is the silent wrong
  // merge this whole design exists to avoid.
  if (line.sku?.value) {
    await client.query(
      `INSERT INTO item_aliases (item_id, source_type, alias_kind, alias_value, source, confidence, label, attributes)
       VALUES ($1, $2, 'sku', $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (source_type, alias_kind, alias_value) DO NOTHING`,
      [itemId, line.sourceType, line.sku.value, source, confidence, label, attributes],
    );
  }
  await client.query(
    `INSERT INTO item_aliases (item_id, source_type, alias_kind, alias_value, source, confidence, label, attributes)
     VALUES ($1, $2, 'name', $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (source_type, alias_kind, alias_value) DO NOTHING`,
    [itemId, line.sourceType, canon, source, confidence, label, attributes],
  );
}

async function raiseProposals(
  client: PoolClient,
  itemId: string,
  propose: Candidate[],
): Promise<number> {
  let raised = 0;
  for (const c of propose) {
    const lo = BigInt(itemId) < BigInt(c.itemId) ? itemId : c.itemId;
    const hi = BigInt(itemId) < BigInt(c.itemId) ? c.itemId : itemId;
    if (lo === hi) continue;
    // Ordered pair + unique index: a pair proposed from both directions is ONE question, not
    // two. DO NOTHING also means a pair already REJECTED is not asked again — a person's "no"
    // has to survive the next import or the queue never empties.
    const r = await client.query(
      `INSERT INTO item_merge_proposals (lo_item_id, hi_item_id, similarity, source)
       VALUES ($1, $2, $3, 'trigram')
       ON CONFLICT (lo_item_id, hi_item_id) DO NOTHING`,
      [lo, hi, c.similarity],
    );
    raised += r.rowCount ?? 0;
  }
  return raised;
}

/**
 * What WOULD happen to this line, without writing anything.
 *
 * The review screen needs this before a person confirms, and it must be computed at READ time
 * rather than stored when the file was uploaded: someone can upload 200 orders today and
 * confirm them tomorrow, and in between they may have categorised items or accepted merges.
 * A stored preview would quietly describe a catalogue that no longer exists.
 *
 * Shares every step with `resolveAndRecord` below except the writes, so the preview cannot
 * disagree with what confirming actually does.
 */
export async function previewLine(
  client: PoolClient,
  line: RawLine,
): Promise<{ resolution: Resolution; canonical: string }> {
  const canon = canonicalName(line.description);
  if (canon === "") return { resolution: { action: "create", confidence: 100, propose: [] }, canonical: "" };
  const aliasHit = await findAlias(client, line, canon);
  const candidates = aliasHit ? [] : await findCandidates(client, canon, line);
  return { resolution: resolveLine(aliasHit, candidates, canon), canonical: canon };
}

/** The name and category an item shows in a review screen. */
export async function itemSummary(client: PoolClient, itemId: string) {
  const r = await client.query<{
    id: string; display_name: string | null; canonical_name: string;
    category_id: string | null; category_name: string | null;
  }>(
    `SELECT i.id, i.display_name, i.canonical_name, i.category_id, c.name AS category_name
       FROM items i LEFT JOIN categories c ON c.id = i.category_id WHERE i.id = $1`,
    [itemId],
  );
  return r.rowCount ? r.rows[0] : null;
}

/**
 * Turn one raw merchant line into a catalogue item, writing whatever that implies.
 *
 * The ONE entry point a parser calls. It never blocks and never merges: the worst outcome is a
 * new item plus a question in the review queue, which is the safe direction (the design
 * — a duplicate is visible and recoverable, a wrong merge is silent and permanent).
 */
export async function resolveAndRecord(
  client: PoolClient,
  line: RawLine,
): Promise<ResolvedItem> {
  const canon = canonicalName(line.description);
  if (canon === "") {
    throw new Error(`line description canonicalises to nothing: ${line.description.slice(0, 80)}`);
  }

  const aliasHit = await findAlias(client, line, canon);
  const candidates = aliasHit ? [] : await findCandidates(client, canon, line);
  const resolution = resolveLine(aliasHit, candidates, canon);

  if (resolution.action === "existing") {
    // Seen before. Record the OTHER alias too if this sighting carried one the item lacks —
    // the first time a product arrives with a SKU after arriving without one, that is new
    // information and the next lookup should be exact rather than fuzzy.
    await addAlias(client, resolution.itemId, line, canon, "exact", 100);
    await client.query("UPDATE items SET updated_at = now() WHERE id = $1", [resolution.itemId]);
    return { itemId: resolution.itemId, resolution, created: false, proposalsRaised: 0 };
  }

  if (resolution.action === "link") {
    await addAlias(client, resolution.itemId, line, canon, "trigram", resolution.confidence);
    // The word that differs from the sibling IS the variant axis (cola / lemon / orange).
    // Derived from the pair rather than guessed at, so no vocabulary of flavours is needed --
    // and recorded under `variant` because we know the VALUE without knowing the axis's NAME.
    // Naming it is a later, once-per-family question; the value is useful immediately.
    const sibling = candidates.find((c) => c.itemId === resolution.itemId);
    if (sibling) {
      const diff = variantDiff(canon, sibling.canonicalName);
      const mine = diff.differing.filter((t) => canon.split(" ").includes(t));
      if (mine.length > 0) {
        await client.query(
          `UPDATE item_aliases
              SET attributes = attributes || jsonb_build_object('variant', $3::text)
            WHERE item_id = $1 AND alias_kind = 'name' AND alias_value = $2`,
          [resolution.itemId, canon, mine.join(" ")],
        );
      }
    }
    await client.query("UPDATE items SET updated_at = now() WHERE id = $1", [resolution.itemId]);
    return { itemId: resolution.itemId, resolution, created: false, proposalsRaised: 0 };
  }

  // Create. `display_name` keeps the raw string; the canonical one is only for comparison.
  const inserted = await client.query<{ id: string }>(
    "INSERT INTO items (canonical_name, display_name) VALUES ($1, $2) RETURNING id",
    [canon, line.description.trim()],
  );
  const itemId = inserted.rows[0].id;
  await addAlias(client, itemId, line, canon, "exact", 100);
  const proposalsRaised = await raiseProposals(client, itemId, resolution.propose);
  return { itemId, resolution, created: true, proposalsRaised };
}

// ---------------------------------------------------------------------------------------
// Reads and edits, for the Items screen
// ---------------------------------------------------------------------------------------

export type ItemRow = {
  id: string;
  canonical_name: string;
  display_name: string | null;
  category_id: string | null;
  category_name: string | null;
  category_source: string | null;
  alias_count: number;
  /**
   * How many invoice LINES across the whole ledger resolve to this product.
   *
   * Derived, not stored, and that is the honest shape: nothing increments a counter today, so a
   * column would be a cache with no writer. Computed by walking the confirmed evidence payloads
   * and joining their line skus to this item's aliases — the same key `resolveAndRecord` wrote,
   * so the count and the resolution cannot disagree.
   *
   * Zero is a real answer: an item created by hand through `POST /items/resolve` has no
   * purchase behind it yet.
   */
  times_seen: number;
  updated_at: string;
};

/**
 * File MANY products under one category, in one statement.
 *
 * Two ways to say which, and the difference matters. `itemIds` is an explicit selection — the
 * rows a person ticked, and exactly those. A filter instead means "everything matching what is
 * on screen", which is the only honest way to offer "all 119" from a server-paged list: the
 * browser holds one page and cannot name the rest, so shipping ids would silently mean the
 * page. Same reasoning as the staged worklist's select-all.
 *
 * Always `source = 'user'`: this is reached only from a person pressing a button, and 'user' is
 * the provenance the design  says a re-run of the classifier may never
 * overwrite. Confidence is 100 for the same reason — a decision, not an estimate.
 */
export async function setCategoryForMany(
  client: PoolClient,
  opts: {
    categoryId: number | null;
    itemIds?: number[];
    q?: string;
    unclassifiedOnly?: boolean;
  },
): Promise<number> {
  const params: unknown[] = [opts.categoryId, opts.categoryId === null ? null : 100];
  const where: string[] = [];

  if (opts.itemIds !== undefined) {
    params.push(opts.itemIds);
    where.push(`id = ANY($${params.length}::bigint[])`);
  } else {
    // Mirrors listItems' predicates exactly. Two places building "which items" from the same
    // query string is how a bulk action comes to touch a different set from the one shown.
    if (opts.q) {
      params.push(`%${opts.q.toLowerCase()}%`);
      where.push(`(canonical_name LIKE $${params.length} OR lower(display_name) LIKE $${params.length})`);
    }
    if (opts.unclassifiedOnly) where.push("category_id IS NULL");
  }

  // An unfiltered, unselected call would file the WHOLE catalogue. Refused rather than
  // obeyed: there is no button that should mean that, so a request shaped like one is a bug.
  if (where.length === 0) throw new Error("refusing to file every item — send item_ids or a filter");

  const done = await client.query(
    // `category_source` follows the id in and out. `items_category_has_source` CHECKs that the
    // two are null together — a category with no provenance is unreviewable — so writing
    // 'user' beside a cleared id is a constraint violation, not a stylistic slip. Same shape
    // and the same casts as `setItemCategory`, for the same reason recorded there.
    `UPDATE items
        SET category_id = $1,
            category_source = CASE WHEN $1::bigint IS NULL THEN NULL ELSE 'user' END,
            category_confidence = $2::smallint,
            updated_at = now()
      WHERE ${where.join(" AND ")}`,
    params,
  );
  return done.rowCount ?? 0;
}

export async function listItems(
  client: PoolClient,
  opts: { q?: string; unclassifiedOnly?: boolean; limit: number; offset: number },
): Promise<{ rows: ItemRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.q) {
    params.push(`%${opts.q.toLowerCase()}%`);
    where.push(`(i.canonical_name LIKE $${params.length} OR lower(i.display_name) LIKE $${params.length})`);
  }
  if (opts.unclassifiedOnly) where.push("i.category_id IS NULL");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await client.query<ItemRow>(
    // MOST-BOUGHT FIRST, because the products worth classifying are the ones you buy again —
    // that is the entire economic argument for a catalogue. Most
    // recently touched, the old order, put whatever you happened to edit last at the top, which
    // is a fact about your session rather than about your shopping.
    //
    // The count is a CTE computed once per request rather than a correlated subquery per row.
    // It walks every confirmed payload, which is bounded by how much has been imported and is
    // ~400 rows here; if that stops being cheap the fix is a counter maintained by
    // `resolveAndRecord`, not a page whose order depends on which slice you asked for.
    `WITH seen AS (
       SELECT a.item_id, count(*)::int AS times
         FROM evidence e
         CROSS JOIN LATERAL jsonb_array_elements(e.payload->'invoices') inv
         CROSS JOIN LATERAL jsonb_array_elements(inv->'lines') ln
         JOIN item_aliases a
           ON a.source_type = e.source_type
          AND a.alias_kind = 'sku'
          AND a.alias_value = ln->>'sku'
        WHERE ln->>'kind' IS DISTINCT FROM 'fee'
        GROUP BY a.item_id
     )
     SELECT i.id, i.canonical_name, i.display_name, i.category_id,
            c.name AS category_name, i.category_source,
            (SELECT count(*)::int FROM item_aliases a WHERE a.item_id = i.id) AS alias_count,
            COALESCE(s.times, 0) AS times_seen,
            i.updated_at
       FROM items i
       LEFT JOIN categories c ON c.id = i.category_id
       LEFT JOIN seen s ON s.item_id = i.id
       ${clause}
      ORDER BY times_seen DESC, i.updated_at DESC, i.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, opts.limit, opts.offset],
  );
  const total = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM items i ${clause}`,
    params,
  );
  return { rows: rows.rows, total: Number(total.rows[0].count) };
}

export async function getItem(client: PoolClient, id: number) {
  const item = await client.query(
    `SELECT i.*, c.name AS category_name
       FROM items i LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.id = $1`,
    [id],
  );
  if (item.rowCount === 0) return null;
  const aliases = await client.query(
    `SELECT id, source_type, alias_kind, alias_value, label, attributes, source, confidence, created_at
       FROM item_aliases WHERE item_id = $1 ORDER BY alias_kind, alias_value`,
    [id],
  );
  return { ...item.rows[0], aliases: aliases.rows };
}

/**
 * Set (or clear) an item's category.
 *
 * `source` is required and carries the override invariant: a 'user' row is a DECISION, and
 * the design makes it the most important line in that design — a re-run of
 * the model must never overwrite it. Nothing here enforces that on its own; the future
 * classifier does, by refusing to touch rows where category_source = 'user'.
 */
export async function setItemCategory(
  client: PoolClient,
  id: number,
  categoryId: number | null,
  source: "user" | "llm" | "seed" | "hsn",
  confidence: number | null,
): Promise<boolean> {
  const r = await client.query(
    `UPDATE items
        SET category_id = $2,
            -- Casts are REQUIRED, not decoration: a bare $3/$4 inside a CASE has no inferred
            -- type, and Postgres refuses to assign an untyped parameter to a SMALLINT column
            -- (42804, "you will need to rewrite or cast"). The column type is only inferred
            -- for a direct col = $n assignment, not through an expression.
            category_source = CASE WHEN $2::bigint IS NULL THEN NULL ELSE $3::text END,
            category_confidence = CASE WHEN $2::bigint IS NULL THEN NULL ELSE $4::smallint END,
            updated_at = now()
      WHERE id = $1`,
    [id, categoryId, source, confidence],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Merge `loserId` into `keeperId`: one product, two rows, made one.
 *
 * A first-class operation rather than a manual UPDATE someone runs once, because the review
 * queue produces these constantly. The order matters:
 *
 *   1. aliases move — DO NOTHING on conflict, since an alias the keeper already owns is the
 *      same fact and the loser's copy is redundant
 *   2. the keeper adopts a category only if it HAS none. Never the other way round: silently
 *      replacing a category someone chose is exactly the override violation the design forbids
 *   3. proposals touching the loser are closed, so the queue does not keep asking about a row
 *      that no longer exists
 *   4. the loser is deleted; ON DELETE CASCADE removes anything still pointing at it
 */
export async function mergeItems(
  client: PoolClient,
  keeperId: number,
  loserId: number,
): Promise<{ ok: boolean; error?: string; aliasesMoved: number }> {
  if (keeperId === loserId) return { ok: false, error: "an item cannot be merged into itself", aliasesMoved: 0 };
  const both = await client.query<{ id: string; category_id: string | null }>(
    "SELECT id, category_id FROM items WHERE id = ANY($1::bigint[])",
    [[keeperId, loserId]],
  );
  if (both.rowCount !== 2) return { ok: false, error: "one or both items do not exist", aliasesMoved: 0 };

  const moved = await client.query(
    `UPDATE item_aliases SET item_id = $1
      WHERE item_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM item_aliases k
           WHERE k.item_id = $1 AND k.source_type = item_aliases.source_type
             AND k.alias_kind = item_aliases.alias_kind
             AND k.alias_value = item_aliases.alias_value)`,
    [keeperId, loserId],
  );

  await client.query(
    `UPDATE items keeper
        SET category_id = loser.category_id,
            category_source = loser.category_source,
            category_confidence = loser.category_confidence
       FROM items loser
      WHERE keeper.id = $1 AND loser.id = $2
        AND keeper.category_id IS NULL AND loser.category_id IS NOT NULL`,
    [keeperId, loserId],
  );

  // Proposals touching the loser need no UPDATE: both id columns are ON DELETE CASCADE, so
  // deleting the item removes them. That is the right outcome rather than a shortcut — a
  // question about a row that no longer exists is not a question anyone can answer, and
  // leaving it open would put an unanswerable item in the queue forever.
  //
  // KNOWN LIMIT: it also means accepted merges leave no history. Nothing needs that yet; if
  // an audit trail is ever wanted, it belongs in its own table rather than in the queue.
  await client.query("DELETE FROM items WHERE id = $1", [loserId]);
  await client.query("UPDATE items SET updated_at = now() WHERE id = $1", [keeperId]);
  return { ok: true, aliasesMoved: moved.rowCount ?? 0 };
}

export async function listProposals(
  client: PoolClient,
  opts: { status: string; limit: number; offset: number },
) {
  const rows = await client.query(
    `SELECT p.id, p.similarity, p.source, p.status, p.created_at,
            lo.id AS lo_id, lo.display_name AS lo_name, lo.canonical_name AS lo_canonical,
            hi.id AS hi_id, hi.display_name AS hi_name, hi.canonical_name AS hi_canonical
       FROM item_merge_proposals p
       JOIN items lo ON lo.id = p.lo_item_id
       JOIN items hi ON hi.id = p.hi_item_id
      WHERE p.status = $1
      ORDER BY p.similarity DESC, p.id
      LIMIT $2 OFFSET $3`,
    [opts.status, opts.limit, opts.offset],
  );
  const total = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM item_merge_proposals WHERE status = $1",
    [opts.status],
  );
  return { rows: rows.rows, total: Number(total.rows[0].count) };
}

export async function rejectProposal(client: PoolClient, id: number): Promise<boolean> {
  // Rejected, not deleted. The row is what stops the same pair being proposed on every future
  // import — a person's "these are different" has to outlive the answer.
  const r = await client.query(
    "UPDATE item_merge_proposals SET status = 'rejected', decided_at = now() WHERE id = $1 AND status = 'open'",
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function getProposal(client: PoolClient, id: number) {
  const r = await client.query<{ lo_item_id: string; hi_item_id: string; status: string }>(
    "SELECT lo_item_id, hi_item_id, status FROM item_merge_proposals WHERE id = $1",
    [id],
  );
  return r.rowCount ? r.rows[0] : null;
}

/** Counts the Items screen leads with. */
export async function itemStats(client: PoolClient) {
  const r = await client.query<{
    total: string; unclassified: string; aliases: string; open_proposals: string;
  }>(
    `SELECT (SELECT count(*) FROM items)::text AS total,
            (SELECT count(*) FROM items WHERE category_id IS NULL)::text AS unclassified,
            (SELECT count(*) FROM item_aliases)::text AS aliases,
            (SELECT count(*) FROM item_merge_proposals WHERE status = 'open')::text AS open_proposals`,
  );
  const row = r.rows[0];
  return {
    total: Number(row.total),
    unclassified: Number(row.unclassified),
    aliases: Number(row.aliases),
    open_proposals: Number(row.open_proposals),
    propose_similarity: PROPOSE_SIMILARITY,
  };
}
