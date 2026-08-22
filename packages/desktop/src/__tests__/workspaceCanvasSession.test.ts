import { mkdtemp, rm } from "node:fs/promises";
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
import type { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { CollaborationCanvasCommandFacade } from "../main/collaboration/collaborationCanvasCommands.js";
import { CollaborationClientError } from "../main/collaboration/collaborationErrors.js";
import { CanvasReplicaStore } from "../main/collaboration/CanvasReplicaStore.js";
import type { CanvasReplicaCommandTransport } from "../main/collaboration/CanvasReplicaCommandWorker.js";
import { WorkspaceCanvasSession } from "../main/collaboration/WorkspaceCanvasSession.js";
import { WorkspaceAuthoritativeSnapshotCache } from "../main/collaboration/WorkspaceAuthoritativeSnapshotCache.js";
import {
  type WorkspaceRemoteAuthorityKey,
  workspaceRemoteAuthorityId
} from "../main/collaboration/WorkspaceRemoteAuthorityIdentity.js";
import type { CollaborationCanvasCommandSessionView } from "../shared/collaboration.js";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator.js";

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
}) {
  let content = fixtureContent();
  const store = new CanvasReplicaStore(
    () => undefined,
    (snapshot) => options?.snapshotCache?.capture(cacheKey, snapshot)
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
    resolveCanvasScope: async () => ({
      workspaceId: locator.workspaceId,
      projectId: locator.projectId,
      canvasId: locator.canvasId
    }),
    resolveAuthorityId: () => workspaceRemoteAuthorityId(cacheKey),
    store,
    transport
  });
  const flushSnapshotCache = vi.spyOn(facade, "flushSnapshotCache");
  const statuses: string[] = [];
  const resetRuntime = vi.fn().mockResolvedValue({
    type: "canvas.runtime.reset.rejected" as const,
    operationId: "reset-1",
    code: "host_offline" as const
  });
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
    resetRuntime,
    onProjection: (projection) => statuses.push(projection.status)
  });
  return {
    session,
    submitted,
    mirror,
    flushSnapshotCache,
    statuses,
    resetRuntime,
    fetchReconnectBaseline,
    resolveSnapshotCacheKey,
    content: () => content
  };
}

describe("WorkspaceCanvasSession", () => {
  it("opens a verified Server projection without a local package directory", async () => {
    const harness = createHarness();
    const projection = await harness.session.open(locator);
    expect(projection.status).toBe("accepted");
    expect(projection.locator).toEqual(locator);
    expect(projection.replica.bindingKind).toBe("remote");
    expect(projection.replica).not.toHaveProperty("localProjectId");
    expect(harness.mirror.bind).not.toHaveBeenCalled();
    expect(harness.flushSnapshotCache).not.toHaveBeenCalled();
    expect(harness.resolveSnapshotCacheKey).not.toHaveBeenCalled();
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

    const restarted = createHarness({ connectedProfileId: null, snapshotCache });
    const recovered = await restarted.session.open(locator);
    expect(recovered).toMatchObject({
      authorityMode: "offline_cache_readonly",
      readOnly: true,
      cachedAt: expect.any(String),
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
});
