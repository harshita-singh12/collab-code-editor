import React, { useState } from "react";
import type { DocumentDetailDTO, LinkAccess } from "@collab/shared";
import { api } from "../api/client";

export function ShareDialog({
  doc,
  onClose,
  onChanged,
}: {
  doc: DocumentDetailDTO;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [linkAccess, setLinkAccess] = useState<LinkAccess>(doc.linkAccess);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; displayName: string; color: string }>>([]);
  const [busy, setBusy] = useState(false);
  const shareUrl = `${window.location.origin}/doc/${doc.id}`;

  async function handleLinkAccessChange(next: LinkAccess) {
    setLinkAccess(next);
    await api.updateLinkAccess(doc.id, { linkAccess: next });
    onChanged();
  }

  async function handleSearch(q: string) {
    setQuery(q);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setResults(await api.searchUsers(q.trim()));
  }

  async function grant(userId: string, role: "editor" | "viewer") {
    setBusy(true);
    try {
      await api.updatePermission(doc.id, { userId, role });
      onChanged();
      setQuery("");
      setResults([]);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(userId: string) {
    setBusy(true);
    try {
      await api.updatePermission(doc.id, { userId, role: "none" });
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Share "{doc.title}"</h2>

        <label className="field">
          <span>Share link</span>
          <div className="copy-row">
            <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
            <button onClick={() => navigator.clipboard.writeText(shareUrl)}>Copy</button>
          </div>
        </label>

        <label className="field">
          <span>Anyone with the link can</span>
          <select
            value={linkAccess}
            onChange={(e) => handleLinkAccessChange(e.target.value as LinkAccess)}
          >
            <option value="none">Not access it (invite only)</option>
            <option value="viewer">View</option>
            <option value="editor">Edit</option>
          </select>
        </label>

        <div className="field">
          <span>People with access</span>
          <div className="collaborator-list">
            <div className="collaborator-row">
              <span className="user-chip" style={{ background: "#888" }}>
                {doc.ownerName}
              </span>
              <span className="role-pill role-owner">owner</span>
            </div>
            {doc.collaborators.map((c) => (
              <div key={c.userId} className="collaborator-row">
                <span className="user-chip" style={{ background: c.color }}>
                  {c.displayName}
                </span>
                <select
                  value={c.role}
                  disabled={busy}
                  onChange={(e) => grant(c.userId, e.target.value as "editor" | "viewer")}
                >
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                </select>
                <button className="link-button danger" disabled={busy} onClick={() => revoke(c.userId)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>

        <label className="field">
          <span>Add a specific person</span>
          <input
            placeholder="Search by display name"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
          />
          {results.length > 0 && (
            <div className="search-results">
              {results.map((u) => (
                <div key={u.id} className="search-result-row">
                  <span className="user-chip" style={{ background: u.color }}>
                    {u.displayName}
                  </span>
                  <button disabled={busy} onClick={() => grant(u.id, "viewer")}>
                    + Viewer
                  </button>
                  <button disabled={busy} onClick={() => grant(u.id, "editor")}>
                    + Editor
                  </button>
                </div>
              ))}
            </div>
          )}
        </label>

        <div className="modal-actions">
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
