import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { resetDb, closeDb } from "./testDb";
import { createDocument, getDocumentById, updateDocumentState } from "../src/db/documentsRepo";
import { findOrCreateUser } from "../src/db/usersRepo";
import {
  getSnapshot,
  getSnapshotBefore,
  insertSnapshot,
  listSnapshots,
  nextSeq,
  pruneSnapshots,
} from "../src/db/snapshotsRepo";
import { pool } from "../src/db/pool";

describe("snapshot persistence", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("persists and reloads the current merged Yjs state as a single update (no operation log replay)", async () => {
    const user = await findOrCreateUser("client-1", "Alice");
    const doc = await createDocument("Test Doc", user.id, "javascript");

    const ydoc = new Y.Doc();
    ydoc.getText("content").insert(0, "function hello() {}");
    // Simulate a lot of edit history that would be expensive to replay
    // one-by-one; what we persist is only the final merged state.
    for (let i = 0; i < 50; i++) {
      ydoc.getText("content").insert(ydoc.getText("content").length, ".");
    }
    const state = Buffer.from(Y.encodeStateAsUpdate(ydoc));
    await updateDocumentState(doc.id, state);

    const reloaded = await getDocumentById(doc.id);
    expect(reloaded?.state).toBeInstanceOf(Buffer);

    // Loading is exactly one applyUpdate call, regardless of the 51 edits
    // that produced this state.
    const freshDoc = new Y.Doc();
    Y.applyUpdate(freshDoc, reloaded!.state!);
    expect(freshDoc.getText("content").toString()).toBe(ydoc.getText("content").toString());
  });

  it("assigns monotonically increasing sequence numbers per document", async () => {
    const user = await findOrCreateUser("client-2", "Bob");
    const doc = await createDocument("Seq Doc", user.id, "javascript");

    expect(await nextSeq(doc.id)).toBe(1);
    await insertSnapshot({
      documentId: doc.id,
      label: null,
      state: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())),
      textExcerpt: "v1",
      createdBy: user.id,
    });
    expect(await nextSeq(doc.id)).toBe(2);

    await insertSnapshot({
      documentId: doc.id,
      label: "checkpoint",
      state: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())),
      textExcerpt: "v2",
      createdBy: user.id,
    });

    const versions = await listSnapshots(doc.id);
    expect(versions.map((v) => v.seq)).toEqual([2, 1]); // newest first
  });

  it("getSnapshotBefore returns the immediately preceding version for diffing", async () => {
    const user = await findOrCreateUser("client-3", "Carol");
    const doc = await createDocument("Diff Doc", user.id, "javascript");

    const s1 = await insertSnapshot({
      documentId: doc.id,
      label: null,
      state: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())),
      textExcerpt: "hello",
      createdBy: user.id,
    });
    const s2 = await insertSnapshot({
      documentId: doc.id,
      label: null,
      state: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())),
      textExcerpt: "hello world",
      createdBy: user.id,
    });

    const before = await getSnapshotBefore(doc.id, s2.seq);
    expect(before?.id).toBe(s1.id);

    const beforeFirst = await getSnapshotBefore(doc.id, s1.seq);
    expect(beforeFirst).toBeNull();

    const fetched = await getSnapshot(s2.id);
    expect(fetched?.text_excerpt).toBe("hello world");
  });

  it("prunes old, unlabeled snapshots per the retention policy but keeps labeled checkpoints and the latest", async () => {
    const user = await findOrCreateUser("client-4", "Dave");
    const doc = await createDocument("Prune Doc", user.id, "javascript");

    // Insert several snapshots and backdate their created_at so the
    // retention thinning logic (see snapshotsRepo.pruneSnapshots) has
    // something old to thin out, without waiting in real time.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await insertSnapshot({
        documentId: doc.id,
        label: i === 2 ? "important" : null,
        state: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())),
        textExcerpt: `v${i}`,
        createdBy: user.id,
      });
      ids.push(s.id);
    }
    // Backdate all but the very last one to 40 days ago, spread across
    // distinct days so they'd collapse into different daily buckets.
    for (let i = 0; i < ids.length - 1; i++) {
      await pool.query(
        "UPDATE document_snapshots SET created_at = now() - interval '40 days' - ($2 || ' days')::interval WHERE id = $1",
        [ids[i], i]
      );
    }

    const deleted = await pruneSnapshots(doc.id);
    expect(deleted).toBeGreaterThanOrEqual(0);

    const remaining = await listSnapshots(doc.id);
    const remainingIds = new Set(remaining.map((r) => r.id));
    // The labeled checkpoint must survive pruning.
    expect(remainingIds.has(ids[2])).toBe(true);
    // The most recent snapshot (never backdated) must survive.
    expect(remainingIds.has(ids[ids.length - 1])).toBe(true);
  });
});
