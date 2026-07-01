import { Router } from "express";
import type { VersionDiffDTO, VersionSummaryDTO } from "@collab/shared";
import { requireAuth, type AuthedRequest } from "../auth/middleware";
import { getDocumentById } from "../db/documentsRepo";
import { resolveEffectiveRole, requireAtLeast } from "../auth/accessControl";
import {
  getSnapshot,
  getSnapshotBefore,
  listSnapshots,
} from "../db/snapshotsRepo";
import { getUserById } from "../db/usersRepo";
import { roomManager } from "../rooms/roomManager";

export const versionsRouter = Router();

async function toSummary(row: {
  id: string;
  seq: number;
  label: string | null;
  size_bytes: number;
  created_by: string | null;
  created_at: Date;
}): Promise<VersionSummaryDTO> {
  const user = row.created_by ? await getUserById(row.created_by) : null;
  return {
    id: row.id,
    seq: row.seq,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    sizeBytes: row.size_bytes,
    createdByName: user?.display_name ?? null,
  };
}

versionsRouter.get("/:id/versions", async (req: AuthedRequest, res) => {
  const doc = await getDocumentById(req.params.id);
  if (!doc) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const role = await resolveEffectiveRole(doc, req.userId ?? null);
  if (!requireAtLeast(role, "viewer")) {
    res.status(403).json({ error: "access denied" });
    return;
  }
  const rows = await listSnapshots(doc.id);
  const summaries = await Promise.all(rows.map(toSummary));
  res.json(summaries);
});

versionsRouter.post(
  "/:id/versions",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const doc = await getDocumentById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const role = await resolveEffectiveRole(doc, req.userId ?? null);
    if (!requireAtLeast(role, "editor")) {
      res.status(403).json({ error: "access denied" });
      return;
    }
    const label = (req.body?.label ?? "").toString().trim().slice(0, 120) || null;
    await roomManager.saveManualCheckpoint(doc.id, label, req.userId!);
    const rows = await listSnapshots(doc.id);
    const summaries = await Promise.all(rows.map(toSummary));
    res.status(201).json(summaries[0]);
  }
);

versionsRouter.get(
  "/:id/versions/:versionId",
  async (req: AuthedRequest, res) => {
    const doc = await getDocumentById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const role = await resolveEffectiveRole(doc, req.userId ?? null);
    if (!requireAtLeast(role, "viewer")) {
      res.status(403).json({ error: "access denied" });
      return;
    }
    const snapshot = await getSnapshot(req.params.versionId);
    if (!snapshot || snapshot.document_id !== doc.id) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    const prev = await getSnapshotBefore(doc.id, snapshot.seq);
    const dto: VersionDiffDTO = {
      from: prev ? await toSummary(prev) : null,
      to: await toSummary(snapshot),
      fromText: prev ? prev.text_excerpt : "",
      toText: snapshot.text_excerpt,
    };
    res.json(dto);
  }
);

versionsRouter.post(
  "/:id/versions/:versionId/restore",
  requireAuth,
  async (req: AuthedRequest, res) => {
    const doc = await getDocumentById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const role = await resolveEffectiveRole(doc, req.userId ?? null);
    if (!requireAtLeast(role, "editor")) {
      res.status(403).json({ error: "access denied" });
      return;
    }
    const snapshot = await getSnapshot(req.params.versionId);
    if (!snapshot || snapshot.document_id !== doc.id) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    await roomManager.restoreToText(doc.id, snapshot.text_excerpt, req.userId!);
    res.json({ ok: true });
  }
);

/** Ad-hoc diff between the live document and any historical version --
 * handy for a "what would restoring this change" preview before the user
 * commits to POST .../restore. */
versionsRouter.get(
  "/:id/versions/:versionId/diff-with-current",
  async (req: AuthedRequest, res) => {
    const doc = await getDocumentById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const role = await resolveEffectiveRole(doc, req.userId ?? null);
    if (!requireAtLeast(role, "viewer")) {
      res.status(403).json({ error: "access denied" });
      return;
    }
    const snapshot = await getSnapshot(req.params.versionId);
    if (!snapshot || snapshot.document_id !== doc.id) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    const currentText = await roomManager.getText(doc.id);
    res.json({
      fromText: snapshot.text_excerpt,
      toText: currentText,
    });
  }
);
