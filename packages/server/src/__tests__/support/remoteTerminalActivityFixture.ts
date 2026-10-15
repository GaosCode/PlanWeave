import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  createActivityCommentsComposition,
  createActivityJournalComposition
} from "../../composition/activityComments.js";
import { createRemoteCoordinationOptions } from "../../composition/remoteExecution.js";
import { hashOperatorToken } from "../../operatorAuth.js";
import { parseServerConfig } from "../../config.js";
import { createRemoteBlockCoordination } from "../../distributedCoordination.js";
import { HumanIdentityRepository } from "../../identity/repository.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../../projectAccessRepository.js";
import { handleCommentActivityHttpRequest } from "../../comments/http.js";
import { openServerDatabase } from "../../sqlite.js";
import { ContentVersionRepository } from "../../canvas/contentVersionRepository.js";
import { readStableCanvasRuntimeContentTarget } from "../../canvas/contentFingerprint.js";
import { attachHumanObserverWebSocketServer } from "../../humanObserverWs.js";
import { AuthorizationChangeSignal } from "../../authorizationChangeSignal.js";
import { WebSocketUpgradeRouter } from "../../webSocketUpgradeRouter.js";
import type { RemoteCoordinatorCheckpointPort } from "../../remoteBlockCoordinatorPorts.js";
import { auth, createWorkspaceDevice } from "./commentAttachmentHttpFixture.js";
import { endpointDispatchRequest } from "./endpointCoordinatorFixture.js";
import { exactHostRuntimeRouteFixture } from "./exactHostRuntimeRoute.js";
import { setup } from "./remoteBlockCoordinatorFixture.js";
import { loopbackHttpTransportAdmission } from "./transportAdmission.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export function terminalMessages(socket: WebSocket, count: number) {
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const received: Record<string, unknown>[] = [];
    const timer = setTimeout(() => reject(new Error("terminal_observer_timeout")), 3000);
    const listener = (data: RawData) => {
      received.push(JSON.parse(data.toString()));
      if (received.length !== count) return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(received);
    };
    socket.on("message", listener);
  });
}

