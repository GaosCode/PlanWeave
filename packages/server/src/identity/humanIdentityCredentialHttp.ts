import type { IncomingMessage, ServerResponse } from "node:http";
import {
  humanIdentityRecoverRequestSchema,
  humanIdentityRecoverResponseSchema,
  humanIdentityRenewRequestSchema,
  humanIdentityRenewResponseSchema,
  humanIdentityRevokeRequestSchema,
  humanIdentityRevokeResponseSchema,
  humanPrincipalMergeRequestSchema,
  humanPrincipalMergeResponseSchema
} from "@planweave-ai/collaboration-protocol/identity/credential";
import { z } from "zod";
import {
  humanNetworkTransportAllowed,
  type TransportAdmissionPolicy
} from "../insecureTransport.js";
import {
  HumanIdentityCredentialError,
  type HumanIdentityCredentialStore
} from "./humanIdentityCredentialStore.js";

const MAX_IDENTITY_BODY_BYTES = 16_384;

export type HumanIdentityCredentialHttpOptions = {
  store: HumanIdentityCredentialStore;
  lookupDevicePrincipal: (deviceToken: string) => string | undefined;
  transportAdmission: TransportAdmissionPolicy;
};

type IdentityCredentialRoute = "renew" | "revoke" | "merge" | "recover";

function transportAllowed(
  socket: { encrypted?: boolean; remoteAddress?: string },
  transportAdmission: TransportAdmissionPolicy
): boolean {
  return humanNetworkTransportAllowed(socket, transportAdmission);
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store"
  });
  response.end(bytes);
}

function route(request: IncomingMessage, pathname: string): IdentityCredentialRoute | undefined {
  if (request.method !== "POST") return undefined;
  if (pathname === "/api/v1/human-identity/renew") return "renew";
  if (pathname === "/api/v1/human-identity/revoke") return "revoke";
  if (pathname === "/api/v1/human-identity/merge") return "merge";
  if (pathname === "/api/v1/human-identity/recover") return "recover";
  return undefined;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new HumanIdentityCredentialError("identity_credential_invalid");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_IDENTITY_BODY_BYTES) throw new Error("identity_body_too_large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HumanIdentityCredentialError("identity_credential_invalid");
  }
}

function mapError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "identity_malformed" };
  if (error instanceof HumanIdentityCredentialError) {
    switch (error.code) {
      case "identity_credential_expired":
      case "identity_credential_revoked":
      case "identity_credential_invalid":
      case "identity_merge_unproven":
        return { status: 403, code: error.code };
      case "identity_merge_same_principal":
      case "identity_merge_conflict":
        return { status: 409, code: error.code };
      case "identity_limit_exceeded":
        return { status: 429, code: error.code };
      case "identity_principal_missing":
        return { status: 404, code: error.code };
      default:
        return { status: 400, code: error.code };
    }
  }
  if (error instanceof Error && error.message === "identity_body_too_large") {
    return { status: 413, code: "identity_body_too_large" };
  }
  return { status: 500, code: "identity_credential_failed" };
}

export async function handleHumanIdentityCredentialHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HumanIdentityCredentialHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) return false;

  try {
    if (!transportAllowed(request.socket, options.transportAdmission)) {
      request.resume();
      respond(response, 426, { error: "identity_insecure_transport" });
      return true;
    }
    const body = await readJson(request);
    if (matched === "renew") {
      const parsed = humanIdentityRenewRequestSchema.parse(body);
      const renewed = options.store.renew(parsed.identityToken);
      respond(
        response,
        200,
        humanIdentityRenewResponseSchema.parse({
          schemaVersion: "human-identity/v1",
          humanPrincipalId: renewed.record.humanPrincipalId,
          identityCredentialId: renewed.record.identityCredentialId,
          identityToken: renewed.identityToken,
          identityExpiresAt: renewed.record.expiresAt
        })
      );
      return true;
    }
    if (matched === "revoke") {
      const parsed = humanIdentityRevokeRequestSchema.parse(body);
      const revoked = options.store.revoke(parsed.identityToken, parsed.reason);
      if (revoked.revokedAt === null) {
        throw new HumanIdentityCredentialError("identity_credential_invalid");
      }
      respond(
        response,
        200,
        humanIdentityRevokeResponseSchema.parse({
          schemaVersion: "human-identity/v1",
          humanPrincipalId: revoked.humanPrincipalId,
          identityCredentialId: revoked.identityCredentialId,
          revokedAt: revoked.revokedAt
        })
      );
      return true;
    }
    if (matched === "recover") {
      const parsed = humanIdentityRecoverRequestSchema.parse(body);
      const humanPrincipalId = options.lookupDevicePrincipal(parsed.existingDeviceToken);
      if (!humanPrincipalId) {
        throw new HumanIdentityCredentialError("identity_credential_invalid");
      }
      const issued = options.store.issue(humanPrincipalId);
      respond(
        response,
        200,
        humanIdentityRecoverResponseSchema.parse({
          schemaVersion: "human-identity/v1",
          humanPrincipalId: issued.record.humanPrincipalId,
          identityCredentialId: issued.record.identityCredentialId,
          identityToken: issued.identityToken,
          identityExpiresAt: issued.record.expiresAt
        })
      );
      return true;
    }
    const parsed = humanPrincipalMergeRequestSchema.parse(body);
    const merged = options.store.merge(parsed.sourceIdentityToken, parsed.canonicalIdentityToken);
    respond(
      response,
      200,
      humanPrincipalMergeResponseSchema.parse({
        schemaVersion: "human-identity/v1",
        mergeId: merged.mergeId,
        sourceHumanPrincipalId: merged.sourceHumanPrincipalId,
        canonicalHumanPrincipalId: merged.canonicalHumanPrincipalId,
        mergedAt: merged.mergedAt
      })
    );
    return true;
  } catch (error) {
    const mapped = mapError(error);
    respond(response, mapped.status, { error: mapped.code });
    return true;
  }
}
