import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { AuthResponse, UserDTO } from "@collab/shared";
import { api, setAuthToken } from "../api/client";

const STORAGE_TOKEN = "collab.token";
const STORAGE_USER = "collab.user";

interface AuthContextValue {
  user: UserDTO | null;
  token: string | null;
  ready: boolean;
  signup: (email: string, password: string, displayName: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

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

  const persist = useCallback((response: AuthResponse) => {
    setToken(response.token);
    setUser(response.user);
    setAuthToken(response.token);
    localStorage.setItem(STORAGE_TOKEN, response.token);
    localStorage.setItem(STORAGE_USER, JSON.stringify(response.user));
  }, []);

  const signup = useCallback(
    async (email: string, password: string, displayName: string) => {
      const response = await api.signup({ email, password, displayName });
      persist(response);
    },
    [persist]
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const response = await api.login({ email, password });
      persist(response);
    },
    [persist]
  );

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setAuthToken(null);
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_USER);
  }, []);

  const value = useMemo(
    () => ({ user, token, ready, signup, login, logout }),
    [user, token, ready, signup, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
