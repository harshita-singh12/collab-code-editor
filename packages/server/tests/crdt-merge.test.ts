import { describe, expect, it } from "vitest";
import * as Y from "yjs";

/**
 * Unit-level proof of Yjs's CRDT merge property (see README.md "Why Yjs's
 * built-in causality tracking"), exercised directly against Yjs with no
 * network involved: multiple
 * independent Y.Doc replicas, fed the same set of updates in different
 * orders (including duplicates and out-of-order delivery), must converge
 * to byte-identical text.
 */

function textOf(doc: Y.Doc): string {
  return doc.getText("content").toString();
}

describe("Yjs CRDT merge", () => {
  it("converges for concurrent inserts at the same position regardless of arrival order", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.getText("content").insert(0, "hello world");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // Both replicas concurrently insert at the same index (5, the space),
    // each unaware of the other's edit.
    a.getText("content").insert(5, "-A-");
    const deltaA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));

    b.getText("content").insert(5, "-B-");
    const deltaB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));

    // Cross-apply: each replica now receives the other's concurrent delta.
    Y.applyUpdate(a, deltaB);
    Y.applyUpdate(b, deltaA);

    expect(textOf(a)).toBe(textOf(b));
    expect(textOf(a)).toContain("-A-");
    expect(textOf(a)).toContain("-B-");

    // A fresh third replica that receives A's full final state (which
    // already encodes both concurrent edits, merged) reaches the exact
    // same text too -- convergence doesn't depend on which replica or
    // delivery path you ask.
    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
    expect(textOf(c)).toBe(textOf(a));
  });

  it("converges when the same update is applied twice (idempotency)", () => {
    const a = new Y.Doc();
    a.getText("content").insert(0, "idempotent");
    const update = Y.encodeStateAsUpdate(a);

    const b = new Y.Doc();
    Y.applyUpdate(b, update);
    Y.applyUpdate(b, update); // duplicate delivery, e.g. a redundant redis relay

    expect(textOf(b)).toBe("idempotent");
  });

  it("converges when updates are applied out of order", () => {
    const source = new Y.Doc();
    const ytext = source.getText("content");
    const updates: Uint8Array[] = [];
    source.on("update", (u: Uint8Array) => updates.push(u));

    ytext.insert(0, "a");
    ytext.insert(1, "b");
    ytext.insert(2, "c");
    ytext.insert(3, "d");
    expect(updates.length).toBe(4);

    const forward = new Y.Doc();
    for (const u of updates) Y.applyUpdate(forward, u);

    const reversed = new Y.Doc();
    for (const u of [...updates].reverse()) Y.applyUpdate(reversed, u);

    const shuffled = new Y.Doc();
    for (const u of [updates[2], updates[0], updates[3], updates[1]]) Y.applyUpdate(shuffled, u);

    expect(textOf(forward)).toBe("abcd");
    expect(textOf(reversed)).toBe(textOf(forward));
    expect(textOf(shuffled)).toBe(textOf(forward));
  });

  it("handles concurrent insert + delete around the same region without corruption", () => {
    const a = new Y.Doc();
    a.getText("content").insert(0, "hello brave new world");
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    // A deletes "brave " (a tombstone, not a physical removal).
    a.getText("content").delete(6, 6);
    // B concurrently inserts inside that same range, unaware it's being deleted.
    b.getText("content").insert(9, "XYZ");

    const deltaA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
    const deltaB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(a, deltaB);
    Y.applyUpdate(b, deltaA);

    expect(textOf(a)).toBe(textOf(b));
    // The concurrently-inserted text must survive the delete.
    expect(textOf(a)).toContain("XYZ");
  });

  it("tombstones deleted content instead of physically removing item identity (gc:true still converges)", () => {
    const a = new Y.Doc({ gc: true });
    a.getText("content").insert(0, "abcdef");
    a.getText("content").delete(1, 2); // remove "bc"
    const b = new Y.Doc({ gc: true });
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(textOf(b)).toBe("adef");
  });

  it("many interleaved concurrent replicas converge (randomized, deterministic seed)", () => {
    let seed = 7;
    function rand() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    const docs = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
    for (let round = 0; round < 60; round++) {
      const doc = docs[Math.floor(rand() * docs.length)];
      const ytext = doc.getText("content");
      if (ytext.length === 0 || rand() < 0.6) {
        const pos = Math.floor(rand() * (ytext.length + 1));
        ytext.insert(pos, String.fromCharCode(97 + Math.floor(rand() * 26)));
      } else {
        const pos = Math.floor(rand() * ytext.length);
        const len = Math.min(ytext.length - pos, 1 + Math.floor(rand() * 3));
        ytext.delete(pos, len);
      }
      // Occasionally gossip full state between all replicas, simulating a
      // network that eventually delivers everything (possibly out of order).
      if (rand() < 0.3) {
        for (const other of docs) {
          if (other === doc) continue;
          Y.applyUpdate(other, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(other)));
        }
      }
    }
    // Final full gossip round to guarantee everyone is caught up.
    for (const doc of docs) {
      for (const other of docs) {
        if (other === doc) continue;
        Y.applyUpdate(other, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(other)));
      }
    }

    const texts = docs.map(textOf);
    expect(texts[0]).toBe(texts[1]);
    expect(texts[1]).toBe(texts[2]);
  });
});
