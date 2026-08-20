import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { parseServerConfig } from "../config.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase } from "../sqlite.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";
import {
  adminToken,
  jsonHeaders,
  remoteManifest,
  setupServerCompositionFixture
} from "./support/serverCompositionFixture.js";

const httpServers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  return setupServerCompositionFixture({ directories, httpServers, compositions });
}

describe("distributed server composition", () => {
  it("starts a collaboration Server before any trusted project is configured", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const httpServer = createServer();
    httpServers.push(httpServer);
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory: join(workspace.root, "empty-collaboration-server-data"),
      trustedProjects: [],
      operatorCredentials: [
        {
          operatorId: "admin",
          tokenSha256: hashOperatorToken(adminToken),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    const composition = await createDistributedServerComposition({ httpServer, config });
    compositions.push(composition);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected HTTP address");

    expect(composition.trustedProjectControl.listTrustedProjectScopes()).toEqual([]);
    const origin = `http://127.0.0.1:${address.port}`;
    const readiness = await fetch(`${origin}/readyz`);
    expect(readiness.status).toBe(200);
    const issued = await fetch(`${origin}/api/v1/setup-codes`, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session"
      })
    });
    expect(issued.status).toBe(201);
    await expect(issued.json()).resolves.toMatchObject({
      grant: { workspaceId: "workspace-self-host", purpose: "device_session" },
      displayOnce: true
    });
  });

  it("uses an active pathless registry scope for collaboration and reports missing Runtime", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const httpServer = createServer();
    httpServers.push(httpServer);
    const dataDirectory = join(workspace.root, "restored-identity-server-data");
    const restoredProjectId = "restored-project-1";
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [],
      operatorCredentials: [
        {
          operatorId: "admin",
          tokenSha256: hashOperatorToken(adminToken),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    const composition = await createDistributedServerComposition({ httpServer, config });
    compositions.push(composition);
    const database = await openServerDatabase(config.databasePath, 5_000);
    try {
      const access = new ProjectAccessRepository(database);
      const workspaceIdentity = new WorkspaceIdentityRepository(database);
      access.registerProjectInternal({
        workspaceId: "workspace-self-host",
        projectId: restoredProjectId,
        projectRoot: workspace.root
      });
      access.registerCanvasInternal({
        workspaceId: "workspace-self-host",
        projectId: restoredProjectId,
        canvasId: "default",
        packageDir: workspace.root
      });
      database
        .prepare("UPDATE project_registry SET project_root_internal=NULL WHERE project_id=?")
        .run(restoredProjectId);
      database
        .prepare(
          "UPDATE canvas_registry SET package_dir_internal=NULL WHERE project_id=? AND canvas_id='default'"
        )
        .run(restoredProjectId);
      workspaceIdentity.ensureLegacyProjectAdapter(restoredProjectId, "workspace-self-host");
    } finally {
      database.close();
    }
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected HTTP address");
    const origin = `http://127.0.0.1:${address.port}`;

    const unknown = await fetch(`${origin}/api/v1/projects/unknown-project/human/members?limit=1`);
    expect(unknown.status).toBe(403);
    await expect(unknown.json()).resolves.toEqual({ error: "human_cross_project_forbidden" });

    const bootstrap = await fetch(
      `${origin}/api/v1/projects/${restoredProjectId}/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Restored Owner", humanPrincipalId: "restored-owner" })
      }
    );
    expect(bootstrap.status).toBe(201);
    const { deviceToken } = (await bootstrap.json()) as { deviceToken: string };
    const members = await fetch(
      `${origin}/api/v1/projects/${restoredProjectId}/human/members?limit=1`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(members.status).toBe(200);
    await expect(members.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ humanPrincipalId: "restored-owner", role: "owner" })]
    });

    const access = await fetch(
      `${origin}/api/v1/projects/${restoredProjectId}/canvases/default/access`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(access.status).toBe(200);

    const agentEndpoints = await fetch(
      `${origin}/api/v1/projects/${restoredProjectId}/agent-endpoints`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(agentEndpoints.status).toBe(200);
    await expect(agentEndpoints.json()).resolves.toEqual({
      schemaVersion: "agent-endpoint-list/v1",
      items: []
    });

    const workItem = encodeURIComponent(
      JSON.stringify({ kind: "task", canvasId: "default", taskId: "T-001" })
    );
    const assignment = await fetch(
      `${origin}/api/v1/projects/${restoredProjectId}/assignments?workItem=${workItem}`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(assignment.status).toBe(503);
    await expect(assignment.json()).resolves.toEqual({ error: "runtime_not_attached" });

    const remoteOperation = await fetch(
      `${origin}/api/v1/projects/${restoredProjectId}/remote-operations`,
      {
        method: "POST",
        headers: jsonHeaders(deviceToken),
        body: JSON.stringify({
          schemaVersion: "remote-run/v3",
          projectId: restoredProjectId,
          canvasId: "default",
          blockRef: "T-001#B-001",
          agentEndpointId: "missing-agent-endpoint",
          idempotencyKey: "pathless-registry-dispatch",
          expectedResponsibilityRevision: 0,
          expectedReviewerRevision: 0
        })
      }
    );
    expect(remoteOperation.status).toBe(503);
    await expect(remoteOperation.json()).resolves.toEqual({
      error: "human_remote_runtime_unavailable"
    });

    const canvases = await fetch(
      `${origin}/api/v1/registry/projects/${restoredProjectId}/canvases`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(canvases.status).toBe(200);
    await expect(canvases.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({ registry: expect.objectContaining({ canvasId: "default" }) })
      ]
    });

    const head = await fetch(
      `${origin}/api/v1/projects/${restoredProjectId}/canvases/default/content/head`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deviceToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          projectId: restoredProjectId,
          canvasId: "default",
          localReplica: null,
          knownRevision: null
        })
      }
    );
    expect(head.status).toBe(200);
    await expect(head.json()).resolves.toMatchObject({
      authoritativeHead: null,
      canPublishInitial: true
    });

    const runtimeAvailability = await fetch(
      `${origin}/api/v1/projects/${restoredProjectId}/canvases/default/runtime-availability`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(runtimeAvailability.status).toBe(200);
    await expect(runtimeAvailability.json()).resolves.toEqual({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "unavailable",
      reason: "runtime_not_attached"
    });

    const reconnect = await fetch(
      `${origin}/api/v1/projects/${restoredProjectId}/canvases/default/reconnect`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deviceToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ afterRevision: 0 })
      }
    );
    expect(reconnect.status).toBe(409);
    await expect(reconnect.json()).resolves.toMatchObject({
      type: "canvas.reconnect.error",
      code: "snapshot_malformed"
    });

    const revokeDatabase = await openServerDatabase(config.databasePath, 5_000);
    try {
      revokeDatabase
        .prepare("UPDATE project_registry SET revoked_at=? WHERE project_id=?")
        .run("2026-08-20T00:00:00.000Z", restoredProjectId);
    } finally {
      revokeDatabase.close();
    }
    const revokedAgentEndpoints = await fetch(
      `${origin}/api/v1/projects/${restoredProjectId}/agent-endpoints`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(revokedAgentEndpoints.status).toBe(403);
    await expect(revokedAgentEndpoints.json()).resolves.toEqual({
      error: "agent_endpoint_forbidden"
    });
    const revokedAssignment = await fetch(
      `${origin}/api/v1/projects/${restoredProjectId}/assignments?workItem=${workItem}`,
      { headers: { Authorization: `Bearer ${deviceToken}` } }
    );
    expect(revokedAssignment.status).toBe(403);
    await expect(revokedAssignment.json()).resolves.toEqual({
      error: "work_cross_project_forbidden"
    });
  });

  it("exposes active trusted project scopes with WorkspaceIdentity-derived workspace IDs", async () => {
    const fixture = await setup();
    const scopes = fixture.composition.trustedProjectControl.listTrustedProjectScopes();
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ projectId: fixture.projectId, canvasId: "default" });
    expect(JSON.stringify(scopes)).not.toMatch(/path|package|tmp/);

    const database = await openServerDatabase(fixture.databasePath, 5_000);
    try {
      expect(fixture.workspaceId).toBe(scopes[0].workspaceId);
      expect(
        fixture.composition.trustedProjectControl.resolveTrustedProjectScope({
          workspaceId: "workspace-other-001",
          projectId: fixture.projectId,
          canvasId: "default"
        })
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("materializes trusted registry owners during bootstrap for listing and management", async () => {
    const fixture = await setup();
    const bootstrap = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
      }
    );
    expect(bootstrap.status).toBe(201);
    const bootstrapBody = (await bootstrap.json()) as { deviceToken: string };
    const headers = { Authorization: `Bearer ${bootstrapBody.deviceToken}` };

    const projects = await fetch(`${fixture.origin}/api/v1/registry/projects`, { headers });
    expect(projects.status).toBe(200);
    await expect(projects.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          registry: expect.objectContaining({ projectId: fixture.projectId }),
          owner: "trusted-owner"
        })
      ]
    });

    const canvases = await fetch(
      `${fixture.origin}/api/v1/registry/projects/${fixture.projectId}/canvases`,
      { headers }
    );
    expect(canvases.status).toBe(200);
    const canvasesBody = (await canvases.json()) as {
      items: Array<{ registry: { canvasId: string }; owner: string; acl: { revision: number } }>;
    };
    expect(canvasesBody.items).toEqual([
      expect.objectContaining({
        registry: expect.objectContaining({ canvasId: "default" }),
        owner: "trusted-owner",
        acl: { revision: 0, updatedAt: expect.any(String) }
      })
    ]);

    const snapshot = await fetch(
      `${fixture.origin}/api/v1/registry/projects/${fixture.projectId}/canvases/default/snapshots`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          projectId: fixture.projectId,
          canvasId: "default",
          expectedAclRevision: canvasesBody.items[0].acl.revision
        })
      }
    );
    expect(snapshot.status).toBe(201);
  });
});
