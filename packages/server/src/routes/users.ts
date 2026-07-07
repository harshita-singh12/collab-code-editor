import { Router } from "express";
import { pool } from "../db/pool";
import { requireAuth } from "../auth/middleware";

export const usersRouter = Router();

/** Lets a document owner find a user by display name to grant them access.
 * Scoped to requireAuth just so this isn't a fully open, unauthenticated
 * user enumeration endpoint; it still only searches display names, never
 * emails, to avoid leaking account emails through the share dialog. */
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
