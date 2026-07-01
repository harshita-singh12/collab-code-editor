import type { EffectiveRole } from "@collab/shared";
import type { DocumentRow } from "../db/documentsRepo";
import { getExplicitRole } from "../db/permissionsRepo";

/**
 * Resolves a user's effective role on a document. This is the single
 * source of truth for access control -- both REST routes and the
 * Socket.io room-join handler call this, so there is exactly one place
 * that encodes "who can do what."
 *
 * Precedence: owner > explicit permission grant > link_access default > none.
 */
export async function resolveEffectiveRole(
  doc: DocumentRow,
  userId: string | null
): Promise<EffectiveRole> {
  if (!userId) {
    return doc.link_access === "none" ? "none" : (doc.link_access as EffectiveRole);
  }
  if (doc.owner_id === userId) return "owner";

  const explicit = await getExplicitRole(doc.id, userId);
  if (explicit) return explicit;

  if (doc.link_access === "none") return "none";
  return doc.link_access;
}

export function requireAtLeast(
  role: EffectiveRole,
  min: "viewer" | "editor" | "owner"
): boolean {
  const rank: Record<EffectiveRole, number> = {
    owner: 3,
    editor: 2,
    viewer: 1,
    none: 0,
  };
  return rank[role] >= rank[min];
}
