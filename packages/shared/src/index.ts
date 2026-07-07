/**
 * Types shared between the server and client packages. Kept dependency-free
 * (pure TypeScript) so both sides compile against exactly the same contract
 * for the REST API and the Socket.io wire protocol.
 */

// ---------------------------------------------------------------------------
// Roles / access control
// ---------------------------------------------------------------------------

/** Explicit per-user role. Owner is never stored here — it is implied by
 * `documents.owner_id` — this only covers editor/viewer grants. */
export type ExplicitRole = "editor" | "viewer";

/** Effective role for a given user on a given document, after resolving
 * owner-ship, explicit grants, and the document's link-access default. */
export type EffectiveRole = "owner" | "editor" | "viewer" | "none";

/** What any authenticated user gets by holding the share link, absent an
 * explicit permission row. */
export type LinkAccess = "none" | "viewer" | "editor";

export function roleRank(role: EffectiveRole): number {
  switch (role) {
    case "owner":
      return 3;
    case "editor":
      return 2;
    case "viewer":
      return 1;
    case "none":
    default:
      return 0;
  }
}

export function canWrite(role: EffectiveRole): boolean {
  return role === "owner" || role === "editor";
}

export function canRead(role: EffectiveRole): boolean {
  return role !== "none";
}

export function canManageAccess(role: EffectiveRole): boolean {
  return role === "owner";
}

// ---------------------------------------------------------------------------
// REST DTOs
// ---------------------------------------------------------------------------

export interface UserDTO {
  id: string;
  displayName: string;
  color: string;
}

export interface DocumentSummaryDTO {
  id: string;
  title: string;
  ownerId: string;
  ownerName: string;
  role: EffectiveRole;
  linkAccess: LinkAccess;
  language: string;
  updatedAt: string;
  createdAt: string;
}

export interface DocumentDetailDTO extends DocumentSummaryDTO {
  collaborators: Array<{ userId: string; displayName: string; color: string; role: ExplicitRole }>;
}

export interface CreateDocumentRequest {
  title: string;
  language?: string;
}

export interface UpdatePermissionRequest {
  userId: string;
  role: ExplicitRole | "none";
}

export interface UpdateLinkAccessRequest {
  linkAccess: LinkAccess;
}

export interface VersionSummaryDTO {
  id: string;
  seq: number;
  label: string | null;
  createdAt: string;
  sizeBytes: number;
  createdByName: string | null;
}

export interface VersionDiffDTO {
  from: VersionSummaryDTO | null;
  to: VersionSummaryDTO;
  fromText: string;
  toText: string;
}

export interface SignupRequest {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: UserDTO;
}

// ---------------------------------------------------------------------------
// Socket.io wire protocol
// ---------------------------------------------------------------------------

/** Client -> server: join a document room. */
export interface JoinRoomPayload {
  docId: string;
}

/** Server -> client: join result. */
export interface JoinRoomAck {
  ok: true;
  role: EffectiveRole;
  awarenessClientId: number;
}

export interface JoinRoomError {
  ok: false;
  error: string;
}

export const SOCKET_EVENTS = {
  JOIN_ROOM: "join-room",
  LEAVE_ROOM: "leave-room",
  DOC_SYNC: "doc-sync",
  DOC_AWARENESS: "doc-awareness",
  DOC_SAVED: "doc-saved",
  ERROR: "server-error",
} as const;

export interface PresenceUser {
  name: string;
  color: string;
  userId: string;
}
