/**
 * Standalone, narrated convergence demo for the WebRTC transport: boots a
 * real server (Express + Socket.io + our self-hosted WebRTC signaling
 * endpoint, see `src/webrtc/signalingServer.ts`), then spawns two
 * completely separate child processes ("alice" and "bob",
 * `webrtcPeer.ts`), each running a real `y-webrtc` `WebrtcProvider` --
 * the same client code path used by
 * `packages/client/src/yjs/webrtcTransport.ts` -- with its own
 * independent `Y.Doc` and no `SocketIOProvider` involved at all. Two
 * separate processes because `y-webrtc` keeps a process-wide room
 * registry keyed by room name (it assumes "one process == one peer
 * identity", same as one browser tab), so this mirrors two real
 * collaborators in two real browser tabs more faithfully than two
 * providers in one process could.
 *
 * If the two child processes' documents converge, it can only be because
 * a real WebRTC data channel was negotiated through our signaling server
 * and used to exchange Yjs updates peer-to-peer.
 *
 * Real `RTCPeerConnection`s need a WebRTC implementation; in a browser
 * that's built in, but these child processes run in plain Node, so they
 * supply one via `node-datachannel`'s polyfill (see `nodeWrtcShim.ts` for
 * a small `simple-peer` compatibility shim on top of it) and polyfill the
 * global `WebSocket` used for signaling with the `ws` package.
 *
 * Run with:
 *   npm run webrtc-convergence-demo --workspace=packages/server
 * (requires DATABASE_URL/REDIS_URL reachable, same as convergence-demo.ts
 * -- only used here to create the account that authorizes the signaling
 * connection, not for the WebRTC sync itself, which never touches Postgres).
 */
import type { AddressInfo } from "net";
import { spawn } from "child_process";
import path from "path";
import { createApp } from "../src/app";
import { migrate } from "../src/db/migrate";
import { createTestUser } from "./testUsers";
import { signToken } from "../src/auth/jwt";
import { redisBus } from "../src/redis/pubsub";
import { roomManager } from "../src/rooms/roomManager";
import { pool } from "../src/db/pool";

function log(...args: unknown[]) {
  console.log(...args);
}

interface PeerResult {
  role: "alice" | "bob";
  text: string;
}

function runPeer(role: "alice" | "bob", signalingUrl: string, roomName: string): Promise<PeerResult> {
  return new Promise((resolve, reject) => {
    const tsxCli = require.resolve("tsx/cli");
    const child = spawn(process.execPath, [tsxCli, "tests/webrtcPeer.ts", role, signalingUrl, roomName], {
      cwd: path.join(__dirname, ".."),
      env: process.env,
    });

    let result: PeerResult | null = null;
    let stderrOutput = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line) continue;
        if (line.startsWith("RESULT:")) {
          result = JSON.parse(line.slice("RESULT:".length));
        } else {
          log(`  ${line}`);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrOutput += chunk;
    });

    child.on("exit", (code) => {
      if (code === 0 && result) {
        resolve(result);
      } else {
        reject(new Error(`${role} peer process exited with code ${code}\n${stderrOutput}`));
      }
    });
    child.on("error", reject);
  });
}

async function main() {
  await migrate();

  const { httpServer } = createApp();
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;
  log(`[webrtc-demo] server + self-hosted WebRTC signaling listening on ws://localhost:${port}/webrtc-signaling\n`);

  const owner = await createTestUser(`webrtc-demo-${Date.now()}`, "Demo Owner");
  const token = signToken({ sub: owner.id, displayName: "Demo Owner" });
  const signalingUrl = `ws://localhost:${port}/webrtc-signaling?token=${encodeURIComponent(token)}`;
  const roomName = `webrtc-demo-room-${Date.now()}`;

  log("[webrtc-demo] spawning two independent peer processes (alice, bob), each with its own Y.Doc and its own WebrtcProvider -- no Socket.io involved:\n");

  const [alice, bob] = await Promise.all([
    runPeer("alice", signalingUrl, roomName),
    runPeer("bob", signalingUrl, roomName),
  ]);

  log(`\n[webrtc-demo] alice final doc: ${JSON.stringify(alice.text)}`);
  log(`[webrtc-demo] bob final doc:   ${JSON.stringify(bob.text)}`);
  const converged = alice.text === bob.text && alice.text.length > 0;
  log(`\n[webrtc-demo] CONVERGED OVER REAL WEBRTC (no Socket.io involved): ${converged}`);
  if (!converged) {
    throw new Error("documents did not converge over WebRTC");
  }

  await roomManager.flushAll();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await redisBus.close();
  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[webrtc-demo] failed", err);
    process.exit(1);
  });
