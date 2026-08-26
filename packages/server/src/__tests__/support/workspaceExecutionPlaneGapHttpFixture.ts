import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import { createTestWorkspace } from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import { handleAgentEndpointHttpRequest } from "../../agentEndpointHttp.js";
import { ArtifactStore } from "../../artifacts.js";
import { canonicalRemoteRuntimePort } from "../../canonicalRemoteRuntimePort.js";
import { parseServerConfig } from "../../config.js";
import { createRemoteBlockCoordination } from "../../distributedCoordination.js";
import { handleHumanRemoteHttpRequest } from "../../humanRemoteHttp.js";
import { HumanRemoteControlService } from "../../humanRemoteControlService.js";
import {
  handleHumanHttpRequest,
  HumanIdentityRepository,
  HumanMembershipService
} from "../../identity/index.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../../lifecycle.js";
import { hashOperatorToken } from "../../operatorAuth.js";
import { ProjectAccessRepository } from "../../projectAccessRepository.js";
import { RemoteRuntimePortRegistry } from "../../remoteRuntimeLocator.js";
import { syncRemoteAgentsFromHost } from "../../remoteAgent/index.js";
import { AgentHostRepository } from "../../hosts.js";
import { openServerDatabase, type SqliteDatabase } from "../../sqlite.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../../serverComposition.js";
import { AuthorityRepository } from "../../work/authorityRepository.js";
import { loopbackHttpTransportAdmission } from "./transportAdmission.js";
import { ownHostRemoteAgents } from "./remoteAgentOwnerFixture.js";
import { adminToken, jsonHeaders, remoteManifest } from "./serverCompositionFixture.js";

const directories: string[] = [];
const storageServers: PlanweaveServer[] = [];
const httpServers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const server of storageServers.splice(0)) server.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

export { jsonHeaders };

const readyCodexProfile = {
  profileId: "codex-acp",
  agentId: "codex",
  displayName: "Test Agent",
  status: "ready" as const,
  capabilities: ["acp.codex", "acp.session.load"]
};

export function endpointIdForHost(database: SqliteDatabase, hostId: string): string {
  const row = database
    .prepare(
      `SELECT endpoint_id FROM remote_agents WHERE host_id=? AND revoked_at IS NULL
       ORDER BY endpoint_id LIMIT 1`
    )
    .get(hostId) as { endpoint_id: string } | undefined;
  if (!row) throw new Error("expected_test_remote_agent");
  return row.endpoint_id;
}

