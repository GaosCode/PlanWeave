import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  captureAuthorizedCanvasContent,
  createRemoteBlockArtifactSource
} from "@planweave-ai/runtime";
import { ContentVersionRepository } from "../../../server/src/canvas/contentVersionRepository.js";
import { OwnerCanvasMaterializationRepository } from "../../../server/src/canvas/ownerCanvasMaterializationRepository.js";
import { OwnerCanvasMaterializationService } from "../../../server/src/canvas/ownerCanvasMaterializationService.js";
import { HostEnrollmentService } from "../../../server/src/hostEnrollment.js";
import { HumanIdentityCredentialStore } from "../../../server/src/identity/humanIdentityCredentialStore.js";
import { OperatorSessionStore } from "../../../server/src/identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../../../server/src/identity/workspaceRepository.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../../../server/src/operatorAuth.js";
import { handleOperatorHttpRequest } from "../../../server/src/operatorHttp.js";
import { RemoteControlService } from "../../../server/src/remoteControlService.js";
import { setupFleetUnboundHost } from "../../../server/src/__tests__/support/remoteBlockCoordinatorFixture.js";
import { TEST_REMOTE_AGENT_OWNER_ID } from "../../../server/src/__tests__/support/remoteAgentOwnerFixture.js";
import { loopbackHttpTransportAdmission } from "../../../server/src/__tests__/support/transportAdmission.js";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import { OperatorControlClient } from "../main/operatorControl/OperatorControlClient.js";
import type { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { WorkspaceExecutionDesktopService } from "../main/workspaceExecutionDesktopService.js";

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

export async function setupOperatorCas() {
  const f = await setupFleetUnboundHost();
  const database = f.server.database;
  const scope = {
    ownerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID,
    projectId: f.locator.projectId,
    canvasId: f.locator.canvasId
  };
  const scopes = new OwnerCanvasMaterializationRepository(database);
  const contentVersions = new ContentVersionRepository(database);
  const materialization = new OwnerCanvasMaterializationService({
    contentVersions,
    scopes,
    activityFence: {
      assertScopeMaterializable: (current) => {
        if (
          f.operations
            .listNonTerminal()
            .some(
              (operation) =>
                operation.workspaceId === current.workspaceId &&
                operation.projectId === current.projectId &&
                operation.canvasId === current.canvasId
            )
        )
          throw new Error("owner_canvas_materialization_active_operation");
      }
    }
  });
  const captured = await captureAuthorizedCanvasContent({
    projectRoot: f.workspace.root,
    canvasId: f.locator.canvasId,
    expectedPackageDir: f.workspace.init.workspace.packageDir,
    authorityProjectId: f.locator.projectId
  });
  materialization.materialize({
    schemaVersion: "owner-canvas-materialization/v1",
    materializationId: "initial-owner-content",
    scope,
    expectedHead: { kind: "absent" },
    content: captured.content
  });
  const registered = scopes.findScope(scope);
  if (!registered) throw new Error("owner_scope_required");
  // Reuse the fixture's real local runtime under the production owner namespace.
  const operatorWorkspaceId = f.locator.workspaceId;
  f.locator.workspaceId = registered.workspaceId;
  f.registry.bind(
    f.locator,
    f.runtime,
    createRemoteBlockArtifactSource({ projectRoot: f.workspace.root }),
    f.runtimeInitializationEvidenceFor(f.locator)
  );
  const token = `pw_operator_${"T".repeat(43)}`;
  new OperatorSessionStore(database).create({
    workspaceId: operatorWorkspaceId,
    operatorId: "operator-cas",
    credentialSha256: hashOperatorToken(token),
    issuedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z"
  });
  const authorization = new OperatorTokenRegistry(database, [
    {
      operatorId: "operator-cas",
      tokenSha256: hashOperatorToken(token),
      projectIds: [],
      serverAdmin: true
    }
  ]);
  const humanIdentityCredentials = new HumanIdentityCredentialStore(database, () => new Date());
  const identityToken = humanIdentityCredentials.issue(scope.ownerHumanPrincipalId).identityToken;
  const control = new RemoteControlService({
    authorization,
    enrollments: new HostEnrollmentService(database),
    hosts: f.hosts,
    agentEndpoints: f.agentEndpoints,
    remoteAgentAccess: f.remoteAgentAccess,
    remoteAgentRepository: f.remoteAgents,
    operations: f.operations,
    dispatches: f.dispatches,
    coordinator: f.coordinator,
    events: f.acpEvents,
    interactions: f.interactions,
    artifactContent: { readReport: async (ref) => f.artifacts.read(ref) },
    disconnectHost: () => {},
    workspaceIdentity: new WorkspaceIdentityRepository(database),
    authorizeProjectScope: () => {},
    ownerCanvasMaterialization: materialization,
    resolveOwnerRuntimeScope: (owner) => {
      const registeredScope = scopes.findScope({
        ownerHumanPrincipalId: owner.ownerHumanPrincipalId,
        projectId: owner.projectId,
        canvasId: owner.canvasId
      });
      if (!registeredScope) throw new Error("owner_scope_required");
      return registeredScope;
    }
  });
  const server = createServer((request, response) => {
    void handleOperatorHttpRequest(request, response, {
      authorization,
      humanIdentityCredentials,
      service: control,
      readiness: () => ({ status: "ready", schemaVersion: 1 }),
      serverVersion: "test",
      serverBuildRevision: "abcdef0123456789",
      limits: { maxArtifactBytes: 1024 * 1024, maxWebSocketPayloadBytes: 2048 },
      transportAdmission: loopbackHttpTransportAdmission
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("http_address_required");
  const origin = `http://127.0.0.1:${address.port}`;
  const actions: { request: unknown; status: number; response: unknown }[] = [];
  let loseActionResponse = false;
  let afterConflict: (() => Promise<void>) | undefined;
  const client = new OperatorControlClient({
    profile: {
      profileId: "profile-cas",
      displayName: "CAS Server",
      serverBaseUrl: origin,
      allowInsecureTransport: true
    },
    credential: { getOperatorToken: () => token, getHumanIdentityToken: () => identityToken },
    request: async (input, init) => {
      const response = await fetch(input, init);
      if (new URL(String(input)).pathname.endsWith("/actions")) {
        actions.push({
          request: JSON.parse(String(init?.body)),
          status: response.status,
          response: await response.clone().json()
        });
        if (response.status === 409 && afterConflict) {
          const replace = afterConflict;
          afterConflict = undefined;
          await replace();
        }
        if (loseActionResponse && response.ok) {
          loseActionResponse = false;
          await response.arrayBuffer();
          throw new Error("accepted_response_lost");
        }
      }
      return response;
    }
  });
  const operatorControl: Pick<OperatorControlService, "withExecutionProfile"> = {
    withExecutionProfile: async (_profile, operation) => operation(client)
  };
  const root = await mkdtemp(join(tmpdir(), "planweave-operator-cas-"));
  directories.push(root);
  const collaboration = new CollaborationService({
    profileStorePaths: { profilesPath: join(root, "profiles.json") },
    workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
    credentialsPath: join(root, "credentials.json"),
    invitationsPath: join(root, "invitations.json")
  });
  const endpoint = (
    await client.listAgentEndpoints({
      humanPrincipalId: scope.ownerHumanPrincipalId,
      projectId: scope.projectId,
      canvasId: scope.canvasId
    })
  ).items[0];
  if (!endpoint) throw new Error("endpoint_required");
  const input = {
    locator: {
      kind: "owner_canvas" as const,
      operatorProfileId: "profile-cas",
      humanPrincipalId: scope.ownerHumanPrincipalId,
      projectRoot: f.workspace.root,
      projectId: scope.projectId,
      canvasId: scope.canvasId
    },
    blockRef: "T-001#B-001",
    agentEndpointId: endpoint.endpointId,
    effectiveExecutor: { name: "codex-acp", agentId: "codex" },
    startRequestId: "start-operator-cas"
  };
  return {
    f,
    input,
    client,
    actions,
    create: () => new WorkspaceExecutionDesktopService(collaboration, operatorControl, root),
    loseNextActionResponse: () => {
      loseActionResponse = true;
    },
    afterConflict: (callback: () => Promise<void>) => {
      afterConflict = callback;
    },
    cancelCommands: () =>
      f.mailbox.listAfter(f.host.id, 0).filter((entry) => entry.command.type === "cancel_execution")
  };
}
