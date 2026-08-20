import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEndpointCatalog } from "../agentEndpointCatalog.js";
import { handleAgentEndpointHttpRequest } from "../agentEndpointHttp.js";
import { AgentHostRepository } from "../hosts.js";
import { HostReservationRepository } from "../hostReservations.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { parseServerConfig } from "../config.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";

const httpServers: HttpServer[] = [];
const databases: SqliteDatabase[] = [];
const compositions: DistributedServerComposition[] = [];
const directories: string[] = [];
const now = new Date("2026-08-03T08:00:00.000Z");
const adminToken = `pw_operator_${"E".repeat(43)}`;

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject("project-a");
  const foreignWorkspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject("project-b");
  const identity = new HumanIdentityRepository(database, () => now);
  const owner = identity.bootstrapOwner({
    kind: "local_administrative_proof",
    projectId: "project-a",
    humanPrincipalId: "owner-a",
    displayName: "Owner A",
    issuedAt: now.toISOString()
  });
  const foreignOwner = identity.bootstrapOwner({
    kind: "local_administrative_proof",
    projectId: "project-b",
    humanPrincipalId: "owner-b",
    displayName: "Owner B",
    issuedAt: now.toISOString()
  });
  const hosts = new AgentHostRepository(database, () => now);
  const registered = hosts.register("HTTP Host").host;
  hosts.bindToWorkspace(registered.id, workspaceId);
  hosts.reportOnline(registered.id, ["acp.codex"], 2, {
    workspaceMappings: [{ workspaceId, status: "ready" }],
    acpProfiles: [
      {
        profileId: "profile-main",
        agentId: "codex",
        displayName: "Codex",
        status: "ready",
        capabilities: ["acp.codex"]
      }
    ]
  });
  const capacities = new HostReservationRepository(database, {
    hostOfflineAfterMs: 60_000,
    leaseDurationMs: 60_000,
    clock: () => now
  });
  const catalog = new AgentEndpointCatalog({
    hosts,
    capacities,
    hostOfflineAfterMs: 60_000,
    clock: () => now
  });
  const collaborationScopeAuthority = {
    hasProject: (projectId: string) => projectId === "project-a" || projectId === "project-b",
    hasScope: (scope: { workspaceId: string; projectId: string }) =>
      (scope.workspaceId === workspaceId && scope.projectId === "project-a") ||
      (scope.workspaceId === foreignWorkspaceId && scope.projectId === "project-b")
  };
  const server = createServer((request, response) => {
    void handleAgentEndpointHttpRequest(request, response, {
      catalog,
      repository: identity,
      workspaceIdentity,
      collaborationScopeAuthority,
      transportAdmission: loopbackHttpTransportAdmission
    }).then((handled) => {
      if (!handled) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "route_not_found" }));
      }
    });
  });
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    owner,
    foreignOwner,
    database,
    identity,
    hostId: registered.id,
    hosts,
    catalog,
    foreignWorkspaceId,
    workspaceId
  };
}

