/**
 * Standalone, narrated convergence demo: boots a real server (Express +
 * Socket.io + real Postgres/Redis from your .env), spins up two real
 * socket.io-client connections editing the same document, simulates a
 * network partition (one client goes offline, both sides keep editing),
 * reconnects, and prints the converged result.
 *
 * This is the automated counterpart to manually opening two browser tabs
 * (see README.md "How convergence was verified"). Run with:
 *   npm run convergence-demo --workspace=packages/server
 * (requires DATABASE_URL/REDIS_URL reachable -- see README "Running
 * locally without Docker").
 */
import type { AddressInfo } from "net";
import { createApp } from "../src/app";
import { findOrCreateUser } from "../src/db/usersRepo";
import { createDocument } from "../src/db/documentsRepo";
import { signToken } from "../src/auth/jwt";
import { redisBus } from "../src/redis/pubsub";
import { roomManager } from "../src/rooms/roomManager";
import { pool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { TestYjsClient, waitUntil } from "./testYjsClient";

function log(...args: unknown[]) {
  console.log(...args);
}

async function main() {
  await migrate();

  const { httpServer } = createApp();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  const baseUrl = `http://localhost:${port}`;
  log(`[demo] server listening on ${baseUrl}\n`);

  const owner = await findOrCreateUser(`demo-${Date.now()}`, "Demo Owner");
  const doc = await createDocument("Convergence Demo Doc", owner.id, "javascript");
  const token = signToken({ sub: owner.id, displayName: "Demo Owner" });
  log(`[demo] created document ${doc.id}\n`);

  const alice = new TestYjsClient(baseUrl, doc.id, token);
  const bob = new TestYjsClient(baseUrl, doc.id, token);
  await Promise.all([alice.connectAndJoin(), bob.connectAndJoin()]);
  log("[demo] both clients connected and completed the initial sync handshake\n");

  alice.insert(0, "// shared header\n");
  await waitUntil(() => bob.text() === alice.text());
  log(`[demo] alice typed a header, bob received it live -> ${JSON.stringify(bob.text())}\n`);

  log("[demo] --- simulating a network partition: disconnecting bob's socket ---");
  bob.disconnectNetwork();

  alice.insert(alice.text().length, "function fromAlice() { /* while bob was offline */ }\n");
  bob.insert(bob.text().length, "function fromBob() { /* written fully offline, no network */ }\n");
  log(`[demo] alice (online) doc:  ${JSON.stringify(alice.text())}`);
  log(`[demo] bob (offline) doc:   ${JSON.stringify(bob.text())}`);
  log(`[demo] documents have diverged: ${alice.text() !== bob.text()}\n`);

  log("[demo] --- reconnecting bob ---");
  await bob.reconnectNetwork();
  await waitUntil(() => alice.text() === bob.text(), 5000);

  log(`[demo] alice final doc: ${JSON.stringify(alice.text())}`);
  log(`[demo] bob final doc:   ${JSON.stringify(bob.text())}`);
  const converged = alice.text() === bob.text();
  log(`\n[demo] CONVERGED: ${converged}`);
  if (!converged) {
    throw new Error("documents did not converge");
  }

  alice.destroy();
  bob.destroy();
  // Fully evict (not just flush) every room this demo touched so their
  // timers (persistence debounce, version checkpoints, awareness's own
  // internal cleanup interval) are cancelled before we tear down the
  // shared Postgres/Redis connections they'd otherwise try to use.
  await roomManager.evict(doc.id);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await redisBus.close();
  await pool.end();
}

main().catch((err) => {
  console.error("[demo] failed", err);
  process.exitCode = 1;
});
