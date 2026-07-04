import { OTServer } from "./server";
import { apply, applyAll, type Op } from "./ops";

/**
 * Runs a small narrated scenario: two clients start from the same doc and
 * make concurrent edits; a central OTServer sequences and transforms them.
 * We then show that replaying the server's final canonical op history
 * onto a fresh copy of the original doc reproduces the server's doc
 * exactly -- that replay is what every client ultimately converges to.
 *
 * Note on scope: this demo's OTClient (see server.ts) only models
 * "generate an op, submit it, apply the ack" -- it does not implement the
 * additional client-side reconciliation algorithm (the counterpart of
 * Google Wave's "GOT") needed to let a client keep typing locally while
 * concurrent remote ops are still in flight and merge everything
 * correctly. Building that is a substantial undertaking on its own; the
 * server-side transform machinery shown here is the harder-to-get-right
 * half. See COMPARISON.md for what this costs vs. the CRDT approach used
 * in the main app, where no such client-side algorithm is needed at all.
 *
 * Run with: npm run demo --workspace=packages/ot-demo
 */
function main() {
  const initial = "Hello World";
  const server = new OTServer(initial);
  console.log(`initial doc: ${JSON.stringify(initial)}\n`);

  // Alice inserts "Beautiful " before "World" (index 6)...
  const aliceOp: Op = { type: "insert", pos: 6, text: "Beautiful " };
  console.log(
    `alice (at revision 0) locally previews: ${JSON.stringify(apply(initial, aliceOp))}`
  );

  // ...concurrently with Bob deleting "World" and typing "Yjs", also
  // starting from revision 0 (neither has seen the other's edit yet).
  const bobDelete: Op = { type: "delete", pos: 6, len: 5 };
  const bobInsert: Op = { type: "insert", pos: 6, text: "Yjs" };
  console.log(
    `bob   (at revision 0) locally previews: ${JSON.stringify(apply(apply(initial, bobDelete), bobInsert))}\n`
  );

  // Bob's ops happen to reach the server first.
  const bobResult1 = server.receive(bobDelete, 0, "left");
  console.log(`server accepts bob's delete   -> ${JSON.stringify(server.doc)} (rev ${bobResult1.revision})`);
  const bobResult2 = server.receive(bobInsert, bobResult1.revision, "left");
  console.log(`server accepts bob's insert   -> ${JSON.stringify(server.doc)} (rev ${bobResult2.revision})\n`);

  // Alice's op was generated against revision 0, but the server is now at
  // revision 2 -- it transforms her op against both of Bob's ops in turn
  // before applying it.
  const aliceResult = server.receive(aliceOp, 0, "right");
  console.log(
    `server transforms alice's insert against bob's 2 ops -> applied as ${JSON.stringify(aliceResult.ops)}`
  );
  console.log(`server doc after transform+apply: ${JSON.stringify(server.doc)} (rev ${aliceResult.revision})\n`);

  // Convergence check: replay the server's full canonical history onto a
  // fresh copy of the original doc. Every client ends up here once fully
  // caught up.
  const replayed = applyAll(initial, server.getHistory());
  console.log(`replayed from full history:       ${JSON.stringify(replayed)}`);
  console.log(`server doc:                        ${JSON.stringify(server.doc)}`);
  console.log(`\nconverged: ${replayed === server.doc}`);
}

main();
