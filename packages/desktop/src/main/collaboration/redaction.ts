import {
  HUMAN_DEVICE_TOKEN_PREFIX,
  HUMAN_IDENTITY_TOKEN_PREFIX,
  PROJECT_INVITATION_TOKEN_PREFIX
} from "@planweave-ai/collaboration-protocol/core/limits";

const TOKEN_LIKE =
  /(pw_hdev_[A-Za-z0-9_-]+|pw_hid_[A-Za-z0-9_-]+|pw_inv_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~+/-]+=*)/gi;

/** Absolute filesystem paths that must not cross the renderer IPC boundary. */
const WINDOWS_ABSOLUTE_PATH_LIKE = /(?:[A-Za-z]:\\|\\\\)[^\s"'`]+/g;
const UNIX_ABSOLUTE_PATH_LIKE = /(^|[^A-Za-z0-9+.:/])\/[^\s"'`]+/gm;

/**
 * Redact human device / invitation tokens, Authorization headers, and absolute paths
 * from diagnostic / boundary error text. Never throw; returns a safe string only.
 */
export function redactCollaborationText(value: string): string {
  return value
    .replace(TOKEN_LIKE, (match) => {
      if (match.toLowerCase().startsWith("bearer ")) return "Bearer [REDACTED]";
      if (match.startsWith(HUMAN_DEVICE_TOKEN_PREFIX))
        return `${HUMAN_DEVICE_TOKEN_PREFIX}[REDACTED]`;
      if (match.startsWith(HUMAN_IDENTITY_TOKEN_PREFIX))
        return `${HUMAN_IDENTITY_TOKEN_PREFIX}[REDACTED]`;
      if (match.startsWith(PROJECT_INVITATION_TOKEN_PREFIX)) {
        return `${PROJECT_INVITATION_TOKEN_PREFIX}[REDACTED]`;
      }
      return "[REDACTED]";
    })
    .replace(WINDOWS_ABSOLUTE_PATH_LIKE, "<redacted-path>")
    .replace(UNIX_ABSOLUTE_PATH_LIKE, (_match, boundary: string) => `${boundary}<redacted-path>`)
    .replace(/"deviceToken"\s*:\s*"[^"]*"/g, '"deviceToken":"[REDACTED]"')
    .replace(/"invitationToken"\s*:\s*"[^"]*"/g, '"invitationToken":"[REDACTED]"')
    .replace(/"existingDeviceToken"\s*:\s*"[^"]*"/g, '"existingDeviceToken":"[REDACTED]"')
    .replace(/"existingIdentityToken"\s*:\s*"[^"]*"/g, '"existingIdentityToken":"[REDACTED]"')
    .replace(/"identityToken"\s*:\s*"[^"]*"/g, '"identityToken":"[REDACTED]"');
}

export function redactCollaborationValue(value: unknown): unknown {
  if (typeof value === "string") return redactCollaborationText(value);
  try {
    return JSON.parse(redactCollaborationText(JSON.stringify(value)));
  } catch {
    return "[unserializable]";
  }
}
