import { pool } from "./pool";

export interface UserRow {
  id: string;
  client_id: string;
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

function colorForClientId(clientId: string): string {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    hash = (hash * 31 + clientId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export async function findOrCreateUser(
  clientId: string,
  displayName: string
): Promise<UserRow> {
  const existing = await pool.query<UserRow>(
    "SELECT * FROM users WHERE client_id = $1",
    [clientId]
  );
  if (existing.rows[0]) {
    if (existing.rows[0].display_name !== displayName) {
      const updated = await pool.query<UserRow>(
        "UPDATE users SET display_name = $1 WHERE id = $2 RETURNING *",
        [displayName, existing.rows[0].id]
      );
      return updated.rows[0];
    }
    return existing.rows[0];
  }
  const color = colorForClientId(clientId);
  const inserted = await pool.query<UserRow>(
    `INSERT INTO users (client_id, display_name, color)
     VALUES ($1, $2, $3) RETURNING *`,
    [clientId, displayName, color]
  );
  return inserted.rows[0];
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const res = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [
    id,
  ]);
  return res.rows[0] ?? null;
}
