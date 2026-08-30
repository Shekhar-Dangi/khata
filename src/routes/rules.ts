import { Router } from "express";

import { pool } from "./../db.ts";
import { badRequest, conflict, intParam, isUniqueViolation, notFound, route, withTransaction } from "./../http.ts";
import { accountExists } from "./../accounts.ts";
import { EXPLAINABLE_SPEND } from "./../spend.ts";
import { isIsoDate } from "./../filters.ts";
import {
  MATCH_MODES,
  OPS_BY_FIELD,
  RULE_FIELDS,
  RULE_OPS,
  decideAllocation,
  isMatchMode,
  isRuleField,
  isRuleOp,
  sameAllocation,
} from "./../rules.ts";
import type { ApplicableRule } from "./../rules.ts";

const router = Router();
export { router as rules };

// that interprets it. One source of truth: a word this file accepts is a word the
// matcher is guaranteed (by an exhaustive switch) to handle.

// Returns an error message, or null when the conditions array is well-formed.
function validateConditions(conditions: unknown): string | null {
  if (!Array.isArray(conditions)) return "conditions must be an array";
  // An EMPTY array is rejected ON PURPOSE. Under match_mode 'all' it is vacuously
  // true (same reason [].every() is true), so an empty rule would match every
  // transaction in the ledger and categorise the lot. Refuse to store one.
  if (conditions.length === 0) return "conditions must not be empty";

  for (const [i, c] of conditions.entries()) {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      return `condition ${i}: must be an object`;
    }
    const { field, op, value } = c as Record<string, unknown>;
    // The guards narrow `unknown` to the vocabulary union, so everything below
    // (and the matcher downstream) works with literal types rather than strings.
    if (!isRuleField(field)) {
      return `condition ${i}: field must be one of ${RULE_FIELDS.join(", ")}`;
    }
    if (!isRuleOp(op)) {
      return `condition ${i}: op must be one of ${RULE_OPS.join(", ")}`;
    }
    if (!OPS_BY_FIELD[field].includes(op)) {
      return `condition ${i}: op '${op}' is not valid on field '${field}'`;
    }
    // Exhaustive over RuleField: add a field to the vocabulary and this switch
    // stops compiling until its value contract is written.
    switch (field) {
      case "narration":
        if (typeof value !== "string" || value.trim() === "") {
          return `condition ${i}: value must be a non-empty string`;
        }
        break;
      case "amount_paise":
        // Demand an actual integer, not merely something coercible: Number("") is 0
        // and Number("abc") is NaN — neither throws, both would store a broken rule.
        if (!Number.isInteger(value)) {
          return `condition ${i}: value must be an integer (paise)`;
        }
        break;
      case "txn_date":
        // The SAME predicate the filter vocabulary uses — imported, not re-implemented.
        // This used to be a bare `Date.parse` check, which accepts "March 3", "2026" and
        // "2026-06-31" alike, so a rule could be stored with a date the matcher (which
        // compares ISO strings) could never match against anything.
        if (!isIsoDate(value)) {
          return `condition ${i}: value must be a real date (YYYY-MM-DD)`;
        }
        break;
    }
  }
  return null;
}

// GET /rules/vocabulary — the fields, ops and legal combinations a rule may use.
// The rule builder in the UI renders itself from this rather than hardcoding a copy:
// add an op to rules.ts and the form offers it, with no second place to update.
// Same reason server.ts imports the vocabulary instead of declaring its own.
router.get("/rules/vocabulary", (_req, res) => {
  res.json({
    fields: RULE_FIELDS,
    ops: RULE_OPS,
    match_modes: MATCH_MODES,
    ops_by_field: OPS_BY_FIELD,
  });
});

