import { describe, expect, it, vi } from "vitest";
import { canvasRuntimeStatusProjectionSchema } from "@planweave-ai/collaboration-protocol/canvas/status";
import type {
  CanvasCommandIntent,
  CanvasJournalEntry,
  CanvasReconnectResponse
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  applyCanvasReplicaIntent,
  encodeCanvasReplicaDocument,
  parseCanvasReplicaDocument,
  type CanvasReplicaDocument,
  type DesktopGraphViewModel
} from "@planweave-ai/runtime";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { CanvasReplicaStore } from "../main/collaboration/CanvasReplicaStore.js";
import { canvasReplicaProjectionToDesktopGraph } from "../renderer/collaboration/canvasReplicaGraphAdapter.js";
import type { CollaborationCanvasReplicaProjection } from "../shared/canvasReplicaIpc.js";
import {
  CanvasRuntimeAvailabilityCoordinator,
  type CanvasRuntimeCommandPort,
  type CanvasRuntimeContentPort,
  type CanvasRuntimeReplicaPort
} from "../main/collaboration/CanvasRuntimeAvailabilityCoordinator.js";

function documentFixture(): CanvasReplicaDocument {
  const manifest = basicManifest({ includeSecondTask: true });
  return parseCanvasReplicaDocument({
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
      projectId: "project-authority",
      nodes: [
        { nodeId: "T-001", x: 10, y: 20 },
        { nodeId: "T-002", x: 30, y: 40 }
      ],
      updatedAt: "2026-08-02T00:00:00.000Z"
    }
  });
}

function scope(authorityId = "authority-a") {
  return {
    authorityId,
    localProjectId: "local-project",
    localCanvasId: "local-canvas",
    projectId: "project-authority",
    canvasId: "default",
    workspaceId: "workspace-authority"
  };
}

function install(store: CanvasReplicaStore, authorityId = "authority-a", revision = 3) {
  const document = documentFixture();
  const content = encodeCanvasReplicaDocument(document);
  const s = scope(authorityId);
  store.bind(s);
  store.installBaseline(s, {
    content,
    revision,
    contentDigest: content.canonicalDigest
  });
  store.setCanEdit(s, true);
  return { scope: s, document, content, revision, digest: content.canonicalDigest };
}

function layoutIntent(x: number, y: number, updatedAt: string): CanvasCommandIntent {
  return {
    kind: "update_layout",
    nodes: [
      { nodeId: "T-001", x, y },
      { nodeId: "T-002", x: 30, y: 40 }
    ],
    updatedAt
  };
}

