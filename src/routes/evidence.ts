import { Router } from "express";

import { pool } from "./../db.ts";
import { badRequest, intParam, route, withTransaction } from "./../http.ts";
import {
  type RecordState,
  categoriseEvidence,
  linkEvidence,
  listImports,
  listNearMisses,
  listRecords,
  listUnmatched,
  matchSplitwiseEvidence,
  rederiveEvidence,
  unlinkEvidence,
} from "./../evidence-detect.ts";
import { importEvidenceFile } from "./../evidence-import.ts";
import {
  evidenceNeedingRederive,
  listSourceCategories,
  remapSourceCategory,
} from "./../source-categories.ts";
import { normaliseGroup } from "./../splitwise-plan.ts";
import { parsePaging } from "./../filters.ts";

const router = Router();
export { router as evidence };

/** The states a record can be in, as a request may name them. Closed, like every other. */
const STATES: RecordState[] = ["matched", "near", "conflicted", "unmatched"];

/**
 * Which person column in a Splitwise export is the ledger owner's.
 *
 * Configuration rather than a request parameter: it is a property of whose ledger this is,
 * not of a request, and letting a caller pass it would mean a typo silently reads a
 * flatmate's shares and writes their consumption as yours. Fail loudly at the edge instead.
 */
function owner(): string {
  const me = process.env.SPLITWISE_ME;
  if (!me) throw badRequest("SPLITWISE_ME is not set — it names your column in the export");
  return me;
}

/**
 * POST /evidence/import?dry_run=1&group=flat
 *
 * Body is the file itself, as text. No multipart and no upload dependency: an export is a
 * CSV, and `express.text()` reads it in one line. Binary formats (an invoice PDF) will want
 * `express.raw()` on the same route, which is a smaller change than adding multipart now for
 * a format we do not yet parse.
 *
 * **`dry_run` performs the whole import and then ROLLS BACK.** The alternative — a second
 * code path that only predicts what would happen — is the one place a discrepancy between
 * the preview and the result could hide, and a preview that lies about what an import will
 * do is worse than no preview. A rollback exercises exactly the real thing.
 */