// POST /rules — create an auto-explanation rule. Validates the whole shape before
// touching the DB, so the engine can trust every field/op/value it later reads.
router.post("/rules", route(async (req, res) => {
  const { name, conditions, match_mode, category_id, priority, enabled } =
    req.body ?? {};

  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "name must be a non-empty string" });
  }
  const conditionError = validateConditions(conditions);
  if (conditionError !== null) {
    return res.status(400).json({ error: conditionError });
  }
  // `??` (not `||`) so a deliberate `false`/`0` survives — only null/undefined default.
  const mode = match_mode ?? "all";
  if (!isMatchMode(mode)) {
    return res
      .status(400)
      .json({ error: `match_mode must be one of ${MATCH_MODES.join(", ")}` });
  }
  // The action. Nullable in the schema, but a rule that assigns nothing does nothing.
  if (!Number.isInteger(category_id)) {
    return res.status(400).json({ error: "category_id must be an integer" });
  }
  const rulePriority = priority ?? 0;
  if (!Number.isInteger(rulePriority)) {
    return res.status(400).json({ error: "priority must be an integer" });
  }
  const isEnabled = enabled ?? true;
  if (typeof isEnabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean" });
  }

  try {
    // Check the FK ourselves so a bad id is a clean 400, not a constraint-violation 500.
    const cat = await pool.query("SELECT 1 FROM categories WHERE id = $1", [
      category_id,
    ]);
    if (cat.rowCount === 0) {
      return res.status(400).json({ error: "category_id does not exist" });
    }
    const result = await pool.query(
      `INSERT INTO rules (name, conditions, match_mode, category_id, priority, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        name.trim(),
        JSON.stringify(conditions),
        mode,
        category_id,
        rulePriority,
        isEnabled,
      ],
    );
    return res.status(201).json({ id: Number(result.rows[0].id) });
  } catch (error) {
    // 23505 = unique_violation. rules.name is UNIQUE, so a retried POST after a dropped
    // response lands here instead of silently creating a second identical rule.
    if (isUniqueViolation(error)) throw conflict("a rule with that name already exists");
    throw error;
  }
}));

// PATCH /rules/:id — edit a rule in place.
//
// Editing used to mean delete-then-recreate, which is not the same operation: the new
// rule gets a new id, so `/reports/by-rule` loses the rule's history and any URL or
// bookmark pointing at `rule_id=` goes stale. It is also two writes with no transaction
// around them — a failure between them leaves the rule simply gone.
//
// PATCH, not PUT: the body carries the fields you are CHANGING. Every field is read with
// `Object.hasOwn`, not `??`, because `enabled: false` and `priority: 0` are values a
// user means, and `??` would quietly discard both in favour of the existing row.
//
// Changing a rule INVALIDATES what it already wrote. The engine converges, so the next
// `/rules/apply` would fix it — but between the edit and that run the reports would show
// allocations justified by conditions that no longer exist. So the edit sweeps the
// rule's own allocations, with the same `source = 'rule'` scope every sweep here
// carries, and reports the count so the caller can re-apply.
router.patch("/rules/:id", route(async (req, res) => {
  const ruleId = intParam(req.params.id, "rule id");
  const body = req.body ?? {};

  // The unique-violation branch is why this one keeps a try/catch after the rest lost
  // theirs: it is not boilerplate, it is the only correct way to handle a name race.
  // Checking "is this name taken?" and then updating is two statements with a gap, and
  // the constraint is the only thing that actually closes it.
  try {
    const result = await withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT name, conditions, match_mode, category_id, priority, enabled
         FROM rules WHERE id = $1 FOR UPDATE`,
      [ruleId],
    );
    if (existing.rowCount === 0) {
      throw notFound("no rule found");
    }
    const current = existing.rows[0];

    const next = {
      name: Object.hasOwn(body, "name") ? body.name : current.name,
      conditions: Object.hasOwn(body, "conditions")
        ? body.conditions
        : current.conditions,
      match_mode: Object.hasOwn(body, "match_mode")
        ? body.match_mode
        : current.match_mode,
      category_id: Object.hasOwn(body, "category_id")
        ? body.category_id
        : Number(current.category_id),
      priority: Object.hasOwn(body, "priority") ? body.priority : Number(current.priority),
      enabled: Object.hasOwn(body, "enabled") ? body.enabled : current.enabled,
    };

    // Same validation as the create path, on the MERGED shape — so a PATCH can never
    // leave a row the matcher would refuse to interpret.
    if (typeof next.name !== "string" || next.name.trim() === "") {
      throw badRequest("name must be a non-empty string");
    }
    const conditionError = validateConditions(next.conditions);
    if (conditionError !== null) {
      throw badRequest(conditionError);
    }
    if (!isMatchMode(next.match_mode)) {
      throw badRequest(`match_mode must be one of ${MATCH_MODES.join(", ")}`);
    }
    if (!Number.isInteger(next.category_id)) {
      throw badRequest("category_id must be an integer");
    }
    if (!Number.isInteger(next.priority)) {
      throw badRequest("priority must be an integer");
    }
    if (typeof next.enabled !== "boolean") {
      throw badRequest("enabled must be a boolean");
    }
    const cat = await client.query("SELECT 1 FROM categories WHERE id = $1", [
      next.category_id,
    ]);
    if (cat.rowCount === 0) {
      throw badRequest("category_id does not exist");
    }

    // A rename changes nothing about what the rule MATCHES, so it must not throw away
    // work. Everything else — including priority, which decides who wins a conflict, and
    // `enabled: false`, whose whole point is that the guesses stop — can change the
    // engine's output, and its old output has to go.
    const matchingChanged =
      JSON.stringify(next.conditions) !== JSON.stringify(current.conditions) ||
      next.match_mode !== current.match_mode ||
      next.category_id !== Number(current.category_id) ||
      next.priority !== Number(current.priority) ||
      next.enabled !== current.enabled;

    let removed = 0;
    if (matchingChanged) {
      const swept = await client.query(
        "DELETE FROM allocations WHERE rule_id = $1 AND source = 'rule'",
        [ruleId],
      );
      removed = swept.rowCount ?? 0;
    }

    await client.query(
      `UPDATE rules SET name = $1, conditions = $2, match_mode = $3,
              category_id = $4, priority = $5, enabled = $6
        WHERE id = $7`,
      [
        next.name.trim(),
        JSON.stringify(next.conditions),
        next.match_mode,
        next.category_id,
        next.priority,
        next.enabled,
        ruleId,
      ],
    );
    return {
      id: ruleId,
      allocations_removed: removed,
      // The caller has to re-run the engine to get the new guesses. Saying so beats a
      // silent auto-apply: applying is a whole-ledger write and should be a decision.
      reapply_needed: matchingChanged,
    };
    });
    return res.json(result);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("a rule with that name already exists");
    throw error;
  }
}));

