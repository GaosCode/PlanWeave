import {
  operatorEnrollmentGrantRequestSchema,
  operatorEnrollmentGrantResponseSchema,
  operatorHostPageSchema,
  operatorHostRenewalRequestSchema,
  operatorHostRenewalResponseSchema,
  operatorHostRevokeResponseSchema,
  operatorPageQuerySchema,
  operatorTokenSchema,
  opaqueIdentifierSchema,
  type OperatorEnrollmentGrantResponse,
  type OperatorHostPage,
  type OperatorHostView
} from "@planweave-ai/agent-host-protocol";
import {
  OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE,
  remoteEventReplaySchema
} from "@planweave-ai/collaboration-protocol/remote-run";
import {
  remoteAgentEndpointListSchema,
  type RemoteAgentEndpointList
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  setupCodeIssueResponseSchema,
  type SetupCodeIssueResponse
} from "@planweave-ai/collaboration-protocol/setup";
import { z, type ZodType } from "zod";
import {
  OperatorControlError,
  operatorControlProfileSchema,
  operatorListAgentEndpointsInputSchema,
  operatorRemoteAgentListSchema,
  operatorRemoteAgentViewSchema,
  type OperatorControlProfile,
  type OperatorCreateEnrollmentGrantInput,
  type OperatorGrantRemoteAgentWorkspaceInput,
  type OperatorListAgentEndpointsInput,
  type OperatorListHostsInput,
  type OperatorListRemoteAgentsInput,
  type OperatorRemoteAgentList,
  type OperatorRemoteAgentView,
  type OperatorRepairRemoteAgentOwnershipInput,
  type OperatorRevokeRemoteAgentGrantInput,
  type OperatorRevokeRemoteAgentInput,
  type OperatorSetRemoteAgentAccessModeInput
} from "../../shared/operatorControl.js";

const OPERATOR_REQUEST_TIMEOUT_MS = 30_000;
const OPERATOR_JSON_BODY_MAX_BYTES = 64 * 1024;

export type OperatorCredentialPort = {
  getOperatorToken(): string | undefined | Promise<string | undefined>;
};

export type OperatorControlClientOptions = {
  profile: OperatorControlProfile;
  credential: OperatorCredentialPort;
  request?: typeof fetch;
  requestTimeoutMs?: number;
  clock?: OperatorClientClock;
};

export type OperatorClientClock = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
};

const systemClock = {
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  return /^[A-Za-z0-9_.-]{1,96}$/.test(code) ? code : undefined;
}

function safeServerBuildRevision(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const revision = value.trim();
  return /^(?:[0-9a-f]{7,64}|development)$/.test(revision) ? revision : undefined;
}

function errorFromHttp(status: number, body: string): OperatorControlError {
  let code = `http_${status}`;
  let serverBuildRevision: string | undefined;
  try {
    const parsed = z
      .object({ error: z.unknown(), serverBuildRevision: z.unknown().optional() })
      .passthrough()
      .safeParse(JSON.parse(body));
    if (parsed.success) {
      code = safeErrorCode(parsed.data.error) ?? code;
      serverBuildRevision = safeServerBuildRevision(parsed.data.serverBuildRevision);
    }
  } catch {
    // Keep status-derived code; never copy an untrusted response body to the error.
  }
  const kind =
    status === 401
      ? "unauthorized"
      : status === 403
        ? "forbidden"
        : status === 409
          ? "conflict"
          : status >= 500
            ? "server"
            : "unknown";
  return new OperatorControlError({
    kind,
    code,
    httpStatus: status,
    serverBuildRevision,
    message: serverBuildRevision ? `${code} (server ${serverBuildRevision})` : code
  });
}

function operatorErrorFromUnknown(error: unknown): OperatorControlError {
  if (error instanceof OperatorControlError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new OperatorControlError({ kind: "timeout", code: "operator_timeout" });
  }
  if (error instanceof TypeError) {
    return new OperatorControlError({ kind: "offline", code: "operator_offline" });
  }
  return new OperatorControlError({
    kind: "unknown",
    code: "operator_request_failed",
    message: "Operator request failed."
  });
}