router.post("/evidence/import", route(async (req, res) => {
  const text = typeof req.body === "string" ? req.body : "";
  if (text.trim() === "") return res.status(400).json({ error: "the file is empty" });

  const dryRun = req.query.dry_run === "1" || req.query.dry_run === "true";
  const rawGroup = req.query.group;
  if (typeof rawGroup !== "string") {
    // The group is part of the natural key and the export does not
    // name it inside the file — only its filename does. Defaulting it would silently merge
    // two groups' expenses under one key.
    return res.status(400).json({ error: "group is required — it is part of a record's identity" });
  }
  // Tested on the NORMALISED value, not the raw one: "  |  " is a non-empty string and an
  // empty group name, and letting it through would key every row in the file to "".
  const group = normaliseGroup(rawGroup);
  if (group === "") {
    return res.status(400).json({ error: "group is required — it is part of a record's identity" });
  }
  const me = owner();

  // The transaction is managed here rather than through `withTransaction`, because a dry run
  // ends in a deliberate ROLLBACK on the SUCCESS path — and a helper whose whole contract is
  // "commit unless something threw" cannot express that without a trick.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const imported = await importEvidenceFile(client, text, { group, me });
    if (!imported.ok) {
      await client.query("ROLLBACK");
      return res.status(422).json({ errors: imported.errors });
    }

    // Matching runs inside the SAME transaction, so a preview shows what the import will
    // actually leave behind — including which rule guesses it would displace, which is the
    // thing a person most needs to see before committing.
    const match = await matchSplitwiseEvidence(client, me);
    const nearMisses = await listNearMisses(client, me);

    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return res.status(dryRun ? 200 : 201).json({
      committed: !dryRun,
      imported: imported.outcome,
      match,
      near_misses: nearMisses,
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* keep the original error */ }
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * GET /evidence/near-misses
 *
 * Records whose amount and direction match a bank row exactly, but whose date falls just
 * outside the accept window. Never auto-accepted: the judgement they need is whether a bank
 * narration and a free-text description are the same event, which the matcher structurally
 * cannot make. See the design.
 */
router.get("/evidence/near-misses", route(async (_req, res) => {
  const client = await pool.connect();
  try {
    return res.status(200).json({ near_misses: await listNearMisses(client, owner()) });
  } finally {
    client.release();
  }
}));

/**
 * GET /evidence/unmatched
 *
 * EVERY record still waiting for a transaction, including the ones nothing plausible was
 * found for — those are exactly the ones a person has to go and find a payment for. The
 * preview uses /near-misses instead, which is the same query narrowed to quick yes/no rows.
 */
router.get("/evidence/unmatched", route(async (_req, res) => {
  const client = await pool.connect();
  try {
    return res.status(200).json({ unmatched: await listUnmatched(client, owner(), false) });
  } finally {
    client.release();
  }
}));

/**
 * POST /evidence/:id/match   { transaction_ids: [...] }
 *
 * Link a record to one or more transactions. SEVERAL, because a Rs 6,000 expense can leave
 * the account as Rs 1,000 + Rs 5,000 and the record is still one record (migration 010).
 *
 * The selected transactions need not sum to the record's amount: paid 2,745 and entered 2,700
 * is ordinary, and the 45 becomes that transaction's unexplained remainder rather than a
 * reason to refuse.
 *
 * Goes through the same writer as an automatic match, so precedence still applies — it may
 * displace a rule's guess, and is refused where a human authored the allocation already.
 * Deciding a date, or which payments a bill went out as, is not overruling another person.
 *
 * 409 rather than 400 on a refusal: the request is well formed and the STATE rejects it, and
 * the UI needs to tell those apart to say something useful.
 */
router.post("/evidence/:id/match", route(async (req, res) => {
  // Accepts either shape. `transaction_id` was the original single-value contract and there is
  // no reason to break a caller for a field that widened.
  const body = req.body ?? {};
  const raw = Array.isArray(body.transaction_ids)
    ? body.transaction_ids
    : body.transaction_id !== undefined
      ? [body.transaction_id]
      : [];
  if (raw.length === 0) {
    return res.status(400).json({ error: "transaction_ids is required" });
  }
  // Shape-checked HERE, not left to the database. An id like "" or "abc" reaches Postgres as
  // part of `= ANY($1)`, fails the bigint cast, and surfaces to the caller as "internal
  // error" — which blames us for their typo and says nothing about how to fix it.
  const ids: string[] = raw.map((v: unknown) => String(v));
  if (!ids.every((v) => /^\d+$/.test(v))) {
    return res.status(400).json({ error: "transaction_ids must be positive integers" });
  }
  // intParam, not req.params.id directly: Express types a route param as string | string[],
  // and this project's discipline (see http.ts) is to fail the shape test rather than coerce.
  const evidenceId = intParam(req.params.id, "evidence id");

  // Optional, and only meaningful where the source map has no answer — see `applyMatch`.
  // Offered HERE as well as on its own route because the two are one action for a person:
  // deciding what a "General" expense was, and deciding which payment it went out as, are
  // answered in the same breath while looking at the same row.
  const rawCategory = body.category_id;
  if (rawCategory !== undefined && rawCategory !== null && !/^\d+$/.test(String(rawCategory))) {
    return res.status(400).json({ error: "category_id must be a positive integer" });
  }
  const categoryId =
    rawCategory === undefined || rawCategory === null ? null : String(rawCategory);

  const result = await withTransaction((client) =>
    linkEvidence(client, String(evidenceId), ids, owner(), categoryId),
  );
  if (!result.ok) return res.status(409).json({ error: result.error });
  return res.status(200).json(result);
}));

/**
 * GET /evidence/imports
 *
 * One entry per import, newest first, with the counts its collapsed header shows.
 *
 * The Sources screen is organised around this rather than around one flat queue. A flat queue
 * conflates two imports' leftovers into a single list of forty rows with no way to tell which
 * export they came from, and no way to put a finished one away — so the screen only ever grows.
 */
router.get("/evidence/imports", route(async (_req, res) => {
  const client = await pool.connect();
  try {
    return res.status(200).json({ imports: await listImports(client, owner()) });
  } finally {
    client.release();
  }
}));

/**
 * GET /evidence/records?group=&state=&limit=&offset=
 *
 * The review worklist: what each record's state is now, paged.
 *
 * One endpoint for all three states rather than three endpoints, because the screen shows them
 * TOGETHER and they are computed in a single pass — the near-miss rule needs the whole ledger
 * either way, so splitting it into three routes would be three passes to render one screen.
 *
 * Paged in the ROUTE, not in SQL, and `total` is the count before slicing so `Pager` can size
 * itself. See `listRecords` for why the pass is in TypeScript.
 */
router.get("/evidence/records", route(async (req, res) => {
  const paging = parsePaging(req.query);
  if (!paging.ok) return res.status(400).json({ error: paging.error });

  const rawState = req.query.state;
  // A closed set, checked rather than coerced: an unrecognised value would otherwise filter
  // everything out and look exactly like "you have no work left", which is the one wrong
  // answer this screen must never give.
  if (rawState !== undefined && !STATES.includes(rawState as RecordState)) {
    return res.status(400).json({ error: `state must be one of ${STATES.join(", ")}` });
  }
  const rawGroup = req.query.group;
  if (rawGroup !== undefined && typeof rawGroup !== "string") {
    return res.status(400).json({ error: "group must be a string" });
  }
  // Through the same normaliser the writer used. The UI passes back a name that came from
  // /evidence/imports and is already normalised, but a hand-typed "?group=Flat" should find
  // the same rows rather than quietly return an empty worklist.
  const group = rawGroup === undefined ? undefined : normaliseGroup(rawGroup);

  const client = await pool.connect();
  try {
    const all = await listRecords(client, owner(), {
      group,
      state: rawState as RecordState | undefined,
    });
    return res.status(200).json({
      records: all.slice(paging.offset, paging.offset + paging.limit),
      total: all.length,
      limit: paging.limit,
      offset: paging.offset,
    });
  } finally {
    client.release();
  }
}));

/**
 * DELETE /evidence/:id/match
 *
 * Undo a link. The counterpart to POST — see `unlinkEvidence` for what it can and cannot
 * restore, which the UI repeats to the person rather than keeping to itself.
 *
 * 409, not 404, when a record is not linked: the record exists and the STATE refuses the
 * request, which is the same distinction POST already draws.
 */
router.delete("/evidence/:id/match", route(async (req, res) => {
  const evidenceId = intParam(req.params.id, "evidence id");
  const result = await withTransaction((client) =>
    unlinkEvidence(client, String(evidenceId)),
  );
  if (!result.ok) {
    return res.status(result.error === "no such record" ? 404 : 409).json({ error: result.error });
  }
  return res.status(200).json(result);
}));

/**
 * POST /evidence/:id/category   { category_id }
 *
 * File an already-linked record's own share under a category.
 *
 * The gap it closes: `source_category_map` maps Splitwise's `General` to NULL on purpose — it
 * is a catch-all holding anything from an appliance to a repair visit, so no single mapping is right for
 * most of it. The importer therefore writes only the shared slice and the owner's share stays
 * an unexplained remainder. That rule was decided about IMPORT time, where the question is
 * asked in bulk about rows nobody is looking at; at REVIEW time, with the description and the
 * amount on screen, it is an easy question. The rule was right and its scope was too wide.
 *
 * Re-derives through the same writer as a match, so the split arithmetic exists once.
 *
 * 409 rather than 400 on a refusal: the request is well formed and the STATE rejects it — the
 * record is a settlement, or it is not linked to anything yet.
 */
router.post("/evidence/:id/category", route(async (req, res) => {
  const evidenceId = intParam(req.params.id, "evidence id");
  const raw = req.body?.category_id;
  if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) {
    return res.status(400).json({ error: "category_id must be a positive integer" });
  }

  const result = await withTransaction((client) =>
    categoriseEvidence(client, String(evidenceId), String(raw), owner()),
  );
  if (!result.ok) {
    return res.status(result.error === "no such record" ? 404 : 409).json({ error: result.error });
  }
  return res.status(200).json(result);
}));

/**
 * GET /evidence/categories
 *
 * The source's vocabulary and what each word means here — every category the ledger has seen,
 * plus every one already decided, with what it costs to leave undecided.
 */
router.get("/evidence/categories", route(async (_req, res) => {
  const client = await pool.connect();
  try {
    return res.status(200).json({ categories: await listSourceCategories(client, owner()) });
  } finally {
    client.release();
  }
}));

/**
 * POST /evidence/categories   { source_category, category_id | null, note? }
 *
 * Decide what one source category means, and APPLY IT BACKWARDS. A mapping that only changed
 * the next import would be a setting; the value of learning a category once is that every row
 * already carrying it stops being unclassified.
 *
 * `category_id: null` is a real answer, not a missing one — it means "this cannot be mapped,
 * stop asking", which is what `General` is. The two states the map
 * distinguishes are "no row" and "row with null", and this is how a person reaches the second.
 *
 * Records whose allocations a person authored themselves are left completely alone: they are
 * filtered out before re-derivation, and `authority: "auto"` would refuse them anyway.
 */
router.post("/evidence/categories", route(async (req, res) => {
  const body = req.body ?? {};
  const sourceCategory = typeof body.source_category === "string" ? body.source_category : "";
  if (sourceCategory.trim() === "") {
    return res.status(400).json({ error: "source_category is required" });
  }

  // `null` and "absent" are DIFFERENT here, so the check cannot be a truthiness test: null is
  // the deliberate "unmappable" answer and absent is a malformed request.
  const raw = body.category_id;
  if (raw !== null && !/^\d+$/.test(String(raw ?? ""))) {
    return res.status(400).json({ error: "category_id must be a positive integer, or null" });
  }
  const categoryId = raw === null ? null : Number(raw);
  const note = typeof body.note === "string" ? body.note : undefined;
  const me = owner();

  const result = await withTransaction(async (client) => {
    // Which records need re-deriving is decided BEFORE the map moves — afterwards the old
    // answer is gone and there is no way to tell which rows it produced.
    const stale = await evidenceNeedingRederive(client, sourceCategory);
    const remapped = await remapSourceCategory(client, sourceCategory, categoryId, me, note);
    if (!remapped.ok) return remapped;

    let relinked = 0;
    const refused: string[] = [];
    for (const id of stale) {
      const again = await rederiveEvidence(client, id, me);
      if (again.ok) relinked++;
      else refused.push(again.error);
    }
    return { ...remapped, relinked, refused };
  });

  if (!result.ok) {
    return res.status(result.error === "no such category" ? 404 : 400).json({ error: result.error });
  }
  return res.status(200).json(result);
}));
