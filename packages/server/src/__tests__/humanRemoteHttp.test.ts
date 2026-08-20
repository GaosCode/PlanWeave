import { createServer, type Server as HttpServer } from "node:http";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createRemoteBlockRuntimePort, type PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import {
  handleHumanHttpRequest,
  HumanIdentityRepository,
  HumanMembershipService
} from "../identity/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { HumanRemoteControlService } from "../humanRemoteControlService.js";
import { handleHumanRemoteHttpRequest } from "../humanRemoteHttp.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";
import { AuthorityRepository } from "../work/authorityRepository.js";

const directories: string[] = [];
const storageServers: PlanweaveServer[] = [];
const httpServers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const server of storageServers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    }
  };
  return manifest;
}

async function setup(options: { runtimeAvailable?: boolean } = {}) {
  const workspace = await createTestWorkspace(remoteManifest());
  directories.push(workspace.home, workspace.root);
  const dataDirectory = join(workspace.root, "server-data");
  const storage = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  storageServers.push(storage);

  const projectId = workspace.init.workspace.id;
  const canvasId = "default";
  const blockRef = "T-001#B-001";
  const otherProjectId = "trusted-other-project";
  const identity = new HumanIdentityRepository(storage.database);
  const workspaceIdentity = new WorkspaceIdentityRepository(storage.database);
  const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
  const collaborationScopeAuthority = {
    hasProject: (candidate: string) => candidate === projectId || candidate === otherProjectId,
    hasScope: (scope: { workspaceId: string; projectId: string }) =>
      scope.workspaceId === workspaceId &&
      (scope.projectId === projectId || scope.projectId === otherProjectId)
  };
  const membership = new HumanMembershipService({
    repository: identity,
    collaborationScopeAuthority,
    workspaceForProject: (candidate) =>
      candidate === projectId || candidate === otherProjectId ? workspaceId : undefined
  });
  const access = new ProjectAccessRepository(storage.database);
  access.registerProjectInternal({
    workspaceId,
    projectId,
    projectRoot: workspace.root
  });
  access.registerCanvasInternal({
    workspaceId,
    projectId,
    canvasId,
    packageDir: workspace.init.workspace.packageDir
  });
  const registry = new RemoteRuntimePortRegistry();
  registry.bind(
    { workspaceId, projectId, canvasId },
    canonicalRemoteRuntimePort(
      createRemoteBlockRuntimePort({ projectRoot: workspace.root }),
      workspaceId
    )
  );
  const artifacts = new ArtifactStore(storage.database, dataDirectory, 1024 * 1024);
  const coordination = createRemoteBlockCoordination(
    storage.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeResolver: registry,
      inputArtifacts: { materialize: async () => undefined },
      artifactContent: { readReport: async (ref) => artifacts.read(ref) },
      interactionAuthorization: {
        canRespond: ({ responderId, projectId: targetProjectId }) =>
          identity.getActiveMembership(targetProjectId, responderId) !== undefined
      }
    },
    { serverInstanceOwnerToken: storage.serverInstanceOwnerToken }
  );
  const host = coordination.hosts.register("Human Remote Host").host;
  coordination.hosts.bindToWorkspace(host.id, workspaceId);
  coordination.hosts.reportOnline(host.id, ["acp.codex", "acp.session.load"], 1, {
    workspaceMappings: [{ workspaceId, status: "ready" }],
    acpProfiles: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Test Agent",
        status: "ready",
        capabilities: ["acp.codex", "acp.session.load"]
      }
    ]
  });
  const authority = new AuthorityRepository(storage.database);
  const executionTarget = authority.applyExecutionTarget({
    mutation: {
      schemaVersion: "execution-target/v1",
      scope: { kind: "block", workspaceId, projectId, canvasId, blockRef },
      target: { kind: "exact_host", hostId: host.id },
      expectedRevision: 0
    },
    actor: { kind: "system", id: "human-remote-http-test" }
  });
  const service = new HumanRemoteControlService({
    operations: coordination.operations,
    dispatches: coordination.dispatches,
    coordinator: coordination.coordinator,
    events: coordination.acpEvents,
    interactions: coordination.interactions,
    runtimeAvailable: () => options.runtimeAvailable ?? true
  });
  let acceptingMutations = true;

  const httpServer = createServer((request, response) => {
    void (async () => {
      if (
        await handleHumanHttpRequest(request, response, {
          service: membership,
          repository: identity,
          collaborationScopeAuthority,
          transportAdmission: loopbackHttpTransportAdmission
        })
      ) {
        return;
      }
      if (
        await handleHumanRemoteHttpRequest(request, response, {
          service,
          repository: identity,
          workspaceIdentity,
          collaborationScopeAuthority,
          readiness: () =>
            acceptingMutations
              ? { status: "ready", schemaVersion: 1 }
              : { status: "draining", schemaVersion: 1 },
          transportAdmission: loopbackHttpTransportAdmission
        })
      ) {
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "route_not_found" }));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "request_failed" }));
      } else {
        response.destroy();
      }
    });
  });
  httpServers.push(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    projectId,
    workspaceId,
    canvasId,
    blockRef,
    otherProjectId,
    host,
    authority,
    coordination,
    executionTargetRevision: executionTarget.revision,
    setAcceptingMutations(value: boolean) {
      acceptingMutations = value;
    }
  };
}

