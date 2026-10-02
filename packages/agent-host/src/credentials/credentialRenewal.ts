import { randomBytes, randomUUID } from "node:crypto";
import {
  hostCredentialRenewalErrorSchema,
  hostCredentialRenewalStatusSchema,
  hostCredentialRotationRequestSchema,
  hostCredentialRotationResponseSchema,
  type HostCredentialRenewalStatus
} from "@planweave-ai/agent-host-protocol";
import type { ActiveHostCredential, PendingHostCredentialRotation } from "./credentialContract.js";
import { FileHostCredentialStore } from "./fileCredentialStore.js";

const STATUS_POLL_INTERVAL_MS = 30_000;
const MIN_RENEWAL_WINDOW_MS = 24 * 60 * 60_000;
const MAX_RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60_000;
const RESPONSE_MAX_BYTES = 16_384;
const REQUEST_TIMEOUT_MS = 30_000;

export interface HostCredentialRenewalPort {
  poll(signal?: AbortSignal): Promise<ActiveHostCredential | undefined>;
  readActiveCredential(): Promise<ActiveHostCredential>;
}

export function hostCredentialRenewalWindowMs(credential: ActiveHostCredential): number {
  const lifetimeMs = Date.parse(credential.expiresAt) - Date.parse(credential.issuedAt);
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
    throw new Error("agent_host_credential_lifetime_invalid");
  }
  return Math.min(
    MAX_RENEWAL_WINDOW_MS,
    Math.max(MIN_RENEWAL_WINDOW_MS, Math.floor(lifetimeMs * 0.2))
  );
}

function renewalEndpoint(serverUrl: string, hostId: string, workspaceId?: string): URL {
  const base = new URL(serverUrl);
  if (base.protocol === "wss:") base.protocol = "https:";
  if (base.protocol === "ws:") base.protocol = "http:";
  base.pathname = `/agent-hosts/${encodeURIComponent(hostId)}/credential-renewal`;
  base.search = "";
  base.hash = "";
  if (workspaceId !== undefined) base.searchParams.set("workspaceId", workspaceId);
  return base;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")
  ) {
    throw new Error("agent_host_credential_renewal_response_malformed");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new Error("agent_host_credential_renewal_response_malformed");
    }
    if (parsedLength > RESPONSE_MAX_BYTES) {
      throw new Error("agent_host_credential_renewal_response_too_large");
    }
  }
  if (!response.body) throw new Error("agent_host_credential_renewal_response_malformed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new Error("agent_host_credential_renewal_response_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch (error) {
    throw new Error("agent_host_credential_renewal_response_malformed", { cause: error });
  }
}

function assertMatchingStatus(
  credential: ActiveHostCredential,
  status: HostCredentialRenewalStatus
): void {
  if (
    status.hostId !== credential.hostId ||
    status.credentialExpiresAt !== credential.expiresAt ||
    JSON.stringify(status.policy) !== JSON.stringify(credential.credentialPolicy)
  ) {
    throw new Error("agent_host_credential_renewal_state_mismatch");
  }
}

export class AgentHostCredentialRenewal implements HostCredentialRenewalPort {
  private readonly request: typeof fetch;
  private nextPollAt = 0;
  private pending?: Promise<ActiveHostCredential | undefined>;

  constructor(
    private readonly serverUrl: string,
    private readonly credentials: FileHostCredentialStore,
    private readonly options: {
      request?: typeof fetch;
      clock?: () => Date;
    } = {}
  ) {
    this.request = options.request ?? fetch;
  }

  async readActiveCredential(): Promise<ActiveHostCredential> {
    return this.credentials.requireUsable(this.options.clock?.() ?? new Date());
  }

  poll(signal?: AbortSignal): Promise<ActiveHostCredential | undefined> {
    if (this.pending) return this.pending;
    const operation = this.pollOwned(signal).finally(() => {
      if (this.pending === operation) this.pending = undefined;
      if (signal?.aborted) this.nextPollAt = 0;
    });
    this.pending = operation;
    return operation;
  }

  private async pollOwned(signal?: AbortSignal): Promise<ActiveHostCredential | undefined> {
    signal?.throwIfAborted();
    const now = this.options.clock?.() ?? new Date();
    if (now.getTime() < this.nextPollAt) return undefined;
    this.nextPollAt = now.getTime() + STATUS_POLL_INTERVAL_MS;
    const document = await this.credentials.read();
    signal?.throwIfAborted();
    const active = document?.active;
    const pendingRotation = document?.rotation;
    if (!active?.credentialPolicy || active.revokedAt) return undefined;
    if (Date.parse(active.expiresAt) <= now.getTime()) {
      throw new Error("agent_host_credential_unavailable");
    }

    const status = await this.readStatus(active, signal);
    signal?.throwIfAborted();
    assertMatchingStatus(active, status);
    const shouldRotate =
      pendingRotation !== undefined ||
      status.renewalRequestedAt !== undefined ||
      Date.parse(status.credentialExpiresAt) - Date.parse(status.serverTime) <=
        hostCredentialRenewalWindowMs(active);
    if (!shouldRotate) return undefined;

    const rotation = pendingRotation ?? {
      rotationId: `credential-rotation-${randomUUID()}`,
      credentialToken: `pw_host_${randomBytes(32).toString("base64url")}`,
      createdAt: now.toISOString()
    };
    await this.credentials.beginRotation(rotation);
    signal?.throwIfAborted();
    const response = await this.rotate(active, rotation, signal);
    signal?.throwIfAborted();
    return this.credentials.commitRotation(response, now);
  }

  private async readStatus(
    active: ActiveHostCredential,
    signal?: AbortSignal
  ): Promise<HostCredentialRenewalStatus> {
    return this.requestWithTimeout(
      renewalEndpoint(this.serverUrl, active.hostId, active.workspaceId),
      {
        method: "GET",
        headers: { authorization: `Bearer ${active.credentialToken}` },
        redirect: "error"
      },
      (response, payload) => {
        if (!response.ok) {
          const error = hostCredentialRenewalErrorSchema.parse(payload);
          throw new Error(`agent_host_credential_renewal_rejected:${error.error}`);
        }
        return hostCredentialRenewalStatusSchema.parse(payload);
      },
      signal
    );
  }

  private async rotate(
    active: ActiveHostCredential,
    rotation: PendingHostCredentialRotation,
    signal?: AbortSignal
  ) {
    const request = hostCredentialRotationRequestSchema.parse({
      rotationId: rotation.rotationId,
      nextCredentialToken: rotation.credentialToken
    });
    return this.requestWithTimeout(
      renewalEndpoint(this.serverUrl, active.hostId, active.workspaceId),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${active.credentialToken}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(request),
        redirect: "error"
      },
      (response, payload) => {
        if (!response.ok) {
          const error = hostCredentialRenewalErrorSchema.parse(payload);
          throw new Error(`agent_host_credential_rotation_rejected:${error.error}`);
        }
        return hostCredentialRotationResponseSchema.parse(payload);
      },
      signal
    );
  }

  private async requestWithTimeout<T>(
    input: URL,
    init: RequestInit,
    parse: (response: Response, payload: unknown) => T,
    owner?: AbortSignal
  ): Promise<T> {
    const controller = new AbortController();
    const signal = owner ? AbortSignal.any([owner, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      signal.throwIfAborted();
      const response = await this.request(input, { ...init, signal });
      const payload = await readBoundedJson(response);
      signal.throwIfAborted();
      const result = parse(response, payload);
      signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
}
