import { Router } from "express";

import { pool } from "./../db.ts";
import { parsePaging } from "./../filters.ts";
import { badRequest, intParam, notFound, route, withTransaction } from "./../http.ts";
import {
  getItem,
  getProposal,
  itemStats,
  listItems,
  listProposals,
  mergeItems,
  rejectProposal,
  resolveAndRecord,
  setItemCategory,
} from "./../items-store.ts";

const router = Router();
export { router as items };

/** Where a category came from. Closed, like every other vocabulary in this codebase. */
const CATEGORY_SOURCES = ["user", "llm", "seed", "hsn"] as const;
type CategorySource = (typeof CATEGORY_SOURCES)[number];

/**
 * GET /items?q=&unclassified=1&limit=&offset=
 *
 * The catalogue. `unclassified=1` is the working list — the design makes
 * partial itemisation a first-class outcome, so an item with no category is normal rather than
 * broken, and this is where a person clears them.
 */
router.get("/items", route(async (req, res) => {
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });
  const q = typeof req.query.q === "string" && req.query.q.trim() !== "" ? req.query.q.trim() : undefined;
  const unclassifiedOnly = req.query.unclassified === "1" || req.query.unclassified === "true";

  const client = await pool.connect();
  try {
    const { rows, total } = await listItems(client, {
      q, unclassifiedOnly, limit: paging.limit, offset: paging.offset,
    });
    return res.json({ items: rows, total, limit: paging.limit, offset: paging.offset });
  } finally {
    client.release();
  }
}));

/** GET /items/stats — what the Items screen leads with. */
router.get("/items/stats", route(async (_req, res) => {
  const client = await pool.connect();
  try {
    return res.json(await itemStats(client));
  } finally {
    client.release();
  }
}));

/**
 * GET /items/proposals?status=open
 *
 * The merge queue — step 3b. Everything the resolver was not confident enough to decide
 * lands here, sorted by similarity, because a person reviewing this wants the near-certain
 * ones first.
 */
router.get("/items/proposals", route(async (req, res) => {
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });
  const raw = req.query.status;
  const status = typeof raw === "string" && raw !== "" ? raw : "open";
  if (!["open", "accepted", "rejected"].includes(status)) {
    throw badRequest(`unknown status: ${status}`);
  }
  const client = await pool.connect();
  try {
    const { rows, total } = await listProposals(client, {
      status, limit: paging.limit, offset: paging.offset,
    });
    return res.json({ proposals: rows, total, limit: paging.limit, offset: paging.offset });
  } finally {
    client.release();
  }
}));

/** GET /items/:id — one item with every alias pointing at it. */
router.get("/items/:id", route(async (req, res) => {
  const id = intParam(req.params.id, "id");
  const client = await pool.connect();
  try {
    const item = await getItem(client, id);
    if (item === null) throw notFound(`no item ${id}`);
    return res.json(item);
  } finally {
    client.release();
  }
}));

/**
 * POST /items/resolve
 *
 * The entry point a parser calls: one raw merchant line in, a catalogue item out. Exposed as a
 * route so the resolution policy can be exercised — and reviewed — before any parser exists.
 *
 * Body: `{ source_type, sku?: {kind, value}, description }`
 *
 * It never merges. The worst outcome is a new item plus a question in the queue, which is the
 * safe direction: a duplicate is visible and recoverable, a wrong merge is silent and forever.
 */
router.post("/items/resolve", route(async (req, res) => {
  const body = req.body as {
    source_type?: unknown; description?: unknown;
    sku?: { kind?: unknown; value?: unknown } | null;
  };
  if (typeof body?.source_type !== "string" || body.source_type.trim() === "") {
    throw badRequest("source_type is required");
  }
  if (typeof body?.description !== "string" || body.description.trim() === "") {
    throw badRequest("description is required");
  }
  let sku: { kind: "asin" | "upc"; value: string } | null = null;
  if (body.sku != null) {
    const kind = body.sku.kind;
    const value = body.sku.value;
    if (kind !== "asin" && kind !== "upc") throw badRequest("sku.kind must be 'asin' or 'upc'");
    if (typeof value !== "string" || value.trim() === "") throw badRequest("sku.value is required");
    sku = { kind, value: value.trim() };
  }

  const result = await withTransaction((client) =>
    resolveAndRecord(client, {
      sourceType: body.source_type as string,
      description: body.description as string,
      sku,
    }),
  );
  return res.status(result.created ? 201 : 200).json(result);
}));

