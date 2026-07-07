import argon2 from "argon2";
import { pool } from "./pool";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  color: string;
  created_at: Date;
}

const PALETTE = [
  "#e57373",
  "#f06292",
  "#ba68c8",
  "#9575cd",
  "#7986cb",
  "#64b5f6",
  "#4fc3f7",
  "#4dd0e1",
  "#4db6ac",
  "#81c784",
  "#aed581",
  "#ffb74d",
  "#ff8a65",
  "#a1887f",
];

function colorForEmail(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash * 31 + email.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** Creates a new account with an argon2id-hashed password. Throws (unique
 * violation) if the email is already registered -- callers should check
 * `findUserByEmail` first to return a clean 409 instead of a raw DB error. */
export async function createUser(
  email: string,
  password: string,
  displayName: string
): Promise<UserRow> {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const color = colorForEmail(normalizedEmail);
  const inserted = await pool.query<UserRow>(
    `INSERT INTO users (email, password_hash, display_name, color)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [normalizedEmail, passwordHash, displayName, color]
  );
  return inserted.rows[0];
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const res = await pool.query<UserRow>("SELECT * FROM users WHERE email = $1", [
    email.trim().toLowerCase(),
  ]);
  return res.rows[0] ?? null;
}

export async function verifyPassword(user: UserRow, password: string): Promise<boolean> {
  return argon2.verify(user.password_hash, password);
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const res = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [
    id,
  ]);
  return res.rows[0] ?? null;
}
