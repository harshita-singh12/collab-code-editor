import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { DocumentDetailDTO } from "@collab/shared";
import { canManageAccess } from "@collab/shared";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import { useYjsDocument } from "../hooks/useYjsDocument";
import { Editor } from "../components/Editor";
import { PresenceBar } from "../components/PresenceBar";
import { StatusBadge } from "../components/StatusBadge";
import { ShareDialog } from "../components/ShareDialog";
import { VersionHistory } from "../components/VersionHistory";

export function EditorPage() {
  const { docId } = useParams<{ docId: string }>();
  const { user, token } = useAuth();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<DocumentDetailDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const handle = useYjsDocument(docId, token, user);

  async function refreshDetail() {
    if (!docId) return;
    try {
      setDetail(await api.getDocument(docId));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "failed to load document");
    }
  }

  useEffect(() => {
    refreshDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  if (loadError) {
    return (
      <div className="centered-screen">
        <p className="error-text">{loadError}</p>
        <button onClick={() => navigate("/")}>Back home</button>
      </div>
    );
  }

  if (handle.joinError) {
    return (
      <div className="centered-screen">
        <p className="error-text">{handle.joinError}</p>
        <button onClick={() => navigate("/")}>Back home</button>
      </div>
    );
  }

  if (!detail || !handle.provider) {
    return <div className="centered-screen">Loading...</div>;
  }

  return (
    <div className="editor-page">
      <header className="topbar">
        <button className="link-button" onClick={() => navigate("/")}>
          Back
        </button>
        <h1>{detail.title}</h1>
        <StatusBadge status={handle.status} synced={handle.synced} />
        <div className="topbar-right">
          <PresenceBar awareness={handle.provider.awareness} selfClientId={handle.doc?.clientID ?? null} />
          <button onClick={() => setShowHistory(true)}>History</button>
          {canManageAccess(handle.role) && (
            <button onClick={() => setShowShare(true)}>Share</button>
          )}
          <span className={`role-pill role-${handle.role}`}>{handle.role}</span>
        </div>
      </header>

      <main className="editor-body">
        <Editor
          doc={handle.doc}
          awareness={handle.provider.awareness}
          undoManager={handle.undoManager!}
          language={detail.language}
          role={handle.role}
        />
      </main>

      {showShare && (
        <ShareDialog doc={detail} onClose={() => setShowShare(false)} onChanged={refreshDetail} />
      )}
      {showHistory && (
        <VersionHistory
          docId={detail.id}
          language={detail.language}
          canRestore={handle.role === "owner" || handle.role === "editor"}
          onClose={() => setShowHistory(false)}
          onRestored={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}
