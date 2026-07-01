import { pool } from "./pool";
import type { LinkAccess } from "@collab/shared";

export interface DocumentRow {
  id: string;
  title: string;
  owner_id: string;
  link_access: LinkAccess;
  language: string;
  state: Buffer | null;
  created_at: Date;
  updated_at: Date;
}

export async function createDocument(
  title: string,
  ownerId: string,
  language: string
): Promise<DocumentRow> {
  const res = await pool.query<DocumentRow>(
    `INSERT INTO documents (title, owner_id, language, link_access)
     VALUES ($1, $2, $3, 'viewer') RETURNING *`,
    [title, ownerId, language]
  );
  return res.rows[0];
}

export async function getDocumentById(id: string): Promise<DocumentRow | null> {
  const res = await pool.query<DocumentRow>(
    "SELECT * FROM documents WHERE id = $1",
    [id]
  );
  return res.rows[0] ?? null;
}

/** Documents a user owns or has an explicit permission row for. */
export async function listDocumentsForUser(userId: string): Promise<
  Array<DocumentRow & { role: "owner" | "editor" | "viewer" }>
> {
  const res = await pool.query(
    `SELECT d.*, CASE WHEN d.owner_id = $1 THEN 'owner' ELSE dp.role END AS role
     FROM documents d
     LEFT JOIN document_permissions dp ON dp.document_id = d.id AND dp.user_id = $1
     WHERE d.owner_id = $1 OR dp.user_id = $1
     ORDER BY d.updated_at DESC`,
    [userId]
  );
  return res.rows;
}

export async function updateDocumentState(
  id: string,
  state: Buffer
): Promise<void> {
  await pool.query(
    "UPDATE documents SET state = $1, updated_at = now() WHERE id = $2",
    [state, id]
  );
}

export async function updateLinkAccess(
  id: string,
  linkAccess: LinkAccess
): Promise<DocumentRow | null> {
  const res = await pool.query<DocumentRow>(
    "UPDATE documents SET link_access = $1, updated_at = now() WHERE id = $2 RETURNING *",
    [linkAccess, id]
  );
  return res.rows[0] ?? null;
}

export async function deleteDocument(id: string): Promise<void> {
  await pool.query("DELETE FROM documents WHERE id = $1", [id]);
}
