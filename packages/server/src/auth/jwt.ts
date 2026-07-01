import jwt from "jsonwebtoken";
import { env } from "../util/env";

export interface TokenPayload {
  sub: string; // user id
  displayName: string;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "30d" });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as TokenPayload;
}
