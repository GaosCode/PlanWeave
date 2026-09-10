import {
  COLLABORATION_CONNECTION_ERROR_CODES,
  CollaborationClientError
} from "./collaborationErrors.js";

const IDENTITY_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1_000;

export function nowIso(clock?: { now(): Date }): string {
  return (clock?.now() ?? new Date()).toISOString();
}

export function needsIdentityRenewal(expiresAt: string | null, now: Date): boolean {
  if (expiresAt === null) return false;
  const expires = Date.parse(expiresAt);
  return Number.isFinite(expires) && expires - now.getTime() <= IDENTITY_RENEW_BEFORE_MS;
}

export function isUnusableIdentityCredential(error: unknown): boolean {
  return (
    error instanceof CollaborationClientError &&
    (error.code === "identity_credential_expired" ||
      error.code === "identity_credential_revoked" ||
      error.code === "identity_credential_invalid")
  );
}

export function isRejectedWorkspaceCredential(error: unknown): boolean {
  if (!(error instanceof CollaborationClientError)) return false;
  if (error.httpStatus === 401 || error.httpStatus === 403) return true;
  return (
    error.code === COLLABORATION_CONNECTION_ERROR_CODES.workspaceUnauthorized ||
    error.code === COLLABORATION_CONNECTION_ERROR_CODES.workspaceForbidden ||
    error.kind === "auth" ||
    error.kind === "forbidden"
  );
}
