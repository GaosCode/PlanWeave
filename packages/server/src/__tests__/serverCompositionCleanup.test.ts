import { createServer, IncomingMessage } from "node:http";
import { rm } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";

const cleanupSpies = vi.hoisted(() => ({
  webSocketClose: vi.fn(async () => {
    throw new Error("websocket_close_failed");
  }),
  retentionStart: vi.fn(async () => {}),
  retentionClose: vi.fn(async () => {}),
  retentionStartFailure: { enabled: false },
  retentionCloseFailure: { enabled: false },
  lifecycleClose: vi.fn(),
  runtimeRegistryClose: vi.fn(),
  canvasPresenceClose: vi.fn(),
  canvasLiveSyncClose: vi.fn(),
  canvasCaptureFailure: { enabled: false }
}));

vi.mock("../presenceWebSocket.js", async () => {
  const actual =
    await vi.importActual<typeof import("../presenceWebSocket.js")>("../presenceWebSocket.js");
  return {
    ...actual,
    attachCanvasPresenceWebSocketServer: (
      options: Parameters<typeof actual.attachCanvasPresenceWebSocketServer>[0]
    ) => {
      const server = actual.attachCanvasPresenceWebSocketServer(options);
      return {
        ...server,
        async close() {
          cleanupSpies.canvasPresenceClose();
          await server.close();
        }
      };
    }
  };
});

vi.mock("../canvas/index.js", async () => {
  const actual = await vi.importActual<typeof import("../canvas/index.js")>("../canvas/index.js");
  return {
    ...actual,
    attachCanvasLiveSyncWebSocketServer: (
      options: Parameters<typeof actual.attachCanvasLiveSyncWebSocketServer>[0]
    ) => {
      const server = actual.attachCanvasLiveSyncWebSocketServer(options);
      return {
        ...server,
        async close() {
          cleanupSpies.canvasLiveSyncClose();
          await server.close();
        }
      };
    },
    createDefaultCanvasRuntimePort: () => {
      const runtime = actual.createDefaultCanvasRuntimePort();
      return {
        ...runtime,
        async captureContent(input: Parameters<NonNullable<typeof runtime.captureContent>>[0]) {
          if (cleanupSpies.canvasCaptureFailure.enabled) {
            throw new Error("canvas_capture_startup_failed");
          }
          return runtime.captureContent?.(input);
        }
      };
    }
  };
});

vi.mock("../comments/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../comments/index.js")>("../comments/index.js");
  return {
    ...actual,
    ActivityRetentionMaintenance: class {
      async start() {
        await cleanupSpies.retentionStart();
        if (cleanupSpies.retentionStartFailure.enabled) {
          throw new Error("activity_retention_start_failed");
        }
      }
      async close() {
        await cleanupSpies.retentionClose();
        if (cleanupSpies.retentionCloseFailure.enabled) {
          throw new Error("activity_retention_close_failed");
        }
      }
    }
  };
});

vi.mock("../distributedCoordination.js", async () => {
  const actual = await vi.importActual<typeof import("../distributedCoordination.js")>(
    "../distributedCoordination.js"
  );
  return {
    ...actual,
    async startRemoteBlockCoordinationServer(
      ...args: Parameters<typeof actual.startRemoteBlockCoordinationServer>
    ) {
      const lifecycle = await actual.startRemoteBlockCoordinationServer(...args);
      return {
        ...lifecycle,
        server: {
          ...lifecycle.server,
          close() {
            cleanupSpies.lifecycleClose();
            lifecycle.server.close();
          }
        }
      };
    }
  };
});

vi.mock("../wsServer.js", async () => {
  const actual = await vi.importActual<typeof import("../wsServer.js")>("../wsServer.js");
  return {
    ...actual,
    attachAgentHostWebSocketServer: () => ({
      disconnectHost: () => {},
      close: cleanupSpies.webSocketClose
    })
  };
});

