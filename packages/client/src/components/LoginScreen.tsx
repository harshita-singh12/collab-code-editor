import React, { useState } from "react";
import { useAuth } from "../hooks/useAuth";

export function LoginScreen() {
  const { login } = useAuth();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await login(name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Collab Code Editor</h1>
        <p className="subtle">
          Pick a display name to identify you to collaborators. No password
          needed -- this is a lightweight identity tied to this browser (see
          DESIGN.md "Authentication").
        </p>
        <input
          autoFocus
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
        />
        {error && <div className="error-text">{error}</div>}
        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? "Signing in..." : "Continue"}
        </button>
      </form>
    </div>
  );
}
