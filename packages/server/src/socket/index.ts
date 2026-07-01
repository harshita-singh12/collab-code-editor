import type { Server, Socket } from "socket.io";
import { SOCKET_EVENTS, type JoinRoomAck, type JoinRoomError } from "@collab/shared";
import { verifyToken } from "../auth/jwt";
import { getDocumentById } from "../db/documentsRepo";
import { resolveEffectiveRole } from "../auth/accessControl";
import { roomManager } from "../rooms/roomManager";

interface SocketData {
  userId: string | null;
  displayName: string | null;
  currentDocId: string | null;
}

export function registerSocketHandlers(io: Server): void {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const data = socket.data as SocketData;
    data.userId = null;
    data.displayName = null;
    data.currentDocId = null;
    if (token) {
      try {
        const payload = verifyToken(token);
        data.userId = payload.sub;
        data.displayName = payload.displayName;
      } catch {
        // Invalid token -> connect anonymously; document-level access
        // control will resolve them to "none" or link-access role.
      }
    }
    next();
  });

  io.on("connection", (socket: Socket) => {
    const data = socket.data as SocketData;

    socket.on(SOCKET_EVENTS.JOIN_ROOM, async (payload: { docId: string }, cb) => {
      try {
        const doc = await getDocumentById(payload.docId);
        if (!doc) {
          const err: JoinRoomError = { ok: false, error: "document not found" };
          cb?.(err);
          return;
        }
        const role = await resolveEffectiveRole(doc, data.userId);
        if (role === "none") {
          const err: JoinRoomError = { ok: false, error: "access denied" };
          cb?.(err);
          return;
        }

        // A socket only ever participates in one document room at a time
        // in this app's UI, but guard against stale joins anyway.
        if (data.currentDocId && data.currentDocId !== payload.docId) {
          roomManager.handleDisconnectCleanup(data.currentDocId, socket);
          socket.leave(data.currentDocId);
        }

        data.currentDocId = payload.docId;
        socket.join(payload.docId);
        const awarenessClientId = await roomManager.join(payload.docId, socket, role);

        const ack: JoinRoomAck = { ok: true, role, awarenessClientId };
        cb?.(ack);
      } catch (err) {
        console.error("[socket] join-room failed", err);
        const errAck: JoinRoomError = { ok: false, error: "internal error" };
        cb?.(errAck);
      }
    });

    socket.on(SOCKET_EVENTS.LEAVE_ROOM, () => {
      if (data.currentDocId) {
        roomManager.handleDisconnectCleanup(data.currentDocId, socket);
        socket.leave(data.currentDocId);
        data.currentDocId = null;
      }
    });

    socket.on(SOCKET_EVENTS.DOC_SYNC, (payload: ArrayBuffer | Uint8Array) => {
      if (!data.currentDocId) return;
      roomManager.handleSyncMessage(data.currentDocId, socket, toUint8Array(payload));
    });

    socket.on(SOCKET_EVENTS.DOC_AWARENESS, (payload: ArrayBuffer | Uint8Array) => {
      if (!data.currentDocId) return;
      roomManager.handleAwarenessMessage(data.currentDocId, socket, toUint8Array(payload));
    });

    socket.on("disconnect", () => {
      if (data.currentDocId) {
        roomManager.handleDisconnectCleanup(data.currentDocId, socket);
      }
    });
  });
}

function toUint8Array(payload: ArrayBuffer | Uint8Array): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  return new Uint8Array(payload);
}
