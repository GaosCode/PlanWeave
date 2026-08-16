/**
 * Operator-facing lifecycle client for real-process ACP integration tests.
 * Speaks public HTTP APIs and reuses Server authority persistence only to establish
 * the durable execution-target precondition for the real-process harness.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  remoteAgentEndpointListSchema,
  type RemoteAgentEndpoint,
  type RemoteAgentEndpointList
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS,
  type RealProcessAcpHarness
} from "./realProcessAcpHarness.js";

const require = createRequire(import.meta.url);

type AvailableAgentEndpoint = Extract<RemoteAgentEndpoint, { status: "available" }>;

export type OperatorOperationView = {
  operationId: string;
  projectId: string;
  canvasId: string;
  blockRef: string;
  state: string;
  dispatchId: string;
  executionAttemptId: string;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  agentEndpoint?: AvailableAgentEndpoint & { resolvedAt: string };
  attempt: {
    executionAttemptId: string;
    dispatchId: string;
    status: string;
    hostId?: string;
    leaseId?: string;
    leaseExpiresAt?: string;
    stateVersion: number;
  };
  dispatchStatus?: string;
  runtime: {
    ref: string;
    status: string;
    ownership?: { phase?: string };
    terminalReceipt?: {
      outcome: string;
      operationId: string;
      sourceRevision: string;
      graphFingerprint: string;
      dispatchId: string;
      executionAttemptId: string;
      runId?: string;
      failure?: { code: string; message: string; retryable: boolean };
    };
    blockedReason?: string;
  };
};

export type OperatorEventReplay = {
  executionAttemptId: string;
  afterCursor: number;
  cursor: number;
  highWatermark: number;
  hasMore: boolean;
  events: Array<Record<string, unknown>>;
  diagnostics: unknown[];
};

export type OperatorInteractionView = {
  request: {
    type: string;
    actionId: string;
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
    acpSessionId: string;
    expiresAt: string;
    title?: string;
    description?: string;
    prompt?: string;
  };
  operationId: string;
  hostId: string;
  status: string;
  createdAt: string;
  settlement?: Record<string, unknown>;
  settledBy?: string;
  settledAt?: string;
};

export type ServerDispatchRow = {
  id: string;
  status: string;
  host_id: string;
  lease_id: string;
  execution_attempt_id: string;
  result_json: string | null;
  failure_json: string | null;
};

function openSqlite(path: string, readOnly = true) {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { readOnly?: boolean }
    ) => {
      prepare(sql: string): {
        get(...values: unknown[]): Record<string, unknown> | undefined;
        all(...values: unknown[]): Array<Record<string, unknown>>;
      };
      close(): void;
    };
  };
  return new DatabaseSync(path, readOnly ? { readOnly: true } : undefined);
}

class TerminalDispatchStatusError extends Error {}

export function expectedDispatchStatusReached(
  view: OperatorOperationView,
  allowed: ReadonlySet<string>
): boolean {
  if (typeof view.dispatchStatus === "string" && allowed.has(view.dispatchStatus)) return true;
  const isTerminal = ["completed", "failed", "cancelled"].includes(view.state);
  if (!isTerminal) return false;
  const failureCode = view.runtime.terminalReceipt?.failure?.code ?? "none";
  throw new TerminalDispatchStatusError(
    `real_process_lifecycle_terminal_dispatch_mismatch:operation_state=${view.state}:dispatch_status=${view.dispatchStatus ?? "none"}:failure_code=${failureCode}`
  );
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  options: { timeoutMs: number; intervalMs?: number; label: string }
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 50;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      if (error instanceof TerminalDispatchStatusError) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `real_process_lifecycle_timeout:${options.label}${
      lastError instanceof Error ? `\ncause: ${lastError.message}` : ""
    }`
  );
}

export class RealProcessLifecycleClient {
  constructor(
    readonly harness: RealProcessAcpHarness,
    readonly timeoutMs = REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS * 3
  ) {}

  private headers(json = false): Record<string, string> {
    return json
      ? {
          ...this.harness.authorizationHeaders(),
          "content-type": "application/json"
        }
      : this.harness.authorizationHeaders();
  }

  async dispatch(input: {
    blockRef: string;
    idempotencyKey: string;
    canvasId?: string;
    agentEndpointId?: string;
  }): Promise<OperatorOperationView> {
    const result = await this.rawDispatch(input);
    const body = result.body as OperatorOperationView & { error?: string };
    if (result.status !== 202) {
      throw new Error(
        `real_process_lifecycle_dispatch_failed:${result.status}:${body.error ?? JSON.stringify(body)}`
      );
    }
    return body;
  }

  async rawDispatch(input: {
    blockRef: string;
    idempotencyKey: string;
    canvasId?: string;
    agentEndpointId?: string;
  }): Promise<{ status: number; body: unknown; text: string }> {
    const agentEndpointId = input.agentEndpointId ?? (await this.availableAgentEndpointId());
    return this.rawRequest({
      method: "POST",
      path: "/api/v1/remote-operations",
      body: {
        schemaVersion: "remote-run/v3",
        projectId: this.harness.projectId,
        canvasId: input.canvasId ?? "default",
        blockRef: input.blockRef,
        agentEndpointId,
        idempotencyKey: input.idempotencyKey,
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0
      }
    });
  }

  /**
   * Raw operator HTTP call for adversarial authorization matrices.
   * Does not throw on non-2xx; callers assert status/body.
   */
  async rawRequest(input: {
    method: string;
    path: string;
    body?: unknown;
    authorization?: string | null;
    headers?: Record<string, string>;
  }): Promise<{ status: number; body: unknown; text: string }> {
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    if (input.authorization === undefined) {
      Object.assign(headers, this.harness.authorizationHeaders());
    } else if (input.authorization !== null) {
      headers.Authorization = input.authorization.startsWith("Bearer ")
        ? input.authorization
        : `Bearer ${input.authorization}`;
    }
    if (input.body !== undefined && !headers["content-type"] && !headers["Content-Type"]) {
      headers["content-type"] = "application/json";
    }
    const response = await fetch(`${this.harness.origin}${input.path}`, {
      method: input.method,
      headers,
      body:
        input.body === undefined
          ? undefined
          : typeof input.body === "string"
            ? input.body
            : JSON.stringify(input.body)
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body, text };
  }

  countServerRows(table: string, whereSql = "1=1", params: unknown[] = []): number {
    const database = openSqlite(this.serverDatabasePath());
    try {
      const row = database
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${whereSql}`)
        .get(...params) as { count?: number } | undefined;
      return Number(row?.count ?? 0);
    } finally {
      database.close();
    }
  }

  countLifecycleFragment(fragment: string): number {
    // lifecycle.log is harness-owned ACP control evidence (not production Server logs).
    const path = this.harness.paths.acpLifecycle;
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes(fragment)).length;
  }

  /**
   * Count exact ACP lifecycle events (`"<pid> <event>"`), not substring matches.
   * Critical for restart predicates: `"paused session/prompt"` must not satisfy `"session/prompt"`.
   */
  countLifecycleExactEvent(event: string): number {
    const path = this.harness.paths.acpLifecycle;
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => {
        const match = /^(\d+)\s+(.+)$/.exec(line);
        return match?.[2] === event;
      }).length;
  }

  async observe(operationId: string): Promise<OperatorOperationView> {
    const response = await fetch(
      `${this.harness.origin}/api/v1/remote-operations/${encodeURIComponent(operationId)}`,
      { headers: this.headers() }
    );
    const body = (await response.json()) as OperatorOperationView & { error?: string };
    if (response.status !== 200) {
      throw new Error(
        `real_process_lifecycle_observe_failed:${response.status}:${body.error ?? JSON.stringify(body)}`
      );
    }
    return body;
  }

  async waitForOperation(
    operationId: string,
    predicate: (view: OperatorOperationView) => boolean,
    label = "operation-predicate"
  ): Promise<OperatorOperationView> {
    let latest: OperatorOperationView | undefined;
    await waitFor(
      async () => {
        latest = await this.observe(operationId);
        return predicate(latest);
      },
      { timeoutMs: this.timeoutMs, label: `${label}:${operationId}` }
    );
    if (!latest) throw new Error(`real_process_lifecycle_wait_missing:${label}`);
    return latest;
  }

  async waitForTerminal(operationId: string): Promise<OperatorOperationView> {
    return this.waitForOperation(
      operationId,
      (view) => ["completed", "failed", "cancelled"].includes(view.state),
      "terminal"
    );
  }

  async waitForDispatchStatus(
    operationId: string,
    status: string | readonly string[]
  ): Promise<OperatorOperationView> {
    const allowed = new Set(Array.isArray(status) ? status : [status]);
    return this.waitForOperation(
      operationId,
      (view) => expectedDispatchStatusReached(view, allowed),
      `dispatch-status:${[...allowed].join("|")}`
    );
  }

  async listEvents(operationId: string, afterCursor = 0): Promise<OperatorEventReplay> {
    const response = await fetch(
      `${this.harness.origin}/api/v1/remote-operations/${encodeURIComponent(operationId)}/events?afterCursor=${afterCursor}`,
      { headers: this.headers() }
    );
    const body = (await response.json()) as OperatorEventReplay & { error?: string };
    if (response.status !== 200) {
      throw new Error(
        `real_process_lifecycle_events_failed:${response.status}:${body.error ?? JSON.stringify(body)}`
      );
    }
    return body;
  }

  async listInteractions(operationId: string): Promise<OperatorInteractionView[]> {
    const response = await fetch(
      `${this.harness.origin}/api/v1/remote-operations/${encodeURIComponent(operationId)}/interactions?limit=50`,
      { headers: this.headers() }
    );
    const body = (await response.json()) as { items?: OperatorInteractionView[]; error?: string };
    if (response.status !== 200) {
      throw new Error(
        `real_process_lifecycle_interactions_failed:${response.status}:${body.error ?? JSON.stringify(body)}`
      );
    }
    return body.items ?? [];
  }

  async waitForPendingInteraction(operationId: string): Promise<OperatorInteractionView> {
    let found: OperatorInteractionView | undefined;
    await waitFor(
      async () => {
        const items = await this.listInteractions(operationId);
        found = items.find((item) => item.status === "pending");
        return Boolean(found);
      },
      { timeoutMs: this.timeoutMs, label: `pending-interaction:${operationId}` }
    );
    if (!found) throw new Error("real_process_lifecycle_interaction_missing");
    return found;
  }

  async settlePermission(
    operationId: string,
    interaction: OperatorInteractionView,
    decision: "allow_once" | "deny" = "allow_once"
  ): Promise<OperatorInteractionView> {
    const view = await this.observe(operationId);
    const response = await fetch(
      `${this.harness.origin}/api/v1/remote-operations/${encodeURIComponent(operationId)}/interactions/respond`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          type: "interaction.permission_response",
          actionId: interaction.request.actionId,
          dispatchId: view.dispatchId,
          leaseId: view.attempt.leaseId,
          executionAttemptId: view.executionAttemptId,
          acpSessionId: interaction.request.acpSessionId,
          decision
        })
      }
    );
    const body = (await response.json()) as OperatorInteractionView & { error?: string };
    if (response.status !== 200) {
      throw new Error(
        `real_process_lifecycle_settle_failed:${response.status}:${body.error ?? JSON.stringify(body)}`
      );
    }
    return body;
  }

  async cancel(
    operationId: string,
    reason = "operator cancelled from lifecycle harness"
  ): Promise<unknown> {
    const view = await this.observe(operationId);
    if (!view.attempt.leaseId) throw new Error("real_process_lifecycle_cancel_missing_lease");
    const response = await fetch(
      `${this.harness.origin}/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          actionId: `action-cancel-${view.executionAttemptId}`,
          operationId: view.operationId,
          dispatchId: view.dispatchId,
          executionAttemptId: view.executionAttemptId,
          expectedAttemptVersion: view.attempt.stateVersion,
          kind: "cancel",
          leaseId: view.attempt.leaseId,
          reason
        })
      }
    );
    const body = await response.json();
    if (response.status !== 202) {
      throw new Error(
        `real_process_lifecycle_cancel_failed:${response.status}:${JSON.stringify(body)}`
      );
    }
    return body;
  }

  listHosts(): Promise<{
    items: Array<{
      id: string;
      displayName: string;
      capacity: number;
      capabilities: string[];
      lastSeenAt?: string;
    }>;
  }> {
    return fetch(`${this.harness.origin}/api/v1/hosts`, { headers: this.headers() }).then(
      async (response) => {
        if (!response.ok) throw new Error(`real_process_lifecycle_hosts_failed:${response.status}`);
        return response.json() as Promise<{
          items: Array<{
            id: string;
            displayName: string;
            capacity: number;
            capabilities: string[];
            lastSeenAt?: string;
          }>;
        }>;
      }
    );
  }

  serverDatabasePath(): string {
    return join(this.harness.paths.serverData, "planweave-server.sqlite");
  }

  async listAgentEndpoints(): Promise<RemoteAgentEndpointList> {
    const response = await fetch(
      `${this.harness.origin}/api/v1/agent-endpoints?projectId=${encodeURIComponent(this.harness.projectId)}`,
      { headers: this.headers() }
    );
    const body: unknown = await response.json();
    if (response.status !== 200) {
      const error =
        typeof body === "object" && body !== null && "error" in body
          ? String(body.error)
          : JSON.stringify(body);
      throw new Error(`real_process_lifecycle_endpoints_failed:${response.status}:${error}`);
    }
    return remoteAgentEndpointListSchema.parse(body);
  }

  async availableAgentEndpoints(): Promise<RemoteAgentEndpoint[]> {
    const page = await this.listAgentEndpoints();
    return page.items.filter((endpoint) => endpoint.status === "available");
  }

  async agentEndpointForHostDisplayName(hostDisplayName: string): Promise<RemoteAgentEndpoint> {
    const matches = (await this.listAgentEndpoints()).items.filter(
      (endpoint) => endpoint.hostDisplayName === hostDisplayName
    );
    if (matches.length !== 1) {
      throw new Error(
        `real_process_lifecycle_endpoint_host_mismatch:${hostDisplayName}:${matches.length}`
      );
    }
    return matches[0];
  }

  async availableAgentEndpointForHostDisplayName(
    hostDisplayName: string
  ): Promise<AvailableAgentEndpoint> {
    const endpoint = await this.agentEndpointForHostDisplayName(hostDisplayName);
    if (endpoint.status !== "available") {
      throw new Error(
        `real_process_lifecycle_endpoint_host_unavailable:${hostDisplayName}:${endpoint.unavailableReason}`
      );
    }
    return endpoint;
  }

  async availableAgentEndpointId(): Promise<string> {
    const endpoint = (await this.availableAgentEndpoints())[0];
    if (!endpoint) throw new Error("real_process_lifecycle_endpoint_failed:missing_endpoint");
    return endpoint.endpointId;
  }

  hostDatabasePath(dataDir = this.harness.paths.hostData): string {
    return join(dataDir, "state.sqlite");
  }

  readServerDispatch(dispatchId: string): ServerDispatchRow {
    const database = openSqlite(this.serverDatabasePath());
    try {
      const row = database
        .prepare(
          "SELECT id,status,host_id,lease_id,execution_attempt_id,result_json,failure_json FROM dispatches WHERE id=?"
        )
        .get(dispatchId) as ServerDispatchRow | undefined;
      if (!row) throw new Error(`real_process_lifecycle_dispatch_row_missing:${dispatchId}`);
      return row;
    } finally {
      database.close();
    }
  }

  readServerEnvelope(dispatchId: string): Record<string, unknown> {
    const database = openSqlite(this.serverDatabasePath());
    try {
      const row = database
        .prepare("SELECT canonical_json FROM dispatch_execution_envelopes WHERE dispatch_id=?")
        .get(dispatchId) as { canonical_json?: string } | undefined;
      if (!row?.canonical_json) {
        throw new Error(`real_process_lifecycle_envelope_missing:${dispatchId}`);
      }
      return JSON.parse(row.canonical_json) as Record<string, unknown>;
    } finally {
      database.close();
    }
  }

  readServerArtifactLinks(dispatchId: string): Array<Record<string, unknown>> {
    const database = openSqlite(this.serverDatabasePath());
    try {
      return database
        .prepare(
          `SELECT project_id,host_id,dispatch_id,lease_id,execution_attempt_id,artifact_ref,
                  purpose,permission,logical_name,grant_id,produced_by_host_id,linked_at
           FROM dispatch_artifact_links WHERE dispatch_id=? ORDER BY link_id`
        )
        .all(dispatchId);
    } finally {
      database.close();
    }
  }

  readOperationDiagnostic(operationId: string): {
    diagnostic_code: string | null;
    diagnostic_message: string | null;
    state: string;
  } {
    const database = openSqlite(this.serverDatabasePath());
    try {
      const row = database
        .prepare(
          "SELECT diagnostic_code,diagnostic_message,state FROM remote_operations WHERE id=?"
        )
        .get(operationId) as
        | { diagnostic_code: string | null; diagnostic_message: string | null; state: string }
        | undefined;
      if (!row) throw new Error(`real_process_lifecycle_operation_missing:${operationId}`);
      return row;
    } finally {
      database.close();
    }
  }

  readHostTerminalReceipt(
    dispatchId: string,
    hostDataDir = this.harness.paths.hostData
  ):
    | {
        execution_attempt_id: string;
        terminal_kind: string;
        terminal_payload_digest: string;
      }
    | undefined {
    const database = openSqlite(this.hostDatabasePath(hostDataDir));
    try {
      return database
        .prepare(
          `SELECT execution_attempt_id,terminal_kind,terminal_payload_digest
           FROM agent_host_terminal_execution_receipts
           WHERE dispatch_id=?`
        )
        .get(dispatchId) as
        | {
            execution_attempt_id: string;
            terminal_kind: string;
            terminal_payload_digest: string;
          }
        | undefined;
    } finally {
      database.close();
    }
  }

  /** Read Host credential token from the harness-owned Host data directory (not Server). */
  readHostCredential(hostDataDir = this.harness.paths.hostData): {
    hostId: string;
    credentialToken: string;
  } {
    const path = join(hostDataDir, "credentials.json");
    if (!existsSync(path))
      throw new Error(`real_process_lifecycle_host_credential_missing:${path}`);
    const document = JSON.parse(readFileSync(path, "utf8")) as {
      active?: { hostId?: string; credentialToken?: string };
    };
    const hostId = document.active?.hostId;
    const credentialToken = document.active?.credentialToken;
    if (typeof hostId !== "string" || typeof credentialToken !== "string") {
      throw new Error("real_process_lifecycle_host_credential_inactive");
    }
    return { hostId, credentialToken };
  }

  artifactUrl(input: {
    hostId: string;
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
    sha256: string;
  }): string {
    return (
      `${this.harness.origin}/agent-hosts/${encodeURIComponent(input.hostId)}` +
      `/dispatches/${encodeURIComponent(input.dispatchId)}` +
      `/leases/${encodeURIComponent(input.leaseId)}` +
      `/attempts/${encodeURIComponent(input.executionAttemptId)}` +
      `/artifacts/${encodeURIComponent(input.sha256)}`
    );
  }

  /** Read content-addressed artifact bytes from the Server data directory. */
  readServerArtifactBytes(artifactRef: string): Buffer {
    const match = /^artifact:sha256:([a-f0-9]{64})$/.exec(artifactRef);
    if (!match) throw new Error(`real_process_lifecycle_artifact_ref_invalid:${artifactRef}`);
    const sha256 = match[1];
    const path = join(
      this.harness.paths.serverData,
      "artifacts",
      "sha256",
      sha256.slice(0, 2),
      sha256
    );
    if (!existsSync(path))
      throw new Error(`real_process_lifecycle_artifact_blob_missing:${sha256}`);
    const bytes = readFileSync(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== sha256) throw new Error("real_process_lifecycle_artifact_digest_mismatch");
    return bytes;
  }

  serverArtifactBlobExists(artifactRef: string): boolean {
    const match = /^artifact:sha256:([a-f0-9]{64})$/.exec(artifactRef);
    if (!match) throw new Error(`real_process_lifecycle_artifact_ref_invalid:${artifactRef}`);
    const sha256 = match[1];
    return existsSync(
      join(this.harness.paths.serverData, "artifacts", "sha256", sha256.slice(0, 2), sha256)
    );
  }

  readServerEnvelopeCanonical(dispatchId: string): string {
    const database = openSqlite(this.serverDatabasePath());
    try {
      const row = database
        .prepare("SELECT canonical_json FROM dispatch_execution_envelopes WHERE dispatch_id=?")
        .get(dispatchId) as { canonical_json?: string } | undefined;
      if (!row?.canonical_json) {
        throw new Error(`real_process_lifecycle_envelope_missing:${dispatchId}`);
      }
      return row.canonical_json;
    } finally {
      database.close();
    }
  }
}
