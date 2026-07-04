/**
 * A from-scratch, minimal Operational Transformation engine for plain-text
 * insert/delete, built purely to compare against the Yjs CRDT approach
 * used in the rest of this repo. Not wired into the main app -- see
 * COMPARISON.md for the write-up.
 */

export interface InsertOp {
  type: "insert";
  pos: number;
  text: string;
}

export interface DeleteOp {
  type: "delete";
  pos: number;
  len: number;
}

export type Op = InsertOp | DeleteOp;

export function apply(doc: string, op: Op): string {
  if (op.type === "insert") {
    return doc.slice(0, op.pos) + op.text + doc.slice(op.pos);
  }
  return doc.slice(0, op.pos) + doc.slice(op.pos + op.len);
}

export function applyAll(doc: string, ops: Op[]): string {
  return ops.reduce((d, op) => apply(d, op), doc);
}

/** Tie-break priority when two concurrent inserts land at the same
 * position. "left" means opA came from the client considered to have
 * priority (e.g. lower site id); this mirrors the tie-break every OT
 * implementation needs (Jupiter/Google Wave use a similar site-id/priority
 * rule) and is directly analogous to how Yjs's YATA algorithm breaks ties
 * on clientID -- see DESIGN.md #1. */
export type Priority = "left" | "right";

/**
 * Transforms `opA` so that it can be applied *after* `opB` has already
 * been applied, producing the same logical effect `opA` originally
 * intended. This is the core of OT: every pair of concurrent ops needs an
 * explicit, hand-proven transform rule -- there is no generic algorithm
 * that "just works" for arbitrary op types the way a CRDT's merge does.
 *
 * Returns an array because delete/insert and insert/delete interactions
 * can require splitting a single delete into two (see the insert-inside-
 * delete-range case below) -- another source of OT implementation
 * complexity that a sequence CRDT sidesteps entirely by tracking
 * per-character identity instead of numeric offsets.
 */
export function transform(opA: Op, opB: Op, priority: Priority): Op[] {
  if (opA.type === "insert" && opB.type === "insert") {
    return [transformInsertInsert(opA, opB, priority)];
  }
  if (opA.type === "insert" && opB.type === "delete") {
    return [transformInsertDelete(opA, opB)];
  }
  if (opA.type === "delete" && opB.type === "insert") {
    return transformDeleteInsert(opA, opB);
  }
  return transformDeleteDelete(opA as DeleteOp, opB as DeleteOp);
}

function transformInsertInsert(opA: InsertOp, opB: InsertOp, priority: Priority): InsertOp {
  if (opA.pos < opB.pos) return opA;
  if (opA.pos > opB.pos) return { ...opA, pos: opA.pos + opB.text.length };
  // Equal position: priority decides who "goes first" in the final order.
  return priority === "left" ? opA : { ...opA, pos: opA.pos + opB.text.length };
}

function transformInsertDelete(opA: InsertOp, opB: DeleteOp): InsertOp {
  if (opA.pos <= opB.pos) return opA;
  if (opA.pos >= opB.pos + opB.len) return { ...opA, pos: opA.pos - opB.len };
  // The insertion point was inside the now-deleted range: clamp to the
  // start of where that range used to be.
  return { ...opA, pos: opB.pos };
}

function transformDeleteInsert(opA: DeleteOp, opB: InsertOp): Op[] {
  const aEnd = opA.pos + opA.len;
  if (opB.pos <= opA.pos) {
    return [{ ...opA, pos: opA.pos + opB.text.length }];
  }
  if (opB.pos >= aEnd) {
    return [opA];
  }
  // opB inserted new text strictly inside the range opA wants to delete.
  // We must not silently delete the newly inserted text, so the delete is
  // split around it.
  const leftLen = opB.pos - opA.pos;
  const rightLen = aEnd - opB.pos;
  const ops: Op[] = [];
  if (leftLen > 0) ops.push({ type: "delete", pos: opA.pos, len: leftLen });
  if (rightLen > 0) ops.push({ type: "delete", pos: opA.pos + opB.text.length, len: rightLen });
  return ops;
}

function transformDeleteDelete(opA: DeleteOp, opB: DeleteOp): Op[] {
  const aStart = opA.pos;
  const aEnd = opA.pos + opA.len;
  const bStart = opB.pos;
  const bEnd = opB.pos + opB.len;

  if (bEnd <= aStart) {
    // B's deleted range is entirely before A's: shift A left.
    return [{ ...opA, pos: aStart - opB.len }];
  }
  if (bStart >= aEnd) {
    // B's deleted range is entirely after A's: no change.
    return [opA];
  }

  // Overlapping ranges: subtract whatever B already deleted from A's
  // range. Because both ranges are contiguous, the surviving portion of
  // A's range is always contiguous too (see COMPARISON.md for the proof
  // sketch), so a single resulting op always suffices here.
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  const overlapLen = Math.max(0, overlapEnd - overlapStart);
  const newLen = opA.len - overlapLen;
  const shiftFromLeft = Math.max(0, Math.min(bEnd, aStart) - bStart);
  const newPos = aStart - shiftFromLeft;

  if (newLen <= 0) return []; // A's entire range was already deleted by B
  return [{ type: "delete", pos: newPos, len: newLen }];
}