vi.mock("../runtimeProjectRegistry.js", async () => {
  const actual = await vi.importActual<typeof import("../runtimeProjectRegistry.js")>(
    "../runtimeProjectRegistry.js"
  );
  return {
    ...actual,
    createTrustedRuntimeRegistry: async (
      projects: Parameters<typeof actual.createTrustedRuntimeRegistry>[0]
    ) => {
      const registry = await actual.createTrustedRuntimeRegistry(projects);
      return {
        ...registry,
        close() {
          cleanupSpies.runtimeRegistryClose();
          registry.close();
        }
      };
    }
  };
});

import { hashOperatorToken } from "../operatorAuth.js";
import { parseServerConfig } from "../config.js";
import { legacyWorkspaceIdForProject } from "./support/legacyWorkspaceId.js";
import { createDistributedServerComposition } from "../serverComposition.js";
import { createCanvasCollaborationComposition } from "../canvas/collaborationComposition.js";
import { canvasLiveSyncRouteFromUrl } from "../canvas/canvasLiveSyncWebSocket.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { AuthorizationChangeSignal } from "../authorizationChangeSignal.js";
import { createTransportAdmissionPolicyForMode } from "../insecureTransport.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { canvasPresenceRouteFromUrl } from "../presenceWebSocket.js";
import { openServerDatabase } from "../sqlite.js";
import { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";
import { seedOperatorSessions } from "./support/operatorAuthFixture.js";

const directories: string[] = [];

afterEach(async () => {
  cleanupSpies.webSocketClose.mockClear();
  cleanupSpies.retentionStart.mockClear();
  cleanupSpies.retentionClose.mockClear();
  cleanupSpies.lifecycleClose.mockClear();
  cleanupSpies.runtimeRegistryClose.mockClear();
  cleanupSpies.canvasPresenceClose.mockClear();
  cleanupSpies.canvasLiveSyncClose.mockClear();
  cleanupSpies.canvasCaptureFailure.enabled = false;
  cleanupSpies.retentionStartFailure.enabled = false;
  cleanupSpies.retentionCloseFailure.enabled = false;
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  return manifest;
}

describe("distributed server composition cleanup", () => {
  it("closes retention and storage when retention startup fails", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory: join(workspace.root, "retention-start-failure-server-data"),
      trustedProjects: [
        {
          workspaceId: legacyWorkspaceIdForProject(workspace.init.workspace.id),
          projectId: workspace.init.workspace.id,
          canvasId: "default",
          projectRoot: workspace.root
        }
      ],
      operatorCredentials: [
        {
          operatorId: "admin",
          tokenSha256: hashOperatorToken(`pw_operator_${"D".repeat(43)}`),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    cleanupSpies.retentionStartFailure.enabled = true;
    cleanupSpies.retentionCloseFailure.enabled = true;

    const startup = createDistributedServerComposition({
      httpServer: createServer(),
      config
    });
    await expect(startup).rejects.toMatchObject({
      message: "distributed_server_startup_and_cleanup_failed",
      errors: [
        expect.objectContaining({ message: "activity_retention_start_failed" }),
        expect.objectContaining({ message: "activity_retention_close_failed" })
      ]
    });
    expect(cleanupSpies.retentionStart).toHaveBeenCalledOnce();
    expect(cleanupSpies.retentionClose).toHaveBeenCalledOnce();
    expect(cleanupSpies.lifecycleClose).toHaveBeenCalledOnce();
    expect(cleanupSpies.runtimeRegistryClose).toHaveBeenCalledOnce();
    expect(cleanupSpies.retentionClose.mock.invocationCallOrder[0]).toBeLessThan(
      cleanupSpies.lifecycleClose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(cleanupSpies.lifecycleClose.mock.invocationCallOrder[0]).toBeLessThan(
      cleanupSpies.runtimeRegistryClose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("releases partial Canvas transports when initial content capture fails", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    applyMigrations(database);
    const httpServer = createServer();
    const upgradeRouter = new WebSocketUpgradeRouter(httpServer);
    const workspaceIdentity = new WorkspaceIdentityRepository(database);
    const identity = new HumanIdentityRepository(database);
    const projectAccess = new ProjectAccessRepository(database);
    const observerJournal = new HumanObserverJournal(database, 100);
    vi.useFakeTimers();
    const initialTimerCount = vi.getTimerCount();
    cleanupSpies.canvasCaptureFailure.enabled = true;

    try {
      await expect(
        createCanvasCollaborationComposition({
          database,
          upgradeRouter,
          identity,
          workspaceIdentity,
          projectAccess,
          projectAuthority: {
            hasProject: (projectId) => projectId === "project-capture-failure",
            hasScope: (scope) =>
              scope.workspaceId === "workspace-capture-failure" &&
              scope.projectId === "project-capture-failure"
          },
          authorizationChanges: new AuthorizationChangeSignal(),
          expansions: [
            {
              workspaceId: "workspace-capture-failure",
              projectId: "project-capture-failure",
              canvasId: "default",
              projectRoot: "/srv/project-capture-failure",
              packageDir: "/srv/project-capture-failure/default"
            }
          ],
          observerJournal,
          transportAdmission: createTransportAdmissionPolicyForMode("loopback_http"),
          maxPayloadBytes: 64 * 1024,
          shutdownTimeoutMs: 1_000,
          clock: () => new Date("2026-08-04T00:00:00.000Z")
        })
      ).rejects.toThrow("canvas_capture_startup_failed");

      expect(cleanupSpies.canvasLiveSyncClose).toHaveBeenCalledOnce();
      expect(cleanupSpies.canvasPresenceClose).toHaveBeenCalledOnce();
      expect(cleanupSpies.canvasLiveSyncClose.mock.invocationCallOrder[0]).toBeLessThan(
        cleanupSpies.canvasPresenceClose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
      );
      expect(vi.getTimerCount()).toBe(initialTimerCount);

      const fallbackUpgrade = vi.fn();
      upgradeRouter.register({
        matches: () => true,
        handle: fallbackUpgrade
      });
      const presenceUrl =
        "/api/v1/projects/project-capture-failure/canvases/default/human/presence";
      const liveSyncUrl = "/api/v1/projects/project-capture-failure/canvases/default/human/live";
      expect(canvasPresenceRouteFromUrl(presenceUrl)).toEqual({
        projectId: "project-capture-failure",
        canvasId: "default"
      });
      expect(canvasLiveSyncRouteFromUrl(liveSyncUrl)).toEqual({
        projectId: "project-capture-failure",
        canvasId: "default"
      });
      for (const url of [presenceUrl, liveSyncUrl]) {
        const request = new IncomingMessage(new Socket());
        request.url = url;
        httpServer.emit("upgrade", request, new PassThrough(), Buffer.alloc(0));
      }
      expect(fallbackUpgrade).toHaveBeenCalledTimes(2);
    } finally {
      upgradeRouter.close();
      httpServer.close();
      database.close();
    }
  });

  it("closes SQLite and unbinds runtimes when WebSocket cleanup fails", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const dataDirectory = join(workspace.root, "server-data");
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [
        {
          workspaceId: legacyWorkspaceIdForProject(workspace.init.workspace.id),
          projectId: workspace.init.workspace.id,
          canvasId: "default",
          projectRoot: workspace.root
        }
      ],
      operatorCredentials: [
        {
          operatorId: "admin",
          tokenSha256: hashOperatorToken(`pw_operator_${"C".repeat(43)}`),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    const composition = await createDistributedServerComposition({
      httpServer: createServer(),
      config
    });
    await seedOperatorSessions(config.databasePath, config.operatorCredentials);

    await expect(composition.close()).rejects.toThrow("distributed_server_cleanup_failed");
    expect(cleanupSpies.webSocketClose).toHaveBeenCalledOnce();
    expect(cleanupSpies.retentionStart).toHaveBeenCalledOnce();
    expect(cleanupSpies.retentionClose).toHaveBeenCalledOnce();
    expect(cleanupSpies.runtimeRegistryClose).toHaveBeenCalledOnce();
    expect(composition.readiness()).toMatchObject({ status: "draining" });
    await expect(composition.close()).rejects.toThrow("distributed_server_cleanup_failed");
    expect(cleanupSpies.webSocketClose).toHaveBeenCalledOnce();
    expect(cleanupSpies.retentionClose).toHaveBeenCalledOnce();
    expect(cleanupSpies.runtimeRegistryClose).toHaveBeenCalledOnce();
  });
});
