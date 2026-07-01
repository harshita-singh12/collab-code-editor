import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "./jwt";

export interface AuthedRequest extends Request {
  userId?: string;
  displayName?: string;
}

/** Populates req.userId if a valid bearer token is present; never rejects
 * the request itself (some routes are readable anonymously via link
 * access), so downstream handlers decide what to do with a missing user. */
export function optionalAuth(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = verifyToken(header.slice("Bearer ".length));
      req.userId = payload.sub;
      req.displayName = payload.displayName;
    } catch {
      // invalid/expired token: treat as anonymous rather than erroring, so
      // an expired token behaves the same as no token.
    }
  }
  next();
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.userId) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  next();
}
