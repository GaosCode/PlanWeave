import { createServer, type Server as HttpServer } from "node:http";
import { RemoteBlockRuntimeError } from "@planweave-ai/runtime";
import { OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE } from "@planweave-ai/collaboration-protocol/remote-run";
import { CONTENT_VERSION_MAX_MEMBERS } from "@planweave-ai/collaboration-protocol/core/limits";
import { ownerCanvasMaterializationUploadMediaType } from "@planweave-ai/collaboration-protocol/owner-canvas/materialization";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEndpointCatalogError } from "../agentEndpointCatalog.js";
import { CanvasRuntimeUnavailableError } from "../canvas/executionRuntimePort.js";
import { OwnerCanvasMaterializationUploadBudget } from "../canvas/ownerCanvasMaterializationHttp.js";
import { CanvasRuntimeRpcError } from "../canvas/runtimeRpcBroker.js";
import { applyMigrations } from "../migrations.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { HumanIdentityCredentialStore } from "../identity/humanIdentityCredentialStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";
import { RemoteExecutionActionRejectedError } from "../remoteExecutionActions.js";
import {
  OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE,
  OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER,
  operatorDispatchRequestSchema,
  operatorOwnerTerminalResultMetadataSchema
} from "../operatorDtos.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { resolveServerBuildRevision } from "../packageInfo.js";
import {
  handleOperatorHttpRequest,
  operatorTransportAllowed,
  type OperatorControlPort
} from "../operatorHttp.js";
import {
  directHttpsTransportAdmission,
  loopbackHttpTransportAdmission
} from "./support/transportAdmission.js";

const servers: HttpServer[] = [];
const databases: SqliteDatabase[] = [];
const token = `pw_operator_${"T".repeat(43)}`;

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
});

const managedAgent = {
  endpointId: "endpoint-1",
  hostId: "host-1",
  displayName: "Codex",
  accessMode: "workspace_restricted" as const,
  allowOwnerCanvas: true,
  ownershipRepairRequired: false,
  ownerHumanPrincipalId: "owner-human-1",
  policyRevision: 1,
  revokedAt: null,
  grants: []
};

function control(): OperatorControlPort {
  return {
    createEnrollmentGrant: vi.fn(() => ({
      enrollmentCode: "pw_enroll_test",
      expiresAt: "2030-01-01T00:00:00.000Z",
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
    })),
    listHosts: vi.fn(() => ({ items: [], nextCursor: null })),
    listAgentEndpoints: vi.fn(() => ({
      schemaVersion: "agent-endpoint-list/v1",
      items: []
    })),
    getHost: vi.fn(),
    revokeHost: vi.fn(),
    requestHostCredentialRenewal: vi.fn(() => ({
      id: "host-1",
      displayName: "Host 1",
      capabilities: [],
      capacity: 1,
      online: true,
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      credentialRenewalRequestedAt: "2030-01-01T00:00:00.000Z",
      availability: { status: "unavailable", reason: "readiness_not_reported" }
    })),
    dispatch: vi.fn(async (_principal, request) => {
      if ((request as { projectId?: string }).projectId === "project-b") {
        throw new Error("operator_project_forbidden");
      }
      return { operationId: "operation-1" };
    }),
    observeOperation: vi.fn(),
    readOwnerOperationTerminalResult: vi.fn(),
    inspectOwnerCanvasMaterializationHead: vi.fn(),
    materializeOwnerCanvas: vi.fn(),
    executeAction: vi.fn(async () => {
      throw new Error("remote_action_attempt_version_conflict");
    }),
    conversation: vi.fn(() => ({ turns: [], cursor: 0 })),
    converse: vi.fn(() => ({ turns: [], cursor: 0 })),
    replayEvents: vi.fn(),
    listPendingInteractions: vi.fn(() => ({ items: [], nextCursor: null })),
    settleInteraction: vi.fn(),
    listRemoteAgents: vi.fn(() => ({
      schemaVersion: "remote-agent-management-list/v1",
      items: []
    })),
    setRemoteAgentAccessMode: vi.fn(() => managedAgent),
    grantRemoteAgentWorkspace: vi.fn(() => managedAgent),
    revokeRemoteAgentGrant: vi.fn(() => managedAgent),
    revokeRemoteAgent: vi.fn(() => managedAgent),
    repairRemoteAgentOwnership: vi.fn(() => managedAgent)
  };
}

