import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CanvasCommandOutcome,
  CanvasReconnectResponse
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import {
  applyCanvasReplicaIntent,
  decodeCanvasReplicaDocument,
  encodeCanvasReplicaDocument,
  parseCanvasReplicaDocument
} from "@planweave-ai/runtime";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { CollaborationCanvasCommandFacade } from "../main/collaboration/collaborationCanvasCommands.js";
import { CollaborationClientError } from "../main/collaboration/collaborationErrors.js";
import { CanvasReplicaStore } from "../main/collaboration/CanvasReplicaStore.js";
import type { CanvasReplicaCommandTransport } from "../main/collaboration/CanvasReplicaCommandWorker.js";
import { CollaborationSessionLifecycle } from "../main/collaboration/CollaborationSessionLifecycle.js";
import { CollaborationPresenceSession } from "../main/collaboration/collaborationPresenceSession.js";
import { CollaborationProfileStore } from "../main/collaboration/collaborationProfileStore.js";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import { ContentVersionFacade } from "../main/collaboration/ContentVersionFacade.js";
import { createWorkspaceCanvasSnapshotSessionComposition } from "../main/collaboration/workspaceCanvasSnapshotSessionComposition.js";
import { parseCollaborationConnectionProfile } from "@planweave-ai/collaboration-protocol/connection";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import { WorkspaceCanvasSession } from "../main/collaboration/WorkspaceCanvasSession.js";
import {
  workspaceAuthoritativeSnapshotCacheEntrySchema,
  WorkspaceAuthoritativeSnapshotCache
} from "../main/collaboration/WorkspaceAuthoritativeSnapshotCache.js";
import {
  type WorkspaceRemoteAuthorityKey,
  workspaceRemoteAuthorityId
} from "../main/collaboration/WorkspaceRemoteAuthorityIdentity.js";
import type { CollaborationCanvasCommandSessionView } from "../shared/collaboration.js";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator.js";
import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";

const locator: WorkspaceCanvasLocator = {
  kind: "workspace",
  connectionProfileId: "profile-1",
  workspaceId: "workspace-001",
  projectId: "remote-project",
  canvasId: "remote-canvas"
};

