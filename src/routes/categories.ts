import { Router } from "express";

import { pool } from "../db.ts";
import { badRequest, conflict, intParam, isUniqueViolation, notFound, route, withTransaction } from "../http.ts";

const router = Router();
export { router as categories };

// GET /categories — the category hierarchy (flat list + each row's parent name for
// display), plus how much each one is being used. `in_use` is what makes a delete
// button honest: it says what you would be breaking before you press it.
router.get("/categories", route(async (_req, res) => {
  const result = await pool.query(
    `SELECT c.id, c.name, c.parent_id, p.name AS parent_name,
              (SELECT COUNT(*) FROM categories ch WHERE ch.parent_id = c.id)   AS children,
              (SELECT COUNT(*) FROM allocations al WHERE al.category_id = c.id) AS allocations,
              (SELECT COUNT(*) FROM rules r WHERE r.category_id = c.id)         AS rules
         FROM categories c
         LEFT JOIN categories p ON p.id = c.parent_id
        ORDER BY COALESCE(p.name, c.name), c.parent_id NULLS FIRST, c.name`,
  );
  const categories = result.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    parent_id: r.parent_id == null ? null : Number(r.parent_id),
    parent_name: r.parent_name, // null for top-level rows
    children: Number(r.children),
    allocations: Number(r.allocations),
    rules: Number(r.rules),
  }));
  res.json({ categories });
}));

// Shared validation for create and update. Returns an error string, or the cleaned name.
// `parentId` has three meanings and they are NOT the same: undefined = "leave it alone"
// (update only), null = "make this top level", a number = "put it under that one".
// `??` and `||` both collapse two of those three, which is why every check below is an
// explicit `=== undefined` / `=== null`.
async function validateCategory(
  name: unknown,
  parentId: unknown,
  selfId: number | null,
): Promise<{ ok: false; error: string } | { ok: true; name: string }> {
  if (typeof name !== "string" || name.trim() === "") {
    return { ok: false, error: "name must be a non-empty string" };
  }
  if (name.trim().length > 60) {
    return { ok: false, error: "name must be 60 characters or fewer" };
  }
  if (parentId !== undefined && parentId !== null) {
    if (!Number.isInteger(parentId)) {
      return { ok: false, error: "parent_id must be an integer or null" };
    }
    if (selfId !== null && parentId === selfId) {
      return { ok: false, error: "a category cannot be its own parent" };
    }
    const parent = await pool.query(
      "SELECT parent_id FROM categories WHERE id = $1",
      [parentId],
    );
    if (parent.rowCount === 0) {
      return { ok: false, error: "parent_id does not exist" };
    }
    // The two-level rule. Without it a "Groceries > Fruit" would vanish from every
    // report: the roll-up in filters.ts matches a category or its DIRECT children, so a
    // grandchild's money lands in no bar at all.
    if (parent.rows[0].parent_id !== null) {
      return {
        ok: false,
        error: "categories are two levels deep — pick a top-level parent",
      };
    }
    if (selfId !== null) {
      const kids = await pool.query(
        "SELECT 1 FROM categories WHERE parent_id = $1 LIMIT 1",
        [selfId],
      );
      if (kids.rowCount !== 0) {
        return {
          ok: false,
          error: "this category has sub-categories — move them out before nesting it",
        };
      }
    }
  }
  return { ok: true, name: name.trim() };
}

// POST /categories — add one. `parent_id: null` (or absent) makes it top level.
router.post("/categories", route(async (req, res) => {
  const { name, parent_id } = req.body ?? {};
  const checked = await validateCategory(name, parent_id ?? null, null);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  try {
    // The UNIQUE (parent_id, name) constraint does NOT catch two top-level rows with
    // the same name — Postgres treats NULLs as distinct — so that case is checked here.
    // IS NOT DISTINCT FROM is the null-safe equality the plain `=` cannot give us.
    const clash = await pool.query(
      "SELECT 1 FROM categories WHERE parent_id IS NOT DISTINCT FROM $1 AND lower(name) = lower($2)",
      [parent_id ?? null, checked.name],
    );
    if (clash.rowCount !== 0) {
      return res.status(409).json({ error: "a category with that name already exists here" });
    }
    const result = await pool.query(
      "INSERT INTO categories (name, parent_id) VALUES ($1, $2) RETURNING id",
      [checked.name, parent_id ?? null],
    );
    return res.status(201).json({ id: Number(result.rows[0].id) });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("a category with that name already exists here");
    throw error;
  }
}));

