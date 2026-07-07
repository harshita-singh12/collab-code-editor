import { Router } from "express";
import type { AuthResponse, LoginRequest, SignupRequest } from "@collab/shared";
import { createUser, findUserByEmail, verifyPassword } from "../db/usersRepo";
import { signToken } from "../auth/jwt";

export const authRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function toAuthResponse(user: {
  id: string;
  display_name: string;
  color: string;
}): AuthResponse {
  return {
    token: signToken({ sub: user.id, displayName: user.display_name }),
    user: { id: user.id, displayName: user.display_name, color: user.color },
  };
}

/**
 * Real account creation: email + password, hashed with argon2id
 * (see `db/usersRepo.ts`). Returns a JWT immediately on success, same as
 * `/login`, so a fresh signup doesn't require a second round trip.
 */
authRouter.post("/signup", async (req, res) => {
  const body = req.body as SignupRequest;
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const displayName = (body.displayName ?? "").trim().slice(0, 60);

  if (!EMAIL_RE.test(email)) {
    res.status(400).json({ error: "a valid email is required" });
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }
  if (!displayName) {
    res.status(400).json({ error: "displayName is required" });
    return;
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    res.status(409).json({ error: "an account with that email already exists" });
    return;
  }

  const user = await createUser(email, password, displayName);
  res.status(201).json(toAuthResponse(user));
});

/**
 * Real login: verifies the argon2id hash and issues a fresh JWT (HS256,
 * secret from env, 30-day expiry) used as a Bearer token for REST calls
 * and as the Socket.io / WebRTC-signaling handshake auth. Deliberately
 * returns the same generic error for "no such account" and "wrong
 * password" so this endpoint can't be used to enumerate registered
 * emails.
 */
authRouter.post("/login", async (req, res) => {
  const body = req.body as LoginRequest;
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  const user = await findUserByEmail(email);
  const valid = user ? await verifyPassword(user, password) : false;
  if (!user || !valid) {
    res.status(401).json({ error: "invalid email or password" });
    return;
  }

  res.json(toAuthResponse(user));
});
