import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
} from "y-protocols/awareness";
import * as diffLib from "diff";
import type { Socket } from "socket.io";
import type { EffectiveRole } from "@collab/shared";
import { SOCKET_EVENTS } from "@collab/shared";
import { redisBus } from "../redis/pubsub";
import { getDocumentById, updateDocumentState } from "../db/documentsRepo";
import { insertSnapshot } from "../db/snapshotsRepo";
import { env } from "../util/env";

export const CONTENT_KEY = "content";
const REDIS_ORIGIN = "redis-relay";
const INIT_ORIGIN = "init-from-db";
export const RESTORE_ORIGIN = "restore";

interface RoomSocketEntry {
  socket: Socket;
  role: EffectiveRole;
}

interface Room {
  docId: string;
  doc: Y.Doc;
  awareness: Awareness;
  sockets: Map<string, RoomSocketEntry>;
  persistTimer: NodeJS.Timeout | null;
  maxPersistTimer: NodeJS.Timeout | null;
  checkpointTimer: NodeJS.Timeout | null;
  idleEvictTimer: NodeJS.Timeout | null;
  dirtySincePersist: boolean;
  dirtySinceCheckpoint: boolean;
}

/**
 * Owns one authoritative in-memory Y.Doc + Awareness instance per actively
 * used document ("room"), and is the single place that:
 *  - loads/persists document state to Postgres (debounced -- writes the
 *    merged current state, not an update log, see README.md "Stack")
 *  - fans out updates to locally-connected sockets
 *  - fans out updates to other server instances via Redis pub/sub
 *  - drops writes from viewer-role sockets (the actual access-control
 *    enforcement point for real-time edits)
 */
class RoomManager {
  private rooms = new Map<string, Room>();