// PATCH /categories/:id — rename and/or re-parent.
//
// PATCH, not PUT: the body is the fields you are CHANGING. Omitting `parent_id` leaves
// the parent alone; sending `null` moves the category to the top level. A PUT would have
// to mean "the absent field is now null", which turns a rename into an accidental move.
router.patch("/categories/:id", route(async (req, res) => {
  const id = intParam(req.params.id, "category id");
  const body = req.body ?? {};
  const reparenting = Object.hasOwn(body, "parent_id");

  try {
    const existing = await pool.query(
      "SELECT name, parent_id FROM categories WHERE id = $1",
      [id],
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: "no category found" });
    }
    const current = existing.rows[0];
    const nextName = Object.hasOwn(body, "name") ? body.name : current.name;
    const nextParent = reparenting
      ? body.parent_id
      : current.parent_id === null
        ? null
        : Number(current.parent_id);

    const checked = await validateCategory(nextName, nextParent, id);
    if (!checked.ok) return res.status(400).json({ error: checked.error });

    const clash = await pool.query(
      `SELECT 1 FROM categories
        WHERE parent_id IS NOT DISTINCT FROM $1 AND lower(name) = lower($2) AND id <> $3`,
      [nextParent, checked.name, id],
    );
    if (clash.rowCount !== 0) {
      return res.status(409).json({ error: "a category with that name already exists here" });
    }

    await pool.query("UPDATE categories SET name = $1, parent_id = $2 WHERE id = $3", [
      checked.name,
      nextParent,
      id,
    ]);
    return res.json({ id, name: checked.name, parent_id: nextParent });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict("a category with that name already exists here");
    throw error;
  }
}));

// DELETE /categories/:id — remove a category, optionally moving its money first.
//
// A category is referenced by allocations (a human's explanation of real money) and by
// rules. Deleting it out from under either would be data loss with a friendly button on
// it, so the default is a 409 that SAYS what is in the way. `?reassign_to=N` is the way
// through: every allocation and rule is repointed, in one transaction, and only then is
// the row removed. Sub-categories are never silently orphaned — move them yourself.
router.delete("/categories/:id", route(async (req, res) => {
  const id = intParam(req.params.id, "category id");

  const rawReassign = req.query.reassign_to;
  let reassignTo: number | null = null;
  if (rawReassign !== undefined) {
    if (typeof rawReassign !== "string" || !/^\d+$/.test(rawReassign)) {
      return res.status(400).json({ error: "reassign_to must be a positive integer" });
    }
    reassignTo = Number(rawReassign);
    if (reassignTo === id) {
      return res.status(400).json({ error: "cannot reassign a category to itself" });
    }
  }

  const result = await withTransaction(async (client) => {
    const found = await client.query(
      "SELECT name FROM categories WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (found.rowCount === 0) {
      throw notFound("no category found");
    }

    const kids = await client.query(
      "SELECT COUNT(*) AS n FROM categories WHERE parent_id = $1",
      [id],
    );
    if (Number(kids.rows[0].n) > 0) {
      throw conflict(
        `has ${kids.rows[0].n} sub-categor${kids.rows[0].n === "1" ? "y" : "ies"} — move or delete those first`,
      );
    }

    const allocations = Number(
      (
        await client.query(
          "SELECT COUNT(*) AS n FROM allocations WHERE category_id = $1",
          [id],
        )
      ).rows[0].n,
    );
    const rules = Number(
      (await client.query("SELECT COUNT(*) AS n FROM rules WHERE category_id = $1", [id]))
        .rows[0].n,
    );

    if ((allocations > 0 || rules > 0) && reassignTo === null) {
      throw conflict("category is in use", {
        allocations,
        rules,
        hint: "delete again with ?reassign_to=<category_id> to move them",
      });
    }

    if (reassignTo !== null) {
      const target = await client.query("SELECT 1 FROM categories WHERE id = $1", [
        reassignTo,
      ]);
      if (target.rowCount === 0) {
        throw badRequest("reassign_to does not exist");
      }
      await client.query(
        "UPDATE allocations SET category_id = $1 WHERE category_id = $2",
        [reassignTo, id],
      );
      await client.query("UPDATE rules SET category_id = $1 WHERE category_id = $2", [
        reassignTo,
        id,
      ]);
    }

    await client.query("DELETE FROM categories WHERE id = $1", [id]);
    return {
      deleted: id,
      allocations_reassigned: reassignTo === null ? 0 : allocations,
      rules_reassigned: reassignTo === null ? 0 : rules,
    };
  });

  return res.json(result);
}));

