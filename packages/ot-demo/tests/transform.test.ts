import { describe, expect, it } from "vitest";
import { apply, applyAll, transform, type Op } from "../src/ops";

/**
 * The defining correctness property of OT (Transformation Property 1,
 * "TP1"): for two concurrent ops opA and opB starting from the same doc,
 *   apply(apply(doc, opA), transform(opB, opA)) === apply(apply(doc, opB), transform(opA, opB))
 * i.e. it doesn't matter which op "wins" the race to apply first, as long
 * as the other one is transformed against it before being applied next.
 * Every test below checks this property directly, which is exactly the
 * kind of hand-proven-per-op-pair-type correctness argument a CRDT
 * doesn't require (see COMPARISON.md).
 */
function assertConverges(doc: string, opA: Op, opB: Op) {
  const viaAThenB = applyAll(apply(doc, opA), transform(opB, opA, "right"));
  const viaBThenA = applyAll(apply(doc, opB), transform(opA, opB, "left"));
  expect(viaAThenB).toBe(viaBThenA);
  return viaAThenB;
}

describe("transform: insert / insert", () => {
  it("converges when inserting at different positions", () => {
    const doc = "hello world";
    const opA: Op = { type: "insert", pos: 0, text: "[A]" };
    const opB: Op = { type: "insert", pos: 6, text: "[B]" };
    const result = assertConverges(doc, opA, opB);
    expect(result).toBe("[A]hello [B]world");
  });

  it("converges when inserting at the exact same position (tie-break by priority)", () => {
    const doc = "hello world";
    const opA: Op = { type: "insert", pos: 5, text: "-A-" };
    const opB: Op = { type: "insert", pos: 5, text: "-B-" };
    // Both orderings must still land on the same final string, regardless
    // of which physical order the two sites' inserts are applied in --
    // that's the point of the priority tie-break.
    assertConverges(doc, opA, opB);
  });
});

describe("transform: insert / delete", () => {
  it("insert after a delete shifts left by the deleted length", () => {
    const doc = "hello brave new world";
    const opDelete: Op = { type: "delete", pos: 6, len: 6 }; // removes "brave "
    const opInsert: Op = { type: "insert", pos: 16, text: "!" }; // after "new "
    assertConverges(doc, opDelete, opInsert);
  });

  it("insert whose position falls inside a concurrently-deleted range clamps to the delete start", () => {
    const doc = "hello brave new world";
    const opDelete: Op = { type: "delete", pos: 6, len: 6 }; // removes "brave "
    const opInsert: Op = { type: "insert", pos: 9, text: "XYZ" }; // was inside "brave "
    const result = assertConverges(doc, opDelete, opInsert);
    expect(result).toBe("hello XYZnew world");
  });
});

describe("transform: delete / insert (split case)", () => {
  it("splits a delete around text concurrently inserted inside its range", () => {
    const doc = "hello world";
    const opDelete: Op = { type: "delete", pos: 0, len: 11 }; // deletes everything
    const opInsert: Op = { type: "insert", pos: 5, text: " brand new" }; // inserted inside the range
    const result = assertConverges(doc, opDelete, opInsert);
    // The concurrently-inserted text must survive even though the
    // original delete spanned the whole document.
    expect(result).toBe(" brand new");
  });

  it("does not split when the insert lands outside the delete range", () => {
    const doc = "hello world";
    const opDelete: Op = { type: "delete", pos: 0, len: 5 }; // "hello"
    const opInsert: Op = { type: "insert", pos: 8, text: "!" };
    assertConverges(doc, opDelete, opInsert);
  });
});

describe("transform: delete / delete", () => {
  it("converges for non-overlapping deletes", () => {
    const doc = "0123456789";
    const opA: Op = { type: "delete", pos: 0, len: 2 };
    const opB: Op = { type: "delete", pos: 5, len: 2 };
    assertConverges(doc, opA, opB);
  });

  it("converges for partially overlapping deletes", () => {
    const doc = "0123456789";
    const opA: Op = { type: "delete", pos: 2, len: 4 }; // "2345"
    const opB: Op = { type: "delete", pos: 4, len: 4 }; // "4567"
    const result = assertConverges(doc, opA, opB);
    expect(result).toBe("01" + "89");
  });

  it("converges when one delete range fully contains the other", () => {
    const doc = "0123456789";
    const opA: Op = { type: "delete", pos: 0, len: 10 }; // everything
    const opB: Op = { type: "delete", pos: 3, len: 2 }; // "34", subset of A
    const result = assertConverges(doc, opA, opB);
    expect(result).toBe("");
  });

  it("converges for identical duplicate deletes (idempotent overlap)", () => {
    const doc = "0123456789";
    const opA: Op = { type: "delete", pos: 2, len: 3 };
    const opB: Op = { type: "delete", pos: 2, len: 3 };
    const result = assertConverges(doc, opA, opB);
    expect(result).toBe("01" + "56789");
  });
});
