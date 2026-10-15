import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { captureAuthorizedCanvasContent } from "@planweave-ai/runtime";
import { exampleHumanIdentityToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { HostEnrollmentService } from "../../../server/src/hostEnrollment.js";
import { OperatorSessionStore } from "../../../server/src/identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../../../server/src/identity/workspaceRepository.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../../../server/src/operatorAuth.js";
import { RemoteControlService } from "../../../server/src/remoteControlService.js";
import { setupFleetUnboundHost } from "../../../server/src/__tests__/support/remoteBlockCoordinatorFixture.js";
import { TEST_REMOTE_AGENT_OWNER_ID } from "../../../server/src/__tests__/support/remoteAgentOwnerFixture.js";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import { OperatorControlClient } from "../main/operatorControl/OperatorControlClient.js";
import type { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { WorkspaceExecutionDesktopService } from "../main/workspaceExecutionDesktopService.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

export async function setupWorkspaceExecutionStartServer() {
  const f = await setupFleetUnboundHost();
  const token = `pw_operator_${"T".repeat(43)}`;
  new OperatorSessionStore(f.server.database).create({
    workspaceId: f.locator.workspaceId,
    operatorId: "operator-start-stop",
    credentialSha256: hashOperatorToken(token),
    issuedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:00:00.000Z"
  });
  const authorization = new OperatorTokenRegistry(f.server.database, [
    {
      operatorId: "operator-start-stop",
      tokenSha256: hashOperatorToken(token),
      projectIds: [],
      serverAdmin: true
    }
  ]);
  const authenticated = authorization.authenticate(`Bearer ${token}`);
  if (!authenticated) throw new Error("operator_principal_required");
  const principal = { ...authenticated, humanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID };
  const control = new RemoteControlService({
    authorization,
    enrollments: new HostEnrollmentService(f.server.database),
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
    workspaceIdentity: new WorkspaceIdentityRepository(f.server.database),
    authorizeProjectScope: () => {},
    resolveOwnerRuntimeScope: () => f.locator
  });
  const endpoint = control.listAgentEndpoints(principal, {
    humanPrincipalId: principal.humanPrincipalId,
    projectId: f.locator.projectId,
    canvasId: f.locator.canvasId
  }).items[0];
  if (!endpoint) throw new Error("endpoint_required");
  const content = await captureAuthorizedCanvasContent({
    projectRoot: f.workspace.root,
    canvasId: f.locator.canvasId,
    expectedPackageDir: f.workspace.init.workspace.packageDir,
    authorityProjectId: f.locator.projectId
  });
  let launches = 0;
  let catalog: (() => Promise<void>) | undefined;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === "/api/v1/agent-endpoints") {
      if (catalog) await catalog();
      return Response.json(
        control.listAgentEndpoints(principal, Object.fromEntries(url.searchParams))
      );
    }
    if (url.pathname === "/api/v1/owner-canvas-materializations/head")
      return Response.json({
        schemaVersion: "owner-canvas-materialization/v1",
        scope: {
          ownerHumanPrincipalId: principal.humanPrincipalId,
          projectId: f.locator.projectId,
          canvasId: f.locator.canvasId
        },
        head: {
          kind: "present",
          revision: 1,
          content: {
            versionId: `version-${content.content.canonicalDigest}`,
            canonicalDigest: content.content.canonicalDigest,
            verification: "complete"
          }
        }
      });
    if (url.pathname === "/api/v1/remote-operations") {
      if (init?.method === "POST") {
        await control.dispatch(principal, body, "public-runtime-v1");
        launches += 1;
        throw new Error("accepted_response_lost");
      }
      return Response.json(
        await control.lookupOperation(
          principal,
          Object.fromEntries(url.searchParams),
          "public-runtime-v1"
        )
      );
    }
    const match = /^\/api\/v1\/remote-operations\/([^/]+)(.*)$/.exec(url.pathname);
    if (!match) throw new Error(`unexpected_route:${url.pathname}`);
    const [, operationId, suffix] = match;
    if (suffix === "/actions")
      return Response.json(await control.executeAction(principal, operationId, body), {
        status: 202
      });
    if (suffix === "/events")
      return Response.json(
        control.replayEvents(principal, operationId, url.searchParams.get("afterCursor"))
      );
    if (suffix === "/interactions")
      return Response.json(
        control.listPendingInteractions(
          principal,
          operationId,
          Object.fromEntries(url.searchParams)
        )
      );
    return Response.json(
      await control.observeOperation(principal, operationId, "public-runtime-v1")
    );
  };
  const client = new OperatorControlClient({
    profile: {
      profileId: "profile-server",
      displayName: "Server",
      serverBaseUrl: "https://operator.test/",
      allowInsecureTransport: false
    },
    credential: {
      getOperatorToken: () => token,
      getHumanIdentityToken: () => exampleHumanIdentityToken
    },
    request
  });
  const operatorControl: Pick<OperatorControlService, "withExecutionProfile"> = {
    withExecutionProfile: async (_profile, operation) => operation(client)
  };
  const root = await mkdtemp(join(tmpdir(), "planweave-start-stop-server-"));
  directories.push(root);
  const collaboration = new CollaborationService({
    profileStorePaths: { profilesPath: join(root, "profiles.json") },
    workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
    credentialsPath: join(root, "credentials.json"),
    invitationsPath: join(root, "invitations.json")
  });
  const input = {
    locator: {
      kind: "owner_canvas" as const,
      operatorProfileId: "profile-server",
      humanPrincipalId: principal.humanPrincipalId,
      projectRoot: f.workspace.root,
      projectId: f.locator.projectId,
      canvasId: f.locator.canvasId
    },
    blockRef: "T-001#B-001",
    agentEndpointId: endpoint.endpointId,
    effectiveExecutor: { name: "codex-acp", agentId: "codex" },
    startRequestId: "start-real-server"
  };
  const stop = {
    input,
    startRequestId: input.startRequestId,
    actionId: "stop-real-server",
    reason: "Desktop Auto Run stop requested."
  };
  return {
    f,
    root,
    request,
    token,
    input,
    stop,
    create: () => new WorkspaceExecutionDesktopService(collaboration, operatorControl, root),
    launches: () => launches,
    catalog: (value: () => Promise<void>) => {
      catalog = value;
    }
  };
}
