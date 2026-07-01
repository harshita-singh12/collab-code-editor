import { Router } from "express";
import { v4 as uuid } from "uuid";
import type { AuthSessionRequest, AuthSessionResponse } from "@collab/shared";
import { findOrCreateUser } from "../db/usersRepo";
import { signToken } from "../auth/jwt";

export const authRouter = Router();

/**
 * Pragmatic auth (see DESIGN.md "Authentication"): no passwords/OAuth.
 * The client generates and persists a random id in localStorage on first
 * visit; this endpoint upserts a user row keyed by that id and a chosen
 * display name, and returns a JWT used for everything else.
 */
authRouter.post("/session", async (req, res) => {
  const body = req.body as AuthSessionRequest;
  const displayName = (body.displayName ?? "").trim().slice(0, 60);
  if (!displayName) {
    res.status(400).json({ error: "displayName is required" });
    return;
  }
  const clientId = body.clientId && body.clientId.length > 0 ? body.clientId : uuid();

  const user = await findOrCreateUser(clientId, displayName);
  const token = signToken({ sub: user.id, displayName: user.display_name });

  const response: AuthSessionResponse = {
    token,
    user: { id: user.id, displayName: user.display_name, color: user.color },
  };
  res.json(response);
});
