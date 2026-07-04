import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import { createApp } from "../src/app";
import { resetDb, closeDb } from "./testDb";
import { findOrCreateUser } from "../src/db/usersRepo";
import { createDocument } from "../src/db/documentsRepo";
import { signToken } from "../src/auth/jwt";
import { redisBus } from "../src/redis/pubsub";
import { roomManager } from "../src/rooms/roomManager";
import { TestYjsClient, waitUntil } from "./testYjsClient";

/**
 * End-to-end convergence tests: a real HTTP+Socket.io server, real
 * socket.io-client connections (2-3 of them), driving actual network
 * round-trips -- not mocked. This is the automated counterpart to the
 * manual two-browser-tab test described in README.md, and specifically
 * covers the "simulated network partition/latency" requirement by
 * disconnecting a client's socket mid-edit, editing on both sides while
 * partitioned, then reconnecting and asserting convergence.
 */
describe("convergence under network partition (e2e, real Socket.io)", () => {
  let baseUrl: string;
  let httpServer: ReturnType<typeof createApp>["httpServer"];
  const clients: TestYjsClient[] = [];

  beforeAll(async () => {
    const created = createApp();
    httpServer = created.httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await roomManager.flushAll();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closeDb();
    await redisBus.close();
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
  });

  async function makeDocument(title = "Convergence Test Doc") {
    const owner = await findOrCreateUser("owner-client", "Owner");
    const doc = await createDocument(title, owner.id, "javascript");
    const token = signToken({ sub: owner.id, displayName: "Owner" });
    return { doc, token };
  }

  function client(docId: string, token: string): TestYjsClient {
    const c = new TestYjsClient(baseUrl, docId, token);
    clients.push(c);
    return c;
  }

  it("two clients editing concurrently converge to the same text", async () => {
    const { doc, token } = await makeDocument();
    const a = client(doc.id, token);
    const b = client(doc.id, token);
    await Promise.all([a.connectAndJoin(), b.connectAndJoin()]);

    a.insert(0, "Hello ");
    b.insert(0, "World "); // both start from an empty doc, genuinely concurrent

    await waitUntil(() => a.text() === b.text() && a.text().length > 0);
    expect(a.text()).toBe(b.text());
    // Both fragments must have survived the merge.
    expect(a.text()).toContain("Hello");
    expect(a.text()).toContain("World");
  });

  it("converges after a simulated network partition where both sides keep editing offline", async () => {
    const { doc, token } = await makeDocument();
    const a = client(doc.id, token);
    const b = client(doc.id, token);
    await Promise.all([a.connectAndJoin(), b.connectAndJoin()]);

    a.insert(0, "shared prefix. ");
    await waitUntil(() => b.text() === a.text());

    // --- simulate a network partition for client B ---
    b.disconnectNetwork();

    // A keeps editing while connected (its changes reach the server and
    // would reach any other *connected* client, but not B).
    a.insert(a.text().length, "[A said this while B was offline] ");

    // B keeps editing locally while fully disconnected -- this is exactly
    // what "queue local ops while disconnected" means for a CRDT: there
    // is no explicit queue, B's Y.Doc just keeps accumulating local state.
    b.insert(b.text().length, "[B said this while offline] ");

    // Confirm they've actually diverged while partitioned.
    expect(a.text()).not.toBe(b.text());

    // --- reconnect ---
    await b.reconnectNetwork();

    // Give the resync handshake + rebroadcast a moment to settle.
    await waitUntil(() => a.text() === b.text(), 5000);

    expect(a.text()).toBe(b.text());
    expect(a.text()).toContain("[A said this while B was offline]");
    expect(a.text()).toContain("[B said this while offline]");
  });

  it("a third, freshly-joining client converges to the same state as the two active editors", async () => {
    const { doc, token } = await makeDocument();
    const a = client(doc.id, token);
    const b = client(doc.id, token);
    await Promise.all([a.connectAndJoin(), b.connectAndJoin()]);

    a.insert(0, "abc");
    b.insert(0, "xyz");
    await waitUntil(() => a.text() === b.text() && a.text().length === 6);

    const c = client(doc.id, token);
    await c.connectAndJoin();
    await waitUntil(() => c.text() === a.text());
    expect(c.text()).toBe(a.text());
  });

  it("converges regardless of message arrival order (reordered/delayed delivery)", async () => {
    const { doc, token } = await makeDocument();
    const a = client(doc.id, token);
    const b = client(doc.id, token);
    await Promise.all([a.connectAndJoin(), b.connectAndJoin()]);

    // Make several edits on both sides back-to-back (no waiting between
    // them), so update messages are in flight and get interleaved/queued
    // by the event loop and network stack in whatever order they land --
    // Yjs's merge does not depend on that order.
    a.insert(0, "1");
    b.insert(0, "2");
    a.insert(a.text().length, "3");
    b.insert(0, "4");
    a.insert(0, "5");

    await waitUntil(() => a.text() === b.text() && a.text().length === 5, 5000);
    expect(a.text()).toBe(b.text());
    expect([...a.text()].sort().join("")).toBe("12345");
  });
});