/** Main-process application client for the fixed Host operator API surface. */
export class OperatorControlClient {
  private readonly profile: OperatorControlProfile;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: OperatorClientClock;
  private readonly timeoutMs: number;
  private readonly rootController = new AbortController();
  private disposed = false;

  constructor(private readonly options: OperatorControlClientOptions) {
    this.profile = operatorControlProfileSchema.parse(options.profile);
    this.fetchImpl = options.request ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.timeoutMs = options.requestTimeoutMs ?? OPERATOR_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new OperatorControlError({ kind: "validation", code: "operator_timeout_invalid" });
    }
  }

  get connectionProfile(): OperatorControlProfile {
    return this.profile;
  }

  async listHosts(input: OperatorListHostsInput["query"] = {}): Promise<OperatorHostPage> {
    const query = operatorPageQuerySchema.parse(input ?? {});
    const params = new URLSearchParams({
      cursor: String(query.cursor),
      limit: String(query.limit)
    });
    return this.json("GET", `/api/v1/hosts?${params.toString()}`, operatorHostPageSchema);
  }

  async listAgentEndpoints(
    query: Omit<OperatorListAgentEndpointsInput, "profileId">
  ): Promise<RemoteAgentEndpointList> {
    const parsed = operatorListAgentEndpointsInputSchema.omit({ profileId: true }).parse(query);
    const params = new URLSearchParams({
      projectId: parsed.projectId,
      humanPrincipalId: parsed.humanPrincipalId,
      canvasId: parsed.canvasId
    });
    if (parsed.workspaceId !== undefined) params.set("workspaceId", parsed.workspaceId);
    return this.json(
      "GET",
      `/api/v1/agent-endpoints?${params.toString()}`,
      remoteAgentEndpointListSchema
    );
  }

  async createEnrollmentGrant(
    input: OperatorCreateEnrollmentGrantInput["request"]
  ): Promise<OperatorEnrollmentGrantResponse> {
    return this.json("POST", "/api/v1/host-enrollments", operatorEnrollmentGrantResponseSchema, {
      body: operatorEnrollmentGrantRequestSchema.parse(input)
    });
  }

  async issueMemberDeviceSetupCode(): Promise<SetupCodeIssueResponse> {
    return this.json("POST", "/api/v1/setup-codes", setupCodeIssueResponseSchema, {
      body: {
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session"
      }
    });
  }

  async revokeHost(hostId: string): Promise<OperatorHostView> {
    const id = opaqueIdentifierSchema.parse(hostId);
    return this.json(
      "POST",
      `/api/v1/hosts/${encodeURIComponent(id)}/revoke`,
      operatorHostRevokeResponseSchema,
      { body: {} }
    );
  }

  async requestHostCredentialRenewal(hostId: string): Promise<OperatorHostView> {
    const id = opaqueIdentifierSchema.parse(hostId);
    return this.json(
      "POST",
      `/api/v1/hosts/${encodeURIComponent(id)}/credential-renewal`,
      operatorHostRenewalResponseSchema,
      { body: operatorHostRenewalRequestSchema.parse({}) }
    );
  }

  async dispatchRemoteOperation(
    command: import("@planweave-ai/collaboration-protocol/remote-run").RemoteDispatchIntentV3,
    humanPrincipalId: string,
    workspaceId?: string
  ) {
    const { operatorObservationToRemoteRun } = await import("./operatorRemoteOperations.js");
    const { remoteDispatchIntentV3Schema } = await import(
      "@planweave-ai/collaboration-protocol/remote-run"
    );
    const body = {
      ...remoteDispatchIntentV3Schema.parse(command),
      humanPrincipalId,
      ...(workspaceId === undefined ? {} : { workspaceId })
    };
    return operatorObservationToRemoteRun(
      await this.json("POST", "/api/v1/remote-operations", z.object({}).passthrough(), {
        body,
        accept: OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE
      })
    );
  }

  async observeRemoteOperation(operationId: string) {
    const { operatorObservationToRemoteRun } = await import("./operatorRemoteOperations.js");
    const id = opaqueIdentifierSchema.parse(operationId);
    return operatorObservationToRemoteRun(
      await this.json(
        "GET",
        `/api/v1/remote-operations/${encodeURIComponent(id)}`,
        z.object({}).passthrough(),
        { accept: OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE }
      )
    );
  }

  async replayRemoteOperationEvents(operationId: string, afterCursor: number) {
    const id = opaqueIdentifierSchema.parse(operationId);
    const params = new URLSearchParams({ afterCursor: String(afterCursor) });
    return this.json(
      "GET",
      `/api/v1/remote-operations/${encodeURIComponent(id)}/events?${params.toString()}`,
      remoteEventReplaySchema
    );
  }

  async listRemoteAgents(
    query: Omit<OperatorListRemoteAgentsInput, "profileId">
  ): Promise<OperatorRemoteAgentList> {
    const params = new URLSearchParams({ humanPrincipalId: query.humanPrincipalId });
    return this.json(
      "GET",
      `/api/v1/remote-agents?${params.toString()}`,
      operatorRemoteAgentListSchema
    );
  }

  async setRemoteAgentAccessMode(
    input: Omit<OperatorSetRemoteAgentAccessModeInput, "profileId">
  ): Promise<OperatorRemoteAgentView> {
    return this.json(
      "POST",
      `/api/v1/remote-agents/${encodeURIComponent(input.endpointId)}/access-mode`,
      operatorRemoteAgentViewSchema,
      {
        body: {
          humanPrincipalId: input.humanPrincipalId,
          accessMode: input.accessMode,
          ...(input.expectedPolicyRevision === undefined
            ? {}
            : { expectedPolicyRevision: input.expectedPolicyRevision })
        }
      }
    );
  }

  async grantRemoteAgentWorkspace(
    input: Omit<OperatorGrantRemoteAgentWorkspaceInput, "profileId">
  ): Promise<OperatorRemoteAgentView> {
    return this.json(
      "POST",
      `/api/v1/remote-agents/${encodeURIComponent(input.endpointId)}/grants`,
      operatorRemoteAgentViewSchema,
      {
        body: {
          humanPrincipalId: input.humanPrincipalId,
          workspaceId: input.workspaceId,
          ...(input.expectedGrantRevision === undefined
            ? {}
            : { expectedGrantRevision: input.expectedGrantRevision })
        }
      }
    );
  }

  async revokeRemoteAgentGrant(
    input: Omit<OperatorRevokeRemoteAgentGrantInput, "profileId">
  ): Promise<OperatorRemoteAgentView> {
    return this.json(
      "POST",
      `/api/v1/remote-agents/${encodeURIComponent(input.endpointId)}/grants/${encodeURIComponent(input.workspaceId)}/revoke`,
      operatorRemoteAgentViewSchema,
      { body: { humanPrincipalId: input.humanPrincipalId } }
    );
  }

  async revokeRemoteAgent(
    input: Omit<OperatorRevokeRemoteAgentInput, "profileId">
  ): Promise<OperatorRemoteAgentView> {
    return this.json(
      "POST",
      `/api/v1/remote-agents/${encodeURIComponent(input.endpointId)}/revoke`,
      operatorRemoteAgentViewSchema,
      { body: { humanPrincipalId: input.humanPrincipalId } }
    );
  }

  async repairRemoteAgentOwnership(
    input: Omit<OperatorRepairRemoteAgentOwnershipInput, "profileId">
  ): Promise<OperatorRemoteAgentView> {
    return this.json(
      "POST",
      `/api/v1/remote-agents/${encodeURIComponent(input.endpointId)}/repair-ownership`,
      operatorRemoteAgentViewSchema,
      { body: { ownerHumanPrincipalId: input.ownerHumanPrincipalId } }
    );
  }

  async executeRemoteOperationAction(
    operationId: string,
    action: import("@planweave-ai/collaboration-protocol/remote-run").RemoteHumanExecutionActionCommand
  ) {
    const { remoteHumanExecutionActionCommandSchema, remoteActionViewSchema } = await import(
      "@planweave-ai/collaboration-protocol/remote-run"
    );
    const id = opaqueIdentifierSchema.parse(operationId);
    return this.json(
      "POST",
      `/api/v1/remote-operations/${encodeURIComponent(id)}/actions`,
      remoteActionViewSchema,
      { body: remoteHumanExecutionActionCommandSchema.parse(action) }
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rootController.abort();
  }

  private ensureOpen(): void {
    if (this.disposed)
      throw new OperatorControlError({ kind: "offline", code: "operator_client_closed" });
  }

  private async json<T>(
    method: "GET" | "POST",
    path: string,
    schema: ZodType<T>,
    options: { body?: unknown; accept?: string } = {}
  ): Promise<T> {
    this.ensureOpen();
    const token = await this.options.credential.getOperatorToken();
    if (!token) {
      throw new OperatorControlError({ kind: "unauthorized", code: "operator_credential_missing" });
    }
    const parsedToken = operatorTokenSchema.safeParse(token);
    if (!parsedToken.success) {
      throw new OperatorControlError({ kind: "unauthorized", code: "operator_credential_invalid" });
    }
    const headers: Record<string, string> = {
      accept: options.accept ?? "application/json",
      authorization: `Bearer ${parsedToken.data}`
    };
    if (options.body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
    const response = await this.send(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await this.readTextLimited(response);
    if (!response.ok) throw errorFromHttp(response.status, text);
    let value: unknown;
    try {
      value = text.length === 0 ? null : JSON.parse(text);
    } catch {
      throw new OperatorControlError({
        kind: "protocol",
        code: "operator_malformed_json"
      });
    }
    try {
      return schema.parse(value);
    } catch {
      throw new OperatorControlError({
        kind: "protocol",
        code: "operator_response_invalid"
      });
    }
  }

  private async send(
    path: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }
  ): Promise<Response> {
    const base = new URL(this.profile.serverBaseUrl);
    const url = new URL(path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith("/api/v1/")) {
      throw new OperatorControlError({ kind: "validation", code: "operator_route_invalid" });
    }
    const timeout = new AbortController();
    const timer = this.clock.setTimeout(() => timeout.abort(), this.timeoutMs);
    const signal = AbortSignal.any([this.rootController.signal, timeout.signal]);
    try {
      return await this.fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal
      });
    } catch (error) {
      if (timeout.signal.aborted && !this.rootController.signal.aborted) {
        throw new OperatorControlError({ kind: "timeout", code: "operator_timeout" });
      }
      throw operatorErrorFromUnknown(error);
    } finally {
      this.clock.clearTimeout(timer);
    }
  }

  private async readTextLimited(response: Response): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > OPERATOR_JSON_BODY_MAX_BYTES) {
      await response.body?.cancel();
      throw new OperatorControlError({
        kind: "payload_too_large",
        code: "operator_response_too_large",
        httpStatus: response.status
      });
    }
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > OPERATOR_JSON_BODY_MAX_BYTES) {
        await reader.cancel();
        throw new OperatorControlError({
          kind: "payload_too_large",
          code: "operator_response_too_large",
          httpStatus: response.status
        });
      }
      chunks.push(value);
    }
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      totalBytes
    ).toString("utf8");
  }
}

export const OPERATOR_CONTROL_JSON_BODY_MAX_BYTES = OPERATOR_JSON_BODY_MAX_BYTES;
