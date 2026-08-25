import { createServer, type Server as HttpServer } from "node:http";
import { RemoteBlockRuntimeError } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEndpointCatalogError } from "../agentEndpointCatalog.js";
import { applyMigrations } from "../migrations.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";
import { RemoteExecutionActionRejectedError } from "../remoteExecutionActions.js";
import { operatorDispatchRequestSchema } from "../operatorDtos.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
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
    executeAction: vi.fn(async () => {
      throw new Error("remote_action_attempt_version_conflict");
    }),
    replayEvents: vi.fn(),
    listPendingInteractions: vi.fn(() => ({ items: [], nextCursor: null })),
    settleInteraction: vi.fn()
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
      service,
      readiness: () => ({ status: readiness, schemaVersion: 1 }),
      serverVersion: "test",
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
  return { origin: `http://127.0.0.1:${address.port}`, service };
}

const authorization = { Authorization: `Bearer ${token}` };

describe("operator HTTP boundary", () => {
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

    for (const suffix of [
      "projectId=project-a&projectId=project-b",
      "projectId=project-a&workspaceId=workspace-a",
      "unknown=1"
    ]) {
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
    await expect(forbidden.json()).resolves.toEqual({ error: "operator_admin_required" });
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
    await expect(response.json()).resolves.toEqual({ error: "operator_admin_required" });
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
    await expect(response.json()).resolves.toEqual({ error: "operator_insecure_transport" });
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
    await expect(policyRejected.json()).resolves.toEqual({ error: "work_not_agent_assigned" });

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
        expectedReviewerRevision: 0
      })
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({ error: "agent_endpoint_incompatible" });
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
      error: "remote_acp_event_replay_cursor_ahead"
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
        expectedReviewerRevision: 0
      })
    });

    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({ error: code });
    expect(JSON.stringify(body)).not.toContain("private detail");
  });

  it("serves public health and delegates bounded host pagination", async () => {
    const fixture = await setup(true);
    await expect((await fetch(`${fixture.origin}/healthz`)).json()).resolves.toEqual({
      status: "ok"
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
      limits: { maxArtifactBytes: 1024, maxWebSocketPayloadBytes: 2048 }
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
});