/**
 * PATCH /items/:id — set or clear the category, or fix the display name.
 *
 * `category_id: null` CLEARS it, and that is a real answer rather than a missing one: an
 * unclassified item is a valid state whose amount lands in the computed remainder.
 */
router.patch("/items/:id", route(async (req, res) => {
  const id = intParam(req.params.id, "id");
  const body = req.body as { category_id?: unknown; category_source?: unknown; display_name?: unknown };

  if (!("category_id" in body) && !("display_name" in body)) {
    throw badRequest("nothing to change — send category_id and/or display_name");
  }

  return withTransaction(async (client) => {
    if ("category_id" in body) {
      const raw = body.category_id;
      let categoryId: number | null = null;
      if (raw !== null) {
        if (typeof raw !== "number" || !Number.isInteger(raw)) {
          throw badRequest("category_id must be an integer or null");
        }
        categoryId = raw;
      }
      // Defaults to 'user', because a category arriving through a PATCH is a person's
      // decision unless something explicitly says otherwise — and 'user' is the provenance
      // the classifier must never overwrite.
      const source = (body.category_source ?? "user") as CategorySource;
      if (!CATEGORY_SOURCES.includes(source)) {
        throw badRequest(`category_source must be one of ${CATEGORY_SOURCES.join(", ")}`);
      }
      if (categoryId !== null) {
        const exists = await client.query("SELECT 1 FROM categories WHERE id = $1", [categoryId]);
        if (exists.rowCount === 0) throw badRequest(`no category ${categoryId}`);
      }
      // A person's choice is a decision, not an estimate — 100, and never a self-reported one.
      const ok = await setItemCategory(client, id, categoryId, source, categoryId === null ? null : 100);
      if (!ok) throw notFound(`no item ${id}`);
    }

    if ("display_name" in body) {
      if (typeof body.display_name !== "string" || body.display_name.trim() === "") {
        throw badRequest("display_name must be a non-empty string");
      }
      const r = await client.query(
        "UPDATE items SET display_name = $2, updated_at = now() WHERE id = $1",
        [id, body.display_name.trim()],
      );
      if (r.rowCount === 0) throw notFound(`no item ${id}`);
    }

    return res.json(await getItem(client, id));
  });
}));

/**
 * POST /items/:id/merge — fold another item into this one. `{ merge_item_id }`
 *
 * `:id` is the KEEPER and survives, which matters because its id is what allocations and
 * reports reference. The loser's aliases are re-pointed, so every merchant string that used to
 * mean it now means the keeper.
 */
router.post("/items/:id/merge", route(async (req, res) => {
  const keeperId = intParam(req.params.id, "id");
  const raw = (req.body as { merge_item_id?: unknown })?.merge_item_id;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw badRequest("merge_item_id must be an integer");
  }

  const result = await withTransaction((client) => mergeItems(client, keeperId, raw));
  if (!result.ok) throw badRequest(result.error ?? "merge failed");
  return res.json({ keeper_item_id: String(keeperId), merged_item_id: String(raw), aliases_moved: result.aliasesMoved });
}));

/**
 * POST /items/proposals/:id/accept — merge the pair. The LOWER id is kept.
 *
 * Which one survives is arbitrary and has to be decided somewhere; the lower id is the older
 * row, so keeping it means the surviving item is the one more history already points at. A
 * person who wants the other one uses POST /items/:id/merge directly.
 */
router.post("/items/proposals/:id/accept", route(async (req, res) => {
  const id = intParam(req.params.id, "id");
  return withTransaction(async (client) => {
    const proposal = await getProposal(client, id);
    if (proposal === null) throw notFound(`no proposal ${id}`);
    if (proposal.status !== "open") throw badRequest(`proposal ${id} is already ${proposal.status}`);
    const result = await mergeItems(client, Number(proposal.lo_item_id), Number(proposal.hi_item_id));
    if (!result.ok) throw badRequest(result.error ?? "merge failed");
    return res.json({
      keeper_item_id: proposal.lo_item_id,
      merged_item_id: proposal.hi_item_id,
      aliases_moved: result.aliasesMoved,
    });
  });
}));

/** POST /items/proposals/:id/reject — these are different products. Remembered, not deleted. */
router.post("/items/proposals/:id/reject", route(async (req, res) => {
  const id = intParam(req.params.id, "id");
  return withTransaction(async (client) => {
    const ok = await rejectProposal(client, id);
    if (!ok) throw notFound(`no OPEN proposal ${id}`);
    return res.json({ id: String(id), status: "rejected" });
  });
}));