function authorization(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("Agent Endpoint HTTP", () => {
  it("serves configured Workspace Hosts through the real distributed composition", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const httpServer = createServer();
    httpServers.push(httpServer);
    const workspaceId = "workspace-agent-endpoint";
    const projectId = workspace.init.workspace.id;
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory: join(workspace.root, "agent-endpoint-server-data"),
      trustedProjects: [
        { workspaceId, projectId, canvasId: "default", projectRoot: workspace.root }
      ],
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
    if (!address || typeof address === "string") throw new Error("expected HTTP address");
    const origin = `http://127.0.0.1:${address.port}`;

    const issue = await fetch(`${origin}/api/v1/workspaces/${workspaceId}/setup-codes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ schemaVersion: "workspace-setup/v1", purpose: "device_session" })
    });
    expect(issue.status).toBe(201);
    const issued = (await issue.json()) as { setupCode: string };
    const redeem = await fetch(`${origin}/api/v1/setup-codes/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode: issued.setupCode,
        displayName: "Endpoint Owner"
      })
    });
    expect(redeem.status).toBe(200);
    const device = (await redeem.json()) as {
      deviceToken: string;
      humanPrincipalId: string;
    };

    const database = await openServerDatabase(config.databasePath, 5_000);
    databases.push(database);
    const hosts = new AgentHostRepository(database);
    const host = hosts.register("Configured Host").host;
    hosts.bindToWorkspace(host.id, workspaceId);
    hosts.reportOnline(host.id, ["acp.codex"], 1, {
      workspaceMappings: [{ workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "profile-configured",
          agentId: "codex",
          displayName: "Configured Codex",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    });
    const endpointUrl = `${origin}/api/v1/projects/${projectId}/agent-endpoints`;
    const directCatalog = new AgentEndpointCatalog({
      hosts,
      capacities: new HostReservationRepository(database, {
        hostOfflineAfterMs: 60_000,
        leaseDurationMs: 60_000
      }),
      hostOfflineAfterMs: 60_000
    });
    const listed = await fetch(endpointUrl, {
      headers: authorization(device.deviceToken)
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      items: [
        {
          profileId: "profile-configured",
          agentId: "codex",
          status: "available"
        }
      ]
    });

    database
      .prepare(
        `INSERT INTO workspace_identity_migrations(
          migration_id,legacy_project_id,workspace_id,from_version,to_version,step,status,
          interruption_marker,authoritative_read_version,failure_code,updated_at
        ) VALUES(?,?,?,0,1,'create_workspace','pending','none',
          'workspace-identity/v1',NULL,?)`
      )
      .run(
        "migration-configured-coexist",
        "legacy-configured-coexist",
        workspaceId,
        "2099-01-01T00:00:00.000Z"
      );
    for (const migrationState of [
      { status: "pending", marker: "none", failureCode: null },
      { status: "in_progress", marker: "workspace_created", failureCode: null },
      {
        status: "repair_required",
        marker: "partial_backfill_failed",
        failureCode: "configured_workspace_repair_required"
      }
    ] as const) {
      database
        .prepare(
          `UPDATE workspace_identity_migrations
           SET status=?,interruption_marker=?,failure_code=?
           WHERE migration_id='migration-configured-coexist'`
        )
        .run(migrationState.status, migrationState.marker, migrationState.failureCode);
      expect(directCatalog.listVisible(workspaceId).items, migrationState.status).toEqual([]);
    }
    database
      .prepare(
        `UPDATE workspace_identity_migrations
         SET step='verify_cutover',status='completed',
             interruption_marker='read_cutover_complete',failure_code=NULL
         WHERE migration_id='migration-configured-coexist'`
      )
      .run();
    const coexist = await fetch(endpointUrl, {
      headers: authorization(device.deviceToken)
    });
    expect(coexist.status).toBe(200);
    await expect(coexist.json()).resolves.toMatchObject({ items: [{ status: "available" }] });

    database
      .prepare(
        `UPDATE workspace_memberships
         SET revoked_at=?,updated_at=?,revision=revision+1
         WHERE workspace_id=? AND human_principal_id=?`
      )
      .run(now.toISOString(), now.toISOString(), workspaceId, device.humanPrincipalId);
    expect(
      database
        .prepare(
          `SELECT revoked_at FROM workspace_device_sessions
           WHERE workspace_id=? AND human_principal_id=?`
        )
        .get(workspaceId, device.humanPrincipalId)
    ).toEqual({ revoked_at: null });
    const revokedMembership = await fetch(endpointUrl, {
      headers: authorization(device.deviceToken)
    });
    expect({ status: revokedMembership.status, body: await revokedMembership.json() }).toEqual({
      status: 403,
      body: { error: "agent_endpoint_forbidden" }
    });

    const otherWorkspaceId = new WorkspaceIdentityRepository(database).ensureConfiguredWorkspace(
      "workspace-agent-endpoint-other"
    );
    hosts.bindToWorkspace(host.id, otherWorkspaceId);
    expect(directCatalog.listVisible(workspaceId).items).toEqual([]);
  });

  it("lists the current project Workspace projection for an authenticated member", async () => {
    const state = await fixture();
    const response = await fetch(`${state.origin}/api/v1/projects/project-a/agent-endpoints`, {
      headers: authorization(state.owner.deviceToken)
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      schemaVersion: "agent-endpoint-list/v1",
      items: [
        {
          schemaVersion: "agent-endpoint/v1",
          agentId: "codex",
          profileId: "profile-main",
          status: "available"
        }
      ]
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(state.hostId);
    expect(serialized).not.toMatch(/"(?:hostId|command|args|env|token|path|readiness)"/);
  });

  it("fails closed for unauthenticated, cross-project, and revoked credentials", async () => {
    const state = await fixture();
    const url = `${state.origin}/api/v1/projects/project-a/agent-endpoints`;
    const unauthenticated = await fetch(url);
    expect({ status: unauthenticated.status, body: await unauthenticated.json() }).toEqual({
      status: 401,
      body: { error: "agent_endpoint_unauthenticated" }
    });

    const crossProject = await fetch(url, {
      headers: authorization(state.foreignOwner.deviceToken)
    });
    expect({ status: crossProject.status, body: await crossProject.json() }).toEqual({
      status: 403,
      body: { error: "agent_endpoint_forbidden" }
    });

    state.identity.revokeDevice(
      state.owner.device.deviceCredentialId,
      "project-a",
      state.owner.principal.humanPrincipalId
    );
    const revoked = await fetch(url, { headers: authorization(state.owner.deviceToken) });
    expect({ status: revoked.status, body: await revoked.json() }).toEqual({
      status: 401,
      body: { error: "agent_endpoint_unauthenticated" }
    });
  });

  it("rejects query widening instead of silently ignoring it", async () => {
    const state = await fixture();
    const response = await fetch(
      `${state.origin}/api/v1/projects/project-a/agent-endpoints?workspaceId=foreign`,
      { headers: authorization(state.owner.deviceToken) }
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 400,
      body: { error: "agent_endpoint_request_invalid" }
    });
  });

  it("fails closed when a Host has zero or multiple Workspace bindings", async () => {
    const state = await fixture();
    expect(state.catalog.listVisible(state.workspaceId).items).toHaveLength(1);
    state.database.prepare("DELETE FROM workspace_agent_hosts WHERE host_id=?").run(state.hostId);
    expect(state.catalog.listVisible(state.workspaceId).items).toEqual([]);
    state.hosts.bindToWorkspace(state.hostId, state.workspaceId);
    expect(state.catalog.listVisible(state.workspaceId).items).toHaveLength(1);
    state.hosts.bindToWorkspace(state.hostId, state.foreignWorkspaceId);
    expect(state.catalog.listVisible(state.workspaceId).items).toEqual([]);
  });
});
