import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  return header.slice("Bearer ".length).trim() || null;
}

export function verifyPkce(codeVerifier: string, expectedChallenge: string): boolean {
  if (!codeVerifier || !expectedChallenge) {
    return false;
  }
  const actualChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const actual = Buffer.from(actualChallenge);
  const expected = Buffer.from(expectedChallenge);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
