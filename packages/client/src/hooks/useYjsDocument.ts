import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import type { WebrtcProvider } from "y-webrtc";
import type { EffectiveRole, UserDTO } from "@collab/shared";
import { SocketIOProvider, type ConnectionStatus } from "../yjs/SocketIOProvider";
import { createWebrtcProvider } from "../yjs/webrtcTransport";
import { SERVER_URL } from "../api/client";

export const CONTENT_KEY = "content";

export interface YjsDocumentHandle {
  doc: Y.Doc;
  provider: SocketIOProvider | null;
  undoManager: Y.UndoManager | null;
  status: ConnectionStatus;
  synced: boolean;
  /** True once the local IndexedDB cache has finished its initial load --
   * lets the editor mount pre-populated even before the network catches up. */
  localLoaded: boolean;
  role: EffectiveRole;
  joinError: string | null;
  /** Whether the optional WebRTC peer-to-peer transport is currently
   * switched on for this tab. */
  webrtcEnabled: boolean;
  /** Number of directly-connected WebRTC peers (0 if disabled or no peer
   * has been discoverable via signaling yet). */
  webrtcPeerCount: number;
  toggleWebrtc: () => void;
}

/**
 * Wires together the pieces that make a document collaborative:
 *  - a Y.Doc (the CRDT-backed source of truth for this tab)
 *  - y-indexeddb, so local edits survive offline / a closed tab and queue
 *    for reconnect automatically (the Y.Doc itself is the offline queue --
 *    there is no separate outbox to build)
 *  - our SocketIOProvider, the always-on network transport (persistence +
 *    access control), plus an optional WebRTC transport for direct
 *    peer-to-peer sync (see `toggleWebrtc` below and `webrtcTransport.ts`)
 *
 * One instance of this hook == one open document in one browser tab.
 */
export function useYjsDocument(docId: string | undefined, token: string | null, user: UserDTO | null): YjsDocumentHandle {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [synced, setSynced] = useState(false);
  const [localLoaded, setLocalLoaded] = useState(false);
  const [role, setRole] = useState<EffectiveRole>("none");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [handleVersion, setHandleVersion] = useState(0);
  const [webrtcEnabled, setWebrtcEnabled] = useState(false);
  const [webrtcPeerCount, setWebrtcPeerCount] = useState(0);

  const docRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<SocketIOProvider | null>(null);
  const undoManagerRef = useRef<Y.UndoManager | null>(null);
  const idbRef = useRef<IndexeddbPersistence | null>(null);
  const webrtcRef = useRef<WebrtcProvider | null>(null);

  useEffect(() => {
    if (!docId || !token || !user) return;

    setStatus("connecting");
    setSynced(false);
    setLocalLoaded(false);
    setRole("none");
    setJoinError(null);
    setWebrtcEnabled(false);
    setWebrtcPeerCount(0);

    const doc = new Y.Doc();
    const ytext = doc.getText(CONTENT_KEY);
    const undoManager = new Y.UndoManager(ytext, { trackedOrigins: new Set([undefined]) });

    const idb = new IndexeddbPersistence(`collab-doc-${docId}`, doc);
    idb.whenSynced.then(() => setLocalLoaded(true));

    const provider = new SocketIOProvider(SERVER_URL, docId, doc, token);
    provider.setLocalPresence(
      { name: user.displayName, color: user.color, userId: user.id },
      null
    );
    provider.on("status", ({ status }: { status: ConnectionStatus }) => setStatus(status));
    provider.on("synced", ({ synced }: { synced: boolean }) => setSynced(synced));
    provider.on("role", ({ role }: { role: EffectiveRole }) => setRole(role));
    provider.on("join-error", ({ error }: { error: string }) => setJoinError(error));

    docRef.current = doc;
    providerRef.current = provider;
    undoManagerRef.current = undoManager;
    idbRef.current = idb;
    setHandleVersion((v) => v + 1);

    return () => {
      webrtcRef.current?.destroy();
      webrtcRef.current = null;
      provider.destroy();
      idb.destroy();
      undoManager.destroy();
      doc.destroy();
      docRef.current = null;
      providerRef.current = null;
      undoManagerRef.current = null;
      idbRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, token, user?.id]);

  // WebRTC is intentionally a *separate* effect from the Socket.io setup
  // above: toggling it on/off must not tear down and rejoin the room over
  // Socket.io, it only adds/removes an additional provider bound to the
  // exact same Y.Doc + Awareness instance.
  useEffect(() => {
    const doc = docRef.current;
    const provider = providerRef.current;
    if (!webrtcEnabled || !doc || !provider || !docId || !token) return;

    const webrtc = createWebrtcProvider(docId, doc, provider.awareness, token);
    webrtcRef.current = webrtc;

    const onPeers = ({ webrtcPeers }: { webrtcPeers: string[] }) => {
      setWebrtcPeerCount(webrtcPeers.length);
    };
    webrtc.on("peers", onPeers);

    return () => {
      webrtc.off("peers", onPeers);
      webrtc.destroy();
      if (webrtcRef.current === webrtc) webrtcRef.current = null;
      setWebrtcPeerCount(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webrtcEnabled, handleVersion, docId, token]);

  const toggleWebrtc = useCallback(() => {
    setWebrtcEnabled((v) => !v);
  }, []);

  return {
    doc: docRef.current as Y.Doc,
    provider: providerRef.current,
    undoManager: undoManagerRef.current,
    status,
    synced,
    localLoaded,
    role,
    joinError,
    webrtcEnabled,
    webrtcPeerCount,
    toggleWebrtc,
  };
}
