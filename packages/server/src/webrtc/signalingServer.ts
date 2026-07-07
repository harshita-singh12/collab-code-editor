import type { IncomingMessage, Server as HttpServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { env } from "../util/env";
import { verifyToken } from "../auth/jwt";

export const WEBRTC_SIGNALING_PATH = "/webrtc-signaling";

const PING_TIMEOUT_MS = 30000;

interface SignalingSocket extends WebSocket {
  subscribedTopics?: Set<string>;
  pongReceived?: boolean;
}

interface SignalingMessage {
  type: "subscribe" | "unsubscribe" | "publish" | "ping" | "pong";
  topics?: unknown;
  topic?: unknown;
  clients?: number;
  [key: string]: unknown;
}

function send(conn: SignalingSocket, message: SignalingMessage): void {
  if (conn.readyState !== WebSocket.CONNECTING && conn.readyState !== WebSocket.OPEN) {
    conn.close();
    return;
  }
  try {
    conn.send(JSON.stringify(message));
  } catch {
    conn.close();
  }
}

/**
 * Self-hosted signaling server for the optional WebRTC transport
 * (`y-webrtc`'s `WebrtcProvider`, wired up client-side in
 * `packages/client/src/yjs/webrtcTransport.ts`).
 *
 * y-webrtc's provider talks to any server implementing a small
 * subscribe/publish/ping pub-sub protocol over a plain WebSocket -- it
 * defaults to a small set of public servers
 * (`wss://y-webrtc-eu.fly.dev` and friends) run by the Yjs project. We
 * don't want documents' WebRTC signaling (which reveals which document
 * "rooms" are active and briefly relays SDP/ICE offers between
 * collaborators) to depend on a third party's uptime, so this
 * reimplements that same protocol here and mounts it on our *existing*
 * HTTP server/process (same port as Express + Socket.io, via a raw
 * `http.Server` "upgrade" listener scoped to `WEBRTC_SIGNALING_PATH`)
 * instead of standing up a second server. Socket.io's own engine.io
 * upgrade handler only reacts to its own path, so the two coexist on one
 * process without conflict.
 *
 * This server only relays opaque signaling payloads between subscribers
 * of the same topic (a topic is one `collab-doc-<docId>` room) -- it never
 * looks at document content, which stays end-to-end between the peers'
 * `RTCPeerConnection`s (or, once connected, flows directly over Socket.io,
 * which remains the always-on transport and the only one that persists to
 * Postgres). Connections must present a valid JWT (the same one used for
 * REST/Socket.io auth) as a `?token=` query param, so this endpoint can't
 * be used by an unauthenticated client to discover which document rooms
 * are currently active.
 */
export function attachWebrtcSignaling(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  const topics = new Map<string, Set<SignalingSocket>>();

  httpServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== WEBRTC_SIGNALING_PATH) return; // not ours; leave it for Socket.io's own upgrade handler

    const origin = req.headers.origin;
    if (origin && origin !== env.CORS_ORIGIN) {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token");
    if (!token) {
      socket.destroy();
      return;
    }
    try {
      verifyToken(token);
    } catch {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (rawConn: WebSocket) => {
    const conn = rawConn as SignalingSocket;
    conn.subscribedTopics = new Set();
    conn.pongReceived = true;
    let closed = false;

    const pingInterval = setInterval(() => {
      if (!conn.pongReceived) {
        conn.close();
        clearInterval(pingInterval);
        return;
      }
      conn.pongReceived = false;
      try {
        conn.ping();
      } catch {
        conn.close();
      }
    }, PING_TIMEOUT_MS);

    conn.on("pong", () => {
      conn.pongReceived = true;
    });

    conn.on("close", () => {
      closed = true;
      clearInterval(pingInterval);
      for (const topicName of conn.subscribedTopics ?? []) {
        const subs = topics.get(topicName);
        if (!subs) continue;
        subs.delete(conn);
        if (subs.size === 0) topics.delete(topicName);
      }
      conn.subscribedTopics?.clear();
    });

    conn.on("message", (raw) => {
      if (closed) return;
      let message: SignalingMessage;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message?.type) return;

      switch (message.type) {
        case "subscribe": {
          const requested = Array.isArray(message.topics) ? message.topics : [];
          for (const topicName of requested) {
            if (typeof topicName !== "string") continue;
            let subs = topics.get(topicName);
            if (!subs) {
              subs = new Set();
              topics.set(topicName, subs);
            }
            subs.add(conn);
            conn.subscribedTopics?.add(topicName);
          }
          break;
        }
        case "unsubscribe": {
          const requested = Array.isArray(message.topics) ? message.topics : [];
          for (const topicName of requested) {
            if (typeof topicName !== "string") continue;
            topics.get(topicName)?.delete(conn);
            conn.subscribedTopics?.delete(topicName);
          }
          break;
        }
        case "publish": {
          if (typeof message.topic !== "string") break;
          const receivers = topics.get(message.topic);
          if (!receivers) break;
          message.clients = receivers.size;
          for (const receiver of receivers) send(receiver, message);
          break;
        }
        case "ping":
          send(conn, { type: "pong" });
          break;
      }
    });
  });
}
