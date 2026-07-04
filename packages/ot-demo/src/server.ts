import { applyAll, transform, type Op, type Priority } from "./ops";

/**
 * A minimal central sequencer, in the spirit of the classic Jupiter/Google
 * Wave OT protocol: every op must pass through here to be assigned a
 * total order, transformed against whatever concurrent history the
 * submitting client hadn't seen yet, and only then applied and
 * broadcast. This central choke point is precisely what CRDTs (Yjs, used
 * elsewhere in this repo) let you avoid -- see COMPARISON.md.
 */
export class OTServer {
  private history: Op[] = [];
  doc: string;

  constructor(initialDoc = "") {
    this.doc = initialDoc;
  }

  get revision(): number {
    return this.history.length;
  }

  /** The full canonical op sequence accepted so far, in server order.
   * Replaying this onto a fresh copy of the initial doc always reproduces
   * `this.doc` exactly -- that's what "the server defines a total order"
   * means in practice, and it's the basis for the convergence tests. */
  getHistory(): Op[] {
    return [...this.history];
  }

  /**
   * `op` was generated against a client-local doc that reflected
   * `baseRevision` server ops (i.e. the client hadn't seen anything the
   * server accepted after that point). Transform it forward against every
   * op accepted since, apply the result, and return it so the caller can
   * broadcast to other clients.
   */
  receive(op: Op, baseRevision: number, priority: Priority): { ops: Op[]; revision: number } {
    if (baseRevision < 0 || baseRevision > this.history.length) {
      throw new Error(`invalid baseRevision ${baseRevision} (server at ${this.history.length})`);
    }
    let candidates: Op[] = [op];
    for (let i = baseRevision; i < this.history.length; i++) {
      const serverOp = this.history[i];
      candidates = candidates.flatMap((c) => transform(c, serverOp, priority));
    }
    this.doc = applyAll(this.doc, candidates);
    this.history.push(...candidates);
    return { ops: candidates, revision: this.history.length };
  }
}

/** A client's local replica: applies its own edits optimistically, then
 * reconciles with whatever the server echoes back (its own transformed
 * op) or broadcasts (other clients' transformed ops). This intentionally
 * does NOT implement full concurrent local-pending-op transformation
 * (the hardest part of a production OT client, e.g. Google Wave's
 * client-side "GOT" algorithm) -- this demo submits one op at a time and
 * waits, which is enough to demonstrate the server-side transform
 * machinery and convergence without building an entire OT client stack.
 * That simplification, and what it costs vs. a CRDT client, is exactly
 * the story reported in COMPARISON.md. */
export class OTClient {
  doc: string;
  revision: number;

  constructor(
    public readonly id: string,
    initialDoc: string,
    initialRevision: number
  ) {
    this.doc = initialDoc;
    this.revision = initialRevision;
  }

  /** Apply a batch of ops (already in server order) that this client
   * hadn't seen -- either the echo of its own submitted op, or another
   * client's op relayed by the server. */
  applyRemote(ops: Op[], newRevision: number): void {
    this.doc = applyAll(this.doc, ops);
    this.revision = newRevision;
  }
}