describe("CanvasReplicaStore", () => {
  it("passes stopped Runtime state through the strict IPC contract into the shared graph", () => {
    const store = new CanvasReplicaStore(() => undefined);
    const f = install(store);
    const content = store.projection(f.scope)!.content;
    store.setRuntimeStatus(
      f.scope,
      canvasRuntimeStatusProjectionSchema.parse({
        schemaVersion: "canvas-runtime-status/v2",
        scope: {
          workspaceId: f.scope.workspaceId,
          projectId: f.scope.projectId,
          canvasId: f.scope.canvasId
        },
        packageFingerprint: content.packageFingerprint,
        capturedAt: "2026-09-05T00:00:00.000Z",
        tasks: content.tasks.map((task) => ({
          taskId: task.taskId,
          status: "ready",
          openFeedbackCount: 0
        })),
        blocks: content.tasks.flatMap((task) =>
          task.blocks.map((block) => ({
            ref: block.ref,
            status: block.ref === "T-001#B-001" ? "blocked" : "planned",
            stopped: block.ref === "T-001#B-001",
            completionReason: null,
            blockedReason: block.ref === "T-001#B-001" ? "Stopped." : null,
            divergenceReason: null,
            dispatchable: false
          }))
        )
      })
    );
    const projected = store.projection(f.scope)!;
    expect(projected.content.tasks[0]?.blocks[0]).toMatchObject({
      stopped: true,
      status: "blocked"
    });
    expect(projected.content.tasks[0]?.blockPreview[0]).toMatchObject({ stopped: true });
    expect(projected.content.tasks[0]?.exceptions).toEqual([]);
  });

  it("keeps the Runtime executor catalog while applying replica-owned canvas content", () => {
    const runtimeGraph: DesktopGraphViewModel = {
      projectId: "project-1",
      projectTitle: "Local title",
      graphVersion: "pgv-local",
      packageFingerprint: `pkg-${"a".repeat(64)}`,
      executorOptions: ["manual", "codex", "opencode", "claude-code", "pi", "grok"],
      packageExecutorNames: ["package-review"],
      executorProfileBindings: [
        { name: "codex", agentId: "codex", runnerKind: "cli" },
        { name: "package-review", agentId: null, runnerKind: null }
      ],
      agentTransport: "cli",
      autoRunPreflightExecutorHint: "codex",
      tasks: [],
      edges: [],
      sharedResourceGroups: [],
      diagnostics: [],
      dirtyPromptRefs: ["T-001#B-001"]
    };
    const replica: CollaborationCanvasReplicaProjection = {
      authorityId: "authority-1",
      localProjectId: "project-1",
      localCanvasId: "canvas-main",
      workspaceId: "workspace-1",
      projectId: "remote-project-1",
      canvasId: "canvas-main",
      revision: 2,
      contentDigest: "b".repeat(64),
      canEdit: true,
      optimisticOperationIds: [],
      rejections: [],
      content: {
        projectTitle: "Shared title",
        graphVersion: "pgv-shared",
        packageFingerprint: `pkg-${"c".repeat(64)}`,
        tasks: [],
        edges: [],
        sharedResourceGroups: [],
        diagnostics: [],
        layout: {
          version: "desktop-layout/v1",
          projectId: "project-1",
          nodes: [],
          updatedAt: "2026-08-05T00:00:00.000Z"
        },
        blockDependenciesByRef: {},
        taskOpenFeedbackCountByTaskId: {},
        blockPromptMarkdownByRef: {}
      }
    };

    const graph = canvasReplicaProjectionToDesktopGraph(replica, runtimeGraph);

    expect(graph).toMatchObject({
      projectTitle: "Shared title",
      graphVersion: "pgv-shared",
      executorOptions: ["manual", "codex", "opencode", "claude-code", "pi", "grok"],
      packageExecutorNames: ["package-review"],
      executorProfileBindings: runtimeGraph.executorProfileBindings,
      agentTransport: "cli",
      autoRunPreflightExecutorHint: null
    });
    expect(graph.dirtyPromptRefs).toEqual([]);
  });

  it("derives the executor catalog from a pathless Workspace replica", () => {
    const store = new CanvasReplicaStore(() => undefined);
    const installed = install(store);
    const localProjection = store.projection(installed.scope)!;
    const remoteProjection = {
      ...localProjection,
      bindingKind: "remote" as const,
      content: {
        ...localProjection.content,
        tasks: localProjection.content.tasks.map((task, index) =>
          index === 0
            ? {
                ...task,
                executor: "codex-acp",
                executorLabel: "codex-acp",
                blocks: task.blocks.map((block) => ({ ...block, executor: "codex-acp" })),
                blockPreview: task.blockPreview.map((block) => ({
                  ...block,
                  executor: "codex-acp"
                }))
              }
            : task
        )
      }
    };
    const graph = canvasReplicaProjectionToDesktopGraph(remoteProjection, null);

    expect(graph.executorOptions).toEqual(["codex-acp"]);
    expect(graph.packageExecutorNames).toEqual(["codex-acp"]);
  });

  it("publishes only committed content to the durable replica listener", () => {
    const committed: Array<{ revision: number; contentDigest: string }> = [];
    const store = new CanvasReplicaStore(
      () => undefined,
      (snapshot) =>
        committed.push({
          revision: snapshot.revision,
          contentDigest: snapshot.contentDigest
        })
    );
    const content = encodeCanvasReplicaDocument(documentFixture());
    store.bind(scope());
    store.installBaseline(scope(), {
      content,
      revision: 3,
      contentDigest: content.canonicalDigest
    });
    store.setCanEdit(scope(), true);

    store.enqueue(scope(), {
      operationId: "operation-pending",
      intent: {
        kind: "update_layout",
        nodes: [
          { nodeId: "T-001", x: 101, y: 202 },
          { nodeId: "T-002", x: 30, y: 40 }
        ],
        updatedAt: "2026-08-03T00:00:00.000Z"
      }
    });

    expect(committed).toEqual([{ revision: 3, contentDigest: content.canonicalDigest }]);
  });
  it("rejects malformed immutable snapshots before they become a replica baseline", () => {
    const published: CollaborationCanvasReplicaProjection[] = [];
    const store = new CanvasReplicaStore((projection) => published.push(projection));
    const s = scope();
    store.bind(s);
    expect(() =>
      store.replaceFromReconnect({
        scope: s,
        response: {
          type: "canvas.reconnect.snapshot",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: "workspace-authority",
            projectId: s.projectId,
            canvasId: s.canvasId
          },
          reason: "truncated_journal",
          afterRevision: 0,
          snapshot: {
            metadata: {
              schemaVersion: "canvas-snapshot/v2",
              scope: {
                workspaceId: "workspace-authority",
                projectId: s.projectId,
                canvasId: s.canvasId
              },
              revision: 0,
              contentDigest: "a".repeat(64),
              createdAt: "2026-08-02T00:00:00.000Z"
            },
            encoding: "content_version_ref",
            content: {
              versionId: "version-bad",
              canonicalDigest: "a".repeat(64),
              verification: "complete"
            }
          }
        },
        snapshotContent: {
          members: [],
          canonicalDigest: "a".repeat(64),
          totalBytes: 0
        }
      })
    ).toThrow();
    expect(store.projection(s)).toBeNull();
    expect(published).toHaveLength(0);
  });

  it("rejects cross-scope snapshot/delta without mutating the committed replica", () => {
    const published: CollaborationCanvasReplicaProjection[] = [];
    const store = new CanvasReplicaStore((projection) => published.push(projection));
    const installed = install(store);
    const before = store.projection(installed.scope)!;
    const countBefore = published.length;

    expect(() =>
      store.replaceFromReconnect({
        scope: installed.scope,
        response: {
          type: "canvas.reconnect.snapshot",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: "other-workspace",
            projectId: installed.scope.projectId,
            canvasId: installed.scope.canvasId
          },
          reason: "truncated_journal",
          afterRevision: 0,
          snapshot: {
            metadata: {
              schemaVersion: "canvas-snapshot/v2",
              scope: {
                workspaceId: "other-workspace",
                projectId: installed.scope.projectId,
                canvasId: installed.scope.canvasId
              },
              revision: 9,
              contentDigest: installed.digest,
              createdAt: "2026-08-02T00:00:00.000Z"
            },
            encoding: "content_version_ref",
            content: {
              versionId: "version-x",
              canonicalDigest: installed.digest,
              verification: "complete"
            }
          }
        },
        snapshotContent: installed.content
      })
    ).toThrow(/canvas_replica_scope_mismatch/);

    expect(store.revision(installed.scope)).toBe(installed.revision);
    expect(store.digest(installed.scope)).toBe(installed.digest);
    expect(store.projection(installed.scope)).toEqual(before);
    expect(published.length).toBe(countBefore);
  });

  it("publishes a single projection for one reconnect delta install", () => {
    const published: CollaborationCanvasReplicaProjection[] = [];
    const store = new CanvasReplicaStore((projection) => published.push(projection));
    const installed = install(store, "authority-a", 3);
    const intent = layoutIntent(99, 88, "2026-08-02T01:00:00.000Z");
    const nextDoc = applyCanvasReplicaIntent(installed.document, intent);
    const nextContent = encodeCanvasReplicaDocument(nextDoc);
    const entry: CanvasJournalEntry = {
      schemaVersion: "canvas-journal/v1",
      entryId: "journal-4",
      scope: {
        workspaceId: installed.scope.workspaceId,
        projectId: installed.scope.projectId,
        canvasId: installed.scope.canvasId
      },
      revision: 4,
      previousRevision: 3,
      operationId: "op-remote-1",
      intent,
      intentDigest: "c".repeat(64),
      contentDigest: nextContent.canonicalDigest,
      actor: { kind: "human", id: "human-2", displayName: "Peer" },
      acceptedAt: "2026-08-02T01:00:00.000Z"
    };
    const delta: CanvasReconnectResponse = {
      type: "canvas.reconnect.delta",
      protocolVersion: 1,
      schemaVersion: "canvas-command/v1",
      scope: entry.scope,
      afterRevision: 3,
      headRevision: 4,
      headContentDigest: nextContent.canonicalDigest,
      entries: [entry]
    };
    const countBefore = published.length;
    store.replaceFromReconnect({ scope: installed.scope, response: delta });
    expect(published.length - countBefore).toBe(1);
    expect(store.revision(installed.scope)).toBe(4);
    expect(store.digest(installed.scope)).toBe(nextContent.canonicalDigest);
  });

  it("does not reuse a replica when authority identity differs for the same remote canvas", () => {
    const store = new CanvasReplicaStore(() => undefined);
    const a = install(store, "authority-a", 5);
    const b = install(store, "authority-b", 0);
    expect(store.revision(a.scope)).toBe(5);
    expect(store.revision(b.scope)).toBe(0);
    expect(store.projection(a.scope)?.authorityId).toBe("authority-a");
    expect(store.projection(b.scope)?.authorityId).toBe("authority-b");
  });

  it("drops pending via reconnect rebase and reports them", () => {
    const store = new CanvasReplicaStore(() => undefined);
    const installed = install(store);
    // Valid against the current document, but fails after peer removes T-002.
    store.enqueue(installed.scope, {
      operationId: "op-bad",
      intent: {
        kind: "update_task_prompt",
        taskId: "T-002",
        promptMarkdown: "# local edit of second task\n"
      }
    });
    const intent: CanvasCommandIntent = { kind: "remove_task", taskId: "T-002" };
    const nextDoc = applyCanvasReplicaIntent(installed.document, intent);
    const nextContent = encodeCanvasReplicaDocument(nextDoc);
    const entry: CanvasJournalEntry = {
      schemaVersion: "canvas-journal/v1",
      entryId: "journal-4",
      scope: {
        workspaceId: installed.scope.workspaceId,
        projectId: installed.scope.projectId,
        canvasId: installed.scope.canvasId
      },
      revision: 4,
      previousRevision: 3,
      operationId: "op-remote",
      intent,
      intentDigest: "c".repeat(64),
      contentDigest: nextContent.canonicalDigest,
      actor: { kind: "human", id: "human-2", displayName: "Peer" },
      acceptedAt: "2026-08-02T03:00:00.000Z"
    };
    const { droppedPending } = store.replaceFromReconnect({
      scope: installed.scope,
      response: {
        type: "canvas.reconnect.delta",
        protocolVersion: 1,
        schemaVersion: "canvas-command/v1",
        scope: entry.scope,
        afterRevision: 3,
        headRevision: 4,
        headContentDigest: nextContent.canonicalDigest,
        entries: [entry]
      }
    });
    expect(droppedPending.map((item) => item.operationId)).toEqual(["op-bad"]);
    expect(store.pendingOperationIds(installed.scope)).toEqual([]);
  });

  it("projects layout, prompts, dependencies, and feedback fields for the renderer", () => {
    const store = new CanvasReplicaStore(() => undefined);
    const installed = install(store);
    const projection = store.projection(installed.scope)!;
    expect(projection.content.layout.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: "T-001", x: 10, y: 20 })])
    );
    expect(projection.content.tasks[0]?.promptMarkdown).toContain("T-001");
    expect(projection.content.blockPromptMarkdownByRef["T-001#B-001"]).toContain("B-001");
    expect(projection.content.blockDependenciesByRef["T-001#R-001"]).toEqual(["T-001#B-001"]);
    expect(projection.content.taskOpenFeedbackCountByTaskId["T-001"]).toBe(0);
    expect(projection.canEdit).toBe(true);
    expect(projection.revision).toBe(3);
  });

  it("does not leave a ghost pending when optimistic intent is semantically invalid", () => {
    const published: CollaborationCanvasReplicaProjection[] = [];
    const store = new CanvasReplicaStore((projection) => published.push(projection));
    const installed = install(store);
    const countBefore = published.length;
    expect(() =>
      store.enqueue(installed.scope, {
        operationId: "op-ghost",
        intent: {
          kind: "update_task_prompt",
          taskId: "T-MISSING",
          promptMarkdown: "# gone\n"
        }
      })
    ).toThrow(/canvas_replica_pending_invalid|task_missing/);
    expect(store.pendingOperationIds(installed.scope)).toEqual([]);
    expect(published.length).toBe(countBefore);
  });

  it("clears pending without re-applying when authority head already includes the operation", () => {
    const store = new CanvasReplicaStore(() => undefined);
    const installed = install(store, "authority-a", 4);
    store.enqueue(installed.scope, {
      operationId: "op-already",
      intent: layoutIntent(99, 88, "2026-08-02T13:00:00.000Z")
    });
    expect(store.pendingOperationIds(installed.scope)).toEqual(["op-already"]);

    // Idempotent accept at the current head (snapshot already absorbed the op).
    const { droppedPending } = store.accept(installed.scope, {
      type: "canvas.command.accepted",
      protocolVersion: 1,
      schemaVersion: "canvas-command/v1",
      scope: {
        workspaceId: installed.scope.workspaceId,
        projectId: installed.scope.projectId,
        canvasId: installed.scope.canvasId
      },
      operationId: "op-already",
      revision: installed.revision,
      previousRevision: installed.revision - 1,
      contentDigest: installed.digest,
      journalEntryId: "journal-idempotent",
      actor: { kind: "human", id: "human-1", displayName: "Editor" },
      acceptedAt: "2026-08-02T13:00:00.000Z",
      idempotentReplay: true
    });

    expect(droppedPending).toEqual([]);
    expect(store.pendingOperationIds(installed.scope)).toEqual([]);
    expect(store.revision(installed.scope)).toBe(installed.revision);
    expect(store.digest(installed.scope)).toBe(installed.digest);
  });
});

