import { describe, expect, it } from "vitest";
import { OTServer } from "../src/server";
import { applyAll, type Op } from "../src/ops";

describe("OTServer convergence", () => {
  it("sequences and transforms concurrent edits from two clients to one canonical result", () => {
    const initial = "Hello World";
    const server = new OTServer(initial);

    const bobDelete: Op = { type: "delete", pos: 6, len: 5 };
    const bobInsert: Op = { type: "insert", pos: 6, text: "Yjs" };
    const aliceOp: Op = { type: "insert", pos: 6, text: "Beautiful " };

    const r1 = server.receive(bobDelete, 0, "left");
    const r2 = server.receive(bobInsert, r1.revision, "left");
    // Alice's op was generated against revision 0, unaware of Bob's edits.
    // priority "right" means Alice's insert loses the same-position tie
    // against Bob's already-accepted insert, so it lands after "Yjs" --
    // see transformInsertInsert in ../src/ops.ts.
    server.receive(aliceOp, 0, "right");

    expect(server.doc).toBe("Hello YjsBeautiful ");

    // Replaying the full canonical history from scratch must reproduce
    // the server's document exactly -- this is what every client
    // converges to once fully caught up.
    const replayed = applyAll(initial, server.getHistory());
    expect(replayed).toBe(server.doc);
    void r2;
  });

  it("converges for many interleaved random ops from 3 concurrent clients", () => {
    // Deterministic PRNG so the test is reproducible.
    let seed = 42;
    function rand() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }

    const initial = "abcdefghijklmnopqrstuvwxyz";
    const server = new OTServer(initial);

    function randomOp(docLen: number): Op {
      if (docLen === 0 || rand() < 0.5) {
        const pos = Math.floor(rand() * (docLen + 1));
        const text = String.fromCharCode(97 + Math.floor(rand() * 26));
        return { type: "insert", pos, text };
      }
      const pos = Math.floor(rand() * docLen);
      const len = Math.min(docLen - pos, 1 + Math.floor(rand() * 3));
      return { type: "delete", pos, len };
    }

    // Each "client" submits ops against a base revision that lags behind
    // the server (simulating latency / concurrent submission), forcing
    // real transformation work on every receive() call.
    for (let round = 0; round < 200; round++) {
      const baseRevision = Math.max(0, server.revision - Math.floor(rand() * 5));
      const op = randomOp(server.doc.length);
      const priority = rand() < 0.5 ? "left" : "right";
      server.receive(op, baseRevision, priority);
    }

    const replayed = applyAll(initial, server.getHistory());
    expect(replayed).toBe(server.doc);
  });
});
