import { createServer, type Server as HttpServer } from "node:http";
import { WORKSPACE_CANVAS_EXECUTION_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { HostEnrollmentService } from "../hostEnrollment.js";
import { HumanIdentityCredentialStore } from "../identity/humanIdentityCredentialStore.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";
import { handleOperatorHttpRequest } from "../operatorHttp.js";
import { RemoteControlService } from "../remoteControlService.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import {
  ensureTestHumanPrincipal,
  ownHostRemoteAgents,
  persistedTestAgentAccess,
  TEST_REMOTE_AGENT_OWNER_ID
} from "./support/remoteAgentOwnerFixture.js";

const adminToken = `pw_operator_${"F".repeat(43)}`;
const memberToken = `pw_operator_${"G".repeat(43)}`;
const workspaceToken = `pw_operator_${"H".repeat(43)}`;
const now = new Date("2026-08-03T08:00:00.000Z");

const databases: SqliteDatabase[] = [];
const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
});

async function setup(input: { serverAdmin?: boolean; withOwnerResolver?: boolean } = {}) {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject("project-a");
  ensureTestHumanPrincipal(database);
  const humanIdentityCredentials = new HumanIdentityCredentialStore(database, () => now);
  const humanIdentityToken = humanIdentityCredentials.issue(
    TEST_REMOTE_AGENT_OWNER_ID
  ).identityToken;
  const artifactContent = { readReport: async () => new Uint8Array() };
  const coordination = createRemoteBlockCoordination(
    database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      clock: () => now,
      runtimeLeases: {
        acquire: () => {
          throw new Error("runtime_not_configured");
        }
      },
      inputArtifacts: { materialize: async () => undefined },
      artifactContent
    },
    { serverInstanceOwnerToken: "remote-control-service-test" }
  );
  new OperatorSessionStore(database).create({
    workspaceId,
    operatorId: "operator-admin",
    credentialSha256: hashOperatorToken(adminToken),
    issuedAt: now.toISOString(),
    expiresAt: "2030-01-01T00:00:00.000Z"
  });
  new OperatorSessionStore(database).create({
    workspaceId,
    operatorId: "operator-workspace",
    credentialSha256: hashOperatorToken(workspaceToken),
    issuedAt: now.toISOString(),
    expiresAt: "2030-01-01T00:00:00.000Z"
  });
  new OperatorSessionStore(database).create({
    workspaceId,
    operatorId: "operator-member",
    credentialSha256: hashOperatorToken(memberToken),
    issuedAt: now.toISOString(),
    expiresAt: "2030-01-01T00:00:00.000Z"
  });
  const authorization = new OperatorTokenRegistry(database, [
    {
      operatorId: "operator-admin",
      tokenSha256: hashOperatorToken(adminToken),
      projectIds: ["project-a"],
      serverAdmin: true
    },
    {
      operatorId: "operator-member",
      tokenSha256: hashOperatorToken(memberToken),
      projectIds: ["project-a"],
      serverAdmin: input.serverAdmin ?? false
    }
  ]);
  const service = new RemoteControlService({
    authorization,
    enrollments: new HostEnrollmentService(database, () => now),
    hosts: coordination.hosts,
    agentEndpoints: coordination.agentEndpoints,
    remoteAgentAccess: coordination.remoteAgentAccess,
    remoteAgentRepository: coordination.remoteAgents,
    operations: coordination.operations,
    dispatches: coordination.dispatches,
    coordinator: coordination.coordinator,
    events: coordination.acpEvents,
    interactions: coordination.interactions,
    artifactContent,
    disconnectHost: () => {},
    workspaceIdentity,
    authorizeProjectScope: () => {},
    ...(input.withOwnerResolver ? { resolveOwnerRuntimeScope: () => undefined } : {}),
    hostOfflineAfterMs: 60_000,
    clock: () => now
  });
  const httpServer = createServer((request, response) => {
    void handleOperatorHttpRequest(request, response, {
      authorization,
      humanIdentityCredentials,
      service,
      readiness: () => ({ status: "ready", schemaVersion: 1 }),
      serverVersion: "test",
      serverBuildRevision: "abcdef0123456789",
      limits: { maxArtifactBytes: 1024, maxWebSocketPayloadBytes: 2048 },
      transportAdmission: loopbackHttpTransportAdmission
    });
  });
  servers.push(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  const principal = authorization.authenticate(`Bearer ${adminToken}`);
  if (!principal) throw new Error("Expected admin principal");
  const workspacePrincipal = authorization.authenticate(`Bearer ${workspaceToken}`);
  if (!workspacePrincipal) throw new Error("Expected Workspace principal");
  const memberPrincipal = authorization.authenticate(`Bearer ${memberToken}`);
  if (!memberPrincipal) throw new Error("Expected member principal");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    service,
    coordination,
    database,
    workspaceId,
    artifactContent,
    principal,
    workspacePrincipal,
    memberPrincipal,
    humanIdentityToken
  };
}

