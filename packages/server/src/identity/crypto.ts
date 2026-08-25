import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { humanIdentityTokenSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  HUMAN_DEVICE_TOKEN_PREFIX,
  HUMAN_IDENTITY_TOKEN_PREFIX,
  HUMAN_TOKEN_SECRET_CHAR_LENGTH,
  PROJECT_INVITATION_TOKEN_PREFIX
} from "./limits.js";
import {
  humanDeviceTokenSchema,
  projectInvitationTokenSchema,
  tokenSha256HexSchema
} from "./schemas.js";

/** SHA-256 hex digest of a human invitation or device bearer secret. */
export function hashHumanToken(token: string): string {
  return tokenSha256HexSchema.parse(createHash("sha256").update(token).digest("hex"));
}

/**
 * Constant-time comparison of two lowercase hex SHA-256 digests.
 * Returns false when lengths differ (including malformed storage).
 */
export function digestsEqual(expectedHex: string, actualHex: string): boolean {
  try {
    const expected = Buffer.from(tokenSha256HexSchema.parse(expectedHex), "hex");
    const actual = Buffer.from(tokenSha256HexSchema.parse(actualHex), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function mintHumanDeviceToken(): string {
  const secret = randomBytes(32).toString("base64url");
  if (secret.length !== HUMAN_TOKEN_SECRET_CHAR_LENGTH) {
    throw new Error("human_device_token_entropy_invalid");
  }
  return humanDeviceTokenSchema.parse(`${HUMAN_DEVICE_TOKEN_PREFIX}${secret}`);
}

export function mintHumanIdentityToken(): string {
  const secret = randomBytes(32).toString("base64url");
  if (secret.length !== HUMAN_TOKEN_SECRET_CHAR_LENGTH) {
    throw new Error("human_identity_token_entropy_invalid");
  }
  return humanIdentityTokenSchema.parse(`${HUMAN_IDENTITY_TOKEN_PREFIX}${secret}`);
}

export function mintProjectInvitationToken(): string {
  const secret = randomBytes(32).toString("base64url");
  if (secret.length !== HUMAN_TOKEN_SECRET_CHAR_LENGTH) {
    throw new Error("project_invitation_token_entropy_invalid");
  }
  return projectInvitationTokenSchema.parse(`${PROJECT_INVITATION_TOKEN_PREFIX}${secret}`);
}
