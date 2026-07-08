import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "net";
import WebSocket from "ws";
import { createApp } from "../src/app";
import { WEBRTC_SIGNALING_PATH } from "../src/webrtc/signalingServer";
import { signToken } from "../src/auth/jwt";
import { resetDb, closeDb } from "./testDb";
import { createTestUser } from "./testUsers";
import { redisBus } from "../src/redis/pubsub";
import { roomManager } from "../src/rooms/roomManager";
import { createDocument, updateLinkAccess } from "../src/db/documentsRepo";

/**
 * Exercises the actual WebRTC signaling code
 * (`packages/server/src/webrtc/signalingServer.ts`) that the browser's
 * `y-webrtc` `WebrtcProvider` talks to (see
 * `packages/client/src/yjs/webrtcTransport.ts`), with a real listening
 * HTTP server and real `ws` WebSocket connections -- not mocks. This is
 * the automated counterpart to the manual two-browser-tab WebRTC
 * verification described in README.md: real `RTCPeerConnection`
 * establishment (STUN/ICE, NAT traversal) isn't something that can be
 * driven deterministically in a headless test environment, but the
 * signaling relay those peer connections depend on to find each other is
 * entirely our own code, and is fully covered here -- auth gating,
 * topic subscribe/publish fan-out, and isolation between unrelated rooms.
 */
describe("WebRTC signaling server", () => {
  let baseWsUrl: string;
  let httpServer: ReturnType<typeof createApp>["httpServer"];
  let token: string;
  let strangerToken: string;
  let privateDocId: string;
  // Topics the signaling server accepts a subscribe for must correspond to
  // a real document `token`'s user can read (see `canSubscribe` in
  // `signalingServer.ts`) -- these three stand in for the ad-hoc
  // "collab-doc-room-N" names the tests used before that check existed.
  let roomOneTopic: string;
  let roomTwoTopic: string;
  let roomThreeTopic: string;

  beforeAll(async () => {
    await resetDb();
    const owner = await createTestUser("webrtc-owner", "Owner");
    token = signToken({ sub: owner.id, displayName: "Owner" });

    const stranger = await createTestUser("webrtc-stranger", "Stranger");
    strangerToken = signToken({ sub: stranger.id, displayName: "Stranger" });

    const privateDoc = await createDocument("Private doc", owner.id, "javascript");
    await updateLinkAccess(privateDoc.id, "none");
    privateDocId = privateDoc.id;

    const roomOne = await createDocument("Room 1", owner.id, "javascript");
    const roomTwo = await createDocument("Room 2", owner.id, "javascript");
    const roomThree = await createDocument("Room 3", owner.id, "javascript");
    roomOneTopic = `collab-doc-${roomOne.id}`;
    roomTwoTopic = `collab-doc-${roomTwo.id}`;
    roomThreeTopic = `collab-doc-${roomThree.id}`;

    const created = createApp();
    httpServer = created.httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseWsUrl = `ws://localhost:${port}`;
  });

  afterAll(async () => {
    await roomManager.flushAll();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closeDb();
    await redisBus.close();
  });

  function connect(withToken: string | undefined): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const url = withToken
        ? `${baseWsUrl}${WEBRTC_SIGNALING_PATH}?token=${encodeURIComponent(withToken)}`
        : `${baseWsUrl}${WEBRTC_SIGNALING_PATH}`;
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`unexpected status ${res.statusCode}`)));
    });
  }

  function nextMessage(ws: WebSocket): Promise<any> {
    return new Promise((resolve) => {
      ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
  }

  function waitClose(ws: WebSocket): Promise<void> {
    return new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
    });
  }

  it("rejects a connection with no token", async () => {
    await expect(connect(undefined)).rejects.toBeTruthy();
  });

  it("rejects a connection with an invalid/garbage token", async () => {
    await expect(connect("not-a-real-jwt")).rejects.toBeTruthy();
  });

  it("relays a publish message to other subscribers of the same topic, and never to a different topic", async () => {
    const a = await connect(token);
    const b = await connect(token);
    const c = await connect(token); // subscribed to a different room entirely

    a.send(JSON.stringify({ type: "subscribe", topics: [roomOneTopic] }));
    b.send(JSON.stringify({ type: "subscribe", topics: [roomOneTopic] }));
    c.send(JSON.stringify({ type: "subscribe", topics: [roomTwoTopic] }));

    // Give the subscriptions a moment to land server-side before publishing
    // (subscribe now round-trips through an async access-control check).
    await new Promise((resolve) => setTimeout(resolve, 150));

    const bReceived = nextMessage(b);
    const cReceivedOrTimeout = Promise.race([
      nextMessage(c).then(() => "message" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ]);

    a.send(
      JSON.stringify({
        type: "publish",
        topic: roomOneTopic,
        data: { signal: "offer-from-a" },
      })
    );

    const received = await bReceived;
    expect(received.type).toBe("publish");
    expect(received.topic).toBe(roomOneTopic);
    expect(received.data.signal).toBe("offer-from-a");
    expect(received.clients).toBe(2); // a and b are both subscribed

    expect(await cReceivedOrTimeout).toBe("timeout");

    a.close();
    b.close();
    c.close();
    await Promise.all([waitClose(a), waitClose(b), waitClose(c)]);
  });

  it("stops relaying to a socket after it unsubscribes", async () => {
    const a = await connect(token);
    const b = await connect(token);

    a.send(JSON.stringify({ type: "subscribe", topics: [roomThreeTopic] }));
    b.send(JSON.stringify({ type: "subscribe", topics: [roomThreeTopic] }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    b.send(JSON.stringify({ type: "unsubscribe", topics: [roomThreeTopic] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const bReceivedOrTimeout = Promise.race([
      nextMessage(b).then(() => "message" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ]);
    a.send(JSON.stringify({ type: "publish", topic: roomThreeTopic, data: {} }));

    expect(await bReceivedOrTimeout).toBe("timeout");

    a.close();
    b.close();
    await Promise.all([waitClose(a), waitClose(b)]);
  });

  it("does not relay to a subscriber who lacks access to the document behind the topic", async () => {
    // Regression test: the signaling server used to only check that the
    // connecting JWT was *valid*, not that its user could actually read the
    // specific document the topic name encodes. Since WebRTC sync traffic
    // flows directly between peers once connected (bypassing roomManager's
    // access-control enforcement entirely), that let any authenticated user
    // pull down a private document's content over WebRTC despite failing
    // `resolveEffectiveRole` on the REST/Socket.io path.
    const owner = await connect(token);
    const stranger = await connect(strangerToken);
    const topic = `collab-doc-${privateDocId}`;

    owner.send(JSON.stringify({ type: "subscribe", topics: [topic] }));
    stranger.send(JSON.stringify({ type: "subscribe", topics: [topic] }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const strangerReceivedOrTimeout = Promise.race([
      nextMessage(stranger).then(() => "message" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ]);

    owner.send(
      JSON.stringify({ type: "publish", topic, data: { signal: "offer-from-owner" } })
    );

    expect(await strangerReceivedOrTimeout).toBe("timeout");

    owner.close();
    stranger.close();
    await Promise.all([waitClose(owner), waitClose(stranger)]);
  });

  it("responds to a ping with a pong", async () => {
    const a = await connect(token);
    const pong = nextMessage(a);
    a.send(JSON.stringify({ type: "ping" }));
    expect((await pong).type).toBe("pong");
    a.close();
    await waitClose(a);
  });
});
