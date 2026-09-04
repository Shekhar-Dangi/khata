import { Router } from "express";

import { pool } from "./../db.ts";
import { badRequest, intParam, route, withTransaction } from "./../http.ts";
import { linkEvidence, listNearMisses, listUnmatched, matchSplitwiseEvidence } from "./../evidence-detect.ts";
import { importEvidenceFile } from "./../evidence-import.ts";

const router = Router();
export { router as evidence };

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
  if (typeof rawGroup !== "string" || rawGroup.trim() === "") {
    // The group is part of the natural key and the export does not
    // name it inside the file — only its filename does. Defaulting it would silently merge
    // two groups' expenses under one key.
    return res.status(400).json({ error: "group is required — it is part of a record's identity" });
  }
  const group = rawGroup.trim();
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

  const result = await withTransaction((client) =>
    linkEvidence(client, String(evidenceId), ids, owner()),
  );
  if (!result.ok) return res.status(409).json({ error: result.error });
  return res.status(200).json(result);
}));