export async function joinMember(origin: string, projectId: string, ownerToken: string) {
  const invitation = await fetch(`${origin}/api/v1/projects/${projectId}/human/invitations`, {
    method: "POST",
    headers: jsonHeaders(ownerToken),
    body: JSON.stringify({})
  });
  const invitationBody = (await invitation.json()) as { invitationToken: string };
  if (invitation.status !== 201) throw new Error("expected_invitation");
  const joined = await fetch(`${origin}/api/v1/projects/${projectId}/human/invitations/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invitationToken: invitationBody.invitationToken, displayName: "Member" })
  });
  const joinedBody = (await joined.json()) as {
    deviceToken: string;
    principal: { humanPrincipalId: string };
  };
  if (joined.status !== 201) throw new Error("expected_member_join");
  return joinedBody;
}

export function remoteRunV3Body(input: {
  projectId: string;
  canvasId: string;
  blockRef: string;
  agentEndpointId: string;
  idempotencyKey: string;
}) {
  return {
    schemaVersion: "remote-run/v3",
    projectId: input.projectId,
    canvasId: input.canvasId,
    blockRef: input.blockRef,
    agentEndpointId: input.agentEndpointId,
    idempotencyKey: input.idempotencyKey,
    expectedResponsibilityRevision: 0,
    expectedReviewerRevision: 0
  };
}

/**
 * Production Catalog + Dispatch HTTP with a granted Host.
 * `mapWorkspace` false: skip bindToWorkspace and report empty mapping observations.
 */
export async function startGrantedHostCatalogDispatchHttp(options: { mapWorkspace: boolean }) {
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
  const identity = new HumanIdentityRepository(storage.database);
  const workspaceIdentity = new WorkspaceIdentityRepository(storage.database);
  const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
  const collaborationScopeAuthority = {
    hasProject: (candidate: string) => candidate === projectId,
    hasScope: (scope: { workspaceId: string; projectId: string }) =>
      scope.workspaceId === workspaceId && scope.projectId === projectId
  };
  const membership = new HumanMembershipService({
    repository: identity,
    collaborationScopeAuthority,
    workspaceForProject: (candidate) => (candidate === projectId ? workspaceId : undefined)
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
    ),
    createRemoteBlockArtifactSource({ projectRoot: workspace.root })
  );
  const artifacts = new ArtifactStore(storage.database, dataDirectory, 1024 * 1024);
  const coordination = createRemoteBlockCoordination(
    storage.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: registry,
      inputArtifacts: { materialize: async () => undefined },
      artifactContent: { readReport: async (ref) => artifacts.read(ref) },
      interactionAuthorization: {
        canRespond: ({ responderId, projectId: targetProjectId }) =>
          identity.getActiveMembership(targetProjectId, responderId) !== undefined
      }
    },
    { serverInstanceOwnerToken: storage.serverInstanceOwnerToken }
  );
  const owner = identity.bootstrapOwner({
    kind: "local_administrative_proof",
    projectId,
    humanPrincipalId: "gap-owner",
    displayName: "Gap Owner",
    issuedAt: new Date().toISOString()
  });
  const host = coordination.hosts.register("Gap HTTP Host").host;
  ownHostRemoteAgents({
    database: storage.database,
    hostId: host.id,
    ownerHumanPrincipalId: owner.principal.humanPrincipalId,
    grantWorkspaceId: workspaceId
  });
  if (options.mapWorkspace) {
    coordination.hosts.bindToWorkspace(host.id, workspaceId);
  }
  coordination.hosts.reportOnline(host.id, ["acp.codex", "acp.session.load"], 1, {
    workspaceMappings: options.mapWorkspace ? [{ workspaceId, status: "ready" }] : [],
    acpProfiles: [readyCodexProfile]
  });
  const authority = new AuthorityRepository(storage.database);
  authority.applyExecutionTarget({
    mutation: {
      schemaVersion: "execution-target/v1",
      scope: { kind: "block", workspaceId, projectId, canvasId, blockRef },
      target: { kind: "unassigned" },
      expectedRevision: 0
    },
    actor: { kind: "system", id: "workspace-execution-plane-gap-http" }
  });
  const service = new HumanRemoteControlService({
    operations: coordination.operations,
    dispatches: coordination.dispatches,
    coordinator: coordination.coordinator,
    events: coordination.acpEvents,
    interactions: coordination.interactions,
    runtimeAvailable: () => true,
    authorizeCanvas: (_context, scope) => {
      if (
        scope.workspaceId !== workspaceId ||
        scope.projectId !== projectId ||
        scope.canvasId !== canvasId
      ) {
        throw new Error("authority_scope_forbidden");
      }
    }
  });
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
        await handleAgentEndpointHttpRequest(request, response, {
          catalog: coordination.agentEndpoints,
          remoteAgentAccess: coordination.remoteAgentAccess,
          repository: identity,
          workspaceIdentity,
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
          readiness: () => ({ status: "ready", schemaVersion: 1 }),
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
  await new Promise<void>((resolve) => serverListen(httpServer, resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    projectId,
    workspaceId,
    canvasId,
    blockRef,
    ownerToken: owner.deviceToken,
    endpointId: endpointIdForHost(storage.database, host.id)
  };
}

function serverListen(server: HttpServer, resolve: () => void) {
  server.listen(0, "127.0.0.1", resolve);
}

/** Pathless registry composition: collaboration works, no attached Canvas runtime host. */
export async function startPathlessCompositionWithGrantedHost(options: { mapWorkspace: boolean }) {
  const workspace = await createTestWorkspace(remoteManifest());
  directories.push(workspace.home, workspace.root);
  const httpServer = createServer();
  httpServers.push(httpServer);
  const dataDirectory = join(workspace.root, "pathless-gap-server-data");
  const projectId = "pathless-gap-project";
  const workspaceId = "workspace-self-host";
  const canvasId = "default";
  const blockRef = "T-001#B-001";
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
  databases.push(database);
  const access = new ProjectAccessRepository(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  access.registerProjectInternal({
    workspaceId,
    projectId,
    projectRoot: workspace.root
  });
  access.registerCanvasInternal({
    workspaceId,
    projectId,
    canvasId,
    packageDir: workspace.root
  });
  database
    .prepare("UPDATE project_registry SET project_root_internal=NULL WHERE project_id=?")
    .run(projectId);
  database
    .prepare(
      "UPDATE canvas_registry SET package_dir_internal=NULL WHERE project_id=? AND canvas_id=?"
    )
    .run(projectId, canvasId);
  workspaceIdentity.ensureLegacyProjectAdapter(projectId, workspaceId);
  const hosts = new AgentHostRepository(
    database,
    () => new Date(),
    (host) => {
      syncRemoteAgentsFromHost({ database, host, clock: () => new Date() });
    }
  );
  const host = hosts.register("Pathless Gap Host").host;
  await new Promise<void>((resolve) => serverListen(httpServer, resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected HTTP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Pathless Owner", humanPrincipalId: "pathless-owner" })
  });
  const bootstrapped = (await bootstrap.json()) as {
    deviceToken: string;
    humanPrincipalId?: string;
  };
  if (bootstrap.status !== 201) throw new Error("expected_pathless_bootstrap");
  ownHostRemoteAgents({
    database,
    hostId: host.id,
    ownerHumanPrincipalId: "pathless-owner",
    grantWorkspaceId: workspaceId
  });
  if (options.mapWorkspace) {
    hosts.bindToWorkspace(host.id, workspaceId);
  }
  hosts.reportOnline(host.id, ["acp.codex", "acp.session.load"], 1, {
    workspaceMappings: options.mapWorkspace ? [{ workspaceId, status: "ready" }] : [],
    acpProfiles: [readyCodexProfile]
  });
  return {
    origin,
    projectId,
    workspaceId,
    canvasId,
    blockRef,
    ownerToken: bootstrapped.deviceToken,
    endpointId: endpointIdForHost(database, host.id)
  };
}
