import * as ndc from "node-datachannel/polyfill";

/**
 * `simple-peer` (used internally by y-webrtc's `WebrtcProvider`) mutates
 * `offer.sdp` / `answer.sdp` in place after `createOffer()`/
 * `createAnswer()` resolve (see simple-peer's `_createOffer`/
 * `_createAnswer`). `node-datachannel`'s `RTCSessionDescription` polyfill
 * exposes `sdp` as a getter-only property (matching how real browsers
 * behave, where `RTCSessionDescription` is also immutable), so that
 * in-place mutation throws outside a real browser.
 *
 * This subclass just returns a plain, mutable `{ type, sdp }` object from
 * `createOffer`/`createAnswer` instead of a real `RTCSessionDescription`
 * instance -- that's a valid `RTCSessionDescriptionInit`, and
 * `setLocalDescription`/`setRemoteDescription` both accept it, so nothing
 * downstream needs to change. This sidesteps the incompatibility without
 * patching either upstream library.
 *
 * Only used by the Node-side WebRTC convergence demo below, so the actual
 * client-facing WebRTC code path (`packages/client/src/yjs/webrtcTransport.ts`)
 * can be exercised end-to-end without a real browser. Real browsers use
 * their native, built-in `RTCPeerConnection` and never load this file.
 */
class NodeWrtcPeerConnection extends ndc.RTCPeerConnection {
  async createOffer(options?: unknown): Promise<{ type: string; sdp: string }> {
    const desc = await super.createOffer(options as never);
    return { type: desc.type, sdp: desc.sdp };
  }

  async createAnswer(options?: unknown): Promise<{ type: string; sdp: string }> {
    const desc = await super.createAnswer(options as never);
    return { type: desc.type, sdp: desc.sdp };
  }
}

export const nodeWrtc = {
  ...ndc,
  RTCPeerConnection: NodeWrtcPeerConnection,
};