async function setup(
  allowInsecureDevelopment: boolean,
  readiness: "ready" | "reconciling" = "ready",
  serverAdmin = true
) {
  const service = control();
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database
    .prepare(
      "INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES(?,?,?)"
    )
    .run("owner-human-1", "Owner", "2030-01-01T00:00:00.000Z");
  const humanIdentity = new HumanIdentityCredentialStore(
    database,
    () => new Date("2030-01-01T00:00:00.000Z")
  ).issue("owner-human-1");
  const workspaceId = new WorkspaceIdentityRepository(database).ensureWorkspaceForLegacyProject(
    "project-a"
  );
  new OperatorSessionStore(database).create({
    workspaceId,
    operatorId: "operator-1",
    credentialSha256: hashOperatorToken(token),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-02T00:00:00.000Z"
  });
  const authorization = new OperatorTokenRegistry(database, [
    {
      operatorId: "operator-1",
      tokenSha256: hashOperatorToken(token),
      projectIds: ["project-a"],
      serverAdmin
    }
  ]);
  const server = createServer((request, response) => {
    void handleOperatorHttpRequest(request, response, {
      authorization,
      humanIdentityCredentials: new HumanIdentityCredentialStore(
        database,
        () => new Date("2030-01-01T00:00:00.000Z")
      ),
      service,
      readiness: () => ({ status: readiness, schemaVersion: 1 }),
      serverVersion: "test",
      serverBuildRevision: "abcdef0123456789",
      limits: { maxArtifactBytes: 1024, maxWebSocketPayloadBytes: 2048 },
      transportAdmission: allowInsecureDevelopment
        ? loopbackHttpTransportAdmission
        : directHttpsTransportAdmission
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    service,
    humanIdentityToken: humanIdentity.identityToken
  };
}

const authorization = { Authorization: `Bearer ${token}` };
const expectedError = (error: string) => ({
  error,
  serverBuildRevision: "abcdef0123456789"
});

describe("operator HTTP boundary", () => {
  it("authenticates conversation replay and passes the cursor without invoking a prompt", async () => {
    const fixture = await setup(true);
    const path = `${fixture.origin}/api/v1/remote-operations/operation-1/conversation?afterCursor=7`;
    expect((await fetch(path)).status).toBe(401);
    expect(fixture.service.conversation).not.toHaveBeenCalled();
    const response = await fetch(path, { headers: authorization });
    expect(response.status).toBe(200);
    expect(fixture.service.conversation).toHaveBeenCalledWith(
      expect.objectContaining({ operatorId: "operator-1" }),
      "operation-1",
      7
    );
    expect(fixture.service.converse).not.toHaveBeenCalled();
  });
  it("keeps legacy operation views by default and negotiates public Runtime views via Accept", async () => {
    const fixture = await setup(true);
    vi.mocked(fixture.service.observeOperation).mockResolvedValue({ operationId: "operation-1" });

    const legacy = await fetch(`${fixture.origin}/api/v1/remote-operations/operation-1`, {
      headers: authorization
    });
    const publicRuntime = await fetch(`${fixture.origin}/api/v1/remote-operations/operation-1`, {
      headers: {
        ...authorization,
        Accept: `application/json, ${OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE}; q=0.9`
      }
    });
    const publicDispatch = await fetch(`${fixture.origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: {
        ...authorization,
        Accept: `${OPERATOR_PUBLIC_RUNTIME_MEDIA_TYPE}; profile=desktop`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ projectId: "project-a" })
    });

    expect(legacy.status).toBe(200);
    expect(legacy.headers.get("vary")).toBe("Accept");
    expect(publicRuntime.status).toBe(200);
    expect(publicRuntime.headers.get("vary")).toBe("Accept");
    expect(publicDispatch.status).toBe(202);
    expect(publicDispatch.headers.get("vary")).toBe("Accept");
    expect(fixture.service.observeOperation).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "operation-1",
      "legacy-rich"
    );
    expect(fixture.service.observeOperation).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "operation-1",
      "public-runtime-v1"
    );
    expect(fixture.service.dispatch).toHaveBeenCalledWith(
      expect.anything(),
      { projectId: "project-a" },
      "public-runtime-v1"
    );
  });

  it("rejects malformed injected build revisions instead of hiding deployment metadata", () => {
    expect(resolveServerBuildRevision({})).toBe("development");
    expect(
      resolveServerBuildRevision({ PLANWEAVE_SERVER_BUILD_REVISION: "abcdef0123456789" })
    ).toBe("abcdef0123456789");
    expect(() =>
      resolveServerBuildRevision({ PLANWEAVE_SERVER_BUILD_REVISION: "not a revision" })
    ).toThrow("server_build_revision_invalid");
  });

  it("lists redacted Agent Endpoints with strict admin-scoped query handling", async () => {
    const fixture = await setup(true);
    vi.mocked(fixture.service.listAgentEndpoints).mockReturnValue({
      schemaVersion: "agent-endpoint-list/v1",
      items: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-1",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "Builder",
          capabilities: ["acp.codex"],
          status: "available"
        }
      ]
    });

    const fleetUrl = `${fixture.origin}/api/v1/agent-endpoints`;
    const fleet = await fetch(fleetUrl, { headers: authorization });
    expect(fleet.status).toBe(200);
    expect(fixture.service.listAgentEndpoints).toHaveBeenCalledWith(
      expect.objectContaining({ serverAdmin: true }),
      {}
    );

    const endpointUrl = `${fixture.origin}/api/v1/agent-endpoints?projectId=project-a`;
    const first = await fetch(endpointUrl, { headers: authorization });
    const second = await fetch(endpointUrl, { headers: authorization });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json();
    expect(await second.json()).toEqual(firstBody);
    expect(fixture.service.listAgentEndpoints).toHaveBeenCalledWith(
      expect.objectContaining({ serverAdmin: true }),
      { projectId: "project-a" }
    );
    expect(JSON.stringify(firstBody)).not.toMatch(/hostId|path|env|token|readiness/i);

    const locatorUrl = `${fixture.origin}/api/v1/agent-endpoints?projectId=project-a&humanPrincipalId=owner-human-1&canvasId=canvas-main&workspaceId=workspace-a`;
    const locator = await fetch(locatorUrl, { headers: authorization });
    expect(locator.status).toBe(200);
    expect(fixture.service.listAgentEndpoints).toHaveBeenCalledWith(
      expect.objectContaining({ serverAdmin: true }),
      {
        projectId: "project-a",
        humanPrincipalId: "owner-human-1",
        canvasId: "canvas-main",
        workspaceId: "workspace-a"
      }
    );

    const workspaceMember = await setup(true, "ready", false);
    const workspaceLocator = await fetch(
      locatorUrl.replace(fixture.origin, workspaceMember.origin),
      {
        headers: {
          ...authorization,
          "x-planweave-human-identity": `Bearer ${workspaceMember.humanIdentityToken}`
        }
      }
    );
    expect(workspaceLocator.status).toBe(200);
    expect(workspaceMember.service.listAgentEndpoints).toHaveBeenCalledWith(
      expect.objectContaining({
        serverAdmin: false,
        workspaceId: expect.any(String),
        humanPrincipalId: "owner-human-1"
      }),
      {
        projectId: "project-a",
        humanPrincipalId: "owner-human-1",
        canvasId: "canvas-main",
        workspaceId: "workspace-a"
      }
    );

    for (const suffix of ["projectId=project-a&projectId=project-b", "unknown=1"]) {
      const response = await fetch(`${fixture.origin}/api/v1/agent-endpoints?${suffix}`, {
        headers: authorization
      });
      expect(response.status).toBe(400);
    }

    const nonAdmin = await setup(true, "ready", false);
    const forbidden = await fetch(`${nonAdmin.origin}/api/v1/agent-endpoints`, {
      headers: authorization
    });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual(expectedError("operator_admin_required"));
    expect(nonAdmin.service.listAgentEndpoints).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated fleet endpoint listing and member-only operator tokens", async () => {
    const fixture = await setup(true);
    expect((await fetch(`${fixture.origin}/api/v1/agent-endpoints`)).status).toBe(401);

    const memberOnly = await setup(true, "ready", false);
    const response = await fetch(`${memberOnly.origin}/api/v1/agent-endpoints`, {
      headers: authorization
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual(expectedError("operator_admin_required"));
    expect(memberOnly.service.listAgentEndpoints).not.toHaveBeenCalled();
  });

  it("uses the v3 Agent Endpoint dispatch contract as its sole request schema", () => {
    const request = {
      schemaVersion: "remote-run/v3" as const,
      projectId: "project-a",
      canvasId: "default",
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-1",
      idempotencyKey: "operator-v3-contract",
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      executionTargetRevision: 0,
      contentRevision: "1",
      graphFingerprint: `pkg-${"a".repeat(64)}`,
      humanPrincipalId: "owner-human-1"
    };
    expect(operatorDispatchRequestSchema.parse(request)).toEqual(request);
    expect(
      operatorDispatchRequestSchema.safeParse({
        projectId: request.projectId,
        canvasId: request.canvasId,
        blockRef: request.blockRef,
        idempotencyKey: request.idempotencyKey
      }).success
    ).toBe(false);
  });

  it("enforces transport policy before reading a bearer credential", async () => {
    expect(
      operatorTransportAllowed(
        { encrypted: true, remoteAddress: "203.0.113.1" },
        directHttpsTransportAdmission
      )
    ).toBe(true);
    expect(
      operatorTransportAllowed({ remoteAddress: "127.0.0.1" }, directHttpsTransportAdmission)
    ).toBe(false);
    expect(
      operatorTransportAllowed({ remoteAddress: "127.0.0.1" }, loopbackHttpTransportAdmission)
    ).toBe(true);
    expect(
      operatorTransportAllowed({ remoteAddress: "203.0.113.1" }, loopbackHttpTransportAdmission)
    ).toBe(false);

    const fixture = await setup(false);
    const response = await fetch(`${fixture.origin}/api/v1/hosts`, { headers: authorization });
    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toEqual(expectedError("operator_insecure_transport"));
    expect(fixture.service.listHosts).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated, malformed, cross-scope, stale, and invalid pagination requests", async () => {
    const fixture = await setup(true);
    expect((await fetch(`${fixture.origin}/api/v1/hosts`)).status).toBe(401);

    const malformed = await fetch(`${fixture.origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: "{"
    });
    expect(malformed.status).toBe(400);

    const crossScope = await fetch(`${fixture.origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-b" })
    });
    expect(crossScope.status).toBe(403);

    const stale = await fetch(`${fixture.origin}/api/v1/remote-operations/operation-1/actions`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: "{}"
    });
    expect(stale.status).toBe(409);

    vi.mocked(fixture.service.executeAction).mockRejectedValueOnce(
      new RemoteExecutionActionRejectedError("work_not_agent_assigned")
    );
    const policyRejected = await fetch(
      `${fixture.origin}/api/v1/remote-operations/operation-1/actions`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: "{}"
      }
    );
    expect(policyRejected.status).toBe(409);
    await expect(policyRejected.json()).resolves.toEqual(expectedError("work_not_agent_assigned"));

    const invalidPage = await fetch(`${fixture.origin}/api/v1/hosts?limit=1&limit=2`, {
      headers: authorization
    });
    expect(invalidPage.status).toBe(400);
  });

  it("returns a stable redacted conflict for an incompatible Agent Endpoint", async () => {
    const fixture = await setup(true);
    vi.mocked(fixture.service.dispatch).mockRejectedValueOnce(
      new AgentEndpointCatalogError("agent_endpoint_incompatible")
    );
    const response = await fetch(`${fixture.origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "remote-run/v3",
        projectId: "project-a",
        canvasId: "default",
        blockRef: "T-001#B-001",
        agentEndpointId: "private-endpoint-id",
        idempotencyKey: "incompatible-endpoint",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        executionTargetRevision: 0
      })
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual(expectedError("agent_endpoint_incompatible"));
    expect(JSON.stringify(body)).not.toContain("private-endpoint-id");
  });

  it("returns a stable conflict when an ACP replay cursor is ahead", async () => {
    const fixture = await setup(true);
    vi.mocked(fixture.service.replayEvents).mockImplementationOnce(() => {
      throw new Error("remote_acp_event_replay_cursor_ahead");
    });
    const response = await fetch(
      `${fixture.origin}/api/v1/remote-operations/operation-1/events?afterCursor=999999`,
      { headers: authorization }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "remote_acp_event_replay_cursor_ahead",
      serverBuildRevision: "abcdef0123456789"
    });
  });

  it.each([
    ["remote_block_not_found", 404],
    ["remote_block_not_executable", 400],
    ["remote_block_executor_not_acp", 400],
    ["remote_block_not_dispatchable", 409],
    ["remote_block_source_changed", 409],
    ["remote_block_result_conflict", 409]
  ] as const)("preserves the runtime dispatch diagnostic %s", async (code, status) => {
    const fixture = await setup(true);
    vi.mocked(fixture.service.dispatch).mockRejectedValueOnce(
      new RemoteBlockRuntimeError(code, `private detail for ${code}`)
    );
    const response = await fetch(`${fixture.origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "remote-run/v3",
        projectId: "project-a",
        canvasId: "default",
        blockRef: "T-001#B-001",
        agentEndpointId: "private-endpoint-id",
        idempotencyKey: `runtime-error-${code}`,
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        executionTargetRevision: 0
      })
    });

    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual(expectedError(code));
    expect(JSON.stringify(body)).not.toContain("private detail");
  });

  it("preserves a remote Runtime RPC dispatch conflict without reporting the Host offline", async () => {
    const fixture = await setup(true);
    vi.mocked(fixture.service.dispatch).mockRejectedValueOnce(
      new CanvasRuntimeRpcError("remote_block_not_dispatchable", false, false)
    );
    const response = await fetch(`${fixture.origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "remote-run/v3",
        projectId: "project-a",
        canvasId: "default",
        blockRef: "T-001#B-001",
        agentEndpointId: "private-endpoint-id",
        idempotencyKey: "runtime-rpc-not-dispatchable",
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        executionTargetRevision: 0
      })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(expectedError("remote_block_not_dispatchable"));
  });

  it.each([
    [new CanvasRuntimeUnavailableError("host_offline"), "canvas_runtime_unavailable"],
    [
      new CanvasRuntimeRpcError("canvas_runtime_host_offline", true, false),
      "canvas_runtime_host_offline"
    ],
    [
      new CanvasRuntimeRpcError("canvas_runtime_rpc_deadline_exceeded", true, false),
      "canvas_runtime_rpc_deadline_exceeded"
    ],
    [
      new CanvasRuntimeRpcError("canvas_runtime_reconcile_required", true, true),
      "canvas_runtime_reconcile_required"
    ]
  ] as const)("maps an active Runtime observation failure to 503 %s", async (error, code) => {
    const fixture = await setup(true);
    vi.mocked(fixture.service.observeOperation).mockRejectedValueOnce(error);

    const response = await fetch(`${fixture.origin}/api/v1/remote-operations/operation-1`, {
      headers: authorization
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(expectedError(code));
  });

  it("serves public health and delegates bounded host pagination", async () => {
    const fixture = await setup(true);
    await expect((await fetch(`${fixture.origin}/healthz`)).json()).resolves.toEqual({
      status: "ok",
      serverBuildRevision: "abcdef0123456789"
    });
    const response = await fetch(`${fixture.origin}/api/v1/hosts?cursor=0&limit=50`, {
      headers: authorization
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null });
    expect(fixture.service.listHosts).toHaveBeenCalledWith(
      expect.objectContaining({ operatorId: "operator-1" }),
      { cursor: "0", limit: "50" }
    );
    await expect((await fetch(`${fixture.origin}/version`)).json()).resolves.toMatchObject({
      serverBuildRevision: "abcdef0123456789",
      remoteRunnerEvents: { available: false },
      limits: { maxArtifactBytes: 1024, maxWebSocketPayloadBytes: 2048 }
    });
  });

  it("streams an Owner terminal report larger than the Operator JSON limit", async () => {
    const fixture = await setup(true);
    const reportBytes = Buffer.alloc(70 * 1024, 0x61);
    const metadata = operatorOwnerTerminalResultMetadataSchema.parse({
      operationId: "operation-owner-1",
      projectId: "project-owner-1",
      canvasId: "canvas-owner-1",
      blockRef: "T-001#B-001",
      controlPlane: "owner",
      sourceRevision: "source-revision-1",
      graphFingerprint: `pkg-${"a".repeat(64)}`,
      dispatchId: "dispatch-owner-1",
      executionAttemptId: "attempt-owner-1",
      reportArtifactRef: `artifact:sha256:${"b".repeat(64)}`
    });
    vi.mocked(fixture.service.readOwnerOperationTerminalResult).mockResolvedValueOnce({
      metadata,
      reportBytes
    });

    const response = await fetch(
      `${fixture.origin}/api/v1/remote-operations/${metadata.operationId}/terminal-result`,
      {
        headers: {
          ...authorization,
          "x-planweave-human-identity": `Bearer ${fixture.humanIdentityToken}`
        }
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(OPERATOR_OWNER_TERMINAL_RESULT_MEDIA_TYPE);
    expect(
      operatorOwnerTerminalResultMetadataSchema.parse(
        JSON.parse(
          Buffer.from(
            response.headers.get(OPERATOR_OWNER_TERMINAL_RESULT_METADATA_HEADER) ?? "",
            "base64url"
          ).toString("utf8")
        )
      )
    ).toEqual(metadata);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(reportBytes);
  });

  it("rejects Owner materialization member budgets before retaining an excess member", () => {
    const countBudget = new OwnerCanvasMaterializationUploadBudget(2, 10);
    countBudget.acceptMember(1);
    countBudget.acceptMember(1);
    expect(() => countBudget.acceptMember(1)).toThrowError(
      "owner_canvas_materialization_member_count_too_large"
    );

    const sizeBudget = new OwnerCanvasMaterializationUploadBudget(3, 10);
    sizeBudget.acceptMember(6);
    expect(() => sizeBudget.acceptMember(5)).toThrowError(
      "owner_canvas_materialization_total_bytes_too_large"
    );
  });

  it("returns 413 immediately when an Owner materialization exceeds the member limit", async () => {
    const fixture = await setup(true);
    const frames = [
      JSON.stringify({
        type: "header",
        request: {
          schemaVersion: "owner-canvas-materialization/v1",
          materializationId: "materialization-too-many-members",
          scope: {
            ownerHumanPrincipalId: "owner-human-1",
            projectId: "project-a",
            canvasId: "default"
          },
          expectedHead: { kind: "absent" }
        }
      }),
      ...Array.from({ length: CONTENT_VERSION_MAX_MEMBERS + 1 }, (_, index) =>
        JSON.stringify({
          type: "member",
          index,
          member: {
            kind: "block_prompt",
            path: `nodes/T-001/blocks/B-${index}.prompt.md`,
            content: "",
            digestSha256: "0".repeat(64),
            sizeBytes: 0
          }
        })
      )
    ];
    const response = await fetch(`${fixture.origin}/api/v1/owner-canvas-materializations`, {
      method: "POST",
      headers: {
        ...authorization,
        "content-type": ownerCanvasMaterializationUploadMediaType,
        "x-planweave-human-identity": `Bearer ${fixture.humanIdentityToken}`
      },
      body: `${frames.join("\n")}\n`
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual(
      expectedError("owner_canvas_materialization_member_count_too_large")
    );
    expect(fixture.service.materializeOwnerCanvas).not.toHaveBeenCalled();
  });

  it("returns the build revision without leaking an unclassified operator failure", async () => {
    const fixture = await setup(true);
    vi.mocked(fixture.service.listHosts).mockImplementation(() => {
      throw new Error("sensitive_internal_failure");
    });
    const response = await fetch(`${fixture.origin}/api/v1/hosts?cursor=0&limit=50`, {
      headers: authorization
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("sensitive_internal_failure");
    expect(JSON.parse(body)).toEqual({
      error: "operator_request_failed",
      serverBuildRevision: "abcdef0123456789"
    });
  });

  it("accepts a strict server-admin request to renew one Host credential", async () => {
    const fixture = await setup(true);
    const response = await fetch(`${fixture.origin}/api/v1/hosts/host-1/credential-renewal`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(202);
    expect(fixture.service.requestHostCredentialRenewal).toHaveBeenCalledWith(
      expect.objectContaining({ operatorId: "operator-1", serverAdmin: true }),
      "host-1",
      {}
    );

    const malformed = await fetch(
      `${fixture.origin}/api/v1/hosts/host-1/credential-renewal?unexpected=1`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: "{}"
      }
    );
    expect(malformed.status).toBe(400);
  });

  it("returns 503 readiness while startup reconciliation is incomplete", async () => {
    const fixture = await setup(true, "reconciling");
    const response = await fetch(`${fixture.origin}/readyz`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "reconciling",
      schemaVersion: 1
    });
  });

  it("lists and mutates remote agents through operator management routes", async () => {
    const fixture = await setup(true);
    const listed = await fetch(
      `${fixture.origin}/api/v1/remote-agents?humanPrincipalId=owner-human-1`,
      { headers: authorization }
    );
    expect(listed.status).toBe(200);
    expect(fixture.service.listRemoteAgents).toHaveBeenCalledWith(
      expect.objectContaining({ serverAdmin: true }),
      { humanPrincipalId: "owner-human-1" }
    );

    const access = await fetch(`${fixture.origin}/api/v1/remote-agents/endpoint-1/access-mode`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        humanPrincipalId: "owner-human-1",
        accessMode: "unrestricted"
      })
    });
    expect(access.status).toBe(200);
    expect(fixture.service.setRemoteAgentAccessMode).toHaveBeenCalledWith(
      expect.objectContaining({ serverAdmin: true }),
      "endpoint-1",
      { humanPrincipalId: "owner-human-1", accessMode: "unrestricted" }
    );

    const grant = await fetch(`${fixture.origin}/api/v1/remote-agents/endpoint-1/grants`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        humanPrincipalId: "owner-human-1",
        workspaceId: "workspace-a"
      })
    });
    expect(grant.status).toBe(200);
    expect(fixture.service.grantRemoteAgentWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ serverAdmin: true }),
      "endpoint-1",
      { humanPrincipalId: "owner-human-1", workspaceId: "workspace-a" }
    );

    const revokeGrant = await fetch(
      `${fixture.origin}/api/v1/remote-agents/endpoint-1/grants/workspace-a/revoke`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ humanPrincipalId: "owner-human-1" })
      }
    );
    expect(revokeGrant.status).toBe(200);
    expect(fixture.service.revokeRemoteAgentGrant).toHaveBeenCalledWith(
      expect.objectContaining({ serverAdmin: true }),
      "endpoint-1",
      "workspace-a",
      { humanPrincipalId: "owner-human-1" }
    );

    const revoke = await fetch(`${fixture.origin}/api/v1/remote-agents/endpoint-1/revoke`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ humanPrincipalId: "owner-human-1" })
    });
    expect(revoke.status).toBe(200);

    const repair = await fetch(
      `${fixture.origin}/api/v1/remote-agents/endpoint-1/repair-ownership`,
      {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ ownerHumanPrincipalId: "owner-human-1" })
      }
    );
    expect(repair.status).toBe(200);

    const missingPrincipal = await fetch(`${fixture.origin}/api/v1/remote-agents`, {
      headers: authorization
    });
    expect(missingPrincipal.status).toBe(400);

    const nonAdmin = await setup(true, "ready", false);
    const owned = await fetch(
      `${nonAdmin.origin}/api/v1/remote-agents?humanPrincipalId=owner-human-1`,
      {
        headers: {
          ...authorization,
          "x-planweave-human-identity": `Bearer ${nonAdmin.humanIdentityToken}`
        }
      }
    );
    expect(owned.status).toBe(200);
    expect(nonAdmin.service.listRemoteAgents).toHaveBeenCalledWith(
      expect.objectContaining({
        serverAdmin: false,
        humanPrincipalId: "owner-human-1"
      }),
      { humanPrincipalId: "owner-human-1" }
    );

    const invalidIdentity = await fetch(
      `${nonAdmin.origin}/api/v1/remote-agents?humanPrincipalId=owner-human-1`,
      {
        headers: {
          ...authorization,
          "x-planweave-human-identity": "Bearer invalid"
        }
      }
    );
    expect(invalidIdentity.status).toBe(401);
    await expect(invalidIdentity.json()).resolves.toEqual(
      expectedError("operator_human_identity_unauthorized")
    );
  });
});
