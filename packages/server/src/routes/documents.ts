import { Router } from "express";
import type {
  CreateDocumentRequest,
  DocumentDetailDTO,
  DocumentSummaryDTO,
  UpdateLinkAccessRequest,
  UpdatePermissionRequest,
} from "@collab/shared";
import { requireAuth, type AuthedRequest } from "../auth/middleware";
import {
  createDocument,
  deleteDocument,
  getDocumentById,
  listDocumentsForUser,
  updateLinkAccess,
} from "../db/documentsRepo";
import {
  listCollaborators,
  removePermission,
  upsertPermission,
} from "../db/permissionsRepo";
import { getUserById } from "../db/usersRepo";
import { resolveEffectiveRole, requireAtLeast } from "../auth/accessControl";
import { roomManager } from "../rooms/roomManager";

export const documentsRouter = Router();

documentsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const rows = await listDocumentsForUser(req.userId!);
  const owners = await Promise.all(rows.map((r) => getUserById(r.owner_id)));
  const summaries: DocumentSummaryDTO[] = rows.map((r, i) => ({
    id: r.id,
    title: r.title,
    ownerId: r.owner_id,
    ownerName: owners[i]?.display_name ?? "unknown",
    role: r.role,
    linkAccess: r.link_access,
    language: r.language,
    updatedAt: r.updated_at.toISOString(),
    createdAt: r.created_at.toISOString(),
  }));
  res.json(summaries);
});

documentsRouter.post("/", requireAuth, async (req: AuthedRequest, res) => {
  const body = req.body as CreateDocumentRequest;
  const title = (body.title ?? "Untitled").trim().slice(0, 200) || "Untitled";
  const language = body.language ?? "javascript";
  const doc = await createDocument(title, req.userId!, language);
  const owner = await getUserById(req.userId!);
  const dto: DocumentSummaryDTO = {
    id: doc.id,
    title: doc.title,
    ownerId: doc.owner_id,
    ownerName: owner!.display_name,
    role: "owner",
    linkAccess: doc.link_access,
    language: doc.language,
    updatedAt: doc.updated_at.toISOString(),
    createdAt: doc.created_at.toISOString(),
  };
  res.status(201).json(dto);
});

documentsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const doc = await getDocumentById(req.params.id);
  if (!doc) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const role = await resolveEffectiveRole(doc, req.userId ?? null);
  if (role === "none") {
    res.status(403).json({ error: "access denied" });
    return;
  }
  const owner = await getUserById(doc.owner_id);
  const collaborators = await listCollaborators(doc.id);
  const dto: DocumentDetailDTO = {
    id: doc.id,
    title: doc.title,
    ownerId: doc.owner_id,
    ownerName: owner?.display_name ?? "unknown",
    role,
    linkAccess: doc.link_access,
    language: doc.language,
    updatedAt: doc.updated_at.toISOString(),
    createdAt: doc.created_at.toISOString(),
    collaborators,
  };
  res.json(dto);
});

documentsRouter.patch(
  "/:id/link-access",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const doc = await getDocumentById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const role = await resolveEffectiveRole(doc, req.userId ?? null);
    if (!requireAtLeast(role, "owner")) {
      res.status(403).json({ error: "only the owner can change link access" });
      return;
    }
    const body = req.body as UpdateLinkAccessRequest;
    const updated = await updateLinkAccess(doc.id, body.linkAccess);
    res.json({ linkAccess: updated!.link_access });
  }
);

documentsRouter.put(
  "/:id/permissions",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const doc = await getDocumentById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const role = await resolveEffectiveRole(doc, req.userId ?? null);
    if (!requireAtLeast(role, "owner")) {
      res.status(403).json({ error: "only the owner can manage access" });
      return;
    }
    const body = req.body as UpdatePermissionRequest;
    if (body.userId === doc.owner_id) {
      res.status(400).json({ error: "owner role cannot be changed" });
      return;
    }
    if (body.role === "none") {
      await removePermission(doc.id, body.userId);
    } else {
      await upsertPermission(doc.id, body.userId, body.role);
    }
    const collaborators = await listCollaborators(doc.id);
    res.json({ collaborators });
  }
);

documentsRouter.delete("/:id", requireAuth, async (req: AuthedRequest, res) => {
  const doc = await getDocumentById(req.params.id);
  if (!doc) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const role = await resolveEffectiveRole(doc, req.userId ?? null);
  if (!requireAtLeast(role, "owner")) {
    res.status(403).json({ error: "only the owner can delete a document" });
    return;
  }
  await roomManager.evict(doc.id);
  await deleteDocument(doc.id);
  res.status(204).send();
});
