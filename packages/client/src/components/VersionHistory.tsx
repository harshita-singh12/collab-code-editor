import React, { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { VersionSummaryDTO } from "@collab/shared";
import { api } from "../api/client";

export function VersionHistory({
  docId,
  language,
  canRestore,
  onClose,
  onRestored,
}: {
  docId: string;
  language: string;
  canRestore: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<VersionSummaryDTO[] | null>(null);
  const [selected, setSelected] = useState<VersionSummaryDTO | null>(null);
  const [diff, setDiff] = useState<{ fromText: string; toText: string } | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setVersions(await api.listVersions(docId));
  }

  useEffect(() => {
    refresh();
  }, [docId]);

  async function selectVersion(v: VersionSummaryDTO) {
    setSelected(v);
    const d = await api.diffVersionWithCurrent(docId, v.id);
    setDiff(d);
  }

  async function handleSaveCheckpoint() {
    setBusy(true);
    try {
      await api.saveVersion(docId, label.trim() || null);
      setLabel("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    if (!selected) return;
    if (!confirm(`Restore to version #${selected.seq}? This creates a new edit merging into the live document.`))
      return;
    setBusy(true);
    try {
      await api.restoreVersion(docId, selected.id);
      onRestored();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Version history</h2>

        {canRestore && (
          <div className="checkpoint-row">
            <input
              placeholder="Optional label for a manual checkpoint"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={120}
            />
            <button disabled={busy} onClick={handleSaveCheckpoint}>
              Save checkpoint now
            </button>
          </div>
        )}

        <div className="version-history-body">
          <ul className="version-list">
            {versions?.map((v) => (
              <li
                key={v.id}
                className={selected?.id === v.id ? "selected" : ""}
                onClick={() => selectVersion(v)}
              >
                <div className="version-seq">#{v.seq}</div>
                <div>
                  <div>{v.label ?? "Autosave checkpoint"}</div>
                  <div className="subtle">
                    {new Date(v.createdAt).toLocaleString()} - {v.createdByName ?? "system"} - {(v.sizeBytes / 1024).toFixed(1)} KB
                  </div>
                </div>
              </li>
            ))}
            {versions && versions.length === 0 && (
              <li className="subtle">No checkpoints yet. Edits are periodically checkpointed automatically.</li>
            )}
          </ul>

          <div className="diff-panel">
            {diff ? (
              <DiffEditor
                height="100%"
                language={language}
                original={diff.fromText}
                modified={diff.toText}
                theme="vs-dark"
                options={{ readOnly: true, renderSideBySide: true }}
              />
            ) : (
              <div className="subtle diff-placeholder">Select a version to compare against the current document.</div>
            )}
          </div>
        </div>

        <div className="modal-actions">
          {canRestore && selected && (
            <button disabled={busy} onClick={handleRestore}>
              Restore this version
            </button>
          )}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
