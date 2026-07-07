import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { resetDb, closeDb } from "./testDb";
import { createApp } from "../src/app";
import { createTestUser } from "./testUsers";
import { createDocument, updateLinkAccess } from "../src/db/documentsRepo";
import { upsertPermission } from "../src/db/permissionsRepo";
import { resolveEffectiveRole, requireAtLeast } from "../src/auth/accessControl";
import { signToken } from "../src/auth/jwt";
import { redisBus } from "../src/redis/pubsub";

describe("access control", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeDb();
    await redisBus.close();
  });

  describe("resolveEffectiveRole (unit)", () => {
    it("owner always resolves to owner regardless of link access", async () => {
      const owner = await createTestUser("u-owner", "Owner");
      const doc = await createDocument("Doc", owner.id, "javascript");
      await updateLinkAccess(doc.id, "none");
      const updated = { ...doc, link_access: "none" as const };
      expect(await resolveEffectiveRole(updated, owner.id)).toBe("owner");
    });

    it("explicit permission grant overrides link access default", async () => {
      const owner = await createTestUser("u-owner2", "Owner");
      const other = await createTestUser("u-other", "Other");
      const doc = await createDocument("Doc", owner.id, "javascript");
      await updateLinkAccess(doc.id, "none");
      await upsertPermission(doc.id, other.id, "editor");
      const updated = { ...doc, link_access: "none" as const };
      expect(await resolveEffectiveRole(updated, other.id)).toBe("editor");
    });

    it("falls back to link access for a user with no explicit grant", async () => {
      const owner = await createTestUser("u-owner3", "Owner");
      const stranger = await createTestUser("u-stranger", "Stranger");
      const doc = await createDocument("Doc", owner.id, "javascript");
      await updateLinkAccess(doc.id, "viewer");
      const updated = { ...doc, link_access: "viewer" as const };
      expect(await resolveEffectiveRole(updated, stranger.id)).toBe("viewer");
    });

    it("anonymous (no user) gets link access role or none", async () => {
      const owner = await createTestUser("u-owner4", "Owner");
      const doc = await createDocument("Doc", owner.id, "javascript");
      await updateLinkAccess(doc.id, "editor");
      const updated = { ...doc, link_access: "editor" as const };
      expect(await resolveEffectiveRole(updated, null)).toBe("editor");

      await updateLinkAccess(doc.id, "none");
      const updated2 = { ...doc, link_access: "none" as const };
      expect(await resolveEffectiveRole(updated2, null)).toBe("none");
    });

    it("requireAtLeast ranks roles correctly", () => {
      expect(requireAtLeast("owner", "viewer")).toBe(true);
      expect(requireAtLeast("editor", "editor")).toBe(true);
      expect(requireAtLeast("viewer", "editor")).toBe(false);
      expect(requireAtLeast("none", "viewer")).toBe(false);
    });
  });

  describe("REST route enforcement", () => {
    it("rejects unauthenticated document creation", async () => {
      const { app } = createApp();
      await request(app).post("/api/documents").send({ title: "X" }).expect(401);
    });

    it("denies access to a document with no permission and link_access=none", async () => {
      const { app } = createApp();
      const owner = await createTestUser("u-a", "Owner");
      const stranger = await createTestUser("u-b", "Stranger");
      const doc = await createDocument("Private Doc", owner.id, "javascript");
      await updateLinkAccess(doc.id, "none");

      const strangerToken = signToken({ sub: stranger.id, displayName: "Stranger" });
      await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Authorization", `Bearer ${strangerToken}`)
        .expect(403);
    });

    it("allows viewer access via link_access without an explicit grant, but blocks link-access changes", async () => {
      const { app } = createApp();
      const owner = await createTestUser("u-c", "Owner");
      const stranger = await createTestUser("u-d", "Stranger");
      const doc = await createDocument("Link Viewable Doc", owner.id, "javascript");
      await updateLinkAccess(doc.id, "viewer");

      const strangerToken = signToken({ sub: stranger.id, displayName: "Stranger" });
      const res = await request(app)
        .get(`/api/documents/${doc.id}`)
        .set("Authorization", `Bearer ${strangerToken}`)
        .expect(200);
      expect(res.body.role).toBe("viewer");

      await request(app)
        .patch(`/api/documents/${doc.id}/link-access`)
        .set("Authorization", `Bearer ${strangerToken}`)
        .send({ linkAccess: "editor" })
        .expect(403);
    });

    it("only the owner can change link access or grant permissions", async () => {
      const { app } = createApp();
      const owner = await createTestUser("u-e", "Owner");
      const editor = await createTestUser("u-f", "Editor");
      const doc = await createDocument("Owner Only Doc", owner.id, "javascript");
      await upsertPermission(doc.id, editor.id, "editor");

      const ownerToken = signToken({ sub: owner.id, displayName: "Owner" });
      const editorToken = signToken({ sub: editor.id, displayName: "Editor" });

      // Editor cannot promote themself to have permission-management rights.
      await request(app)
        .put(`/api/documents/${doc.id}/permissions`)
        .set("Authorization", `Bearer ${editorToken}`)
        .send({ userId: editor.id, role: "editor" })
        .expect(403);

      // Owner can.
      const stranger = await createTestUser("u-g", "Stranger");
      await request(app)
        .put(`/api/documents/${doc.id}/permissions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ userId: stranger.id, role: "viewer" })
        .expect(200);
    });

    it("only the owner can delete a document", async () => {
      const { app } = createApp();
      const owner = await createTestUser("u-h", "Owner");
      const editor = await createTestUser("u-i", "Editor");
      const doc = await createDocument("Deletable Doc", owner.id, "javascript");
      await upsertPermission(doc.id, editor.id, "editor");

      const editorToken = signToken({ sub: editor.id, displayName: "Editor" });
      await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set("Authorization", `Bearer ${editorToken}`)
        .expect(403);

      const ownerToken = signToken({ sub: owner.id, displayName: "Owner" });
      await request(app)
        .delete(`/api/documents/${doc.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(204);
    });
  });
});
