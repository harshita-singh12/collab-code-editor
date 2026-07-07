import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import type { Awareness } from "y-protocols/awareness";
import { SERVER_URL } from "../api/client";

/**
 * Optional, additional real-time transport: direct peer-to-peer sync via
 * WebRTC (`y-webrtc`'s official `WebrtcProvider`), layered on top of the
 * *same* `Y.Doc` and `Awareness` instance the always-on `SocketIOProvider`
 * uses. Yjs updates are commutative/associative/idempotent, so feeding the
 * same doc from two independent providers is safe by construction -- each
 * transport just applies whatever updates it receives, and it doesn't
 * matter which one delivers a given update first.
 *
 * Two collaborators who are online at the same time and can establish a
 * direct connection get lower-latency sync and take load off the server;
 * everyone still gets the durable, access-controlled path via Socket.io
 * regardless (persistence to Postgres and the owner/editor/viewer
 * enforcement in `roomManager.ts` only happen over Socket.io), so WebRTC
 * failing to connect (NAT/firewall, no peers currently online, etc.) is a
 * pure latency/load regression, never a correctness or access-control gap.
 *
 * Signaling: rather than `y-webrtc`'s default public signaling servers
 * (`wss://y-webrtc-eu.fly.dev` and friends), this points at a small
 * self-hosted signaling endpoint mounted on our *own* server, on the same
 * HTTP server/port as the Socket.io relay
 * (`packages/server/src/webrtc/signalingServer.ts`). That keeps "who is
 * editing which document" from ever being relayed through a third party,
 * and means the JWT we already have can gate the signaling connection the
 * same way it gates REST/Socket.io.
 */
export function createWebrtcProvider(
  docId: string,
  doc: Y.Doc,
  awareness: Awareness,
  token: string
): WebrtcProvider {
  const signalingUrl = `${SERVER_URL.replace(/^http/, "ws")}/webrtc-signaling?token=${encodeURIComponent(token)}`;
  return new WebrtcProvider(`collab-doc-${docId}`, doc, {
    signaling: [signalingUrl],
    awareness,
    maxConns: 20,
    filterBcConns: true,
  });
}
