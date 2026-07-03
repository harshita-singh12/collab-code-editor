import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DocumentSummaryDTO } from "@collab/shared";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";

const LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "markdown",
  "json",
];

export function HomePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [docs, setDocs] = useState<DocumentSummaryDTO[] | null>(null);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("javascript");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setDocs(await api.listDocuments());
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load documents");
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      const doc = await api.createDocument({ title: title || "Untitled", language });
      setTitle("");
      navigate(`/doc/${doc.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create document");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this document for everyone? This cannot be undone.")) return;
    await api.deleteDocument(id);
    refresh();
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1>Collab Code Editor</h1>
        <div className="topbar-right">
          <span className="user-chip" style={{ background: user?.color }}>
            {user?.displayName}
          </span>
          <button className="link-button" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="page-body">
        <form className="create-doc-form" onSubmit={handleCreate}>
          <input
            placeholder="New document title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button type="submit">Create document</button>
        </form>

        {error && <div className="error-text">{error}</div>}

        <table className="doc-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Owner</th>
              <th>Role</th>
              <th>Language</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {docs?.map((doc) => (
              <tr key={doc.id} onClick={() => navigate(`/doc/${doc.id}`)}>
                <td>{doc.title}</td>
                <td>{doc.ownerName}</td>
                <td>
                  <span className={`role-pill role-${doc.role}`}>{doc.role}</span>
                </td>
                <td>{doc.language}</td>
                <td>{new Date(doc.updatedAt).toLocaleString()}</td>
                <td>
                  {doc.role === "owner" && (
                    <button
                      className="link-button danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(doc.id);
                      }}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {docs && docs.length === 0 && (
              <tr>
                <td colSpan={6} className="subtle">
                  No documents yet -- create one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </main>
    </div>
  );
}
