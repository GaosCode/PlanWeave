import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse
} from "node:http";
import {
  OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
  OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER
} from "@planweave-ai/agent-host-protocol";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { remoteAgentEndpointListSchema } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { canvasRuntimeAvailabilityV2Schema } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import { canvasAccessPageSchema } from "@planweave-ai/collaboration-protocol/access/project";
import {
  ownerCanvasMaterializationHeadViewSchema,
  ownerCanvasMaterializationResultSchema
} from "@planweave-ai/collaboration-protocol/owner-canvas/materialization";
import {
  remoteDispatchIntentV3Schema,
  remoteEndpointOperationObservationSchema,
  remoteEventReplaySchema,
  remoteInteractionPageSchema,
  remoteInteractionResponseSchema,
  remoteInteractionViewSchema,
  type RemoteDispatchIntentV3,
  type RemoteInteractionView,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { workAuthorityProjectionSchema } from "@planweave-ai/collaboration-protocol/work/authority";
import {
  collaborationWorkScopeSchema,
  type CollaborationWorkScope
} from "@planweave-ai/collaboration-protocol/work/responsibility";

export const workspaceExecutionToken = `pw_hdev_${"a".repeat(43)}`;
export const ownerExecutionOperatorToken = "operator_token_abcdefghijklmnopqrstuvwxyz_1234";
export const ownerExecutionHumanPrincipalId = "human-owner-1";

const endpoint = {
  schemaVersion: "agent-endpoint/v1" as const,
  endpointId: "endpoint-codex",
  profileId: "codex-acp",
  agentId: "codex",
  displayName: "Codex",
  hostDisplayName: "Build Host",
  capabilities: ["acp.codex"],
  status: "available" as const
};

export type WorkspaceExecutionRegistryCanvas = {
  canvasId: string;
  publishSource: { localProjectId: string; localCanvasId: string } | null;
};

type DispatchMode =
  | "action_required"
  | "hold_for_recovery"
  | "completed"
  | "failed"
  | "cancelled"
  | "writeback_failed";
type InteractionKind = "permission" | "elicitation" | "authentication";
type SettlementFailure = "expired" | "settled" | "forbidden";
export type WorkspaceExecutionHttpFailure = {
  stage: "catalog" | "authority" | "dispatch";
  status: 400 | 403 | 409 | 500 | 503;
  code: string;
};

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readText(request: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  return JSON.parse(await readText(request));
}

export class WorkspaceExecutionHttpHarness {
  readonly calls: string[] = [];
  readonly recoveryQueries: URLSearchParams[] = [];
  readonly replayQueries: number[] = [];
  readonly authorityScopes: CollaborationWorkScope[] = [];
  readonly catalogCanvasIds: string[] = [];
  readonly dispatchReceived: Promise<void>;
  private resolveDispatchReceived!: () => void;
  private server: Server | null = null;
  private dispatchIntent: RemoteDispatchIntentV3 | null = null;
  private ownerOperation = false;
  private ownerMaterializedDigest: string | null = null;
  private readonly settledInteractions = new Set<number>();
  private settlementFailure: SettlementFailure | null = null;

  constructor(
    private readonly input: {
      sourceRevision: string;
      graphFingerprint: string;
      dispatchMode: DispatchMode;
      endpointCount?: number;
      interactionKinds?: readonly InteractionKind[];
      duplicateActionId?: boolean;
      authorityMismatch?: boolean;
      replayTransition?: boolean;
      httpFailure?: WorkspaceExecutionHttpFailure;
      recoveryMiss?: boolean;
      registryCanvases: readonly WorkspaceExecutionRegistryCanvas[];
      registryPageSize?: number;
      ownerHumanPrincipalId?: string;
      ownerAccessMode?: "unrestricted" | "workspace_restricted";
      terminalResultMismatch?: boolean;
    }
  ) {
    this.dispatchReceived = new Promise((resolve) => {
      this.resolveDispatchReceived = resolve;
    });
  }

  async start(): Promise<string> {
    this.server = createServer(async (request, response) => {
      try {
        await this.route(request, response);
      } catch {
        if (!response.headersSent) writeJson(response, 500, { error: "fake_server_failure" });
        else response.destroy();
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("fake_server_address_missing");
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
  }

  expireInteraction(): void {
    this.settlementFailure = "expired";
  }

  rejectNextSettlementAs(failure: SettlementFailure): void {
    this.settlementFailure = failure;
  }

  seedPersistedOperation(): void {
    this.dispatchIntent = remoteDispatchIntentV3Schema.parse({
      schemaVersion: "remote-run/v3",
      projectId: "project-1",
      canvasId: "default",
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-codex",
      idempotencyKey: "pre-t005-dispatch",
      expectedResponsibilityRevision: 1,
      expectedReviewerRevision: 2,
      executionTargetRevision: 3,
      contentRevision: this.input.sourceRevision,
      graphFingerprint: this.input.graphFingerprint
    });
  }

  get dispatchCount(): number {
    return this.calls.filter((call) => call === "POST /api/v1/projects/project-1/remote-operations")
      .length;
  }

  get catalogCount(): number {
    return this.calls.filter((call) => call.endsWith("/agent-endpoints")).length;
  }

  get ownerCatalogCount(): number {
    return this.calls.filter((call) => call === "GET /api/v1/agent-endpoints").length;
  }

  get ownerDispatchCount(): number {
    return this.calls.filter((call) => call === "POST /api/v1/remote-operations").length;
  }

  get workspaceScopedRemoteCalls(): string[] {
    return this.calls.filter((call) => call.includes("/api/v1/projects/"));
  }

  get ownerTerminalResultCount(): number {
    return this.calls.filter((call) => call.endsWith("/terminal-result")).length;
  }

  readonly ownerTerminalResultAuth: Array<{
    hasOperatorAuthorization: boolean;
    hasHumanIdentity: boolean;
    usedWorkspaceToken: boolean;
  }> = [];

  private async route(
    request: AsyncIterable<Uint8Array> & { method?: string; url?: string },
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    if (await this.routeOwner(request, url, method, response)) return;

    if (url.pathname.endsWith("/assignments/authority") && method === "GET") {
      if (this.input.httpFailure?.stage === "authority") {
        writeJson(response, this.input.httpFailure.status, { error: this.input.httpFailure.code });
        return;
      }
      const rawScope = url.searchParams.get("scope");
      const parsedScope = collaborationWorkScopeSchema.safeParse(
        rawScope === null ? null : JSON.parse(rawScope)
      );
      if (!parsedScope.success || url.searchParams.size !== 1) {
        writeJson(response, 400, { error: "fake_authority_scope_invalid" });
        return;
      }
      this.authorityScopes.push(parsedScope.data);
      writeJson(response, 200, this.workAuthority(parsedScope.data));
      return;
    }
    if (url.pathname === "/api/v1/registry/projects/project-1/canvases" && method === "GET") {
      const cursor = Number(url.searchParams.get("cursor"));
      const limit = Number(url.searchParams.get("limit"));
      if (
        url.searchParams.size !== 2 ||
        !Number.isInteger(cursor) ||
        cursor < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      ) {
        writeJson(response, 400, { error: "fake_registry_query_invalid" });
        return;
      }
      const canvases = this.registryCanvases();
      const pageSize = Math.min(limit, this.input.registryPageSize ?? limit);
      const items = canvases.slice(cursor, cursor + pageSize).map((canvas, index) => ({
        schemaVersion: "project-access/v1" as const,
        registry: {
          projectRegistryId: "registry-project-1",
          canvasRegistryId: `registry-canvas-${cursor + index + 1}`,
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: canvas.canvasId
        },
        visibility: "shared" as const,
        acl: { revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" },
        owner: "human-1",
        publishSource: canvas.publishSource,
        updatedAt: "2030-01-01T00:00:00.000Z"
      }));
      writeJson(
        response,
        200,
        canvasAccessPageSchema.parse({
          items,
          nextCursor: cursor + items.length < canvases.length ? cursor + items.length : null
        })
      );
      return;
    }
    if (url.pathname.endsWith("/runtime-availability") && method === "GET") {
      writeJson(response, 200, this.runtimeAvailability());
      return;
    }
    if (url.pathname.endsWith("/agent-endpoints") && method === "GET") {
      if (this.input.httpFailure?.stage === "catalog") {
        writeJson(response, this.input.httpFailure.status, { error: this.input.httpFailure.code });
        return;
      }
      const canvasId = url.searchParams.get("canvasId");
      if (
        url.searchParams.size !== 2 ||
        url.searchParams.get("workspaceId") !== "workspace-1" ||
        !canvasId
      ) {
        writeJson(response, 400, { error: "fake_catalog_scope_invalid" });
        return;
      }
      this.catalogCanvasIds.push(canvasId);
      const count = this.input.endpointCount ?? 1;
      writeJson(
        response,
        200,
        remoteAgentEndpointListSchema.parse({
          schemaVersion: "agent-endpoint-list/v1",
          items: Array.from({ length: count }, (_, index) => ({
            ...endpoint,
            endpointId: index === 0 ? endpoint.endpointId : `endpoint-codex-${index + 1}`
          }))
        })
      );
      return;
    }
    if (url.pathname.endsWith("/remote-operations") && method === "POST") {
      this.dispatchIntent = remoteDispatchIntentV3Schema.parse(await readJson(request));
      this.resolveDispatchReceived();
      if (this.input.httpFailure?.stage === "dispatch") {
        writeJson(response, this.input.httpFailure.status, { error: this.input.httpFailure.code });
        return;
      }
      if (
        this.input.dispatchMode === "hold_for_recovery" &&
        !(this.input.recoveryMiss === true && this.dispatchCount > 1)
      )
        return;
      writeJson(response, 202, this.observation(this.operationState(), 1));
      return;
    }
    if (url.pathname.endsWith("/remote-operations") && method === "GET") {
      this.recoveryQueries.push(new URLSearchParams(url.searchParams));
      const key = url.searchParams.get("idempotencyKey");
      writeJson(
        response,
        200,
        !this.input.recoveryMiss &&
          this.dispatchIntent &&
          key === this.dispatchIntent.idempotencyKey
          ? this.observation("completed", 2)
          : null
      );
      return;
    }
    if (url.pathname.endsWith("/events") && method === "GET") {
      const afterCursor = Number(url.searchParams.get("afterCursor") ?? "0");
      this.replayQueries.push(afterCursor);
      if (this.replayTransitionCompleted()) {
        const firstPage = afterCursor === 0;
        writeJson(
          response,
          200,
          remoteEventReplaySchema.parse({
            eventProtocolVersion: 2,
            executionAttemptId: "attempt-2",
            afterCursor,
            cursor: firstPage ? 2 : 3,
            highWatermark: 3,
            hasMore: firstPage,
            events: [
              {
                eventVersion: 2,
                cursor: firstPage ? 2 : 3,
                sourceSequence: firstPage ? 20 : 21,
                timestamp: firstPage ? "2030-01-01T00:00:02.000Z" : "2030-01-01T00:00:03.000Z",
                fragment: {
                  kind: "runner_body",
                  body: {
                    kind: "output",
                    stream: "stdout",
                    content: firstPage ? "resumed" : "completed",
                    redaction: { classes: [], replaced: 0 }
                  }
                }
              }
            ],
            ...(firstPage
              ? {
                  diagnostics: [
                    {
                      code: "remote_acp_event_retention_gap",
                      droppedThroughCursor: 1
                    }
                  ]
                }
              : {})
          })
        );
        return;
      }
      writeJson(
        response,
        200,
        remoteEventReplaySchema.parse({
          eventProtocolVersion: 2,
          executionAttemptId: "attempt-1",
          afterCursor,
          cursor: afterCursor,
          highWatermark: afterCursor,
          hasMore: false,
          events: []
        })
      );
      return;
    }
    if (url.pathname.endsWith("/interactions/respond") && method === "POST") {
      const settlement = remoteInteractionResponseSchema.parse(await readJson(request));
      const failure = this.settlementFailure;
      this.settlementFailure = null;
      if (failure) {
        writeJson(response, failure === "forbidden" ? 403 : 409, {
          error:
            failure === "settled"
              ? "remote_interaction_already_settled"
              : failure === "expired"
                ? "remote_interaction_expired"
                : "human_cross_project_forbidden"
        });
        return;
      }
      const index = this.interactionRequests().findIndex(
        (candidate) =>
          candidate.actionId === settlement.actionId &&
          candidate.dispatchId === settlement.dispatchId &&
          candidate.leaseId === settlement.leaseId &&
          candidate.executionAttemptId === settlement.executionAttemptId &&
          candidate.acpSessionId === settlement.acpSessionId
      );
      if (index < 0) {
        writeJson(response, 404, { error: "remote_interaction_not_found" });
        return;
      }
      this.settledInteractions.add(index);
      writeJson(response, 200, this.interaction(index, "settled", settlement));
      return;
    }
    if (url.pathname.endsWith("/interactions") && method === "GET") {
      writeJson(
        response,
        200,
        remoteInteractionPageSchema.parse({
          items: this.interactionRequests()
            .map((_request, index) => index)
            .filter((index) => !this.settledInteractions.has(index))
            .map((index) => this.interaction(index, "pending")),
          nextCursor: null
        })
      );
      return;
    }
    if (/\/remote-operations\/operation-1$/.test(url.pathname) && method === "GET") {
      writeJson(response, 200, this.observation(this.operationState(), 2));
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  }

  private async routeOwner(
    request: AsyncIterable<Uint8Array> & {
      method?: string;
      url?: string;
      headers?: IncomingHttpHeaders;
    },
    url: URL,
    method: string,
    response: ServerResponse
  ): Promise<boolean> {
    const ownerPrincipal = this.input.ownerHumanPrincipalId ?? ownerExecutionHumanPrincipalId;
    const ownerCatalog = url.pathname === "/api/v1/agent-endpoints" && method === "GET";
    const ownerDispatch = url.pathname === "/api/v1/remote-operations" && method === "POST";
    const ownerHead =
      url.pathname === "/api/v1/owner-canvas-materializations/head" && method === "GET";
    const ownerMaterialize =
      url.pathname === "/api/v1/owner-canvas-materializations" && method === "POST";
    const ownerTerminalResult =
      /^\/api\/v1\/remote-operations\/[^/]+\/terminal-result$/.test(url.pathname) &&
      method === "GET";
    if (
      !ownerCatalog &&
      !ownerDispatch &&
      !ownerHead &&
      !ownerMaterialize &&
      !ownerTerminalResult
    ) {
      return false;
    }
    if (url.searchParams.has("workspaceId")) {
      writeJson(response, 400, { error: "fake_owner_workspace_scope_invalid" });
      return true;
    }
    if (this.input.ownerAccessMode === "workspace_restricted") {
      writeJson(response, 403, { error: "remote_agent_workspace_scope_forbidden" });
      return true;
    }
    if (ownerCatalog) {
      if (this.input.httpFailure?.stage === "catalog") {
        writeJson(response, this.input.httpFailure.status, { error: this.input.httpFailure.code });
        return true;
      }
      const canvasId = url.searchParams.get("canvasId");
      const projectId = url.searchParams.get("projectId");
      const humanPrincipalId = url.searchParams.get("humanPrincipalId");
      if (
        url.searchParams.size !== 3 ||
        !canvasId ||
        !projectId ||
        humanPrincipalId !== ownerPrincipal
      ) {
        writeJson(response, 400, { error: "fake_owner_catalog_scope_invalid" });
        return true;
      }
      this.catalogCanvasIds.push(canvasId);
      const count = this.input.endpointCount ?? 1;
      writeJson(
        response,
        200,
        remoteAgentEndpointListSchema.parse({
          schemaVersion: "agent-endpoint-list/v1",
          items: Array.from({ length: count }, (_, index) => ({
            ...endpoint,
            endpointId: index === 0 ? endpoint.endpointId : `endpoint-codex-${index + 1}`
          }))
        })
      );
      return true;
    }
    if (ownerHead) {
      writeJson(
        response,
        200,
        ownerCanvasMaterializationHeadViewSchema.parse({
          schemaVersion: "owner-canvas-materialization/v1",
          scope: {
            ownerHumanPrincipalId: ownerPrincipal,
            projectId: url.searchParams.get("projectId") ?? "project-1",
            canvasId: url.searchParams.get("canvasId") ?? "default"
          },
          head: this.ownerMaterializedDigest
            ? {
                kind: "present",
                revision: 1,
                content: {
                  versionId: `version-${this.ownerMaterializedDigest}`,
                  canonicalDigest: this.ownerMaterializedDigest,
                  verification: "complete"
                }
              }
            : { kind: "absent" }
        })
      );
      return true;
    }
    if (ownerMaterialize) {
      const frames = (await readText(request))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const header = frames[0] as {
        request: { materializationId: string; scope: Record<string, string> };
      };
      const complete = frames.at(-1) as { canonicalDigest: string };
      this.ownerMaterializedDigest = complete.canonicalDigest;
      writeJson(
        response,
        201,
        ownerCanvasMaterializationResultSchema.parse({
          schemaVersion: "owner-canvas-materialization/v1",
          materializationId: header.request.materializationId,
          scope: header.request.scope,
          head: {
            revision: 1,
            content: {
              versionId: `version-${complete.canonicalDigest}`,
              canonicalDigest: complete.canonicalDigest,
              verification: "complete"
            }
          },
          contentRevision: this.input.sourceRevision,
          graphFingerprint: this.input.graphFingerprint
        })
      );
      return true;
    }
    if (ownerTerminalResult) {
      const headers = request.headers ?? {};
      const authorization = headers.authorization ?? headers.Authorization;
      const identity =
        headers["x-planweave-human-identity"] ?? headers["X-Planweave-Human-Identity"];
      this.ownerTerminalResultAuth.push({
        hasOperatorAuthorization: authorization === `Bearer ${ownerExecutionOperatorToken}`,
        hasHumanIdentity: typeof identity === "string" && identity.startsWith("Bearer "),
        usedWorkspaceToken: authorization === `Bearer ${workspaceExecutionToken}`
      });
      if (!this.dispatchIntent) {
        writeJson(response, 404, { error: "not_found" });
        return true;
      }
      const attemptId = this.replayTransitionCompleted() ? "attempt-2" : "attempt-1";
      const dispatchId = this.replayTransitionCompleted() ? "dispatch-2" : "dispatch-1";
      const report = Buffer.from("# owner-canvas report\n");
      const metadata = {
        operationId: this.input.terminalResultMismatch ? "operation-mismatch" : "operation-1",
        projectId: this.dispatchIntent.projectId,
        canvasId: this.dispatchIntent.canvasId,
        blockRef: this.dispatchIntent.blockRef,
        controlPlane: "owner",
        sourceRevision: this.input.sourceRevision,
        graphFingerprint: this.input.graphFingerprint,
        dispatchId,
        executionAttemptId: attemptId,
        reportArtifactRef: `artifact:sha256:${createHash("sha256").update(report).digest("hex")}`
      };
      response.writeHead(200, {
        "content-type": OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
        "content-length": report.byteLength,
        [OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER]: Buffer.from(
          JSON.stringify(metadata),
          "utf8"
        ).toString("base64url")
      });
      response.end(report);
      return true;
    }
    const payload = (await readJson(request)) as Record<string, unknown>;
    if (payload.workspaceId !== undefined) {
      writeJson(response, 400, { error: "fake_owner_workspace_scope_invalid" });
      return true;
    }
    if (payload.humanPrincipalId !== ownerPrincipal) {
      writeJson(response, 403, { error: "remote_agent_workspace_scope_forbidden" });
      return true;
    }
    const { humanPrincipalId: _humanPrincipalId, ...intent } = payload;
    this.ownerOperation = true;
    this.dispatchIntent = remoteDispatchIntentV3Schema.parse(intent);
    this.resolveDispatchReceived();
    if (this.input.httpFailure?.stage === "dispatch") {
      writeJson(response, this.input.httpFailure.status, { error: this.input.httpFailure.code });
      return true;
    }
    writeJson(response, 202, this.observation(this.operationState(), 1));
    return true;
  }

  private registryCanvases(): readonly WorkspaceExecutionRegistryCanvas[] {
    return this.input.registryCanvases;
  }

  private workAuthority(scope: CollaborationWorkScope) {
    return workAuthorityProjectionSchema.parse({
      schemaVersion: "work-authority/v1",
      scope,
      responsibility: {
        schemaVersion: "responsibility/v1",
        scope,
        principal: null,
        revision: 1,
        updatedAt: "2030-01-01T00:00:00.000Z",
        availability: "unassigned"
      },
      reviewer: {
        schemaVersion: "review-assignment/v1",
        scope,
        principal: null,
        revision: 2,
        updatedAt: "2030-01-01T00:00:00.000Z",
        availability: "unassigned"
      },
      executionTarget: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: "host-1" },
        revision: 3,
        updatedAt: "2030-01-01T00:00:00.000Z",
        availability: { status: "ready", reason: "ready" }
      },
      revisions: {
        responsibilityRevision: 1,
        reviewerRevision: 2,
        executionTargetRevision: 3
      },
      selectedHost: null,
      evaluatedAt: "2030-01-01T00:00:00.000Z"
    });
  }

  private runtimeAvailability() {
    return canvasRuntimeAvailabilityV2Schema.parse({
      schemaVersion: "canvas-runtime-view/v2",
      authority: {
        revision: 1,
        sourceRevision: this.input.authorityMismatch
          ? "snapshot:authority-mismatch"
          : this.input.sourceRevision,
        graphFingerprint: this.input.graphFingerprint
      },
      state: { kind: "uninitialized" },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "host_offline"
      }
    });
  }

  private operationState(): "action_required" | "completed" | "failed" | "cancelled" {
    if (this.input.dispatchMode === "hold_for_recovery") return "completed";
    if (this.replayTransitionCompleted()) return "completed";
    return this.input.dispatchMode === "writeback_failed" ? "failed" : this.input.dispatchMode;
  }

  private replayTransitionCompleted(): boolean {
    return (
      this.input.replayTransition === true &&
      this.settledInteractions.size === this.interactionRequests().length
    );
  }

  private observation(
    state: "action_required" | "completed" | "failed" | "cancelled",
    revision: number
  ): RemoteOperationObservation {
    if (!this.dispatchIntent) throw new Error("dispatch_intent_missing");
    const attemptId = this.replayTransitionCompleted() ? "attempt-2" : "attempt-1";
    const dispatchId = this.replayTransitionCompleted() ? "dispatch-2" : "dispatch-1";
    return remoteEndpointOperationObservationSchema.parse({
      operationId: "operation-1",
      projectId: this.dispatchIntent.projectId,
      canvasId: this.dispatchIntent.canvasId,
      blockRef: this.dispatchIntent.blockRef,
      state,
      dispatchId,
      executionAttemptId: attemptId,
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: `2030-01-01T00:00:0${revision}.000Z`,
      ...(["completed", "failed", "cancelled"].includes(state)
        ? { terminalAt: "2030-01-01T00:00:02.000Z" }
        : {}),
      agentEndpoint: { ...endpoint, resolvedAt: "2030-01-01T00:00:00.000Z" },
      attempt: {
        executionAttemptId: attemptId,
        dispatchId,
        status: state,
        leaseId: "lease-1",
        leaseExpiresAt: "2030-01-01T01:00:00.000Z",
        stateVersion: revision
      },
      diagnostics: {
        stage: state === "action_required" ? "running" : "terminal",
        revision,
        attemptId,
        locator: {
          workspaceId: "workspace-1",
          projectId: this.dispatchIntent.projectId,
          canvasId: this.dispatchIntent.canvasId
        },
        endpointId: endpoint.endpointId,
        authorityRevisions: this.ownerOperation
          ? { responsibility: 0, reviewer: 0, executionTarget: 0 }
          : { responsibility: 1, reviewer: 2, executionTarget: 3 },
        content: {
          revision: this.input.sourceRevision,
          fingerprint: this.input.graphFingerprint
        },
        startedAt: "2030-01-01T00:00:00.000Z",
        updatedAt: `2030-01-01T00:00:0${revision}.000Z`,
        ...(["completed", "failed", "cancelled"].includes(state)
          ? { terminalAt: "2030-01-01T00:00:02.000Z" }
          : {}),
        ...(this.input.dispatchMode === "writeback_failed"
          ? {
              error: {
                code: "remote_writeback_failed",
                retryable: false
              }
            }
          : {})
      },
      ...(this.input.dispatchMode === "writeback_failed"
        ? {
            failure: {
              code: "remote_writeback_failed",
              message: "Remote writeback failed.",
              retryable: false
            }
          }
        : {}),
      runtime: {
        ref: "T-001#B-001",
        status:
          state === "completed"
            ? "completed"
            : state === "failed"
              ? "failed"
              : state === "cancelled"
                ? "stopped"
                : "in_progress"
      }
    });
  }

  private interactionRequests(): RemoteInteractionView["request"][] {
    return (this.input.interactionKinds ?? ["permission"]).map((kind, index) => {
      const identity = {
        dispatchId: "dispatch-1",
        leaseId: "lease-1",
        executionAttemptId: "attempt-1",
        actionId: this.input.duplicateActionId ? "action-1" : `action-${index + 1}`,
        acpSessionId: `acp-session-${index + 1}`,
        expiresAt: "2030-01-01T01:00:00.000Z"
      };
      if (kind === "permission") {
        return {
          ...identity,
          type: "interaction.permission_requested" as const,
          title: "Permission",
          description: "Approve tool use"
        };
      }
      if (kind === "elicitation") {
        return {
          ...identity,
          type: "interaction.elicitation_requested" as const,
          prompt: "Provide input",
          options: ["answer"]
        };
      }
      return {
        ...identity,
        type: "interaction.authentication_required" as const,
        agentProfileId: "codex-acp",
        hostInstruction: "Authenticate on the Host"
      };
    });
  }

  private interaction(
    index: number,
    status: RemoteInteractionView["status"],
    settlement?: unknown
  ): RemoteInteractionView {
    return remoteInteractionViewSchema.parse({
      request: this.interactionRequests()[index],
      operationId: "operation-1",
      hostId: "host-1",
      status,
      createdAt: "2030-01-01T00:00:00.000Z",
      ...(settlement
        ? { settlement, settledBy: "human-1", settledAt: "2030-01-01T00:01:00.000Z" }
        : {})
    });
  }
}

export async function writeOperatorExecutionProfiles(input: {
  home: string;
  serverOrigin: string;
  count?: number;
}): Promise<void> {
  const directory = join(input.home, "desktop", "operator-control");
  await mkdir(directory, { recursive: true });
  const count = input.count ?? 1;
  const profiles = Array.from({ length: count }, (_, index) => ({
    profileId: count === 1 ? "profile-1" : `profile-${index}`,
    displayName: `Owner ${index}`,
    serverBaseUrl: input.serverOrigin.endsWith("/") ? input.serverOrigin : `${input.serverOrigin}/`,
    allowInsecureTransport: true,
    updatedAt: "2030-01-01T00:00:00.000Z"
  }));
  await writeFile(
    join(directory, "profiles.json"),
    JSON.stringify({
      version: 1,
      profiles,
      activeProfileId: profiles[0]?.profileId ?? null
    })
  );
}

export async function writeWorkspaceExecutionProfiles(input: {
  home: string;
  serverOrigin: string;
}): Promise<void> {
  const directory = join(input.home, "desktop", "collaboration");
  await mkdir(directory, { recursive: true });
  const profile = {
    profileId: "profile-1",
    displayName: "Profile 1",
    serverBaseUrl: input.serverOrigin,
    projectId: "project-1",
    allowInsecureTransport: true,
    endpoint: {
      topology: "loopback_http",
      serverOrigin: input.serverOrigin,
      allowedClientOrigins: [input.serverOrigin],
      tlsTrust: "not_applicable"
    },
    connectionState: "ready",
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
  await writeFile(
    join(directory, "profiles.json"),
    JSON.stringify({ version: 3, profiles: [profile], activeProfileId: profile.profileId })
  );
  await writeFile(
    join(directory, "workspace-profiles.json"),
    JSON.stringify({
      version: 1,
      profiles: [
        {
          schemaVersion: "workspace-identity/v1",
          profileId: profile.profileId,
          displayName: "Workspace 1",
          serverBaseUrl: input.serverOrigin,
          workspaceId: "workspace-1",
          allowInsecureTransport: true,
          workspaceDisplayName: "Workspace 1",
          membershipRole: "owner",
          membershipActive: true,
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      activeProfileId: profile.profileId
    })
  );
}
