import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { io, type Socket } from "socket.io-client";
import { SOCKET_EVENTS, type JoinRoomAck, type JoinRoomError } from "@collab/shared";

/**
 * A minimal stand-in for the real browser `SocketIOProvider`
 * (packages/client/src/yjs/SocketIOProvider.ts), reimplemented here
 * against plain `socket.io-client` + `yjs` + `y-protocols/sync` (no DOM,
 * no y-indexeddb) so the server's test suite can drive real network
 * round-trips against a real listening server without pulling in the
 * browser-only client package. The handshake logic is intentionally
 * identical to the real provider's -- this is what "actually run two or
 * more client instances" is exercising end to end (see README.md "How
 * convergence was verified").
 */
export class TestYjsClient {
  readonly doc = new Y.Doc();
  socket: Socket;
  private readonly url: string;
  private readonly docId: string;
  private readonly token: string;

  constructor(url: string, docId: string, token: string) {
    this.url = url;
    this.docId = docId;
    this.token = token;
    this.socket = this.createSocket();
  }

  private createSocket(): Socket {
    const socket = io(this.url, {
      auth: { token: this.token },
      transports: ["websocket"],
      reconnection: false, // tests drive reconnect explicitly
      // socket.io-client caches/reuses one underlying Manager (engine.io
      // connection) per URL by default, which would let unrelated test
      // clients/tests bleed into each other's connection state. Force a
      // fully independent connection per TestYjsClient instance.
      forceNew: true,
    });
    socket.on(SOCKET_EVENTS.DOC_SYNC, (data: ArrayBuffer) => {
      if (process.env.DEBUG_TEST_CLIENT) console.log(`[client ${socket.id}] recv doc-sync bytes=${data.byteLength}`);
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const encoder = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 0) {
        socket.emit(SOCKET_EVENTS.DOC_SYNC, encoding.toUint8Array(encoder));
      }
    });
    socket.on("connect_error", (err) => {
      if (process.env.DEBUG_TEST_CLIENT) console.log(`[client] connect_error`, err.message);
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      if (process.env.DEBUG_TEST_CLIENT) console.log(`[client ${socket.id}] local update, sending`);
      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, update);
      socket.emit(SOCKET_EVENTS.DOC_SYNC, encoding.toUint8Array(encoder));
    });
    return socket;
  }

  /** Connect (or reconnect after connectAndJoin/disconnect) and run the
   * two-way sync handshake to completion. */
  connectAndJoin(): Promise<JoinRoomAck> {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.socket.emit(SOCKET_EVENTS.JOIN_ROOM, { docId: this.docId }, (ack: JoinRoomAck | JoinRoomError) => {
          if (!ack.ok) {
            reject(new Error(ack.error));
            return;
          }
          const encoder = encoding.createEncoder();
          syncProtocol.writeSyncStep1(encoder, this.doc);
          this.socket.emit(SOCKET_EVENTS.DOC_SYNC, encoding.toUint8Array(encoder));
          resolve(ack);
        });
      };
      this.socket.once("connect", onConnect);
      if (this.socket.disconnected) this.socket.connect();
      else onConnect();
    });
  }

  text(): string {
    return this.doc.getText("content").toString();
  }

  insert(pos: number, text: string): void {
    this.doc.getText("content").insert(pos, text);
  }

  delete(pos: number, len: number): void {
    this.doc.getText("content").delete(pos, len);
  }

  /** Simulates a network partition: the socket goes away, but the client
   * keeps editing its local Y.Doc as if nothing happened. */
  disconnectNetwork(): void {
    this.socket.disconnect();
  }

  async reconnectNetwork(): Promise<void> {
    this.socket = this.createSocket();
    await this.connectAndJoin();
  }

  destroy(): void {
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.doc.destroy();
  }
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `check()` returns true or the timeout elapses, for
 * asserting eventual convergence without a fixed sleep. */
export async function waitUntil(check: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition not met before timeout");
    }
    await wait(intervalMs);
  }
}
