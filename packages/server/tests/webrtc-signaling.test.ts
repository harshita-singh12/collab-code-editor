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

  beforeAll(async () => {
    await resetDb();
    const owner = await createTestUser("webrtc-owner", "Owner");
    token = signToken({ sub: owner.id, displayName: "Owner" });

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

    a.send(JSON.stringify({ type: "subscribe", topics: ["collab-doc-room-1"] }));
    b.send(JSON.stringify({ type: "subscribe", topics: ["collab-doc-room-1"] }));
    c.send(JSON.stringify({ type: "subscribe", topics: ["collab-doc-room-2"] }));

    // Give the subscriptions a moment to land server-side before publishing.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const bReceived = nextMessage(b);
    const cReceivedOrTimeout = Promise.race([
      nextMessage(c).then(() => "message" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ]);

    a.send(
      JSON.stringify({
        type: "publish",
        topic: "collab-doc-room-1",
        data: { signal: "offer-from-a" },
      })
    );

    const received = await bReceived;
    expect(received.type).toBe("publish");
    expect(received.topic).toBe("collab-doc-room-1");
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

    a.send(JSON.stringify({ type: "subscribe", topics: ["collab-doc-room-3"] }));
    b.send(JSON.stringify({ type: "subscribe", topics: ["collab-doc-room-3"] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    b.send(JSON.stringify({ type: "unsubscribe", topics: ["collab-doc-room-3"] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const bReceivedOrTimeout = Promise.race([
      nextMessage(b).then(() => "message" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ]);
    a.send(JSON.stringify({ type: "publish", topic: "collab-doc-room-3", data: {} }));

    expect(await bReceivedOrTimeout).toBe("timeout");

    a.close();
    b.close();
    await Promise.all([waitClose(a), waitClose(b)]);
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
