import React, { useState } from "react";
import { useAuth } from "../hooks/useAuth";

type Mode = "login" | "signup";

export function LoginScreen() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;
    if (mode === "signup" && !displayName.trim()) return;

    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        await signup(email.trim(), password, displayName.trim());
      } else {
        await login(email.trim(), password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "authentication failed");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  return (
    <div className="centered-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Collab Code Editor</h1>
        <p className="subtle">
          {mode === "login"
            ? "Sign in with your email and password."
            : "Create an account with an email and password."}
        </p>

        <label className="field">
          <span>Email</span>
          <input
            autoFocus
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={200}
            autoComplete="email"
          />
        </label>

        {mode === "signup" && (
          <label className="field">
            <span>Display name</span>
            <input
              placeholder="Shown to collaborators"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={60}
            />
          </label>
        )}

        <label className="field">
          <span>Password</span>
          <input
            type="password"
            placeholder={mode === "signup" ? "At least 8 characters" : "Password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === "signup" ? 8 : undefined}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        </label>

        {error && <div className="error-text">{error}</div>}

        <button
          type="submit"
          disabled={
            busy || !email.trim() || !password || (mode === "signup" && !displayName.trim())
          }
        >
          {busy ? "Please wait..." : mode === "login" ? "Sign in" : "Create account"}
        </button>

        <p className="subtle login-switch">
          {mode === "login" ? (
            <>
              Don't have an account?{" "}
              <button type="button" className="link-button" onClick={() => switchMode("signup")}>
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button type="button" className="link-button" onClick={() => switchMode("login")}>
                Sign in
              </button>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
