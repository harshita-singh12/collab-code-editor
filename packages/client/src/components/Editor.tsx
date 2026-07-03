import React, { useEffect, useRef } from "react";
import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import type * as MonacoNS from "monaco-editor";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import type { Awareness } from "y-protocols/awareness";
import type { EffectiveRole } from "@collab/shared";

interface EditorProps {
  doc: Y.Doc;
  awareness: Awareness;
  undoManager: Y.UndoManager;
  language: string;
  role: EffectiveRole;
}

/**
 * Thin wrapper around Monaco that hands the actual text model over to
 * `y-monaco`'s MonacoBinding -- an existing, well-tested library that
 * keeps a Monaco `ITextModel` and a `Y.Text` in sync bidirectionally and
 * renders remote collaborators' cursors/selections from `awareness`. We
 * intentionally do not hand-roll this binding (translating Monaco's
 * `onDidChangeModelContent` deltas into Y.Text ops correctly, including
 * multi-cursor edits and IME composition, is exactly the kind of thing
 * that's easy to get subtly wrong).
 */
export function Editor({ doc, awareness, undoManager, language, role }: EditorProps) {
  const bindingRef = useRef<MonacoBinding | null>(null);
  const editorRef = useRef<MonacoNS.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    return () => {
      bindingRef.current?.destroy();
      bindingRef.current = null;
    };
  }, [doc]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    const model = editor.getModel();
    if (!model) return;

    const ytext = doc.getText("content");
    bindingRef.current?.destroy();
    bindingRef.current = new MonacoBinding(
      ytext,
      model,
      new Set([editor]),
      awareness
    );

    // Route undo/redo through the CRDT's UndoManager (scoped to local-origin
    // transactions only) instead of Monaco's own undo stack, so Ctrl+Z never
    // undoes a remote collaborator's concurrent edit. See DESIGN.md "Undo/redo".
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () => {
      undoManager.undo();
    });
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
      () => undoManager.redo()
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => {
      undoManager.redo();
    });
  };

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: role === "viewer" });
  }, [role]);

  return (
    <MonacoEditor
      height="100%"
      language={language}
      theme="vs-dark"
      onMount={handleMount}
      options={{
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: 14,
        readOnly: role === "viewer",
        wordWrap: "on",
      }}
    />
  );
}