describe("CanvasRuntimeAvailabilityCoordinator", () => {
  const scope = {
    workspaceId: "workspace-1",
    projectId: "project-1",
    canvasId: "canvas-1"
  };
  const status = {
    schemaVersion: "canvas-runtime-status/v2" as const,
    scope,
    packageFingerprint: `pkg-${"a".repeat(64)}`,
    capturedAt: "2026-08-20T00:00:00.000Z",
    tasks: [],
    blocks: []
  };
  const available = {
    schemaVersion: "canvas-runtime-view/v1" as const,
    state: { kind: "initialized" as const, runtimeRevision: 1, status },
    execution: {
      schemaVersion: "canvas-runtime-availability/v1" as const,
      kind: "available" as const,
      status,
      sourceRevision: "src-revision-001",
      graphFingerprint: status.packageFingerprint
    }
  };

  function setup(
    initialAvailability: Awaited<
      ReturnType<CanvasRuntimeContentPort["readResolvedRuntimeAvailability"]>
    >,
    isOnline: () => boolean = () => true
  ) {
    const content: CanvasRuntimeContentPort = {
      resolveCanvasScope: vi.fn(async () => scope),
      readResolvedRuntimeAvailability: vi.fn(async () => initialAvailability),
      initializeRuntime: vi.fn(async () => ({
        type: "canvas.runtime.initialize.rejected" as const,
        operationId: "initialize-1",
        code: "host_offline" as const
      })),
      resetRuntime: vi.fn(async () => ({
        type: "canvas.runtime.reset.rejected" as const,
        operationId: "reset-1",
        code: "host_offline" as const
      }))
    };
    const commands: CanvasRuntimeCommandPort = { projectionForBinding: vi.fn(() => null) };
    const replicas: CanvasRuntimeReplicaPort = {
      has: vi.fn(() => true),
      setRuntimeStatus: vi.fn(),
      projection: vi.fn(() => null)
    };
    return {
      content,
      replicas,
      coordinator: new CanvasRuntimeAvailabilityCoordinator(
        isOnline,
        () => "authority-1",
        content,
        commands,
        replicas
      )
    };
  }

  it("writes only an available status into the exact resolved replica scope", async () => {
    const fixture = setup(available);

    await expect(
      fixture.coordinator.readRuntimeAvailability({
        kind: "remote",
        ...scope
      })
    ).resolves.toEqual(available);
    expect(fixture.replicas.setRuntimeStatus).toHaveBeenCalledWith(
      { authorityId: "authority-1", ...scope },
      status
    );
  });

  it("clears the resolved replica overlay for unavailable without synthesizing status", async () => {
    const unavailable = {
      schemaVersion: "canvas-runtime-view/v1" as const,
      state: { kind: "uninitialized" as const },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1" as const,
        kind: "unavailable" as const,
        reason: "host_offline" as const,
        hostId: "host-1",
        lastSeenAt: "2026-08-20T00:00:00.000Z"
      }
    };
    const fixture = setup(unavailable);

    await expect(
      fixture.coordinator.readRuntimeAvailability({
        kind: "remote",
        ...scope
      })
    ).resolves.toEqual(unavailable);
    expect(fixture.replicas.setRuntimeStatus).toHaveBeenCalledWith(
      { authorityId: "authority-1", ...scope },
      null
    );
  });

  it("fails closed and clears a completed overlay when the client disconnects during the read", async () => {
    let online = true;
    let resolveAvailability!: (value: typeof available) => void;
    const fixture = setup(available, () => online);
    vi.mocked(fixture.content.readResolvedRuntimeAvailability).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAvailability = resolve;
        })
    );

    const pending = fixture.coordinator.readRuntimeAvailability({
      kind: "remote",
      ...scope
    });
    await vi.waitFor(() => {
      expect(fixture.content.readResolvedRuntimeAvailability).toHaveBeenCalledTimes(1);
    });
    online = false;
    resolveAvailability(available);

    await expect(pending).resolves.toBeNull();
    expect(fixture.replicas.setRuntimeStatus).toHaveBeenCalledWith(
      { authorityId: "authority-1", ...scope },
      null
    );
  });

  it("does not begin an availability read after disconnecting during scope resolution", async () => {
    let online = true;
    let resolveScope!: (value: typeof scope) => void;
    const fixture = setup(available, () => online);
    vi.mocked(fixture.content.resolveCanvasScope).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScope = resolve;
        })
    );

    const pending = fixture.coordinator.readRuntimeAvailability({
      kind: "remote",
      ...scope
    });
    online = false;
    resolveScope(scope);

    await expect(pending).resolves.toBeNull();
    expect(fixture.content.readResolvedRuntimeAvailability).not.toHaveBeenCalled();
    expect(fixture.replicas.setRuntimeStatus).toHaveBeenCalledWith(
      { authorityId: "authority-1", ...scope },
      null
    );
  });

  it("rejects Local Canvas before resolving or reading collaboration runtime", async () => {
    const fixture = setup(available);

    await expect(
      fixture.coordinator.readRuntimeAvailability({
        kind: "local",
        localProjectId: "local-project",
        canvasId: "default"
      })
    ).rejects.toMatchObject({ code: "workspace_canvas_remote_binding_required" });
    expect(fixture.content.resolveCanvasScope).not.toHaveBeenCalled();
    expect(fixture.content.readResolvedRuntimeAvailability).not.toHaveBeenCalled();
  });

  it("returns reset success from the accepted Server projection without a follow-up availability read", async () => {
    const refreshed = { ...available, state: { ...available.state, runtimeRevision: 2 } };
    const fixture = setup(refreshed);
    vi.mocked(fixture.content.resetRuntime).mockResolvedValue({
      type: "canvas.runtime.reset.accepted",
      operationId: "reset-1",
      runtimeRevision: 2,
      sourceRevision: `snapshot:${"b".repeat(64)}`,
      graphFingerprint: status.packageFingerprint,
      status
    });

    await expect(
      fixture.coordinator.resetRuntime({
        locator: {
          kind: "workspace",
          connectionProfileId: "profile-1",
          ...scope
        },
        operationId: "reset-1",
        expectedSourceRevision: `snapshot:${"b".repeat(64)}`,
        expectedGraphFingerprint: status.packageFingerprint
      })
    ).resolves.toMatchObject({
      type: "canvas.runtime.reset.accepted",
      runtimeRevision: 2
    });
    expect(fixture.content.resetRuntime).toHaveBeenCalledWith(
      { kind: "remote", ...scope },
      expect.objectContaining({ operationId: "reset-1" })
    );
    expect(fixture.content.readResolvedRuntimeAvailability).not.toHaveBeenCalled();
    expect(fixture.replicas.setRuntimeStatus).toHaveBeenCalledWith(
      { authorityId: "authority-1", ...scope },
      status
    );
  });

  it("initializes through the distinct command and publishes only its authoritative projection", async () => {
    const initialized = { ...available, state: { ...available.state, runtimeRevision: 1 } };
    const fixture = setup(initialized);
    vi.mocked(fixture.content.initializeRuntime).mockResolvedValue({
      type: "canvas.runtime.initialize.accepted",
      operationId: "initialize-1",
      runtimeRevision: 1,
      sourceRevision: `snapshot:${"b".repeat(64)}`,
      graphFingerprint: status.packageFingerprint,
      status
    });

    await expect(
      fixture.coordinator.initializeRuntime({
        locator: {
          kind: "workspace",
          connectionProfileId: "profile-1",
          ...scope
        },
        operationId: "initialize-1",
        expectedSourceRevision: `snapshot:${"b".repeat(64)}`,
        expectedGraphFingerprint: status.packageFingerprint
      })
    ).resolves.toMatchObject({
      type: "canvas.runtime.initialize.accepted",
      runtimeRevision: 1
    });
    expect(fixture.content.initializeRuntime).toHaveBeenCalledWith(
      { kind: "remote", ...scope },
      expect.objectContaining({ operationId: "initialize-1" })
    );
    expect(fixture.content.resetRuntime).not.toHaveBeenCalled();
    expect(fixture.content.readResolvedRuntimeAvailability).not.toHaveBeenCalled();
    expect(fixture.replicas.setRuntimeStatus).toHaveBeenCalledWith(
      { authorityId: "authority-1", ...scope },
      status
    );
  });

  it.each([
    {
      type: "canvas.runtime.reset.accepted" as const,
      operationId: "wrong-operation",
      runtimeRevision: 2,
      sourceRevision: `snapshot:${"b".repeat(64)}`,
      graphFingerprint: status.packageFingerprint,
      status
    },
    {
      type: "canvas.runtime.reset.rejected" as const,
      operationId: "wrong-operation",
      code: "active_lease" as const
    },
    {
      type: "canvas.runtime.reset.rejected" as const,
      operationId: "wrong-operation",
      code: "unavailable" as const
    }
  ])("rejects mismatched reset response operation IDs at the Main boundary", async (outcome) => {
    const fixture = setup(available);
    vi.mocked(fixture.content.resetRuntime).mockResolvedValue(outcome);
    await expect(
      fixture.coordinator.resetRuntime({
        locator: { kind: "workspace", connectionProfileId: "profile-1", ...scope },
        operationId: "reset-1",
        expectedSourceRevision: `snapshot:${"b".repeat(64)}`,
        expectedGraphFingerprint: status.packageFingerprint
      })
    ).rejects.toMatchObject({ code: "runtime_reset_operation_id_mismatch" });
  });
});