  private async createRoom(docId: string): Promise<Room> {
    const doc = new Y.Doc(); // gc: true (Yjs default) -- automatic tombstone compaction
    const docRow = await getDocumentById(docId);
    if (docRow?.state && docRow.state.byteLength > 0) {
      Y.applyUpdate(doc, docRow.state, INIT_ORIGIN);
    }
    const awareness = new Awareness(doc);

    const room: Room = {
      docId,
      doc,
      awareness,
      sockets: new Map(),
      persistTimer: null,
      maxPersistTimer: null,
      checkpointTimer: null,
      idleEvictTimer: null,
      dirtySincePersist: false,
      dirtySinceCheckpoint: false,
    };

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.onDocUpdate(room, update, origin);
    });

    awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown
      ) => {
        const changedClients = added.concat(updated).concat(removed);
        const update = encodeAwarenessUpdate(awareness, changedClients);
        this.broadcastAwareness(room, update, origin, changedClients);
      }
    );

    redisBus.onSync(docId, (update) => {
      Y.applyUpdate(room.doc, new Uint8Array(update), REDIS_ORIGIN);
    });
    redisBus.onAwareness(docId, (update) => {
      applyAwarenessUpdate(room.awareness, new Uint8Array(update), REDIS_ORIGIN);
    });

    return room;
  }

  // Guards against a race where two clients joining the same brand-new
  // room concurrently each see `rooms.get(docId)` as empty and both start
  // building a Room (each with its own separate Y.Doc): whichever
  // `createRoom` finishes last would silently overwrite the map entry
  // built by the other, orphaning the first room object -- including any
  // socket that had already registered itself against it. Callers racing
  // on the same docId must await the *same* in-flight creation promise.
  private pendingCreates = new Map<string, Promise<Room>>();

  async getOrLoad(docId: string): Promise<Room> {
    const existing = this.rooms.get(docId);
    if (existing) {
      this.clearIdleEviction(existing);
      return existing;
    }

    let pending = this.pendingCreates.get(docId);
    if (!pending) {
      pending = this.createRoom(docId).then((room) => {
        this.rooms.set(docId, room);
        this.pendingCreates.delete(docId);
        return room;
      });
      this.pendingCreates.set(docId, pending);
    }
    const room = await pending;
    this.clearIdleEviction(room);
    return room;
  }

  /** Client joined the room's socket channel. Sends our state vector so
   * the two-way Yjs sync handshake can begin, plus a snapshot of current
   * presence. */
  async join(docId: string, socket: Socket, role: EffectiveRole): Promise<number> {
    const room = await this.getOrLoad(docId);
    room.sockets.set(socket.id, { socket, role });

    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, room.doc);
    socket.emit(SOCKET_EVENTS.DOC_SYNC, encoding.toUint8Array(encoder));

    const clientIds = Array.from(room.awareness.getStates().keys());
    if (clientIds.length > 0) {
      const awarenessUpdate = encodeAwarenessUpdate(room.awareness, clientIds);
      socket.emit(SOCKET_EVENTS.DOC_AWARENESS, awarenessUpdate);
    }

    return room.awareness.clientID;
  }

  leave(docId: string, socketId: string): void {
    const room = this.rooms.get(docId);
    if (!room) return;
    room.sockets.delete(socketId);
    // Awareness states belonging to this socket's client(s) are cleared by
    // the client-side provider's beforeunload/disconnect handling and by
    // the awareness protocol's own timeout; we don't try to guess which
    // awareness clientID(s) belonged to this socket here.
    if (room.sockets.size === 0) {
      this.scheduleIdleEviction(room);
    }
  }

  updateRole(docId: string, socketId: string, role: EffectiveRole): void {
    const room = this.rooms.get(docId);
    const entry = room?.sockets.get(socketId);
    if (entry) entry.role = role;
  }

  /** Handles an inbound `doc-sync` message from a client socket. Access
   * control for writes is enforced here: a viewer's message is still fed
   * through readSyncMessage so handshake (step1/step2) traffic works (a
   * viewer must still be able to *receive* the doc), but if decoding
   * reveals it carried an update, and the sender is not permitted to
   * write, we discard the whole room by re-deriving from state instead of
   * risking partial application. In practice Monaco is read-only for
   * viewers client-side too, so this path is a defense-in-depth backstop,
   * not the primary UX gate. */
  handleSyncMessage(docId: string, socket: Socket, data: Uint8Array): void {
    const room = this.rooms.get(docId);
    if (!room) return;
    const entry = room.sockets.get(socket.id);
    if (!entry) return;

    // A client-controlled byte payload reaches decoders (lib0/y-protocols)
    // that throw synchronously on anything malformed (truncated buffers,
    // bogus message-type tags, etc). Since this runs inside a plain
    // Socket.io event listener, an uncaught throw here would propagate all
    // the way up and crash the whole process -- taking down every room for
    // every connected client, not just the sender. Treat a malformed
    // payload as "drop it and log", the same way we already treat a
    // disallowed write from a viewer.
    try {
      if (entry.role === "viewer") {
        // A viewer may still request/receive sync (messageYjsSyncStep1) but
        // may not push updates. Peek the message type without mutating doc
        // state for anything other than step1 requests.
        const peekDecoder = decoding.createDecoder(data);
        const messageType = decoding.readVarUint(peekDecoder);
        if (messageType !== syncProtocol.messageYjsSyncStep1) {
          return; // silently drop step2/update from a read-only client
        }
      }

      const decoder = decoding.createDecoder(data);
      const encoder = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket.id);
      if (encoding.length(encoder) > 0) {
        socket.emit(SOCKET_EVENTS.DOC_SYNC, encoding.toUint8Array(encoder));
      }
    } catch (err) {
      console.error(`[room ${docId}] dropped malformed doc-sync payload from ${socket.id}`, err);
    }
  }

  handleAwarenessMessage(docId: string, socket: Socket, data: Uint8Array): void {
    const room = this.rooms.get(docId);
    if (!room) return;
    // Same reasoning as handleSyncMessage above: never let a malformed
    // client payload throw past this point.
    try {
      applyAwarenessUpdate(room.awareness, data, socket.id);
    } catch (err) {
      console.error(`[room ${docId}] dropped malformed awareness payload from ${socket.id}`, err);
    }
  }

  handleDisconnectCleanup(docId: string, socket: Socket): void {
    const room = this.rooms.get(docId);
    if (!room) return;
    // Clear awareness state for any awareness clientIDs tagged with this
    // socket's id as origin isn't tracked directly, so instead we rely on
    // the client to send an explicit "removeAwarenessStates" style update
    // on graceful disconnect (see SocketIOProvider); the library's own
    // timeout-based pruning (30s) is the backstop for ungraceful drops.
    this.leave(docId, socket.id);
  }

  private onDocUpdate(room: Room, update: Uint8Array, origin: unknown): void {
    if (origin === INIT_ORIGIN) return; // initial load from DB, nothing to rebroadcast

    room.dirtySincePersist = true;
    room.dirtySinceCheckpoint = true;
    this.schedulePersist(room);
    this.scheduleCheckpoint(room);

    // Rebroadcast to local sockets, except the one that originated it
    // (origin is that socket's id when the update came from a client).
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    const payload = encoding.toUint8Array(encoder);
    for (const [socketId, { socket }] of room.sockets) {
      if (socketId === origin) continue;
      socket.emit(SOCKET_EVENTS.DOC_SYNC, payload);
    }

    // Fan out to other server instances, unless this update just arrived
    // from Redis in the first place (would create an infinite loop).
    if (origin !== REDIS_ORIGIN) {
      redisBus.publishSync(room.docId, update);
    }
  }

  private broadcastAwareness(
    room: Room,
    update: Uint8Array,
    origin: unknown,
    changedClients: number[]
  ): void {
    for (const [socketId, { socket }] of room.sockets) {
      if (socketId === origin) continue;
      socket.emit(SOCKET_EVENTS.DOC_AWARENESS, update);
    }
    if (origin !== REDIS_ORIGIN) {
      redisBus.publishAwareness(room.docId, update);
    }
  }

  // -- Persistence -----------------------------------------------------

  private schedulePersist(room: Room): void {
    if (room.persistTimer) clearTimeout(room.persistTimer);
    room.persistTimer = setTimeout(() => {
      this.persistNow(room).catch((err) =>
        console.error(`[room ${room.docId}] persist failed`, err)
      );
    }, env.PERSIST_DEBOUNCE_MS);

    if (!room.maxPersistTimer) {
      room.maxPersistTimer = setTimeout(() => {
        room.maxPersistTimer = null;
        this.persistNow(room).catch((err) =>
          console.error(`[room ${room.docId}] max-interval persist failed`, err)
        );
      }, env.PERSIST_MAX_INTERVAL_MS);
    }
  }

  private async persistNow(room: Room): Promise<void> {
    if (!room.dirtySincePersist) return;
    if (room.persistTimer) {
      clearTimeout(room.persistTimer);
      room.persistTimer = null;
    }
    if (room.maxPersistTimer) {
      clearTimeout(room.maxPersistTimer);
      room.maxPersistTimer = null;
    }
    room.dirtySincePersist = false;
    const state = Buffer.from(Y.encodeStateAsUpdate(room.doc));
    await updateDocumentState(room.docId, state);
    for (const { socket } of room.sockets.values()) {
      socket.emit(SOCKET_EVENTS.DOC_SAVED, { at: new Date().toISOString() });
    }
  }

  /** Force-flush (used on graceful shutdown and before eviction). */
  async flush(docId: string): Promise<void> {
    const room = this.rooms.get(docId);
    if (!room) return;
    await this.persistNow(room);
  }

  async flushAll(): Promise<void> {
    await Promise.all(Array.from(this.rooms.values()).map((r) => this.persistNow(r)));
  }

  // -- Version checkpoints ----------------------------------------------

  private scheduleCheckpoint(room: Room): void {
    if (room.checkpointTimer) return; // already scheduled
    room.checkpointTimer = setTimeout(() => {
      room.checkpointTimer = null;
      this.checkpointNow(room, null, null).catch((err) =>
        console.error(`[room ${room.docId}] checkpoint failed`, err)
      );
    }, env.VERSION_CHECKPOINT_INTERVAL_MS);
  }

  async checkpointNow(
    room: Room,
    label: string | null,
    createdBy: string | null
  ): Promise<void> {
    if (!label && !room.dirtySinceCheckpoint) return;
    room.dirtySinceCheckpoint = false;
    const state = Buffer.from(Y.encodeStateAsUpdate(room.doc));
    const text = room.doc.getText(CONTENT_KEY).toString();
    await insertSnapshot({
      documentId: room.docId,
      label,
      state,
      textExcerpt: text,
      createdBy,
    });
  }

  async saveManualCheckpoint(
    docId: string,
    label: string | null,
    createdBy: string
  ): Promise<void> {
    const room = await this.getOrLoad(docId);
    await this.checkpointNow(room, label, createdBy);
  }

  getText(docId: string): Promise<string> {
    return this.getOrLoad(docId).then((room) => room.doc.getText(CONTENT_KEY).toString());
  }

  /** Restores a historical version by diffing the live doc's current text
   * against the target text and applying the diff as ordinary Y.Text
   * operations inside one transaction. This merges causally with
   * concurrent edits instead of clobbering the document wholesale. */
  async restoreToText(docId: string, targetText: string, userId: string): Promise<void> {
    const room = await this.getOrLoad(docId);
    const ytext = room.doc.getText(CONTENT_KEY);
    const currentText = ytext.toString();
    if (currentText === targetText) return;

    const changes = diffLib.diffChars(currentText, targetText);
    room.doc.transact(() => {
      let index = 0;
      for (const part of changes) {
        if (part.removed) {
          ytext.delete(index, part.value.length);
        } else if (part.added) {
          ytext.insert(index, part.value);
          index += part.value.length;
        } else {
          index += part.value.length;
        }
      }
    }, `${RESTORE_ORIGIN}:${userId}`);
  }

  // -- Lifecycle ---------------------------------------------------------

  private scheduleIdleEviction(room: Room): void {
    this.clearIdleEviction(room);
    room.idleEvictTimer = setTimeout(() => {
      if (room.sockets.size === 0) {
        this.evict(room.docId).catch((err) =>
          console.error(`[room ${room.docId}] evict failed`, err)
        );
      }
    }, env.NODE_ENV === "test" ? 200 : 10 * 60 * 1000);
  }

  private clearIdleEviction(room: Room): void {
    if (room.idleEvictTimer) {
      clearTimeout(room.idleEvictTimer);
      room.idleEvictTimer = null;
    }
  }

  async evict(docId: string): Promise<void> {
    const room = this.rooms.get(docId);
    if (!room) return;
    await this.persistNow(room);
    if (room.persistTimer) clearTimeout(room.persistTimer);
    if (room.maxPersistTimer) clearTimeout(room.maxPersistTimer);
    if (room.checkpointTimer) clearTimeout(room.checkpointTimer);
    this.clearIdleEviction(room);
    redisBus.offRoom(docId);
    // Awareness runs its own internal cleanup interval (sweeping stale
    // clients); leaving it running after eviction would keep firing
    // against a room/doc that's gone, so it must be torn down explicitly.
    room.awareness.destroy();
    room.doc.destroy();
    this.rooms.delete(docId);
  }

  activeRoomCount(): number {
    return this.rooms.size;
  }
}

export const roomManager = new RoomManager();
