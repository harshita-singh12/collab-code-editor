import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { UserDTO } from "@collab/shared";
import { api, setAuthToken } from "../api/client";

const STORAGE_CLIENT_ID = "collab.clientId";
const STORAGE_TOKEN = "collab.token";
const STORAGE_USER = "collab.user";

interface AuthContextValue {
  user: UserDTO | null;
  token: string | null;
  ready: boolean;
  login: (displayName: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function getOrCreateClientId(): string {
  let id = localStorage.getItem(STORAGE_CLIENT_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(STORAGE_CLIENT_ID, id);
  }
  return id;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserDTO | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const storedToken = localStorage.getItem(STORAGE_TOKEN);
    const storedUser = localStorage.getItem(STORAGE_USER);
    if (storedToken && storedUser) {
      setToken(storedToken);
      setAuthToken(storedToken);
      setUser(JSON.parse(storedUser));
    }
    setReady(true);
  }, []);

  const login = useCallback(async (displayName: string) => {
    const clientId = getOrCreateClientId();
    const response = await api.createSession({ displayName, clientId });
    setToken(response.token);
    setUser(response.user);
    setAuthToken(response.token);
    localStorage.setItem(STORAGE_TOKEN, response.token);
    localStorage.setItem(STORAGE_USER, JSON.stringify(response.user));
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setAuthToken(null);
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_USER);
  }, []);

  const value = useMemo(
    () => ({ user, token, ready, login, logout }),
    [user, token, ready, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
