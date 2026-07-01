import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../auth/middleware";

export const usersRouter = Router();

/** Lets a document owner find a user by display name to grant them access.
 * Scoped to requireAuth just so this isn't a fully open user enumeration
 * endpoint; still a coarse search since there's no real account privacy
 * model in this project (see DESIGN.md "Authentication"). */
usersRouter.get("/", requireAuth, async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  if (query.length < 2) {
    res.json([]);
    return;
  }
  const result = await pool.query(
    `SELECT id, display_name AS "displayName", color
     FROM users WHERE display_name ILIKE $1 LIMIT 10`,
    [`%${query}%`]
  );
  res.json(result.rows);
});