function remoteDispatchBody(
  fixture: Awaited<ReturnType<typeof setup>>,
  idempotencyKey: string
): Record<string, unknown> {
  const endpoint = fixture.coordination.agentEndpoints.listVisible(fixture.workspaceId).items[0];
  if (!endpoint) throw new Error("human_remote_test_endpoint_missing");
  return {
    schemaVersion: "remote-run/v3",
    projectId: fixture.projectId,
    canvasId: fixture.canvasId,
    blockRef: fixture.blockRef,
    agentEndpointId: endpoint.endpointId,
    idempotencyKey,
    expectedResponsibilityRevision: 0,
    expectedReviewerRevision: 0
  };
}

function headers(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function bootstrap(origin: string, projectId: string, principalId: string) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ displayName: principalId, humanPrincipalId: principalId })
  });
  const body = (await response.json()) as { deviceToken: string };
  expect(response.status).toBe(201);
  return body.deviceToken;
}

async function joinMember(origin: string, projectId: string, ownerToken: string) {
  const invitation = await fetch(`${origin}/api/v1/projects/${projectId}/human/invitations`, {
    method: "POST",
    headers: headers(ownerToken),
    body: JSON.stringify({})
  });
  const invitationBody = (await invitation.json()) as { invitationToken: string };
  expect(invitation.status).toBe(201);
  const joined = await fetch(`${origin}/api/v1/projects/${projectId}/human/invitations/consume`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ invitationToken: invitationBody.invitationToken, displayName: "Member" })
  });
  const joinedBody = (await joined.json()) as {
    deviceToken: string;
    principal: { humanPrincipalId: string };
  };
  expect(joined.status).toBe(201);
  return joinedBody;
}