const cacheKey: WorkspaceRemoteAuthorityKey = {
  connectionProfileId: "profile-1",
  serverOrigin: "http://127.0.0.1:1",
  workspaceId: "workspace-001",
  projectId: "remote-project",
  canvasId: "remote-canvas"
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

const remoteSession: CollaborationCanvasCommandSessionView = {
  canvasId: "remote-canvas",
  revision: 1,
  contentDigest: "a".repeat(64),
  lastOperationId: null,
  lastJournalEntryId: null,
  pendingOperationId: null,
  lastConflict: null,
  lastRejectCode: null
};

const layoutIntent = {
  kind: "update_layout" as const,
  nodes: [
    { nodeId: "T-001", x: 1, y: 2 },
    { nodeId: "T-002", x: 30, y: 40 }
  ],
  updatedAt: "2026-08-02T00:00:00.000Z"
};

function fixtureContent(): CompleteContentVersion {
  const manifest = basicManifest({ includeSecondTask: true });
  return encodeCanvasReplicaDocument(
    parseCanvasReplicaDocument({
      schemaVersion: "canvas-replica-document/v1",
      manifest,
      promptMarkdownByPath: Object.fromEntries(
        manifest.nodes.flatMap((task) => [
          [task.prompt, `# ${task.id} task\n`],
          ...task.blocks.map((block) => [block.prompt, `# ${task.id} ${block.id}\n`])
        ])
      ),
      layout: {
        version: "desktop-layout/v1",
        projectId: "remote-project",
        nodes: [
          { nodeId: "T-001", x: 10, y: 20 },
          { nodeId: "T-002", x: 30, y: 40 }
        ],
        updatedAt: "2026-08-02T00:00:00.000Z"
      }
    })
  );
}

function snapshotResponse(
  content: CompleteContentVersion,
  revision: number
): Extract<CanvasReconnectResponse, { type: "canvas.reconnect.snapshot" }> {
  return {
    type: "canvas.reconnect.snapshot",
    protocolVersion: 1,
    schemaVersion: "canvas-command/v1",
    scope: {
      workspaceId: "workspace-001",
      projectId: "remote-project",
      canvasId: "remote-canvas"
    },
    reason: "truncated_journal",
    afterRevision: 0,
    snapshot: {
      metadata: {
        schemaVersion: "canvas-snapshot/v2",
        scope: {
          workspaceId: "workspace-001",
          projectId: "remote-project",
          canvasId: "remote-canvas"
        },
        revision,
        contentDigest: content.canonicalDigest,
        createdAt: "2026-08-02T00:00:00.000Z",
        sizeBytes: content.totalBytes
      },
      encoding: "content_version_ref",
      content: {
        versionId: `version-${content.canonicalDigest}`,
        canonicalDigest: content.canonicalDigest,
        verification: "complete"
      }
    }
  };
}

function emptyDelta(
  content: CompleteContentVersion,
  afterRevision: number
): CanvasReconnectResponse {
  return {
    type: "canvas.reconnect.delta",
    protocolVersion: 1,
    schemaVersion: "canvas-command/v1",
    scope: {
      workspaceId: "workspace-001",
      projectId: "remote-project",
      canvasId: "remote-canvas"
    },
    afterRevision,
    headRevision: afterRevision,
    headContentDigest: content.canonicalDigest,
    entries: []
  };
}

function makeClient(overrides: Partial<CollaborationClient> = {}) {
  const session = { ...remoteSession };
  return {
    projectId: "remote-project",
    connectionProfile: {
      profileId: "profile-1",
      serverBaseUrl: "http://127.0.0.1:1/",
      projectId: "remote-project",
      allowInsecureTransport: true
    },
    submitCanvasCommand: vi.fn<CollaborationClient["submitCanvasCommand"]>(),
    reconnectCanvasCommands: vi.fn<CollaborationClient["reconnectCanvasCommands"]>(),
    fetchContentVersion: vi.fn<CollaborationClient["fetchContentVersion"]>(),
    bindCanvasCommandSession: vi.fn<CollaborationClient["bindCanvasCommandSession"]>(),
    clearCanvasCommandSession: vi.fn<CollaborationClient["clearCanvasCommandSession"]>(),
    canvasCommandSession: vi.fn<CollaborationClient["canvasCommandSession"]>(() => session),
    getCurrentCanvasAccess: vi.fn(async () => ({
      scope: {
        scopeKind: "canvas" as const,
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: "remote-canvas"
      },
      projectVisibility: "shared" as const,
      canvasVisibility: "shared" as const,
      projectAclRevision: 1,
      canvasAclRevision: 1,
      project: {
        scope: {
          scopeKind: "project" as const,
          workspaceId: "workspace-001",
          projectId: "remote-project",
          canvasId: null
        },
        aclRevision: 1,
        effectiveRole: "owner" as const,
        roleSource: "scope_owner" as const,
        capabilities: {
          list: true,
          read: true,
          persistent_canvas_command: true,
          assignment: true,
          comment: true,
          grant: true,
          revoke: true,
          administration: true,
          visibility: true
        },
        disabledReason: null
      },
      canvas: {
        scope: {
          scopeKind: "canvas" as const,
          workspaceId: "workspace-001",
          projectId: "remote-project",
          canvasId: "remote-canvas"
        },
        aclRevision: 1,
        effectiveRole: "owner" as const,
        roleSource: "scope_owner" as const,
        capabilities: {
          list: true,
          read: true,
          persistent_canvas_command: true,
          assignment: true,
          comment: true,
          grant: true,
          revoke: true,
          administration: true,
          visibility: true
        },
        disabledReason: null
      },
      people: []
    })),
    ...overrides
  } as unknown as CollaborationClient;
}

function createHarness(options?: {
  submit?: CanvasReplicaCommandTransport["submit"];
  reconnect?: CanvasReplicaCommandTransport["reconnect"];
  fetchReconnectBaseline?: CanvasReplicaCommandTransport["fetchReconnectBaseline"];
  connectedProfileId?: string | null;
  snapshotCache?: WorkspaceAuthoritativeSnapshotCache;
  readRuntimeAvailability?: () => Promise<CanvasRuntimeAvailability | null>;
}) {
  let content = fixtureContent();
  const store = new CanvasReplicaStore(
    () => undefined,
    (snapshot) => {
      if (options?.connectedProfileId !== null) options?.snapshotCache?.capture(cacheKey, snapshot);
    }
  );
  const submitted: Array<{
    expectedRevision: number;
    operationId: string;
    payload: unknown;
  }> = [];
  const fetchReconnectBaseline = vi.fn(
    options?.fetchReconnectBaseline ??
      (async () => ({
        response: snapshotResponse(content, 1),
        content
      }))
  );
  const transport: CanvasReplicaCommandTransport = {
    fetchReconnectBaseline,
    reconnect:
      options?.reconnect ??
      (async (_scope, input) => ({
        response: emptyDelta(content, input.afterRevision)
      })),
    async canPersistCanvasCommand() {
      return true;
    },
    submit:
      options?.submit ??
      (async (input) => {
        submitted.push({
          expectedRevision: input.expectedRevision,
          operationId: input.operationId,
          payload: input
        });
        const next = encodeCanvasReplicaDocument(
          applyCanvasReplicaIntent(decodeCanvasReplicaDocument(content), input.intent)
        );
        content = next;
        const outcome: CanvasCommandOutcome = {
          type: "canvas.command.accepted",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: "workspace-001",
            projectId: "remote-project",
            canvasId: "remote-canvas"
          },
          operationId: input.operationId,
          revision: input.expectedRevision + 1,
          previousRevision: input.expectedRevision,
          contentDigest: next.canonicalDigest,
          journalEntryId: "journal-2",
          actor: { kind: "human", id: "human-1", displayName: "Owner" },
          acceptedAt: "2026-08-02T00:00:00.000Z",
          idempotentReplay: false
        };
        return outcome;
      })
  };
  const client = makeClient();
  const connectedProfileId =
    options?.connectedProfileId === undefined ? "profile-1" : options.connectedProfileId;
  const mirror = {
    bind: vi.fn().mockRejectedValue(new Error("workspace session must not bind a local package")),
    flush: vi.fn().mockRejectedValue(new Error("workspace session must not flush a local package")),
    clear: vi.fn()
  };
  const facade = new CollaborationCanvasCommandFacade({
    resolveClient: () => (connectedProfileId ? client : null),
    resolveCanvasBinding: async () => ({
      kind: "remote",
      workspaceId: locator.workspaceId,
      projectId: locator.projectId,
      canvasId: locator.canvasId,
      remoteProjectId: locator.projectId,
      remoteCanvasId: locator.canvasId
    }),
    resolveAuthorityId: () => workspaceRemoteAuthorityId(cacheKey),
    store,
    transport
  });
  const flushSnapshotCache = vi.spyOn(facade, "flushSnapshotCache");
  const releaseBinding = vi.spyOn(facade, "releaseBinding");
  const statuses: string[] = [];
  const resetRuntime = vi.fn().mockResolvedValue({
    type: "canvas.runtime.reset.rejected" as const,
    operationId: "reset-1",
    code: "host_offline" as const
  });
  const initializeRuntime = vi.fn().mockResolvedValue({
    type: "canvas.runtime.initialize.rejected" as const,
    operationId: "initialize-1",
    code: "host_offline" as const
  });
  const readRuntimeAvailability = vi.fn(
    options?.readRuntimeAvailability ??
      (async () => ({
        schemaVersion: "canvas-runtime-view/v1" as const,
        state: { kind: "uninitialized" as const },
        execution: {
          schemaVersion: "canvas-runtime-availability/v1" as const,
          kind: "unavailable" as const,
          reason: "runtime_not_attached" as const
        }
      }))
  );
  const resolveSnapshotCacheKey = vi.fn(async () => cacheKey);
  const session = new WorkspaceCanvasSession({
    resolveConnectedProfileId: () => connectedProfileId,
    commands: {
      bind: (input) => facade.bind(input),
      bindCached: (input) => facade.bindCached(input),
      submit: (input, submitOptions) => facade.submit(input, submitOptions),
      reconnect: (input) => facade.reconnect(input),
      projectionForBinding: (input) => facade.projectionForBinding(input),
      session: () => facade.session(),
      releaseBinding: () => facade.releaseBinding()
    },
    resolveSnapshotCacheKey,
    snapshotCache: options?.snapshotCache ?? { get: vi.fn().mockResolvedValue(null) },
    readRuntimeAvailability,
    initializeRuntime,
    resetRuntime,
    onProjection: (projection) => statuses.push(projection.status)
  });
  return {
    session,
    submitted,
    mirror,
    flushSnapshotCache,
    statuses,
    initializeRuntime,
    readRuntimeAvailability,
    releaseBinding,
    resetRuntime,
    fetchReconnectBaseline,
    resolveSnapshotCacheKey,
    content: () => content
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function serviceWithCache(directory: string, cache: WorkspaceAuthoritativeSnapshotCache) {
  return new CollaborationService({
    profileStorePaths: { profilesPath: join(directory, "profiles.json") },
    workspaceProfileStorePaths: { profilesPath: join(directory, "workspace-profiles.json") },
    credentialsPath: join(directory, "credentials.json"),
    invitationsPath: join(directory, "invitations.json"),
    exportedIdentityPath: join(directory, "identity.json"),
    workspaceSnapshotCache: cache
  });
}

describe("WorkspaceCanvasSession", () => {
  it.each([
    false,
    true
  ])("detaches authority before the flush barrier and cleans the saved client (write fails=%s)", async (writeFails) => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-close-authority-"));
    temporaryDirectories.push(directory);
    const cacheDirectory = join(directory, "cache");
    if (writeFails) await writeFile(cacheDirectory, "blocked");
    const cache = new WorkspaceAuthoritativeSnapshotCache(cacheDirectory);
    const profile = parseCollaborationConnectionProfile({
      profileId: cacheKey.connectionProfileId,
      displayName: "test",
      serverBaseUrl: cacheKey.serverOrigin,
      projectId: cacheKey.projectId,
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: cacheKey.serverOrigin,
        allowedClientOrigins: [cacheKey.serverOrigin],
        tlsTrust: "not_applicable"
      }
    });
    const savedClient = new CollaborationClient({
      profile,
      credential: { getDeviceToken: () => undefined }
    });
    let activeClient: CollaborationClient | null = savedClient;
    const getClient = () => activeClient;
    const cleanup = [
      vi.spyOn(savedClient, "stopPresence"),
      vi.spyOn(savedClient, "stopLiveSync"),
      vi.spyOn(savedClient, "stopObserver"),
      vi.spyOn(savedClient, "dispose")
    ];
    const cursor = vi.spyOn(savedClient, "lastObserverCursor");
    const composition = createWorkspaceCanvasSnapshotSessionComposition({
      snapshotCache: cache,
      contentVersions: new ContentVersionFacade(getClient),
      resolveClient: getClient,
      resolveConnectedProfileId: () => (activeClient ? profile.profileId : null),
      resolveProfile: async () => profile,
      enqueue: async (operation) => operation(),
      assertOpen: () => {}
    });
    const content = fixtureContent();
    const entry = (revision: number) =>
      workspaceAuthoritativeSnapshotCacheEntrySchema.parse({
        schemaVersion: "workspace-authoritative-snapshot-cache/v1",
        key: cacheKey,
        contentRevision: revision,
        contentDigest: content.canonicalDigest,
        contentIdentity: {
          canonicalDigest: content.canonicalDigest,
          totalBytes: content.totalBytes
        },
        recovery: { mode: "offline_readonly", mutationsAllowed: false, executionAllowed: false },
        cachedAt: "2026-10-06T00:00:00.000Z",
        content
      });
    const started = deferred();
    const release = deferred();
    const realPut = cache.put.bind(cache);
    const put = vi.spyOn(cache, "put").mockImplementation(async (...args) => {
      started.resolve();
      await release.promise;
      return realPut(...args);
    });
    const publishStatus = () => serviceWithCache(directory, cache).getStatus();
    const setSession = vi.fn();
    const lifecycle = new CollaborationSessionLifecycle({
      verifyClient: vi.fn(),
      profiles: new CollaborationProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") }
      }),
      presenceSession: new CollaborationPresenceSession({
        getClient,
        getClientProfileId: () => (activeClient ? profile.profileId : null),
        publishPresenceSignal: () => {},
        setSessionError: () => {},
        clearDeviceCredential: async () => {},
        publishStatus
      }),
      canvasCommands: composition.commands,
      enqueue: async (operation) => operation(),
      assertOpen: () => {},
      getClient,
      getClientProfileId: () => (activeClient ? profile.profileId : null),
      setClient: (client) => {
        activeClient = client;
      },
      getSessionPhase: () => "connected",
      setSession,
      clientForProfile: async () => {
        throw new Error("unused");
      },
      publishStatus,
      publishObserverSignal: () => {}
    });
    composition.commands.bindCached({ key: cacheKey, entry: entry(2) });
    await started.promise;
    composition.commands.bindCached({ key: cacheKey, entry: entry(3) });
    let closed = false;
    const closing = lifecycle.dispose("disconnect").finally(() => {
      closed = true;
    });
    const outcome = closing.then(
      () => null,
      (error: unknown) => error
    );
    expect(activeClient).toBeNull();
    expect(closed).toBe(false);
    const binding = {
      kind: "remote" as const,
      workspaceId: cacheKey.workspaceId,
      projectId: cacheKey.projectId,
      canvasId: cacheKey.canvasId
    };
    expect(composition.commands.projectionForBinding(binding)).toBeNull();
    release.resolve();
    const error = await outcome;
    expect(put).toHaveBeenCalledTimes(2);
    expect(composition.commands.projectionForBinding(binding)).toBeNull();
    expect(cleanup[0]).toHaveBeenCalledTimes(2);
    expect(cleanup[1]).toHaveBeenCalledTimes(3);
    expect(cleanup[2]).toHaveBeenCalledTimes(1);
    expect(cleanup[3]).toHaveBeenCalledTimes(1);
    expect(cursor).toHaveBeenCalledTimes(1);
    if (writeFails) {
      expect(error).not.toBeNull();
      expect(setSession).toHaveBeenLastCalledWith(
        "error",
        "canvas_replica_persistence_failed",
        expect.objectContaining({ message: expect.any(String) })
      );
    } else {
      expect(error).toBeNull();
      expect(
        await new WorkspaceAuthoritativeSnapshotCache(cacheDirectory).get(cacheKey)
      ).toMatchObject({ contentRevision: 3, content });
    }
  });

  it("opens a verified Server projection without a local package directory", async () => {
    const harness = createHarness();
    const projection = await harness.session.open(locator);
    expect(projection.status).toBe("accepted");
    expect(projection.locator).toEqual(locator);
    expect(projection.replica.bindingKind).toBe("remote");
    expect(projection.initialRuntimeAvailability).toMatchObject({
      state: { kind: "uninitialized" },
      execution: { kind: "unavailable", reason: "runtime_not_attached" }
    });
    expect(harness.readRuntimeAvailability).toHaveBeenCalledWith({
      kind: "remote",
      workspaceId: locator.workspaceId,
      projectId: locator.projectId,
      canvasId: locator.canvasId
    });
    expect(projection.replica).not.toHaveProperty("localProjectId");
    expect(harness.mirror.bind).not.toHaveBeenCalled();
    expect(harness.flushSnapshotCache).not.toHaveBeenCalled();
    expect(harness.resolveSnapshotCacheKey).not.toHaveBeenCalled();
  });

  it("releases a newly opened binding when the initial Runtime projection fails", async () => {
    const harness = createHarness({
      readRuntimeAvailability: async () => {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "canvas_runtime_availability_invalid",
          message: "canvas_runtime_availability_invalid",
          retryable: false
        });
      }
    });

    await expect(harness.session.open(locator)).rejects.toMatchObject({
      code: "canvas_runtime_availability_invalid"
    });
    expect(harness.releaseBinding).toHaveBeenCalledOnce();
    expect(harness.session.current()).toBeNull();
  });

  it("selects the Desktop connection from connectionProfileId and never forwards it", async () => {
    const harness = createHarness();
    await harness.session.open(locator);
    await harness.session.submit({ locator, intent: layoutIntent });
    expect(harness.submitted[0]?.expectedRevision).toBe(1);
    expect(harness.submitted[0]?.operationId).toMatch(/^op-/);
    expect(JSON.stringify(harness.submitted[0]?.payload)).not.toContain("connectionProfileId");
    await expect(
      createHarness({ connectedProfileId: "other-profile" }).session.open(locator)
    ).rejects.toMatchObject({ code: "workspace_canvas_connection_mismatch" });
  });

  it("publishes pending then accepted projections for a successful submit", async () => {
    const harness = createHarness();
    await harness.session.open(locator);
    harness.statuses.length = 0;
    const projection = await harness.session.submit({ locator, intent: layoutIntent });
    expect(harness.statuses).toEqual(["pending", "accepted"]);
    expect(projection.status).toBe("accepted");
    expect(projection.replica.optimisticOperationIds).toEqual([]);
    expect(harness.mirror.flush).not.toHaveBeenCalled();
    expect(harness.flushSnapshotCache).not.toHaveBeenCalled();
  });

  it("rebuilds from reconnect and surfaces a stale conflict instead of writing local files", async () => {
    const content = fixtureContent();
    const harness = createHarness({
      submit: async (input) => ({
        type: "canvas.command.rejected",
        protocolVersion: 1,
        schemaVersion: "canvas-command/v1",
        projectId: "remote-project",
        canvasId: "remote-canvas",
        operationId: input.operationId,
        code: "stale_revision",
        conflict: {
          expectedRevision: input.expectedRevision,
          authoritativeRevision: input.expectedRevision + 2,
          authoritativeContentDigest: content.canonicalDigest
        }
      }),
      reconnect: async (_scope, input) => ({
        response: emptyDelta(content, input.afterRevision)
      })
    });
    await harness.session.open(locator);
    const projection = await harness.session.submit({ locator, intent: layoutIntent });
    expect(projection.status).toBe("conflicted");
    expect(projection.conflict?.expectedRevision).toBe(1);
    expect(projection.conflict?.authoritativeRevision).toBe(3);
    expect(projection.replica.optimisticOperationIds).toEqual([]);
    expect(harness.flushSnapshotCache).not.toHaveBeenCalled();
    expect(harness.mirror.bind).not.toHaveBeenCalled();
  });

  it("reverts pending state and surfaces a rejected command", async () => {
    const harness = createHarness({
      submit: async (input) => ({
        type: "canvas.command.rejected",
        protocolVersion: 1,
        schemaVersion: "canvas-command/v1",
        projectId: "remote-project",
        canvasId: "remote-canvas",
        operationId: input.operationId,
        code: "forbidden",
        detail: "canvas_write_denied"
      })
    });
    await harness.session.open(locator);
    const projection = await harness.session.submit({ locator, intent: layoutIntent });
    expect(projection.status).toBe("rejected");
    expect(projection.rejectCode).toBe("forbidden");
    expect(projection.replica.optimisticOperationIds).toEqual([]);
    expect(harness.flushSnapshotCache).not.toHaveBeenCalled();
  });

  it("reconnects by revision without treating local materialization as authority", async () => {
    const harness = createHarness();
    await harness.session.open(locator);
    const projection = await harness.session.reconnect(locator);
    expect(projection.status).toBe("accepted");
    expect(projection.replica.revision).toBe(1);
    expect(harness.flushSnapshotCache).not.toHaveBeenCalled();
  });

  it("routes reset only for the currently open Workspace locator", async () => {
    const harness = createHarness();
    await harness.session.open(locator);
    const input = {
      locator,
      operationId: "reset-1",
      expectedSourceRevision: `snapshot:${"b".repeat(64)}`,
      expectedGraphFingerprint: `pkg-${"a".repeat(64)}`
    };
    await expect(harness.session.resetRuntime(input)).resolves.toMatchObject({
      type: "canvas.runtime.reset.rejected",
      code: "host_offline"
    });
    expect(harness.resetRuntime).toHaveBeenCalledWith(input);
    await expect(
      harness.session.resetRuntime({
        ...input,
        locator: { ...locator, canvasId: "other-canvas" }
      })
    ).rejects.toMatchObject({ code: "workspace_canvas_locator_mismatch" });
  });

  it("routes initialization separately from reset for the currently open Workspace locator", async () => {
    const harness = createHarness();
    await harness.session.open(locator);
    const input = {
      locator,
      operationId: "initialize-1",
      expectedSourceRevision: `snapshot:${"b".repeat(64)}`,
      expectedGraphFingerprint: `pkg-${"a".repeat(64)}`
    };

    await expect(harness.session.initializeRuntime(input)).resolves.toMatchObject({
      type: "canvas.runtime.initialize.rejected",
      code: "host_offline"
    });
    expect(harness.initializeRuntime).toHaveBeenCalledWith(input);
    expect(harness.resetRuntime).not.toHaveBeenCalled();
    await expect(
      harness.session.initializeRuntime({
        ...input,
        locator: { ...locator, canvasId: "other-canvas" }
      })
    ).rejects.toMatchObject({ code: "workspace_canvas_locator_mismatch" });
  });

  it("closes the Desktop session without deleting the Server canvas or flushing a package", async () => {
    const harness = createHarness();
    await harness.session.open(locator);
    await harness.session.close(locator);
    expect(harness.session.current()).toBeNull();
    expect(harness.flushSnapshotCache).not.toHaveBeenCalled();
    await expect(harness.session.submit({ locator, intent: layoutIntent })).rejects.toMatchObject({
      code: "workspace_canvas_session_closed"
    });
  });

  it("restores a Server-confirmed snapshot after restart as offline read-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-session-cache-"));
    temporaryDirectories.push(directory);
    const snapshotCache = new WorkspaceAuthoritativeSnapshotCache(directory);
    const online = createHarness({ snapshotCache });
    const onlineProjection = await online.session.open(locator);
    expect(onlineProjection.authorityMode).toBe("server_authoritative");
    await snapshotCache.flush();
    await online.session.close(locator);

    const reopenedCache = new WorkspaceAuthoritativeSnapshotCache(directory);
    const offlineCapture = vi.spyOn(reopenedCache, "capture");
    const offlinePut = vi.spyOn(reopenedCache, "put");
    const restarted = createHarness({
      connectedProfileId: null,
      snapshotCache: reopenedCache
    });
    const recovered = await restarted.session.open(locator);
    expect(recovered).toMatchObject({
      authorityMode: "offline_cache_readonly",
      readOnly: true,
      cachedAt: expect.any(String),
      initialRuntimeAvailability: null,
      replica: { canEdit: false, bindingKind: "remote" }
    });
    expect(restarted.fetchReconnectBaseline).not.toHaveBeenCalled();
    expect(restarted.mirror.bind).not.toHaveBeenCalled();
    expect(restarted.mirror.clear).not.toHaveBeenCalled();
    expect(restarted.flushSnapshotCache).not.toHaveBeenCalled();

    await expect(restarted.session.submit({ locator, intent: layoutIntent })).rejects.toMatchObject(
      { code: "workspace_canvas_offline_readonly" }
    );
    await expect(
      restarted.session.resetRuntime({
        locator,
        operationId: "reset-offline",
        expectedSourceRevision: `snapshot:${"b".repeat(64)}`,
        expectedGraphFingerprint: `pkg-${"a".repeat(64)}`
      })
    ).rejects.toMatchObject({ code: "workspace_canvas_offline_execution_disabled" });
    expect(restarted.resetRuntime).not.toHaveBeenCalled();
    expect(offlineCapture).not.toHaveBeenCalled();
    expect(offlinePut).not.toHaveBeenCalled();
  });

  it("advances the durable recovery snapshot only after a confirmed content revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-session-cache-"));
    temporaryDirectories.push(directory);
    const snapshotCache = new WorkspaceAuthoritativeSnapshotCache(directory);
    const harness = createHarness({ snapshotCache });
    await harness.session.open(locator);
    await snapshotCache.flush();
    expect((await snapshotCache.get(cacheKey))?.contentRevision).toBe(1);

    const projection = await harness.session.submit({ locator, intent: layoutIntent });
    await snapshotCache.flush();
    const cached = await snapshotCache.get(cacheKey);
    expect(cached).toMatchObject({
      contentRevision: 2,
      contentDigest: projection.replica.contentDigest
    });
  });

  it("fails truthfully when offline restart has no authoritative snapshot cache", async () => {
    const harness = createHarness({ connectedProfileId: null });
    await expect(harness.session.open(locator)).rejects.toMatchObject({
      code: "workspace_canvas_offline_cache_unavailable"
    });
    expect(harness.fetchReconnectBaseline).not.toHaveBeenCalled();
    expect(harness.mirror.bind).not.toHaveBeenCalled();
  });

  it("does not hide a Server protocol failure behind a cached projection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-session-cache-"));
    temporaryDirectories.push(directory);
    const snapshotCache = new WorkspaceAuthoritativeSnapshotCache(directory);
    const snapshot = fixtureContent();
    await snapshotCache.put({
      key: cacheKey,
      contentRevision: 1,
      contentDigest: snapshot.canonicalDigest,
      content: snapshot
    });
    const get = vi.spyOn(snapshotCache, "get");
    const harness = createHarness({
      snapshotCache,
      fetchReconnectBaseline: async () => {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "canvas_snapshot_invalid",
          message: "canvas_snapshot_invalid",
          retryable: false
        });
      }
    });

    await expect(harness.session.open(locator)).rejects.toMatchObject({
      code: "canvas_snapshot_invalid"
    });
    expect(get).not.toHaveBeenCalled();
  });
  it.each([
    "disconnect",
    "shutdown"
  ] as const)("waits for the last Server-confirmed snapshot during %s before reopening offline", async (action) => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-close-cache-"));
    temporaryDirectories.push(directory);
    const cacheDirectory = join(directory, "snapshots");
    const cache = new WorkspaceAuthoritativeSnapshotCache(cacheDirectory);
    const service = serviceWithCache(directory, cache);
    const firstWrite = deferred();
    const flushStarted = deferred();
    const put = cache.put.bind(cache);
    vi.spyOn(cache, "put").mockImplementationOnce(async (input) => {
      await firstWrite.promise;
      return put(input);
    });
    const online = createHarness({ snapshotCache: cache });
    await online.session.open(locator);
    const accepted = await online.session.submit({ locator, intent: layoutIntent });
    expect(accepted.replica.revision).toBe(2);
    const flush = cache.flush.bind(cache);
    vi.spyOn(cache, "flush").mockImplementation(() => {
      flushStarted.resolve();
      return flush();
    });
    let closed = false;
    const closing = (
      action === "disconnect" ? service.disconnectSession() : service.shutdown()
    ).then(() => {
      closed = true;
    });
    await flushStarted.promise;
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(await new WorkspaceAuthoritativeSnapshotCache(cacheDirectory).get(cacheKey)).toBeNull();
    firstWrite.resolve();
    await closing;
    await online.session.close(locator);
    const reopenedCache = new WorkspaceAuthoritativeSnapshotCache(cacheDirectory);
    expect(await reopenedCache.get(cacheKey)).toMatchObject({
      contentRevision: 2,
      contentDigest: accepted.replica.contentDigest,
      content: online.content(),
      recovery: { mode: "offline_readonly", mutationsAllowed: false, executionAllowed: false }
    });
    const offline = createHarness({ connectedProfileId: null, snapshotCache: reopenedCache });
    expect(await offline.session.open(locator)).toMatchObject({
      authorityMode: "offline_cache_readonly",
      readOnly: true,
      replica: { revision: 2, contentDigest: accepted.replica.contentDigest, canEdit: false }
    });
    await expect(offline.session.submit({ locator, intent: layoutIntent })).rejects.toMatchObject({
      code: "workspace_canvas_offline_readonly"
    });
  });

  it.each([
    "disconnect",
    "shutdown"
  ] as const)("reports a real persistence failure during %s and allows a later snapshot retry", async (action) => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-close-failure-"));
    temporaryDirectories.push(directory);
    const cacheDirectory = join(directory, "snapshots");
    await writeFile(cacheDirectory, "blocked cache directory", "utf8");
    const cache = new WorkspaceAuthoritativeSnapshotCache(cacheDirectory);
    const service = serviceWithCache(directory, cache);
    const online = createHarness({ snapshotCache: cache });
    await online.session.open(locator);
    await expect(
      action === "disconnect" ? service.disconnectSession() : service.shutdown()
    ).rejects.toBeInstanceOf(Error);
    expect((await service.getStatus()).session).toMatchObject({
      phase: "error",
      detail: "canvas_replica_persistence_failed",
      lastErrorMessage: expect.any(String)
    });
    await rm(cacheDirectory);
    const accepted = await online.session.submit({ locator, intent: layoutIntent });
    if (action === "disconnect") await service.disconnectSession();
    else await service.shutdown();
    expect(
      await new WorkspaceAuthoritativeSnapshotCache(cacheDirectory).get(cacheKey)
    ).toMatchObject({
      contentRevision: 2,
      contentDigest: accepted.replica.contentDigest,
      recovery: { mode: "offline_readonly", mutationsAllowed: false, executionAllowed: false }
    });
  });
});