export async function setupTerminalActivity(checkpoints?: RemoteCoordinatorCheckpointPort) {
  const fixture = await setup(true);
  const { database } = fixture.server;
  const scope = fixture.locator;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: join(fixture.workspace.root, "server-data"),
    trustedProjects: [],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(`pw_operator_${"T".repeat(43)}`),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const device = (suffix: string) =>
    createWorkspaceDevice({
      database,
      workspaceIdentity,
      authorizeScope() {},
      ...scope,
      suffix
    });
  const owner = device("terminal-owner");
  const viewer = device("terminal-viewer");
  const hidden = device("terminal-hidden");
  for (const principal of [viewer, hidden]) {
    database
      .prepare(
        "UPDATE workspace_memberships SET role='member' WHERE workspace_id=? AND human_principal_id=?"
      )
      .run(scope.workspaceId, principal.principalId);
  }
  const access = new ProjectAccessRepository(database);
  access.initializeProjectOwner(scope.workspaceId, scope.projectId, owner.principalId);
  expect(
    access.compareAndSetAccess({
      actor: { kind: "human", id: owner.principalId },
      request: {
        operation: "visibility",
        scope: {
          scopeKind: "project",
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          canvasId: null
        },
        expectedAclRevision: 0,
        visibility: "shared"
      }
    }).status
  ).toBe("applied");
  access.grant({
    ...scope,
    humanPrincipalId: viewer.principalId,
    role: "viewer",
    grantedBy: { kind: "human", id: owner.principalId }
  });
  const activity = createActivityJournalComposition({ database, config, clock: () => new Date() });
  const makeOptions = (currentDatabase: typeof database, currentActivity: typeof activity) =>
    createRemoteCoordinationOptions({
      config,
      clock: () => new Date(),
      activity: currentActivity,
      ownerRuntimeLeases: exactHostRuntimeRouteFixture(fixture.registry),
      ownerRuntimeAvailability: {
        hasRuntimeProject: () => true,
        hasRuntimeScope: (candidate) =>
          candidate.workspaceId === scope.workspaceId &&
          candidate.projectId === scope.projectId &&
          candidate.canvasId === scope.canvasId
      },
      runtimeContentTargets: {
        read: (candidate) =>
          readStableCanvasRuntimeContentTarget(
            new ContentVersionRepository(currentDatabase),
            candidate
          )
      },
      getAuthorization() {
        throw new Error("unexpected_operator_authorization");
      },
      getHumanIdentity: () => new HumanIdentityRepository(currentDatabase),
      getWorkspaceIdentity: () => new WorkspaceIdentityRepository(currentDatabase)
    });
  const createCoordination = (recoveryCheckpoints?: RemoteCoordinatorCheckpointPort) =>
    createRemoteBlockCoordination(
      database,
      { ...makeOptions(database, activity), checkpoints: recoveryCheckpoints },
      { serverInstanceOwnerToken: fixture.server.serverInstanceOwnerToken }
    );
  let coordination = createCoordination(checkpoints);
  const collaborationScopeAuthority = {
    hasScope: (candidate: { workspaceId: string; projectId: string }) =>
      candidate.workspaceId === scope.workspaceId && candidate.projectId === scope.projectId,
    hasProject: (candidate: string) => candidate === scope.projectId
  };
  const comments = createActivityCommentsComposition({
    database,
    config,
    clock: () => new Date(),
    collaborationScopeAuthority,
    workspaceIdentity,
    projectAccess: access,
    humanIdentity: new HumanIdentityRepository(database),
    activity
  });
  const http = createServer((request, response) => {
    void handleCommentActivityHttpRequest(request, response, {
      resolveService: comments.resolveCommentService,
      repository: new HumanIdentityRepository(database),
      workspaceIdentity,
      collaborationScopeAuthority,
      transportAdmission: loopbackHttpTransportAdmission
    }).catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("terminal_http_address_missing");
  cleanups.push(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const observerHttp = createServer();
  const observer = attachHumanObserverWebSocketServer({
    upgradeRouter: new WebSocketUpgradeRouter(observerHttp),
    journal: activity.humanObserverJournal,
    repository: new HumanIdentityRepository(database),
    workspaceIdentity,
    projectAccess: access,
    collaborationScopeAuthority: {
      hasScope: (candidate) =>
        candidate.workspaceId === scope.workspaceId && candidate.projectId === scope.projectId,
      hasProject: (candidate) => candidate === scope.projectId
    },
    authorizationChanges: new AuthorizationChangeSignal(),
    maxPayloadBytes: 16384,
    shutdownTimeoutMs: 1000,
    transportAdmission: loopbackHttpTransportAdmission
  });
  await new Promise<void>((resolve) => observerHttp.listen(0, "127.0.0.1", resolve));
  const observerAddress = observerHttp.address();
  if (!observerAddress || typeof observerAddress === "string")
    throw new Error("terminal_ws_address_missing");
  const sockets: WebSocket[] = [];
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await observer.close();
    await new Promise<void>((resolve) => observerHttp.close(() => resolve()));
  });
  const connect = async (token: string, cursor: number, count: number) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${observerAddress.port}/api/v1/projects/${scope.projectId}/human/observe`,
      { headers: auth(token) }
    );
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const ready = terminalMessages(socket, count);
    socket.send(
      JSON.stringify({
        type: "human.observer.hello",
        protocolVersion: 1,
        projectId: scope.projectId,
        lastCursor: cursor
      })
    );
    return { socket, ready };
  };
  const start = async () => {
    const outcome = await coordination.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: coordination.agentEndpoints,
        locator: fixture.dispatchLocator,
        blockRef: "T-001#B-001",
        idempotencyKey: "terminal-activity",
        callerHumanPrincipalId: fixture.callerHumanPrincipalId
      })
    );
    const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
    coordination.dispatches.accept(
      dispatch.hostId,
      "terminal-accept",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    return { operation: outcome.operation, dispatch };
  };
  const terminal = async (
    action: "complete" | "fail",
    dispatch: Awaited<ReturnType<typeof start>>["dispatch"]
  ) => {
    if (action === "fail")
      return coordination.dispatches.fail(
        dispatch.hostId,
        "terminal-fail",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId,
        { code: "remote_test_failure", message: "Host failed", retryable: false }
      );
    const report = Buffer.from("# Host complete\n\nTerminal Activity report.\n");
    const artifact = await activity.artifactStore.put({
      expectedSha256: createHash("sha256").update(report).digest("hex"),
      expectedSizeBytes: report.byteLength,
      mediaType: "text/markdown",
      chunks: (async function* () {
        yield report;
      })()
    });
    const grant = coordination.artifactAuthorization.createOutputGrant({
      operationId: "terminal-report-grant",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      hostId: dispatch.hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      permission: "report_write",
      expectedSha256: artifact.sha256,
      expectedSizeBytes: artifact.sizeBytes,
      expectedMediaType: artifact.mediaType
    });
    coordination.artifactAuthorization.acceptOutputUpload(
      {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        hostId: dispatch.hostId,
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        grantId: grant.grantId
      },
      artifact
    );
    return coordination.dispatches.complete(
      dispatch.hostId,
      "terminal-complete",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId,
      { summary: "Host completed", reportArtifactRef: artifact.ref, artifactRefs: [] }
    );
  };
  const read = async (token: string) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/projects/${scope.projectId}/activity`,
      { headers: auth(token) }
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { items: Array<{ type: string; workItem?: object }> };
  };
  return {
    ...fixture,
    database,
    scope,
    activity,
    owner,
    viewer,
    hidden,
    access,
    connect,
    start,
    terminal,
    read,
    get coordination() {
      return coordination;
    },
    async restart() {
      const recoveredDatabase = await openServerDatabase(fixture.server.config.databasePath, 5000);
      cleanups.push(async () => recoveredDatabase.close());
      const recoveredActivity = createActivityJournalComposition({
        database: recoveredDatabase,
        config,
        clock: () => new Date()
      });
      coordination = createRemoteBlockCoordination(
        recoveredDatabase,
        makeOptions(recoveredDatabase, recoveredActivity),
        { serverInstanceOwnerToken: fixture.server.serverInstanceOwnerToken }
      );
      await coordination.reconcile();
      return coordination;
    }
  };
}
