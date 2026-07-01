import { pool } from "./pool";
import type { ExplicitRole } from "@collab/shared";

export interface PermissionRow {
  document_id: string;
  user_id: string;
  role: ExplicitRole;
}

export async function getExplicitRole(
  documentId: string,
  userId: string
): Promise<ExplicitRole | null> {
  const res = await pool.query<PermissionRow>(
    "SELECT * FROM document_permissions WHERE document_id = $1 AND user_id = $2",
    [documentId, userId]
  );
  return res.rows[0]?.role ?? null;
}

export async function upsertPermission(
  documentId: string,
  userId: string,
  role: ExplicitRole
): Promise<void> {
  await pool.query(
    `INSERT INTO document_permissions (document_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [documentId, userId, role]
  );
}

export async function removePermission(
  documentId: string,
  userId: string
): Promise<void> {
  await pool.query(
    "DELETE FROM document_permissions WHERE document_id = $1 AND user_id = $2",
    [documentId, userId]
  );
}

export async function listCollaborators(documentId: string): Promise<
  Array<{ userId: string; displayName: string; color: string; role: ExplicitRole }>
> {
  const res = await pool.query(
    `SELECT u.id AS "userId", u.display_name AS "displayName", u.color, dp.role
     FROM document_permissions dp
     JOIN users u ON u.id = dp.user_id
     WHERE dp.document_id = $1
     ORDER BY u.display_name`,
    [documentId]
  );
  return res.rows;
}
