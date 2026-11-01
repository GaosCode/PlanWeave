import { createServer } from "node:http";
import { OperatorControlClient } from "../../../../desktop/src/main/operatorControl/OperatorControlClient.js";
import { CollaborationHttpTransport } from "../../../../desktop/src/main/collaboration/collaborationHttpTransport.js";
import { CollaborationRemoteOperationsClient } from "../../../../desktop/src/main/collaboration/CollaborationRemoteOperationsClient.js";
import { createRemoteBlockCoordination } from "../../distributedCoordination.js";
import { HumanRemoteControlService } from "../../humanRemoteControlService.js";
import { handleHumanRemoteHttpRequest } from "../../humanRemoteHttp.js";
import { HostEnrollmentService } from "../../hostEnrollment.js";
import { HumanIdentityRepository } from "../../identity/repository.js";
import { HumanIdentityCredentialStore } from "../../identity/humanIdentityCredentialStore.js";
import { OperatorSessionStore } from "../../identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../../operatorAuth.js";
import { handleOperatorHttpRequest } from "../../operatorHttp.js";
import { RemoteControlService } from "../../remoteControlService.js";
import { createAcpConversationFixture } from "./acpConversationFixture.js";
import { legacyConversationRoute } from "./legacyAcpConversationContract.js";
import { loopbackHttpTransportAdmission } from "./transportAdmission.js";

export async function createConversationCompatibilityFixture(
  legacyServer = false,
  options?: Parameters<typeof createAcpConversationFixture>[0]
) {
  const f = await createAcpConversationFixture(options);
  const repository = new HumanIdentityRepository(f.db, f.clock);
  const identity = repository.bootstrapOwner({
    kind: "local_administrative_proof",
    projectId: f.operation.projectId,
    humanPrincipalId: "compat-actor",
    displayName: "Compatibility",
    issuedAt: f.clock().toISOString()
  });
  if (!identity.deviceToken) throw new Error("compat_device_missing");
  const humanIdentityCredentials = new HumanIdentityCredentialStore(f.db, f.clock);
  const human = humanIdentityCredentials.issue(identity.principal.humanPrincipalId);
  const token = `pw_operator_${"C".repeat(43)}`;
  const authorization = new OperatorTokenRegistry(f.db, [
    {
      operatorId: "compat-operator",
      tokenSha256: hashOperatorToken(token),
      projectIds: [f.operation.projectId],
      serverAdmin: true
    }
  ]);
  new OperatorSessionStore(f.db).create({
    workspaceId: f.operation.workspaceId,
    operatorId: "compat-operator",
    credentialSha256: hashOperatorToken(token),
    issuedAt: f.clock().toISOString(),
    expiresAt: "2030-01-02T00:00:00.000Z"
  });
  const coordination = createRemoteBlockCoordination(
    f.db,
    {
      clock: f.clock,
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeLeases: {
        acquire() {
          throw new Error("unused_compat_runtime");
        },
        acquireForHost() {
          throw new Error("unused_compat_runtime");
        }
      },
      inputArtifacts: { async materialize() {} },
      artifactContent: {
        async readReport() {
          return new Uint8Array();
        }
      }
    },
    { serverInstanceOwnerToken: f.server.serverInstanceOwnerToken }
  );
  const workspaceIdentity = new WorkspaceIdentityRepository(f.db);
  const ownerService = new RemoteControlService({
    authorization,
    enrollments: new HostEnrollmentService(f.db, f.clock),
    hosts: coordination.hosts,
    agentEndpoints: coordination.agentEndpoints,
    remoteAgentAccess: coordination.remoteAgentAccess,
    operations: coordination.operations,
    dispatches: coordination.dispatches,
    coordinator: coordination.coordinator,
    events: coordination.acpEvents,
    interactions: coordination.interactions,
    conversations: f.service,
    artifactContent: {
      async readReport() {
        return new Uint8Array();
      }
    },
    disconnectHost() {},
    workspaceIdentity,
    authorizeProjectScope() {},
    clock: f.clock
  });
  const workspaceService = new HumanRemoteControlService({
    operations: coordination.operations,
    dispatches: coordination.dispatches,
    coordinator: coordination.coordinator,
    events: coordination.acpEvents,
    interactions: coordination.interactions,
    conversations: f.service
  });
  const http = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://compat.invalid");
      if (legacyServer && !legacyConversationRoute(url.pathname)) {
        request.resume();
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "route_not_found" }));
        return;
      }
      if (legacyServer && [...url.searchParams.keys()].some((key) => key !== "afterCursor")) {
        request.resume();
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "legacy_query_invalid" }));
        return;
      }
      if (url.pathname.startsWith("/api/v1/projects/")) {
        await handleHumanRemoteHttpRequest(request, response, {
          service: workspaceService,
          repository,
          workspaceIdentity,
          collaborationScopeAuthority: {
            hasProject: (id) => id === f.operation.projectId,
            hasScope: (scope) =>
              scope.workspaceId === f.operation.workspaceId &&
              scope.projectId === f.operation.projectId
          },
          readiness: () => ({ status: "ready", schemaVersion: 1 }),
          transportAdmission: loopbackHttpTransportAdmission
        });
      } else {
        await handleOperatorHttpRequest(request, response, {
          authorization,
          humanIdentityCredentials,
          service: ownerService,
          readiness: () => ({ status: "ready", schemaVersion: 1 }),
          serverVersion: "test",
          serverBuildRevision: "development",
          limits: { maxArtifactBytes: 1024, maxWebSocketPayloadBytes: 1024 },
          transportAdmission: loopbackHttpTransportAdmission
        });
      }
    })().catch((error) => response.destroy(error));
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("compat_address_missing");
  const origin = `http://127.0.0.1:${address.port}`;
  const owner = new OperatorControlClient({
    profile: {
      profileId: "compat",
      displayName: "Compatibility",
      serverBaseUrl: `${origin}/`,
      allowInsecureTransport: true
    },
    credential: { getOperatorToken: () => token, getHumanIdentityToken: () => human.identityToken }
  });
  const transport = new CollaborationHttpTransport({
    serverBaseUrl: `${origin}/`,
    credential: { getDeviceToken: () => identity.deviceToken }
  });
  return {
    ...f,
    origin,
    owner,
    workspace: new CollaborationRemoteOperationsClient(f.operation.projectId, transport),
    headers(surface: "owner" | "workspace") {
      return {
        authorization: `Bearer ${surface === "owner" ? token : identity.deviceToken}`,
        "x-planweave-human-identity": `Bearer ${human.identityToken}`,
        "content-type": "application/json"
      };
    },
    path(surface: "owner" | "workspace", version = 1, operationId = f.operation.id) {
      return `${origin}/api/v1/${surface === "workspace" ? `projects/${f.operation.projectId}/` : ""}remote-operations/${operationId}/conversation${version > 1 ? `/v${version}` : ""}`;
    },
    async close() {
      owner.dispose();
      transport.dispose();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
        http.closeAllConnections();
      });
      f.server.close();
    }
  };
}
