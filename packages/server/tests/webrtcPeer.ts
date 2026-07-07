/**
 * Runs as a standalone child process representing one collaborator's
 * browser tab for `webrtc-convergence-demo.ts`. `y-webrtc` keeps a
 * process-wide room registry keyed by room name (it's designed around
 * "one browser tab == one peer identity"), so two independent
 * `WebrtcProvider`s can't join the same room from inside one process --
 * exactly like two real collaborators are always two separate browser
 * processes. This script is spawned twice (once as "alice", once as
 * "bob") to mirror that.
 *
 * Usage: tsx webrtcPeer.ts <alice|bob> <signalingUrl> <roomName>
 * Prints a `RESULT:<json>` line on success and exits 0, or exits 1 on
 * failure/timeout.
 */
import WebSocket from "ws";

// Same polyfill rationale as webrtc-convergence-demo.ts: y-webrtc's
// signaling client expects a browser-global WebSocket.
(globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;

import * as Y from "yjs";
import { WebrtcProvider } from "y-webrtc";
import { nodeWrtc } from "./nodeWrtcShim";

const [, , role, signalingUrl, roomName] = process.argv;
if (role !== "alice" && role !== "bob") {
  console.error(`usage: tsx webrtcPeer.ts <alice|bob> <signalingUrl> <roomName>`);
  process.exit(1);
}

const myLine =
  role === "alice"
    ? "// hello from alice, sent directly over WebRTC\n"
    : "function fromBob() { /* also sent directly, no server relay */ }\n";
const otherMarker = role === "alice" ? "fromBob" : "hello from alice";

async function waitUntil(check: () => boolean, timeoutMs: number, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  const doc = new Y.Doc();
  let peerCount = 0;

  const provider = new WebrtcProvider(roomName, doc, {
    signaling: [signalingUrl],
    maxConns: 5,
    peerOpts: { wrtc: nodeWrtc },
  });
  provider.on("peers", ({ webrtcPeers }: { webrtcPeers: string[] }) => {
    peerCount = webrtcPeers.length;
  });

  console.log(`[${role}] negotiating a direct WebRTC connection via signaling...`);
  await waitUntil(() => peerCount > 0, 25000);
  console.log(`[${role}] connected directly to a peer over WebRTC (no Socket.io involved)`);

  doc.getText("content").insert(0, myLine);

  await waitUntil(() => doc.getText("content").toString().includes(otherMarker), 15000);
  const finalText = doc.getText("content").toString();
  console.log(`[${role}] final text: ${JSON.stringify(finalText)}`);
  console.log(`RESULT:${JSON.stringify({ role, text: finalText })}`);

  provider.destroy();
  doc.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(`[${role}] failed`, err);
  process.exit(1);
});
