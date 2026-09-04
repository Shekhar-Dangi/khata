import { Router } from "express";

import { pool } from "./../db.ts";
import { badRequest, intParam, route, withTransaction } from "./../http.ts";
import { acceptNearMiss, listNearMisses } from "./../evidence-detect.ts";

const router = Router();
export { router as evidence };

/**
 * Which person column in a Splitwise export is the ledger owner's.
 *
 * Configuration rather than a parameter: it is a property of whose ledger this is, not of a
 * request, and letting a caller pass it would mean a typo silently reads a flatmate's shares
 * and writes their consumption as yours. Fail loudly at the edge instead.
 */
function owner(): string {
  const me = process.env.SPLITWISE_ME;
  if (!me) throw badRequest("SPLITWISE_ME is not set — it names your column in the export");
  return me;
}

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
 * POST /evidence/:id/match   { transaction_id }
 *
 * Accept one near miss. Goes through the same writer as an automatic match, so precedence
 * still applies: this may displace a rule's guess, and is refused when a human authored the
 * allocation already. Deciding the DATE is not overruling another person's decision.
 *
 * 409 rather than 400 on a refusal — the request is well formed and the state is what
 * rejects it, and the UI needs to tell those apart to say something useful.
 */
router.post("/evidence/:id/match", route(async (req, res) => {
  const transactionId = req.body?.transaction_id;
  if (typeof transactionId !== "string" && typeof transactionId !== "number") {
    return res.status(400).json({ error: "transaction_id is required" });
  }

  // intParam, not req.params.id directly: Express types a route param as string | string[],
  // and this project's discipline (see http.ts) is to fail the shape test rather than coerce.
  const evidenceId = intParam(req.params.id, "evidence id");

  const result = await withTransaction((client) =>
    acceptNearMiss(client, String(evidenceId), String(transactionId), owner()),
  );
  if (!result.ok) return res.status(409).json({ error: result.error });
  return res.status(200).json(result);
}));
