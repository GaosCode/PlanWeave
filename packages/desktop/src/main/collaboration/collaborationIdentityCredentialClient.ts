import {
  collaborationClientLimitsSchema,
  collaborationServerOriginSchema,
  isPrivateNetworkHostname,
  type CollaborationClientLimits
} from "@planweave-ai/collaboration-protocol/connection";
import {
  humanIdentityRecoverRequestSchema,
  humanIdentityRecoverResponseSchema,
  humanIdentityRenewRequestSchema,
  humanIdentityRenewResponseSchema,
  humanIdentityRevokeRequestSchema,
  humanIdentityRevokeResponseSchema,
  humanPrincipalMergeRequestSchema,
  humanPrincipalMergeResponseSchema,
  type HumanIdentityRecoverResponse,
  type HumanIdentityRenewResponse,
  type HumanIdentityRevokeResponse,
  type HumanPrincipalMergeResponse
} from "@planweave-ai/collaboration-protocol/identity/credential";
import {
  CollaborationClientError,
  collaborationErrorFromHttp,
  collaborationErrorFromUnknown
} from "./collaborationErrors.js";

export type IdentityCredentialClientOrigin = {
  serverBaseUrl: string;
  allowInsecureTransport: boolean;
};

export type CollaborationIdentityCredentialClientOptions = {
  origin: IdentityCredentialClientOrigin;
  limits?: Partial<CollaborationClientLimits>;
  request?: typeof fetch;
};

function assertTransportPolicy(origin: IdentityCredentialClientOrigin): {
  serverBaseUrl: string;
  allowInsecureTransport: boolean;
} {
  const serverBaseUrl = collaborationServerOriginSchema.parse(origin.serverBaseUrl);
  const allowInsecureTransport = origin.allowInsecureTransport === true;
  const url = new URL(serverBaseUrl);
  if (url.protocol !== "https:" && !allowInsecureTransport) {
    throw new CollaborationClientError({
      kind: "protocol",
      code: "collaboration_insecure_transport",
      message: "HTTPS is required unless allowInsecureTransport is true",
      retryable: false
    });
  }
  if (
    allowInsecureTransport &&
    url.protocol === "http:" &&
    !isPrivateNetworkHostname(url.hostname)
  ) {
    throw new CollaborationClientError({
      kind: "protocol",
      code: "collaboration_insecure_transport",
      message: "Insecure HTTP is only allowed for loopback or private-network hosts",
      retryable: false
    });
  }
  return { serverBaseUrl, allowInsecureTransport };
}

export class CollaborationIdentityCredentialClient {
  private readonly serverBaseUrl: string;
  private readonly limits: CollaborationClientLimits;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CollaborationIdentityCredentialClientOptions) {
    const origin = assertTransportPolicy(options.origin);
    this.serverBaseUrl = origin.serverBaseUrl;
    this.limits = collaborationClientLimitsSchema.parse(options.limits ?? {});
    this.fetchImpl = options.request ?? fetch;
  }

  recover(
    existingDeviceToken: string,
    signal?: AbortSignal
  ): Promise<HumanIdentityRecoverResponse> {
    return this.post(
      "/api/v1/human-identity/recover",
      humanIdentityRecoverRequestSchema.parse({
        schemaVersion: "human-identity/v1",
        existingDeviceToken
      }),
      humanIdentityRecoverResponseSchema,
      signal
    );
  }

  renew(identityToken: string, signal?: AbortSignal): Promise<HumanIdentityRenewResponse> {
    return this.post(
      "/api/v1/human-identity/renew",
      humanIdentityRenewRequestSchema.parse({
        schemaVersion: "human-identity/v1",
        identityToken
      }),
      humanIdentityRenewResponseSchema,
      signal
    );
  }

  revoke(
    identityToken: string,
    reason: string,
    signal?: AbortSignal
  ): Promise<HumanIdentityRevokeResponse> {
    return this.post(
      "/api/v1/human-identity/revoke",
      humanIdentityRevokeRequestSchema.parse({
        schemaVersion: "human-identity/v1",
        identityToken,
        reason
      }),
      humanIdentityRevokeResponseSchema,
      signal
    );
  }

  merge(
    sourceIdentityToken: string,
    canonicalIdentityToken: string,
    signal?: AbortSignal
  ): Promise<HumanPrincipalMergeResponse> {
    return this.post(
      "/api/v1/human-identity/merge",
      humanPrincipalMergeRequestSchema.parse({
        schemaVersion: "human-identity/v1",
        sourceIdentityToken,
        canonicalIdentityToken
      }),
      humanPrincipalMergeResponseSchema,
      signal
    );
  }

  private async post<T>(
    path: string,
    body: unknown,
    schema: { parse(value: unknown): T },
    signal?: AbortSignal
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.limits.requestTimeoutMs);
    const signals = [timeout.signal];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);
    try {
      const response = await this.fetchImpl(new URL(path, this.serverBaseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(body),
        signal: combined
      });
      const text = await response.text();
      if (!response.ok) {
        throw collaborationErrorFromHttp(
          response.status,
          text,
          response.headers.get("retry-after")
        );
      }
      return schema.parse(text.length === 0 ? null : JSON.parse(text));
    } catch (error) {
      if (error instanceof CollaborationClientError) throw error;
      if (error instanceof SyntaxError) {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "collaboration_malformed_json",
          message: "Identity credential response was not valid JSON."
        });
      }
      throw collaborationErrorFromUnknown(error);
    } finally {
      clearTimeout(timer);
    }
  }
}