function registerFleetHost(coordination: Awaited<ReturnType<typeof setup>>["coordination"]) {
  const registration = coordination.hosts.register("Fleet Host");
  coordination.hosts.reportOnline(registration.host.id, ["acp.codex"], 1, {
    workspaceMappings: [],
    acpProfiles: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        status: "ready",
        capabilities: ["acp.codex"]
      }
    ]
  });
  return registration.host;
}

function registerWorkspaceHost(fixture: Awaited<ReturnType<typeof setup>>) {
  const registration = fixture.coordination.hosts.register("Workspace Host");
  ownHostRemoteAgents({
    database: fixture.database,
    hostId: registration.host.id,
    ownerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID,
    accessMode: "workspace_restricted",
    grantWorkspaceId: fixture.workspaceId
  });
  fixture.coordination.hosts.bindToWorkspace(registration.host.id, fixture.workspaceId);
  fixture.coordination.hosts.reportOnline(
    registration.host.id,
    ["acp.codex", WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
    1,
    {
      workspaceMappings: [{ workspaceId: fixture.workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    }
  );
  return registration.host;
}

describe("RemoteControlService owner fleet control plane", () => {
  it("serves an unstarted operation without requiring Host Runtime ownership", async () => {
    const fixture = await setup();
    const operation = fixture.coordination.operations.create({
      workspaceId: fixture.workspaceId,
      projectId: "project-a",
      canvasId: "canvas-a",
      blockRef: "T-001#B-003",
      ownershipGeneration: "generation-unstarted",
      idempotencyKey: "owner-unstarted-observation",
      sourceFingerprint: "fingerprint-unstarted",
      requiredCapabilities: ["acp.codex"]
    });
    const query = vi.spyOn(fixture.coordination.coordinator, "query");
    const response = await fetch(`${fixture.origin}/api/v1/remote-operations/${operation.id}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        Accept: "application/vnd.planweave.operator-operation.public-runtime-v1+json"
      }
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operationId: operation.id,
      state: "preparing",
      runtime: { ref: operation.blockRef, status: "not_started" }
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed when the owner operation is not completed", async () => {
    const fixture = await setup();
    const operation = fixture.coordination.operations.create({
      workspaceId: fixture.workspaceId,
      projectId: "project-a",
      canvasId: "canvas-a",
      blockRef: "T-001#B-003",
      ownershipGeneration: "generation-running-result",
      idempotencyKey: "owner-running-result",
      sourceFingerprint: "fingerprint-running-result",
      requiredCapabilities: ["acp.codex"]
    });

    const response = await fetch(
      `${fixture.origin}/api/v1/remote-operations/${operation.id}/terminal-result`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "operator_operation_conflict" });
  });

  it("serves a persisted terminal operation without querying its exact Host Runtime", async () => {
    const fixture = await setup();
    const operation = fixture.coordination.operations.markClaimed(
      fixture.coordination.operations.create({
        workspaceId: fixture.workspaceId,
        projectId: "project-a",
        canvasId: "canvas-a",
        blockRef: "T-001#B-001",
        ownershipGeneration: "generation-terminal-observe",
        idempotencyKey: "owner-terminal-observe",
        sourceFingerprint: "source-terminal-observe",
        requiredCapabilities: ["acp.codex"]
      }).id
    );
    const terminal = fixture.coordination.operations.cancelClaimedAfterRuntimeReset({
      operationId: operation.id,
      executionAttemptId: operation.executionAttemptId
    });
    const query = vi
      .spyOn(fixture.coordination.coordinator, "query")
      .mockRejectedValue(new Error("exact_host_runtime_must_not_be_queried"));

    const response = await fetch(`${fixture.origin}/api/v1/remote-operations/${terminal.id}`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        Accept: "application/vnd.planweave.operator-operation.public-runtime-v1+json"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operationId: terminal.id,
      state: "cancelled",
      runtime: {
        ref: terminal.blockRef,
        status: "cancelled",
        terminalReceipt: { operationId: terminal.id, outcome: "cancelled" }
      }
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns a dispatch that is already terminal without querying its exact Host Runtime", async () => {
    const fixture = await setup();
    const operation = fixture.coordination.operations.markClaimed(
      fixture.coordination.operations.create({
        workspaceId: fixture.workspaceId,
        projectId: "project-a",
        canvasId: "canvas-a",
        blockRef: "T-001#B-002",
        ownershipGeneration: "generation-terminal-dispatch",
        idempotencyKey: "owner-terminal-dispatch-persisted",
        sourceFingerprint: "source-terminal-dispatch",
        requiredCapabilities: ["acp.codex"]
      }).id
    );
    const terminal = fixture.coordination.operations.cancelClaimedAfterRuntimeReset({
      operationId: operation.id,
      executionAttemptId: operation.executionAttemptId
    });
    vi.spyOn(fixture.coordination.coordinator, "dispatch").mockResolvedValueOnce({
      operation: terminal,
      status: "terminal"
    });
    const query = vi
      .spyOn(fixture.coordination.coordinator, "query")
      .mockRejectedValue(new Error("exact_host_runtime_must_not_be_queried"));

    const result = await fixture.service.dispatch(
      { ...fixture.principal, humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID },
      {
        schemaVersion: "remote-run/v3",
        projectId: "project-a",
        canvasId: "canvas-a",
        blockRef: terminal.blockRef,
        idempotencyKey: "owner-terminal-dispatch-request",
        agentEndpointId: "endpoint-terminal-dispatch",
        humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID,
        expectedResponsibilityRevision: 1,
        expectedReviewerRevision: 1,
        executionTargetRevision: 1,
        contentRevision: "1",
        graphFingerprint: `pkg-${"b".repeat(64)}`
      },
      "public-runtime-v1"
    );

    expect(result).toMatchObject({
      operationId: terminal.id,
      state: "cancelled",
      runtime: {
        ref: terminal.blockRef,
        status: "cancelled",
        terminalReceipt: { operationId: terminal.id, outcome: "cancelled" }
      }
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns an empty event replay before the owner operation emits its first ACP event", async () => {
    const fixture = await setup();
    const operation = fixture.coordination.operations.create({
      workspaceId: fixture.workspaceId,
      projectId: "project-a",
      canvasId: "canvas-a",
      blockRef: "T-001#B-001",
      ownershipGeneration: "generation-1",
      idempotencyKey: "owner-empty-replay-1",
      sourceFingerprint: "source-1",
      requiredCapabilities: ["acp.codex"]
    });

    const response = await fetch(
      `${fixture.origin}/api/v1/remote-operations/${operation.id}/events?afterCursor=0`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      executionAttemptId: operation.executionAttemptId,
      afterCursor: 0,
      cursor: 0,
      highWatermark: 0,
      hasMore: false,
      events: []
    });

    const missing = await fetch(
      `${fixture.origin}/api/v1/remote-operations/operation-missing/events?afterCursor=0`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    expect(missing.status).toBe(404);
  });

  it("returns an unbound fleet host from getHost without workspace scope", () => {
    const run = async () => {
      const fixture = await setup();
      const host = registerFleetHost(fixture.coordination);
      const view = fixture.service.getHost(fixture.principal, host.id);
      expect(view).toMatchObject({
        id: host.id,
        displayName: "Fleet Host",
        availability: { status: "available", reason: null }
      });
      expect(view.workspaceId).toBeUndefined();
    };
    return run();
  });

  it("lists fleet hosts without workspace binding and revokes them by hostId", () => {
    const run = async () => {
      const fixture = await setup();
      const host = registerFleetHost(fixture.coordination);
      const page = fixture.service.listHosts(fixture.principal, {});
      expect(page.items.map((item) => item.id)).toContain(host.id);
      const listed = page.items.find((item) => item.id === host.id);
      expect(listed?.workspaceId).toBeUndefined();
      expect(listed?.availability).toEqual({ status: "available", reason: null });

      const revoked = fixture.service.revokeHost(fixture.principal, host.id);
      expect(revoked.revokedAt).toBeDefined();
      expect(revoked.workspaceId).toBeUndefined();
      expect(fixture.coordination.hosts.getRequired(host.id).revokedAt).toBeDefined();
    };
    return run();
  });

  it("lets only a server admin request immediate renewal for a renewable fleet Host", async () => {
    const fixture = await setup();
    const registration = fixture.coordination.hosts.registerWithCredential(
      "Renewable Fleet Host",
      `pw_host_${"H".repeat(43)}`,
      ["acp.codex"],
      1,
      "2027-02-01T00:00:00.000Z",
      { lifetimeDays: 180, renewal: "automatic" }
    );

    const requested = fixture.service.requestHostCredentialRenewal(
      fixture.principal,
      registration.host.id,
      {}
    );
    expect(requested).toMatchObject({
      id: registration.host.id,
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
      credentialRenewalRequestedAt: now.toISOString()
    });

    const forbidden = await fetch(
      `${fixture.origin}/api/v1/hosts/${registration.host.id}/credential-renewal`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${memberToken}`,
          "content-type": "application/json"
        },
        body: "{}"
      }
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({
      error: "operator_admin_required",
      serverBuildRevision: "abcdef0123456789"
    });
  });

  it("fails closed for operator catalog without an explicit human principal", () => {
    const run = async () => {
      const fixture = await setup();
      registerFleetHost(fixture.coordination);
      const fleet = fixture.service.listAgentEndpoints(fixture.principal, {});
      expect(fleet.items).toEqual([]);

      expect(() =>
        fixture.service.listAgentEndpoints(fixture.principal, {
          projectId: "project-a"
        })
      ).toThrow("operator_query_invalid");

      expect(() =>
        fixture.service.listAgentEndpoints(fixture.principal, {
          projectId: "project-a",
          humanPrincipalId: "owner-human-1"
        })
      ).toThrow("operator_query_invalid");
    };
    return run();
  });

  it("lists an owned Remote Agent for an ordinary Canvas without Workspace authority", async () => {
    const fixture = await setup();
    const registration = fixture.coordination.hosts.register("Fleet Host");
    ownHostRemoteAgents({
      database: fixture.database,
      hostId: registration.host.id,
      ownerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID,
      accessMode: "unrestricted"
    });
    fixture.coordination.hosts.reportOnline(registration.host.id, ["acp.codex"], 1, {
      workspaceMappings: [],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    });

    const response = await fetch(
      `${fixture.origin}/api/v1/agent-endpoints?projectId=ordinary-project&canvasId=ordinary-canvas&humanPrincipalId=${TEST_REMOTE_AGENT_OWNER_ID}`,
      {
        headers: {
          Authorization: `Bearer ${memberToken}`,
          "x-planweave-human-identity": `Bearer ${fixture.humanIdentityToken}`
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: "agent-endpoint-list/v1",
      items: [
        {
          hostDisplayName: "Fleet Host",
          profileId: "codex-acp",
          agentId: "codex",
          status: "available"
        }
      ]
    });
  });

  it("rejects owner Canvas access when the proven Human does not own the Agent", async () => {
    const fixture = await setup();

    expect(() =>
      fixture.service.listAgentEndpoints(fixture.principal, {
        projectId: "ordinary-project",
        canvasId: "ordinary-canvas",
        humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
      })
    ).toThrow("operator_human_identity_forbidden");
    expect(() =>
      fixture.service.listAgentEndpoints(
        { ...fixture.memberPrincipal, humanPrincipalId: "different-human" },
        {
          projectId: "ordinary-project",
          canvasId: "ordinary-canvas",
          humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
        }
      )
    ).toThrow("operator_human_identity_forbidden");
  });

  it("requires exact Human proof when an admin enrolls an owner Agent Host", async () => {
    const fixture = await setup();
    const request = {
      expiresAt: "2026-08-03T08:15:00.000Z",
      credentialPolicy: { lifetimeDays: 180, renewal: "automatic" as const },
      ownerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID,
      accessMode: "unrestricted" as const
    };

    expect(() => fixture.service.createEnrollmentGrant(fixture.principal, request)).toThrow(
      "operator_human_identity_forbidden"
    );
    expect(
      fixture.service.createEnrollmentGrant(
        { ...fixture.principal, humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID },
        request
      )
    ).toMatchObject({ enrollmentCode: expect.any(String) });
  });

  it("defaults an explicitly owned Agent Host enrollment to unrestricted access", async () => {
    const fixture = await setup();
    fixture.service.createEnrollmentGrant(
      { ...fixture.principal, humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID },
      {
        expiresAt: "2026-08-03T08:15:00.000Z",
        credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
        ownerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
      }
    );

    expect(
      fixture.database
        .prepare(
          `SELECT owner_human_principal_id, access_mode
           FROM agent_host_enrollment_grants ORDER BY created_at DESC LIMIT 1`
        )
        .get()
    ).toEqual({
      owner_human_principal_id: TEST_REMOTE_AGENT_OWNER_ID,
      access_mode: "unrestricted"
    });
  });

  it("B4/B5: rejects fleet endpoint listing without credential or with member-only operator", async () => {
    const fixture = await setup();
    registerFleetHost(fixture.coordination);
    expect((await fetch(`${fixture.origin}/api/v1/agent-endpoints`)).status).toBe(401);

    const forbidden = await fetch(`${fixture.origin}/api/v1/agent-endpoints`, {
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({
      error: "operator_admin_required",
      serverBuildRevision: "abcdef0123456789"
    });
  });

  it("allows a setup-code operator session to list only its Workspace-scoped endpoints", async () => {
    const fixture = await setup({ withOwnerResolver: true });
    const host = registerWorkspaceHost(fixture);

    const unauthenticatedHuman = await fetch(
      `${fixture.origin}/api/v1/agent-endpoints?projectId=project-a&canvasId=default&humanPrincipalId=${TEST_REMOTE_AGENT_OWNER_ID}&workspaceId=${fixture.workspaceId}`,
      { headers: { Authorization: `Bearer ${workspaceToken}` } }
    );
    expect(unauthenticatedHuman.status).toBe(403);

    const response = await fetch(
      `${fixture.origin}/api/v1/agent-endpoints?projectId=project-a&canvasId=default&humanPrincipalId=${TEST_REMOTE_AGENT_OWNER_ID}&workspaceId=${fixture.workspaceId}`,
      {
        headers: {
          Authorization: `Bearer ${workspaceToken}`,
          "x-planweave-human-identity": `Bearer ${fixture.humanIdentityToken}`
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: "agent-endpoint-list/v1",
      items: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          status: "available"
        }
      ]
    });

    const fleet = await fetch(`${fixture.origin}/api/v1/agent-endpoints`, {
      headers: { Authorization: `Bearer ${workspaceToken}` }
    });
    expect(fleet.status).toBe(403);
    await expect(fleet.json()).resolves.toEqual({
      error: "operator_admin_required",
      serverBuildRevision: "abcdef0123456789"
    });

    const endpoint = fixture.coordination.agentEndpoints.listVisible(fixture.workspaceId).items[0];
    await expect(
      fixture.service.dispatch(
        {
          ...fixture.workspacePrincipal,
          humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
        },
        {
          schemaVersion: "remote-run/v3",
          workspaceId: fixture.workspaceId,
          projectId: "project-a",
          canvasId: "default",
          blockRef: "T-001#B-001",
          idempotencyKey: "workspace-session-dispatch",
          agentEndpointId: endpoint.endpointId,
          humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID,
          expectedResponsibilityRevision: 1,
          expectedReviewerRevision: 1,
          executionTargetRevision: 1,
          contentRevision: "1",
          graphFingerprint: `pkg-${"a".repeat(64)}`
        }
      )
    ).rejects.toThrow("Exact Host is not authorized to serve this project.");

    const operation = fixture.coordination.operations.create({
      workspaceId: fixture.workspaceId,
      projectId: "project-a",
      canvasId: "default",
      blockRef: "T-001#B-002",
      ownershipGeneration: "generation-1",
      idempotencyKey: "workspace-session-observe",
      sourceFingerprint: "source-1",
      requiredCapabilities: ["acp.codex"],
      agentAccess: persistedTestAgentAccess({
        database: fixture.database,
        hostId: host.id,
        workspaceId: fixture.workspaceId,
        callerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
      })
    });
    expect(
      fixture.service.replayEvents(
        {
          ...fixture.workspacePrincipal,
          humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
        },
        operation.id,
        0
      )
    ).toMatchObject({
      executionAttemptId: operation.executionAttemptId,
      events: []
    });

    const legacyOperation = fixture.coordination.operations.create({
      workspaceId: fixture.workspaceId,
      projectId: "project-a",
      canvasId: "default",
      blockRef: "T-001#B-003",
      ownershipGeneration: "generation-1",
      idempotencyKey: "workspace-session-legacy-observe",
      sourceFingerprint: "source-1",
      requiredCapabilities: ["acp.codex"]
    });
    expect(() =>
      fixture.service.replayEvents(fixture.workspacePrincipal, legacyOperation.id, 0)
    ).toThrow("operator_server_admin_required");
  });
});
