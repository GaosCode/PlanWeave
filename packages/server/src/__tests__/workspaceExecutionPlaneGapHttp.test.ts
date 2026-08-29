import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleCanvasCommandHttpRequest,
  resetCanvasCommandHttpRateLimits
} from "../canvas/http.js";
import { hashHumanToken, mintHumanDeviceToken } from "../identity/crypto.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { canvasCommandServiceFixture, submitBody } from "./support/canvasCommandServiceFixture.js";
import { CanvasRuntimeInitializationCoordinator } from "../canvas/runtimeInitializationCoordinator.js";
import { CanvasRuntimeCommandCoordinator } from "../canvas/runtimeCommandCoordinator.js";
import { CanvasRuntimeResetReceiptRepository } from "../canvas/runtimeCommandReceipts.js";
import { CanvasRuntimeUnavailableError } from "../canvas/executionRuntimePort.js";
import { readStableCanvasRuntimeEvidence } from "../canvas/contentFingerprint.js";
import { inWriteTransaction } from "../sqlite.js";
import {
  joinMember,
  jsonHeaders,
  remoteRunV3Body,
  startGrantedHostCatalogDispatchHttp,
  startPathlessCompositionWithGrantedHost
} from "./support/workspaceExecutionPlaneGapHttpFixture.js";

const canvasServers: HttpServer[] = [];