// DELETE /rules/:id — remove a rule and the allocations it produced.
//
// allocations.rule_id is a FK, so those rows have to go first or the delete fails. That
// is the correct semantic anyway: a rule allocation is a machine guess whose entire
// justification was the rule. Remove the justification and the guess should go with it.
//
// This CANNOT touch human work. The schema's CHECK allows rule_id to be non-null only
// when source = 'rule', so a user or evidence allocation is unreachable from here.
router.delete("/rules/:id", route(async (req, res) => {
  const ruleId = intParam(req.params.id, "rule id");

  const result = await withTransaction(async (client) => {
    const found = await client.query(
      "SELECT 1 FROM rules WHERE id = $1 FOR UPDATE",
      [ruleId],
    );
    if (found.rowCount === 0) {
      throw notFound("no rule found");
    }
    const swept = await client.query(
      "DELETE FROM allocations WHERE rule_id = $1",
      [ruleId],
    );
    await client.query("DELETE FROM rules WHERE id = $1", [ruleId]);
    return {
      deleted: ruleId,
      allocations_removed: swept.rowCount ?? 0,
    };
  });

  return res.json(result);
}));

// GET /rules — every rule with its target category name, roughly in precedence order:
// priority DESC, then id ASC. The id tiebreak is not cosmetic even here — SQL promises
// nothing about the order of tied rows, so without it this list could shuffle between
// identical requests.
//
// "Roughly" is deliberate. The AUTHORITATIVE precedence is compareRules() in rules.ts,
// which also ranks by specificity — and that stays in TypeScript rather than being
// mirrored into this ORDER BY. Precedence is policy, and policy belongs in exactly one
// place; duplicating it into SQL is the same mistake we just removed from the vocabulary.
router.get("/rules", route(async (_req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.name, r.conditions, r.match_mode, r.category_id,
              c.name AS category_name, r.priority, r.enabled
         FROM rules r
         LEFT JOIN categories c ON c.id = r.category_id
        ORDER BY r.priority DESC, r.id ASC`,
  );
  const rules = result.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    conditions: r.conditions, // pg parses JSONB into a JS value already
    match_mode: r.match_mode,
    category_id: r.category_id == null ? null : Number(r.category_id),
    category_name: r.category_name, // null if the rule assigns no category
    priority: r.priority,
    enabled: r.enabled,
  }));
  res.json({ rules });
}));

// POST /rules/apply — run every enabled rule over the ledger and make the
// source='rule' allocations match what the rules currently say.
// Optional ?account_id=N scopes the run. Design: the design.
//
// This CONVERGES, it does not append: it computes the desired rule-allocations and
// makes the table match, so running it ten times equals running it once. Run it
// twice and the second run must report created: 0, removed: 0.
router.post("/rules/apply", route(async (req, res) => {
  // Absent = whole ledger. Present-but-junk is a 400, not a silent full run:
  // Absent = the whole ledger. Present-but-junk is a 400, not a silent full run:
  // Number(undefined) is NaN and Number("") is 0, and neither throws.
  //
  // The same `intParam` every route id uses. This was `Number.isInteger(Number(x))`, which
  // accepts "1.0", " 1 " and "1e3" — so `?account_id=1.0` quietly ran against account 1 and
  // `?account_id=1e3` against account 1000. One predicate for "is this an id", everywhere.
  const rawAccountId = req.query.account_id;
  const accountId =
    rawAccountId === undefined ? null : intParam(rawAccountId, "account_id");

  if (accountId !== null && !(await accountExists(accountId))) {
    throw notFound("account id does not exist");
  }

  const result = await withTransaction(async (client) => {
    // Only enabled rules are even considered. chooseWinner checks `enabled` too —
    // two independent guards, because a disabled rule that still categorises money
    // is the kind of bug nobody notices for months.
    const ruleResult = await client.query(
      `SELECT id, conditions, match_mode, category_id, priority, enabled
         FROM rules
        WHERE enabled = true AND category_id IS NOT NULL`,
    );
    const rules: ApplicableRule[] = ruleResult.rows.map((r) => ({
      id: Number(r.id), // BIGINT arrives as a string; the id tiebreak is numeric
      conditions: r.conditions,
      match_mode: r.match_mode,
      category_id: r.category_id === null ? null : Number(r.category_id),
      priority: Number(r.priority),
      enabled: r.enabled,
    }));

    // Candidates. The user-lock is NOT filtered here — we want to count what it
    // skipped, so it is applied below. ORDER BY id gives every concurrent run the
    // same lock order, which is what stops two runs deadlocking against each other.
    //
    // FOR UPDATE is load-bearing: without it the engine can read a transaction as
    // unlocked, a user can save allocations on it, and we then write a rule
    // allocation onto a transaction that now has user allocations. The allocations
    // endpoint takes FOR UPDATE on the same row, so the two serialise.
    const txnResult = await client.query(
      `SELECT id, amount_paise, narration, txn_date
         FROM transactions
        WHERE ($1::bigint IS NULL OR account_id = $1)
          AND ${EXPLAINABLE_SPEND}
        ORDER BY id
        FOR UPDATE`,
      [accountId],
    );
    const txns = txnResult.rows;

    // Every allocation for those transactions, in one query — not one per txn.
    const txnIds = txns.map((t) => t.id);
    const allocResult =
      txnIds.length === 0
        ? { rows: [] as any[] }
        : await client.query(
            `SELECT id, transaction_id, category_id, amount_paise, confidence, source, rule_id
               FROM allocations
              WHERE transaction_id = ANY($1)`,
            [txnIds],
          );

    // Group allocations by transaction. String keys: transaction_id is a BIGINT
    // and arrives as a string, so it is already a safe Map key with no precision loss.
    const allocationsByTxn = new Map<string, any[]>();
    for (const a of allocResult.rows) {
      const key = String(a.transaction_id);
      const list = allocationsByTxn.get(key);
      if (list === undefined) allocationsByTxn.set(key, [a]);
      else list.push(a);
    }

    let matched = 0;
    let created = 0;
    let removed = 0;
    let unchanged = 0;
    let skippedUserLocked = 0;

    for (const t of txns) {
      const existing = allocationsByTxn.get(String(t.id)) ?? [];

      // THE TRANSACTION-LEVEL LOCK. Any user allocation and the engine leaves the
      // whole transaction alone — not just the explained part. Filling the
      // remainder instead would mean you can never deliberately leave money
      // unexplained, and that is the product's whole point.
      if (existing.some((a) => a.source === "user")) {
        skippedUserLocked++;
        continue;
      }

      // The remainder EXCLUDES our own rule rows: they are what we are recomputing.
      // Counting them would make the desired state depend on the previous run.
      // Evidence rows DO count — the |Σ| ≤ |txn| budget is shared across sources.
      const nonRuleExplained = existing
        .filter((a) => a.source !== "rule")
        .reduce((sum, a) => sum + Number(a.amount_paise), 0);
      const remaining = Number(t.amount_paise) - nonRuleExplained;

      const desired = decideAllocation(
        {
          narration: t.narration,
          amount_paise: t.amount_paise,
          txn_date: t.txn_date,
        },
        remaining,
        rules,
      );
      if (desired !== null) matched++;

      const actual = existing.filter((a) => a.source === "rule");

      // The no-op case, detected rather than merely tolerated. Blind delete+insert
      // would still converge the state, but it churns allocation ids every run and
      // makes `created: 0, removed: 0` useless as a signal that we converged.
      if (
        desired !== null &&
        actual.length === 1 &&
        sameAllocation(
          {
            category_id: Number(actual[0].category_id),
            amount_paise: Number(actual[0].amount_paise),
            rule_id: actual[0].rule_id === null ? null : Number(actual[0].rule_id),
            confidence: Number(actual[0].confidence), // NUMERIC comes back as a string
          },
          desired,
        )
      ) {
        unchanged++;
        continue;
      }
      if (desired === null && actual.length === 0) continue;

      // THE SCOPED SWEEP. `AND source = 'rule'` is the entire override guarantee:
      // the engine may only delete rows it could have written. The allocations
      // endpoint deletes unscoped — correct there, fatal here.
      if (actual.length > 0) {
        const del = await client.query(
          "DELETE FROM allocations WHERE transaction_id = $1 AND source = 'rule'",
          [t.id],
        );
        removed += del.rowCount ?? 0;
      }
      if (desired !== null) {
        await client.query(
          `INSERT INTO allocations
             (transaction_id, amount_paise, category_id, confidence, source, rule_id)
           VALUES ($1, $2, $3, $4, 'rule', $5)`,
          [
            t.id,
            desired.amount_paise,
            desired.category_id,
            desired.confidence,
            desired.rule_id,
          ],
        );
        created++;
      }
    }

    return {
      account_id: accountId,
      examined: txns.length,
      matched,
      created,
      removed,
      unchanged,
      skipped_user_locked: skippedUserLocked,
    };
  });

  return res.json(result);
}));
