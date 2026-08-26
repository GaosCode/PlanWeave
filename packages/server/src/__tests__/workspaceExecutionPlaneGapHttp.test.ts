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

async function startCanvasCommandHttp() {
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
  const server = createServer((request, response) => {
    void handleCanvasCommandHttpRequest(request, response, {
      service,
      runtimeAvailabilityService,
      runtimeInitializationCoordinator,
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
  return { origin: `http://127.0.0.1:${address.port}`, token };
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
          idempotencyKey: "gap-member-dispatch"
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
          idempotencyKey: "gap-owner-dispatch"
        })
      )
    });
    expect(dispatched.status).toBe(202);
  });

  it.fails("PHASE0 GAP: first remote operation auto-prepares without pre-bound runtime host", async () => {
    const fixture = await startPathlessCompositionWithGrantedHost({ mapWorkspace: true });
    const dispatched = await fetch(dispatchUrl(fixture.origin, fixture.projectId), {
      method: "POST",
      headers: jsonHeaders(fixture.ownerToken),
      body: JSON.stringify(
        remoteRunV3Body({
          projectId: fixture.projectId,
          canvasId: fixture.canvasId,
          blockRef: fixture.blockRef,
          agentEndpointId: fixture.endpointId,
          idempotencyKey: "gap-autoprepare-dispatch"
        })
      )
    });
    expect(dispatched.status).toBe(202);
    await expect(dispatched.json()).resolves.toMatchObject({
      agentEndpoint: { endpointId: fixture.endpointId }
    });
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
    expect(reset.status).toBe(503);
    await expect(initialize.json()).resolves.toEqual({
      type: "canvas.runtime.initialize.rejected",
      operationId: "control-invalid",
      code: "invalid_request"
    });
    await expect(reset.json()).resolves.toEqual({
      type: "canvas.runtime.reset.rejected",
      operationId: "control-invalid",
      code: "unavailable"
    });
  });

  it("rejects reset without a runtime coordinator as reset unavailable, not initialize", async () => {
    const { origin, token } = await startCanvasCommandHttp();
    const response = await fetch(`${origin}/api/v1/projects/p/canvases/default/runtime-reset`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        operationId: "reset-unattached",
        expectedContentRevision: 1,
        expectedSourceRevision: `snapshot:${"a".repeat(64)}`,
        expectedGraphFingerprint: `pkg-${"b".repeat(64)}`
      })
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { type: string; code: string };
    expect(body.type).toBe("canvas.runtime.reset.rejected");
    expect(body.code).toBe("unavailable");
    expect(body.type).not.toContain("initialize");
  });
});