afterEach(async () => {
  resetCanvasCommandHttpRateLimits();
  await Promise.all(
    canvasServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

async function startCanvasCommandHttp(options: { activeLease?: boolean } = {}) {
  const fixture = await canvasCommandServiceFixture({
    runtimeAvailability: {
      async readAvailability() {
        return {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "runtime_not_attached"
        };
      }
    }
  });
  const {
    service,
    runtimeAvailabilityService,
    database,
    access,
    contentVersions,
    runtimeStatuses
  } = fixture;
  const repository = new HumanIdentityRepository(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const token = mintHumanDeviceToken();
  database
    .prepare(
      `INSERT INTO workspace_device_sessions(
        workspace_id,device_session_id,human_principal_id,credential_sha256,issued_at,
        expires_at,revoked_at,last_used_at
      ) VALUES(?,?,?,?,?,?,NULL,NULL)`
    )
    .run(
      "w",
      "device-owner",
      "owner",
      hashHumanToken(token),
      "2026-01-02T00:00:00.000Z",
      "2036-01-02T00:00:00.000Z"
    );
  const collaborationScopeAuthority = {
    hasProject: (projectId: string) => projectId === "p",
    hasScope: (scope: { workspaceId: string; projectId: string; canvasId?: string }) =>
      scope.workspaceId === "w" && scope.projectId === "p" && scope.canvasId === "default"
  };
  const runtimeInitializationCoordinator = new CanvasRuntimeInitializationCoordinator({
    access,
    workspaceIdentity,
    contentVersions,
    runtimeStatuses,
    executionLeases: {
      acquire() {
        throw new Error("unexpected_runtime_initialize_acquire");
      }
    },
    hasConflictingLease: () => false,
    commitTransaction: (action) => inWriteTransaction(database, action)
  });
  const runtimeCommandCoordinator = new CanvasRuntimeCommandCoordinator({
    access,
    workspaceIdentity,
    contentVersions,
    runtimeStatuses,
    receipts: new CanvasRuntimeResetReceiptRepository(database),
    executionLeases: {
      acquire() {
        throw new CanvasRuntimeUnavailableError("runtime_not_attached");
      }
    },
    hasConflictingLease: () => options.activeLease ?? false,
    commitTransaction: (action) => inWriteTransaction(database, action)
  });
  const server = createServer((request, response) => {
    void handleCanvasCommandHttpRequest(request, response, {
      service,
      runtimeAvailabilityService,
      runtimeInitializationCoordinator,
      runtimeCommandCoordinator,
      repository,
      workspaceIdentity,
      collaborationScopeAuthority,
      transportAdmission: loopbackHttpTransportAdmission,
      clock: () => new Date("2026-08-16T00:00:00.000Z")
    });
  });
  canvasServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  const head = contentVersions.head({ workspaceId: "w", projectId: "p", canvasId: "default" });
  const evidence = readStableCanvasRuntimeEvidence(contentVersions, {
    workspaceId: "w",
    projectId: "p",
    canvasId: "default"
  });
  if (!head || !evidence) throw new Error("test_content_authority_missing");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    token,
    head,
    fingerprint: evidence.target.graphFingerprint,
    sourceRevision: evidence.sourceRevision
  };
}

function catalogUrl(origin: string, projectId: string, workspaceId: string, canvasId: string) {
  return `${origin}/api/v1/projects/${projectId}/agent-endpoints?canvasId=${encodeURIComponent(canvasId)}&workspaceId=${encodeURIComponent(workspaceId)}`;
}

function dispatchUrl(origin: string, projectId: string) {
  return `${origin}/api/v1/projects/${projectId}/remote-operations`;
}

describe("workspace execution plane HTTP gaps", () => {
  it("PHASE0: member with grant and no workspace mapping can catalog and dispatch", async () => {
    const fixture = await startGrantedHostCatalogDispatchHttp({ mapWorkspace: false });
    const member = await joinMember(fixture.origin, fixture.projectId, fixture.ownerToken);
    const listed = await fetch(
      catalogUrl(fixture.origin, fixture.projectId, fixture.workspaceId, fixture.canvasId),
      { headers: { Authorization: `Bearer ${member.deviceToken}` } }
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      schemaVersion: "agent-endpoint-list/v1",
      items: [{ endpointId: fixture.endpointId, status: "available" }]
    });

    const dispatched = await fetch(dispatchUrl(fixture.origin, fixture.projectId), {
      method: "POST",
      headers: jsonHeaders(member.deviceToken),
      body: JSON.stringify(
        remoteRunV3Body({
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef,
          agentEndpointId: fixture.endpointId,
          idempotencyKey: "gap-member-dispatch",
          dispatchAuthority: fixture.dispatchAuthority
        })
      )
    });
    expect(dispatched.status).toBe(202);
    await expect(dispatched.json()).resolves.toMatchObject({
      agentEndpoint: {
        schemaVersion: "agent-endpoint/v1",
        endpointId: fixture.endpointId
      }
    });
  });

  it("owner unrestricted workspace canvas catalogs and dispatches without mapping", async () => {
    const fixture = await startGrantedHostCatalogDispatchHttp({ mapWorkspace: false });
    const listed = await fetch(
      catalogUrl(fixture.origin, fixture.projectId, fixture.workspaceId, fixture.canvasId),
      { headers: { Authorization: `Bearer ${fixture.ownerToken}` } }
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      schemaVersion: "agent-endpoint-list/v1",
      items: [{ endpointId: fixture.endpointId, status: "available" }]
    });

    const dispatched = await fetch(dispatchUrl(fixture.origin, fixture.projectId), {
      method: "POST",
      headers: jsonHeaders(fixture.ownerToken),
      body: JSON.stringify(
        remoteRunV3Body({
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef,
          agentEndpointId: fixture.endpointId,
          idempotencyKey: "gap-owner-dispatch",
          dispatchAuthority: fixture.dispatchAuthority
        })
      )
    });
    expect(dispatched.status).toBe(202);
  });

  it("first remote operation auto-prepares without pre-bound runtime host", async () => {
    const fixture = await startPathlessCompositionWithGrantedHost({
      mapWorkspace: true,
      liveCanvasRuntime: true
    });
    expect(fixture.listRuntimeBindings()).toEqual([]);
    const dispatched = await fetch(dispatchUrl(fixture.origin, fixture.projectId), {
      method: "POST",
      headers: jsonHeaders(fixture.ownerToken),
      body: JSON.stringify(
        remoteRunV3Body({
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef,
          agentEndpointId: fixture.endpointId,
          idempotencyKey: "gap-autoprepare-dispatch",
          dispatchAuthority: fixture.dispatchAuthority
        })
      )
    });
    const dispatchedBody = await dispatched.json();
    expect({
      status: dispatched.status,
      body: dispatchedBody
    }).toMatchObject({
      status: 202,
      body: { agentEndpoint: { endpointId: fixture.endpointId } }
    });
    expect(fixture.listRuntimeBindings()).toEqual([
      expect.objectContaining({
        host_id: fixture.hostId,
        readiness_status: "ready",
        route_selected: 1
      })
    ]);
    expect(fixture.listRuntimeBindings()[0]).not.toHaveProperty("operation_id");
    expect(fixture.listRuntimeAttachments()).toEqual([
      expect.objectContaining({
        operation_id: expect.any(String),
        execution_attempt_id: expect.any(String),
        host_id: fixture.hostId,
        host_generation: fixture.hostId,
        content_revision: fixture.contentHeadRevision(),
        graph_fingerprint: fixture.contentGraphFingerprint,
        reservation_lease_id: expect.any(String)
      })
    ]);
    const availability = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/canvases/${fixture.canvasId}/runtime-availability`,
      { headers: { Authorization: `Bearer ${fixture.ownerToken}` } }
    );
    expect(availability.status).toBe(200);
    await expect(availability.json()).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-view/v1",
      state: { kind: "initialized" }
    });
  });

  it("same-operation reenter does not duplicate attachment or reservation", async () => {
    const fixture = await startPathlessCompositionWithGrantedHost({
      mapWorkspace: true,
      liveCanvasRuntime: true
    });
    const body = JSON.stringify(
      remoteRunV3Body({
        projectId: fixture.projectId,
        canvasId: fixture.canvasId,
        blockRef: fixture.blockRef,
        agentEndpointId: fixture.endpointId,
        idempotencyKey: "gap-autoprepare-reenter",
        dispatchAuthority: fixture.dispatchAuthority
      })
    );
    const first = await fetch(dispatchUrl(fixture.origin, fixture.projectId), {
      method: "POST",
      headers: jsonHeaders(fixture.ownerToken),
      body
    });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { operationId: string };
    const second = await fetch(dispatchUrl(fixture.origin, fixture.projectId), {
      method: "POST",
      headers: jsonHeaders(fixture.ownerToken),
      body
    });
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toMatchObject({ operationId: firstBody.operationId });
    expect(fixture.listRuntimeBindings()).toHaveLength(1);
    expect(fixture.countOperations()).toBe(1);
    expect(fixture.countActiveReservations()).toBe(1);
  });

  it("returns distinct HTTP codes for Host offline and materialization failure", async () => {
    const offline = await startPathlessCompositionWithGrantedHost({
      mapWorkspace: true,
      liveCanvasRuntime: true
    });
    offline.disconnectCanvasRuntime?.();
    const offlineDispatch = await fetch(dispatchUrl(offline.origin, offline.projectId), {
      method: "POST",
      headers: jsonHeaders(offline.ownerToken),
      body: JSON.stringify(
        remoteRunV3Body({
          projectId: offline.projectId,
          canvasId: offline.canvasId,
          blockRef: offline.blockRef,
          agentEndpointId: offline.endpointId,
          idempotencyKey: "gap-offline-dispatch",
          dispatchAuthority: offline.dispatchAuthority
        })
      )
    });
    expect(offlineDispatch.status).toBe(503);
    await expect(offlineDispatch.json()).resolves.toEqual({ error: "human_remote_host_offline" });
    expect(offline.listRuntimeBindings()).toEqual([]);

    const materialization = await startPathlessCompositionWithGrantedHost({
      mapWorkspace: true,
      liveCanvasRuntime: { failOperation: "acquire" }
    });
    const failed = await fetch(dispatchUrl(materialization.origin, materialization.projectId), {
      method: "POST",
      headers: jsonHeaders(materialization.ownerToken),
      body: JSON.stringify(
        remoteRunV3Body({
          projectId: materialization.projectId,
          canvasId: materialization.canvasId,
          blockRef: materialization.blockRef,
          agentEndpointId: materialization.endpointId,
          idempotencyKey: "gap-materialization-dispatch",
          dispatchAuthority: materialization.dispatchAuthority
        })
      )
    });
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toEqual({
      error: "human_remote_materialization_failed"
    });
    expect(materialization.listRuntimeBindings()).toEqual([]);
  });

  it("returns revision drift when content-head and Host replica disagree", async () => {
    const fixture = await startPathlessCompositionWithGrantedHost({
      mapWorkspace: true,
      liveCanvasRuntime: { failOperation: "content_out_of_sync" }
    });
    const drifted = await fetch(dispatchUrl(fixture.origin, fixture.projectId), {
      method: "POST",
      headers: jsonHeaders(fixture.ownerToken),
      body: JSON.stringify(
        remoteRunV3Body({
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef,
          agentEndpointId: fixture.endpointId,
          idempotencyKey: "gap-revision-drift-dispatch",
          dispatchAuthority: fixture.dispatchAuthority
        })
      )
    });
    expect(drifted.status).toBe(503);
    await expect(drifted.json()).resolves.toEqual({ error: "human_remote_revision_drift" });
    expect(fixture.listRuntimeBindings()).toEqual([]);
  });

  it("returns active_lease when another Host holds an active Runtime lease", async () => {
    const fixture = await startPathlessCompositionWithGrantedHost({
      mapWorkspace: true,
      liveCanvasRuntime: true
    });
    const peerHostId = fixture.seedPeerRuntimeLease();
    expect(peerHostId).not.toBe(fixture.hostId);
    const conflicted = await fetch(dispatchUrl(fixture.origin, fixture.projectId), {
      method: "POST",
      headers: jsonHeaders(fixture.ownerToken),
      body: JSON.stringify(
        remoteRunV3Body({
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef,
          agentEndpointId: fixture.endpointId,
          idempotencyKey: "gap-active-lease-dispatch",
          dispatchAuthority: fixture.dispatchAuthority
        })
      )
    });
    expect(conflicted.status).toBe(409);
    await expect(conflicted.json()).resolves.toEqual({ error: "active_lease" });
    expect(fixture.listRuntimeBindings()).toEqual([]);
  });

  it("first remote operation attaches the reserved Host without a pre-bound runtime", async () => {
    const fixture = await startPathlessCompositionWithGrantedHost({ mapWorkspace: true });
    expect(fixture.listRuntimeBindings()).toEqual([]);
    const first = await fetch(dispatchUrl(fixture.origin, fixture.projectId), {
      method: "POST",
      headers: jsonHeaders(fixture.ownerToken),
      body: JSON.stringify(
        remoteRunV3Body({
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef,
          agentEndpointId: fixture.endpointId,
          idempotencyKey: "gap-attach-first",
          dispatchAuthority: fixture.dispatchAuthority
        })
      )
    });
    expect(first.status).toBe(503);
    await expect(first.json()).resolves.toEqual({ error: "human_remote_host_offline" });
    expect(fixture.listRuntimeBindings()).toEqual([]);
    const retry = await fetch(dispatchUrl(fixture.origin, fixture.projectId), {
      method: "POST",
      headers: jsonHeaders(fixture.ownerToken),
      body: JSON.stringify(
        remoteRunV3Body({
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef,
          agentEndpointId: fixture.endpointId,
          idempotencyKey: "gap-attach-retry",
          dispatchAuthority: fixture.dispatchAuthority
        })
      )
    });
    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toEqual({ error: "human_remote_operation_conflict" });
    expect(fixture.countOperations()).toBe(1);
    expect(fixture.listRuntimeBindings()).toEqual([]);
  });

  it("lists members, canvases, and content when execution is unavailable", async () => {
    const fixture = await startPathlessCompositionWithGrantedHost({ mapWorkspace: true });
    const auth = { Authorization: `Bearer ${fixture.ownerToken}` };
    const members = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/members?limit=1`,
      { headers: auth }
    );
    expect(members.status).toBe(200);
    await expect(members.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ humanPrincipalId: "pathless-owner", role: "owner" })]
    });

    const canvases = await fetch(
      `${fixture.origin}/api/v1/registry/projects/${fixture.projectId}/canvases`,
      { headers: auth }
    );
    expect(canvases.status).toBe(200);
    await expect(canvases.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          registry: expect.objectContaining({ canvasId: fixture.canvasId })
        })
      ]
    });

    const head = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/canvases/${fixture.canvasId}/content/head`,
      { headers: auth }
    );
    expect(head.status).toBe(200);

    const assignmentWorkItem = encodeURIComponent(
      JSON.stringify({ kind: "task", canvasId: fixture.canvasId, taskId: "T-001" })
    );
    const assignment = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/assignments?workItem=${assignmentWorkItem}`,
      { headers: auth }
    );
    expect(assignment.status).toBe(503);
    expect(members.status).toBe(200);
    expect(canvases.status).toBe(200);
    expect(head.status).toBe(200);

    const availability = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/canvases/${fixture.canvasId}/runtime-availability`,
      { headers: auth }
    );
    expect(availability.status).toBe(200);
    await expect(availability.json()).resolves.toMatchObject({
      schemaVersion: "canvas-runtime-view/v1",
      state: { kind: "uninitialized" }
    });
    expect(fixture.listRuntimeBindings()).toEqual([]);
  });

  it("accepts canvas command edits when execution availability is unattached", async () => {
    const { origin, token } = await startCanvasCommandHttp();
    const response = await fetch(`${origin}/api/v1/projects/p/canvases/default/commands`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(submitBody("edit-without-runtime", 0))
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "canvas.command.accepted"
    });
  });

  it("rejects invalid reset and initialize bodies on distinct HTTP outcome types", async () => {
    const { origin, token } = await startCanvasCommandHttp();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    };
    const invalidBody = JSON.stringify({ operationId: "control-invalid" });
    const initialize = await fetch(
      `${origin}/api/v1/projects/p/canvases/default/runtime-initialize`,
      { method: "POST", headers, body: invalidBody }
    );
    const reset = await fetch(`${origin}/api/v1/projects/p/canvases/default/runtime-reset`, {
      method: "POST",
      headers,
      body: invalidBody
    });
    expect(initialize.status).toBe(400);
    expect(reset.status).toBe(400);
    await expect(initialize.json()).resolves.toEqual({
      type: "canvas.runtime.initialize.rejected",
      operationId: "control-invalid",
      code: "invalid_request"
    });
    await expect(reset.json()).resolves.toEqual({
      type: "canvas.runtime.reset.rejected",
      operationId: "control-invalid",
      code: "invalid_request"
    });
  });

  it("resets without a Runtime attachment and still fences active work and source drift", async () => {
    const { origin, token, head, fingerprint, sourceRevision } = await startCanvasCommandHttp();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    };
    const response = await fetch(`${origin}/api/v1/projects/p/canvases/default/runtime-reset`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationId: "reset-unattached",
        expectedContentRevision: head.revision,
        expectedSourceRevision: sourceRevision,
        expectedGraphFingerprint: fingerprint
      })
    });
    const responseBody = await response.json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(responseBody).toMatchObject({
      type: "canvas.runtime.reset.accepted",
      status: { packageFingerprint: fingerprint }
    });

    const drifted = await fetch(`${origin}/api/v1/projects/p/canvases/default/runtime-reset`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationId: "reset-source-drift",
        expectedContentRevision: head.revision + 1,
        expectedSourceRevision: sourceRevision,
        expectedGraphFingerprint: fingerprint
      })
    });
    expect(drifted.status).toBe(409);
    await expect(drifted.json()).resolves.toMatchObject({ code: "source_drift" });

    const active = await startCanvasCommandHttp({ activeLease: true });
    const activeResponse = await fetch(
      `${active.origin}/api/v1/projects/p/canvases/default/runtime-reset`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${active.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          operationId: "reset-active-work",
          expectedContentRevision: active.head.revision,
          expectedSourceRevision: active.sourceRevision,
          expectedGraphFingerprint: active.fingerprint
        })
      }
    );
    expect(activeResponse.status).toBe(409);
    await expect(activeResponse.json()).resolves.toMatchObject({ code: "active_lease" });
  });
});