describe("human remote operation HTTP", () => {
  it("dispatches v3 through an exact Agent Endpoint without exposing Host routing", async () => {
    const fixture = await setup();
    const token = await bootstrap(fixture.origin, fixture.projectId, "endpoint-owner");
    fixture.authority.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope: {
          kind: "block",
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef
        },
        target: { kind: "unassigned" },
        expectedRevision: fixture.executionTargetRevision
      },
      actor: { kind: "system", id: "endpoint-v3-test" }
    });
    const endpoint = fixture.coordination.agentEndpoints.listVisible(fixture.workspaceId).items[0];
    expect(endpoint).toBeDefined();
    const dispatched = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/remote-operations`,
      {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({
          schemaVersion: "remote-run/v3",
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef,
          agentEndpointId: endpoint?.endpointId,
          idempotencyKey: "human-endpoint-dispatch",
          expectedResponsibilityRevision: 0,
          expectedReviewerRevision: 0
        })
      }
    );
    const body = (await dispatched.json()) as Record<string, unknown>;
    expect({ status: dispatched.status, body }).toMatchObject({
      status: 202,
      body: {
        agentEndpoint: {
          schemaVersion: "agent-endpoint/v1",
          endpointId: endpoint?.endpointId,
          profileId: "codex-acp",
          agentId: "codex",
          hostDisplayName: "Human Remote Host"
        }
      }
    });
    expect(JSON.stringify(body)).not.toContain(fixture.host.id);
    expect(body).not.toHaveProperty("hostId");
    const operationId = String(body.operationId);
    expect(
      fixture.coordination.operations.getRequired(operationId).endpointSelection?.authority
    ).toEqual({
      schemaVersion: "endpoint-authority/v1",
      controlPlane: "collaboration",
      responsibilityRevision: 0,
      reviewerRevision: 0
    });
  });

  it("returns the normalized Host failure in the human operation observation", async () => {
    const fixture = await setup();
    const token = await bootstrap(fixture.origin, fixture.projectId, "failure-observer");
    const collection = `${fixture.origin}/api/v1/projects/${fixture.projectId}/remote-operations`;
    const dispatched = await fetch(collection, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(remoteDispatchBody(fixture, "human-failed-dispatch"))
    });
    const operation = (await dispatched.json()) as {
      operationId: string;
      dispatchId: string;
      executionAttemptId: string;
      attempt: { leaseId: string };
    };
    expect(dispatched.status).toBe(202);

    fixture.coordination.dispatches.accept(
      fixture.host.id,
      "human-failed-accept",
      operation.dispatchId,
      operation.attempt.leaseId,
      operation.executionAttemptId
    );
    await fixture.coordination.dispatches.fail(
      fixture.host.id,
      "human-failed-terminal",
      operation.dispatchId,
      operation.attempt.leaseId,
      operation.executionAttemptId,
      {
        code: "acp_authentication_required",
        message: "ACP authentication is required.",
        retryable: false
      }
    );

    const observed = await fetch(`${collection}/${operation.operationId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const observedBody = (await observed.json()) as Record<string, unknown>;
    expect({ status: observed.status, body: observedBody }).toMatchObject({
      status: 200,
      body: {
        state: "failed",
        dispatchStatus: "failed",
        failure: {
          code: "acp_authentication_required",
          message: "ACP authentication is required.",
          retryable: false
        }
      }
    });
  });

  it("returns a stable conflict when a selected Agent Endpoint no longer exists", async () => {
    const fixture = await setup();
    const token = await bootstrap(fixture.origin, fixture.projectId, "missing-endpoint-owner");
    const response = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/remote-operations`,
      {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({
          schemaVersion: "remote-run/v3",
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef,
          agentEndpointId: "missing-agent-endpoint",
          idempotencyKey: "missing-endpoint-dispatch",
          expectedResponsibilityRevision: 0,
          expectedReviewerRevision: 0
        })
      }
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "agent_endpoint_unknown" });
  });

  it("reports Runtime unavailability after collaboration scope authorization", async () => {
    const fixture = await setup({ runtimeAvailable: false });
    const token = await bootstrap(fixture.origin, fixture.projectId, "runtime-unavailable-owner");
    const response = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/remote-operations`,
      {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify(remoteDispatchBody(fixture, "runtime-unavailable-dispatch"))
      }
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "human_remote_runtime_unavailable"
    });
  });

  it.each([
    "remote-run/v1",
    "remote-run/v2"
  ])("rejects authorized %s dispatch without creating an operation", async (schemaVersion) => {
    const fixture = await setup();
    const token = await bootstrap(fixture.origin, fixture.projectId, "legacy-dispatch-owner");
    const response = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/remote-operations`,
      {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({
          schemaVersion,
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef,
          idempotencyKey: "legacy-dispatch",
          expectedResponsibilityRevision: 0,
          expectedReviewerRevision: 0,
          expectedExecutionTargetRevision: fixture.executionTargetRevision
        })
      }
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "remote_run_v3_required" });
    expect(fixture.coordination.operations.listNonTerminal()).toEqual([]);
  });

  it("serves strict dispatch, observation, replay, action, and interaction routes to members", async () => {
    const fixture = await setup();
    const ownerToken = await bootstrap(fixture.origin, fixture.projectId, "remote-owner");
    const member = await joinMember(fixture.origin, fixture.projectId, ownerToken);
    const collection = `${fixture.origin}/api/v1/projects/${fixture.projectId}/remote-operations`;

    const dispatched = await fetch(collection, {
      method: "POST",
      headers: headers(member.deviceToken),
      body: JSON.stringify(remoteDispatchBody(fixture, "human-remote-dispatch-1"))
    });
    const operation = (await dispatched.json()) as {
      operationId: string;
      dispatchId: string;
      executionAttemptId: string;
      attempt: { leaseId: string; stateVersion: number };
      envelopeDigest?: string;
    };
    expect(dispatched.status).toBe(202);
    expect(operation.operationId).toBeTruthy();
    expect(operation.attempt).toMatchObject({
      leaseId: expect.any(String),
      stateVersion: expect.any(Number)
    });
    expect(operation).not.toHaveProperty("envelopeDigest");
    expect(operation).not.toHaveProperty("reportArtifactRef");

    const observed = await fetch(`${collection}/${operation.operationId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    expect(observed.status).toBe(200);
    await expect(observed.json()).resolves.toMatchObject({ operationId: operation.operationId });

    const emptyEvents = await fetch(`${collection}/${operation.operationId}/events?afterCursor=0`, {
      headers: { Authorization: `Bearer ${member.deviceToken}` }
    });
    expect(emptyEvents.status).toBe(200);
    await expect(emptyEvents.json()).resolves.toMatchObject({
      afterCursor: 0,
      cursor: 0,
      highWatermark: 0,
      hasMore: false,
      events: []
    });
    fixture.coordination.acpEvents.ingest(fixture.host.id, "human-event-1", {
      type: "acp.events",
      dispatchId: operation.dispatchId,
      leaseId: operation.attempt.leaseId,
      executionAttemptId: operation.executionAttemptId,
      acpSessionId: "acp-human-1",
      afterCursor: 0,
      cursor: 1,
      events: [{ cursor: 1, kind: "agent_message", text: "Remote progress" }]
    });
    const events = await fetch(`${collection}/${operation.operationId}/events?afterCursor=0`, {
      headers: { Authorization: `Bearer ${member.deviceToken}` }
    });
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      afterCursor: 0,
      events: [{ cursor: 1, kind: "agent_message", text: "Remote progress" }]
    });

    const request = {
      type: "interaction.permission_requested" as const,
      dispatchId: operation.dispatchId,
      leaseId: operation.attempt.leaseId,
      executionAttemptId: operation.executionAttemptId,
      actionId: "permission-human-1",
      acpSessionId: "acp-human-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      title: "Permission",
      description: "Allow this operation?"
    };
    fixture.coordination.interactions.recordRequest(fixture.host.id, "human-request-1", request);
    const interactions = await fetch(
      `${collection}/${operation.operationId}/interactions?cursor=0&limit=20`,
      { headers: { Authorization: `Bearer ${member.deviceToken}` } }
    );
    expect(interactions.status).toBe(200);
    await expect(interactions.json()).resolves.toMatchObject({
      items: [{ operationId: operation.operationId, status: "pending" }]
    });

    const settlement = {
      type: "interaction.permission_response",
      dispatchId: operation.dispatchId,
      leaseId: operation.attempt.leaseId,
      executionAttemptId: operation.executionAttemptId,
      actionId: request.actionId,
      acpSessionId: request.acpSessionId,
      decision: "deny"
    };
    const settled = await fetch(`${collection}/${operation.operationId}/interactions/respond`, {
      method: "POST",
      headers: headers(member.deviceToken),
      body: JSON.stringify(settlement)
    });
    expect(settled.status).toBe(200);
    await expect(settled.json()).resolves.toMatchObject({ status: "settled" });

    const action = await fetch(`${collection}/${operation.operationId}/actions`, {
      method: "POST",
      headers: headers(ownerToken),
      body: JSON.stringify({
        kind: "cancel",
        actionId: "human-cancel-1",
        operationId: operation.operationId,
        dispatchId: operation.dispatchId,
        executionAttemptId: operation.executionAttemptId,
        expectedAttemptVersion: operation.attempt.stateVersion,
        leaseId: operation.attempt.leaseId,
        reason: "Owner requested cancellation"
      })
    });
    const actionBody = (await action.json()) as Record<string, unknown>;
    expect({ status: action.status, body: actionBody }).toMatchObject({
      status: 202,
      body: { state: "delivered" }
    });
  });

  it("distinguishes unauthenticated from unauthorized scope without revealing target trust", async () => {
    const fixture = await setup();
    const token = await bootstrap(fixture.origin, fixture.projectId, "boundary-owner");
    const body = JSON.stringify(remoteDispatchBody(fixture, "boundary-dispatch"));
    const targets = [
      {
        path: `${fixture.origin}/api/v1/projects/${fixture.otherProjectId}/remote-operations`,
        error: "human_remote_project_mismatch"
      },
      {
        path: `${fixture.origin}/api/v1/projects/untrusted-project/remote-operations`,
        error: "human_cross_project_forbidden"
      }
    ];

    for (const target of targets) {
      const denied = await fetch(target.path, {
        method: "POST",
        headers: headers(token),
        body
      });
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toEqual({ error: target.error });
    }

    for (const credential of [undefined, "pw_host_not_human", "operator-token-not-human"]) {
      for (const target of targets) {
        const denied = await fetch(target.path, {
          method: "POST",
          headers: headers(credential),
          body
        });
        expect(denied.status).toBe(401);
        await expect(denied.json()).resolves.toEqual({ error: "human_auth_unauthenticated" });
      }
    }

    fixture.setAcceptingMutations(false);
    const draining = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/remote-operations`,
      {
        method: "POST",
        headers: headers(token),
        body
      }
    );
    expect(draining.status).toBe(503);
    await expect(draining.json()).resolves.toEqual({ error: "server_not_accepting_mutations" });
  });

  it("materializes resume lease and recovery on the Server and replays by actionId", async () => {
    const fixture = await setup();
    const token = await bootstrap(fixture.origin, fixture.projectId, "resume-owner");
    const collection = `${fixture.origin}/api/v1/projects/${fixture.projectId}/remote-operations`;
    const dispatched = await fetch(collection, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(remoteDispatchBody(fixture, "human-resume-dispatch"))
    });
    expect(dispatched.status).toBe(202);
    const operation = (await dispatched.json()) as {
      operationId: string;
      dispatchId: string;
      executionAttemptId: string;
      attempt: { leaseId: string; stateVersion: number };
    };
    expect(operation.dispatchId).toBeTruthy();
    const dispatch = fixture.coordination.dispatches.getRequired(operation.dispatchId);
    fixture.coordination.dispatches.accept(
      fixture.host.id,
      "human-resume-accept",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    fixture.coordination.dispatches.interrupt(fixture.host.id, "human-resume-interrupt", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "human-resume-interrupt",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "acp_session_lost",
      resumable: true,
      recovery: { acpSessionId: "session-human-resume", recoveryId: "recovery-human-resume" }
    });
    const reservation = fixture.coordination.reservations.getRequired(dispatch.leaseId);
    fixture.coordination.reservations.release({
      leaseId: reservation.leaseId,
      fencingToken: reservation.fencingToken,
      expectedVersion: reservation.version,
      reason: "expired"
    });
    await fixture.coordination.coordinator.reenter(operation.operationId);
    const interrupted = fixture.coordination.operations.getRequired(operation.operationId);

    const command = {
      kind: "resume_same_session",
      actionId: "human-resume-action-1",
      operationId: operation.operationId,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      priorLeaseId: operation.attempt.leaseId,
      reason: "resume after transport loss"
    };
    const resumed = await fetch(`${collection}/${operation.operationId}/actions`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(command)
    });
    const resumedBody = (await resumed.json()) as {
      request: Record<string, unknown>;
      state: string;
    };
    expect(resumed.status).toBe(202);
    expect(resumedBody.state).toBe("delivered");
    expect(resumedBody.request).toMatchObject({
      kind: "resume_same_session",
      priorLeaseId: reservation.leaseId,
      recovery: { acpSessionId: "session-human-resume", recoveryId: "recovery-human-resume" }
    });
    expect(resumedBody.request.leaseId).not.toBe(reservation.leaseId);
    expect(resumedBody.request.leaseExpiresAt).toEqual(expect.any(String));
    expect(resumedBody.request).not.toHaveProperty("leaseTtlMs");

    const replay = await fetch(`${collection}/${operation.operationId}/actions`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(command)
    });
    await expect(replay.json()).resolves.toMatchObject({ state: "delivered" });
    expect(replay.status).toBe(202);

    const conflict = await fetch(`${collection}/${operation.operationId}/actions`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ ...command, reason: "different payload" })
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: "human_remote_operation_conflict"
    });
  });
});
