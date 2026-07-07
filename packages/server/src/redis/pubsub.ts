import Redis from "ioredis";
import { EventEmitter } from "events";
import { env } from "../util/env";

const SYNC_PREFIX = "room-sync:";
const AWARENESS_PREFIX = "room-awareness:";

/**
 * Thin wrapper around a plain ioredis pub/sub pair (one connection for
 * publishing, one dedicated to subscribing -- ioredis requires a separate
 * connection once a client enters subscribe mode). This is the mechanism
 * that lets multiple server instances fan out both document updates and
 * presence to each other. Deliberately hand-rolled here instead of using
 * @socket.io/redis-adapter: the adapter only solves client-facing Socket.io
 * room fan-out across instances, but each instance still needs its own
 * authoritative Y.Doc replica (used for persistence and for late-joining
 * clients) kept up to date, which requires this pub/sub loop regardless --
 * running both would be two overlapping broadcast systems.
 *
 * Binary Yjs update bytes are sent as Redis message payloads directly
 * (ioredis supports Buffer messages when using `publish`/`on("messageBuffer")`).
 */
class RedisBus extends EventEmitter {
  private pub: Redis;
  private sub: Redis;
  private ready: Promise<void>;

  constructor() {
    super();
    this.pub = new Redis(env.REDIS_URL);
    this.sub = new Redis(env.REDIS_URL);
    this.ready = Promise.all([
      new Promise<void>((resolve) => this.pub.once("ready", () => resolve())),
      new Promise<void>((resolve) => this.sub.once("ready", () => resolve())),
    ]).then(() => undefined);

    this.sub.psubscribe(`${SYNC_PREFIX}*`, `${AWARENESS_PREFIX}*`);
    this.sub.on("pmessageBuffer", (_pattern, channelBuf: Buffer, message: Buffer) => {
      const channel = channelBuf.toString();
      if (channel.startsWith(SYNC_PREFIX)) {
        const roomId = channel.slice(SYNC_PREFIX.length);
        this.emit(`sync:${roomId}`, message);
      } else if (channel.startsWith(AWARENESS_PREFIX)) {
        const roomId = channel.slice(AWARENESS_PREFIX.length);
        this.emit(`awareness:${roomId}`, message);
      }
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.ready;
  }

  publishSync(roomId: string, update: Uint8Array): void {
    this.pub.publish(`${SYNC_PREFIX}${roomId}`, Buffer.from(update));
  }

  publishAwareness(roomId: string, update: Uint8Array): void {
    this.pub.publish(`${AWARENESS_PREFIX}${roomId}`, Buffer.from(update));
  }

  onSync(roomId: string, handler: (update: Buffer) => void): void {
    this.on(`sync:${roomId}`, handler);
  }

  onAwareness(roomId: string, handler: (update: Buffer) => void): void {
    this.on(`awareness:${roomId}`, handler);
  }

  offRoom(roomId: string): void {
    this.removeAllListeners(`sync:${roomId}`);
    this.removeAllListeners(`awareness:${roomId}`);
  }

  async close(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}

export const redisBus = new RedisBus();
