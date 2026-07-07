import type {
  AuthResponse,
  CreateDocumentRequest,
  DocumentDetailDTO,
  DocumentSummaryDTO,
  LoginRequest,
  SignupRequest,
  UpdateLinkAccessRequest,
  UpdatePermissionRequest,
  VersionDiffDTO,
  VersionSummaryDTO,
} from "@collab/shared";

export const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4000";

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`${SERVER_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.error ?? message;
    } catch {
      // ignore body parse failure
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  signup: (body: SignupRequest) =>
    request<AuthResponse>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  login: (body: LoginRequest) =>
    request<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listDocuments: () => request<DocumentSummaryDTO[]>("/api/documents"),

  createDocument: (body: CreateDocumentRequest) =>
    request<DocumentSummaryDTO>("/api/documents", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getDocument: (id: string) => request<DocumentDetailDTO>(`/api/documents/${id}`),

  deleteDocument: (id: string) =>
    request<void>(`/api/documents/${id}`, { method: "DELETE" }),

  updateLinkAccess: (id: string, body: UpdateLinkAccessRequest) =>
    request<{ linkAccess: string }>(`/api/documents/${id}/link-access`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  updatePermission: (id: string, body: UpdatePermissionRequest) =>
    request<{ collaborators: DocumentDetailDTO["collaborators"] }>(
      `/api/documents/${id}/permissions`,
      { method: "PUT", body: JSON.stringify(body) }
    ),

  searchUsers: (q: string) =>
    request<Array<{ id: string; displayName: string; color: string }>>(
      `/api/users?q=${encodeURIComponent(q)}`
    ),

  listVersions: (docId: string) =>
    request<VersionSummaryDTO[]>(`/api/documents/${docId}/versions`),

  saveVersion: (docId: string, label: string | null) =>
    request<VersionSummaryDTO>(`/api/documents/${docId}/versions`, {
      method: "POST",
      body: JSON.stringify({ label }),
    }),

  getVersionDiff: (docId: string, versionId: string) =>
    request<VersionDiffDTO>(`/api/documents/${docId}/versions/${versionId}`),

  restoreVersion: (docId: string, versionId: string) =>
    request<{ ok: boolean }>(`/api/documents/${docId}/versions/${versionId}/restore`, {
      method: "POST",
    }),

  diffVersionWithCurrent: (docId: string, versionId: string) =>
    request<{ fromText: string; toText: string }>(
      `/api/documents/${docId}/versions/${versionId}/diff-with-current`
    ),
};
