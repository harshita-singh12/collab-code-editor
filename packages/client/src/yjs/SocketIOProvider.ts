import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { Observable } from "lib0/observable";
import * as syncProtocol from "y-protocols/sync";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { io, type Socket } from "socket.io-client";
import { SOCKET_EVENTS, type EffectiveRole, type JoinRoomAck, type JoinRoomError } from "@collab/shared";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/**
 * Custom Yjs provider transported over Socket.io. Structurally this is the
 * same handshake `y-websocket` implements (writeSyncStep1 on connect, then
 * peer-symmetric readSyncMessage for everything after), just carried over
 * Socket.io events instead of a raw `ws` socket, and joined to a specific
 * document "room" with a server-authorized role. See DESIGN.md "Transport
 * protocol" for the full write-up of why we hand-roll this thin transport
 * layer but reuse Yjs's own protocol encoders (`y-protocols/sync`,
 * `y-protocols/awareness`) rather than reinventing the wire format.
 */
export class SocketIOProvider extends Observable<string> {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly docId: string;
  private socket: Socket;
  private token: string;
  private _synced = false;
  private _status: ConnectionStatus = "connecting";
  private _role: EffectiveRole = "none";

  constructor(serverUrl: string, docId: string, doc: Y.Doc, token: string) {
    super();
    this.doc = doc;
    this.docId = docId;
    this.token = token;
    this.awareness = new Awareness(doc);

    this.socket = io(serverUrl, {
      auth: { token: this.token },
      transports: ["websocket", "polling"],
    });

    this.socket.on("connect", () => this.onSocketConnect());
    this.socket.on("disconnect", () => this.onSocketDisconnect());
    this.socket.on(SOCKET_EVENTS.DOC_SYNC, (data: ArrayBuffer) => this.onSyncMessage(data));
    this.socket.on(SOCKET_EVENTS.DOC_AWARENESS, (data: ArrayBuffer) =>
      this.onAwarenessMessage(data)
    );

    this.doc.on("update", this.onLocalDocUpdate);
    this.awareness.on("update", this.onLocalAwarenessUpdate);

    window.addEventListener("beforeunload", this.onBeforeUnload);
  }

  get synced(): boolean {
    return this._synced;
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get role(): EffectiveRole {
    return this._role;
  }

  private setStatus(status: ConnectionStatus) {
    this._status = status;
    this.emit("status", [{ status }]);
  }

  private setSynced(synced: boolean) {
    if (this._synced === synced) return;
    this._synced = synced;
    this.emit("synced", [{ synced }]);
  }

  private onSocketConnect() {
    this.setStatus("connected");
    this.socket.emit(
      SOCKET_EVENTS.JOIN_ROOM,
      { docId: this.docId },
      (ack: JoinRoomAck | JoinRoomError) => {
        if (!ack.ok) {
          this.emit("join-error", [{ error: ack.error }]);
          return;
        }
        this._role = ack.role;
        this.emit("role", [{ role: ack.role }]);

        // Kick off our half of the handshake: tell the server our state
        // vector so it can send back whatever we're missing.
        const encoder = encoding.createEncoder();
        syncProtocol.writeSyncStep1(encoder, this.doc);
        this.socket.emit(SOCKET_EVENTS.DOC_SYNC, encoding.toUint8Array(encoder));

        // Publish our current cursor/presence (if any was set before connecting).
        const localState = this.awareness.getLocalState();
        if (localState !== null) {
          const update = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
          this.socket.emit(SOCKET_EVENTS.DOC_AWARENESS, update);
        }

        this.setSynced(true);
      }
    );
  }

  private onSocketDisconnect() {
    this.setStatus("disconnected");
    this.setSynced(false);
    removeAwarenessStates(
      this.awareness,
      Array.from(this.awareness.getStates().keys()).filter((id) => id === this.doc.clientID),
      "socket disconnect"
    );
  }

  private onSyncMessage(data: ArrayBuffer) {
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const encoder = encoding.createEncoder();
    syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
    if (encoding.length(encoder) > 0) {
      this.socket.emit(SOCKET_EVENTS.DOC_SYNC, encoding.toUint8Array(encoder));
    }
  }

  private onAwarenessMessage(data: ArrayBuffer) {
    applyAwarenessUpdate(this.awareness, new Uint8Array(data), this);
  }

  private onLocalDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return; // don't echo back updates we just applied from the network
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    this.socket.emit(SOCKET_EVENTS.DOC_SYNC, encoding.toUint8Array(encoder));
  };

  private onLocalAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (origin === this) return;
    const changed = added.concat(updated).concat(removed);
    const update = encodeAwarenessUpdate(this.awareness, changed);
    this.socket.emit(SOCKET_EVENTS.DOC_AWARENESS, update);
  };

  private onBeforeUnload = () => {
    removeAwarenessStates(this.awareness, [this.doc.clientID], "window unload");
  };

  setLocalPresence(user: { name: string; color: string; userId: string }, cursor: unknown) {
    this.awareness.setLocalState({ user, cursor });
  }

  destroy() {
    removeAwarenessStates(this.awareness, [this.doc.clientID], "provider destroyed");
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    this.doc.off("update", this.onLocalDocUpdate);
    this.awareness.off("update", this.onLocalAwarenessUpdate);
    this.socket.disconnect();
    this.awareness.destroy();
    super.destroy();
  }
}
