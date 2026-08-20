import { describe, expect, it, vi } from "vitest";
import type {
  CanvasCommandIntent,
  CanvasCommandOutcome,
  CanvasJournalEntry,
  CanvasReconnectResponse
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import { CANVAS_LIVE_SYNC_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  applyCanvasReplicaIntent,
  encodeCanvasReplicaDocument,
  parseCanvasReplicaDocument,
  type CanvasReplicaDocument
} from "@planweave-ai/runtime";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  CanvasReplicaCommandWorker,
  type CanvasReplicaCommandTransport
} from "../main/collaboration/CanvasReplicaCommandWorker.js";
import { CollaborationCanvasCommandFacade } from "../main/collaboration/collaborationCanvasCommands.js";
import { CanvasLiveSyncClient } from "../main/collaboration/CanvasLiveSyncClient.js";
import type { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import {
  CanvasReplicaStore,
  type CanvasReplicaScope
} from "../main/collaboration/CanvasReplicaStore.js";
import type { CollaborationCanvasReplicaProjection } from "../shared/canvasReplicaIpc.js";

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

const baseScope: CanvasReplicaScope = {
  authorityId: "authority-a",
  localProjectId: "local-project",
  localCanvasId: "local-canvas",
  projectId: "project-authority",
  canvasId: "default",
  workspaceId: "workspace-authority"
};

function layoutIntent(x: number, updatedAt: string): CanvasCommandIntent {
  return {
    kind: "update_layout",
    nodes: [
      { nodeId: "T-001", x, y: 20 },
      { nodeId: "T-002", x: 30, y: 40 }
    ],
    updatedAt
  };
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
      workspaceId: baseScope.workspaceId,
      projectId: baseScope.projectId,
      canvasId: baseScope.canvasId
    },
    reason: "truncated_journal",
    afterRevision: 0,
    snapshot: {
      metadata: {
        schemaVersion: "canvas-snapshot/v2",
        scope: {
          workspaceId: baseScope.workspaceId,
          projectId: baseScope.projectId,
          canvasId: baseScope.canvasId
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

function journalEntry(input: {
  revision: number;
  previousRevision: number;
  operationId: string;
  intent: CanvasCommandIntent;
  contentDigest: string;
}): CanvasJournalEntry {
  return {
    schemaVersion: "canvas-journal/v1",
    entryId: `journal-${input.revision}`,
    scope: {
      workspaceId: baseScope.workspaceId,
      projectId: baseScope.projectId,
      canvasId: baseScope.canvasId
    },
    revision: input.revision,
    previousRevision: input.previousRevision,
    operationId: input.operationId,
    intent: input.intent,
    intentDigest: "c".repeat(64),
    contentDigest: input.contentDigest,
    actor: { kind: "human", id: "human-peer", displayName: "Peer" },
    acceptedAt: "2026-08-02T12:00:00.000Z"
  };
}

async function bindWorker(options?: {
  canEdit?: boolean;
  onPublish?: (p: CollaborationCanvasReplicaProjection) => void;
}) {
  const document = documentFixture();
  let committedDoc = document;
  let commandRevision = 1;
  let content = encodeCanvasReplicaDocument(committedDoc);
  const published: CollaborationCanvasReplicaProjection[] = [];
  const store = new CanvasReplicaStore((projection) => {
    published.push(projection);
    options?.onPublish?.(projection);
  });
  const transport: CanvasReplicaCommandTransport = {
    async fetchReconnectBaseline() {
      return { response: snapshotResponse(content, commandRevision), content };
    },
    async reconnect(_scope, input) {
      return {
        response: {
          type: "canvas.reconnect.delta",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          afterRevision: input.afterRevision,
          headRevision: commandRevision,
          headContentDigest: content.canonicalDigest,
          entries: []
        }
      };
    },
    async canPersistCanvasCommand() {
      return options?.canEdit ?? true;
    },
    async submit(input) {
      const nextDoc = applyCanvasReplicaIntent(committedDoc, input.intent);
      const nextContent = encodeCanvasReplicaDocument(nextDoc);
      committedDoc = nextDoc;
      content = nextContent;
      commandRevision += 1;
      const outcome: CanvasCommandOutcome = {
        type: "canvas.command.accepted",
        protocolVersion: 1,
        schemaVersion: "canvas-command/v1",
        scope: {
          workspaceId: baseScope.workspaceId,
          projectId: baseScope.projectId,
          canvasId: baseScope.canvasId
        },
        operationId: input.operationId,
        revision: commandRevision,
        previousRevision: commandRevision - 1,
        contentDigest: nextContent.canonicalDigest,
        journalEntryId: `journal-${commandRevision}`,
        actor: { kind: "human", id: "human-self", displayName: "Self" },
        acceptedAt: "2026-08-02T12:00:00.000Z",
        idempotentReplay: false
      };
      return outcome;
    }
  };
  const worker = new CanvasReplicaCommandWorker(store, transport, {
    random: () => 0,
    backoff: { initialDelayMs: 1, maxDelayMs: 1 },
    sleep: async () => undefined
  });
  await worker.bind(baseScope);
  return {
    worker,
    store,
    published,
    getCommitted: () => ({ doc: committedDoc, revision: commandRevision, content }),
    setCommitted: (doc: CanvasReplicaDocument, revision: number) => {
      committedDoc = doc;
      commandRevision = revision;
      content = encodeCanvasReplicaDocument(doc);
    },
    advanceRemote: (intent: CanvasCommandIntent, operationId: string) => {
      const nextDoc = applyCanvasReplicaIntent(committedDoc, intent);
      const nextContent = encodeCanvasReplicaDocument(nextDoc);
      const previousRevision = commandRevision;
      committedDoc = nextDoc;
      content = nextContent;
      commandRevision += 1;
      return journalEntry({
        revision: commandRevision,
        previousRevision,
        operationId,
        intent,
        contentDigest: nextContent.canonicalDigest
      });
    },
    transport
  };
}

describe("Canvas replica live broadcast (Phase 5B)", () => {
  it("applies a remote accepted move_node/update_layout into the local projection without reload", async () => {
    const harness = await bindWorker();
    const entry = harness.advanceRemote(
      layoutIntent(99, "2026-08-02T12:01:00.000Z"),
      "op-remote-move"
    );
    await harness.worker.applyLiveEntry(baseScope, entry);
    expect(harness.store.revision(baseScope)).toBe(2);
    expect(harness.store.projection(baseScope)?.content.layout.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: "T-001", x: 99 })])
    );
  });

  it("keeps A pending while applying B's committed operation to the projection", async () => {
    const document = documentFixture();
    let committedDoc = document;
    let commandRevision = 1;
    let content = encodeCanvasReplicaDocument(committedDoc);
    const published: CollaborationCanvasReplicaProjection[] = [];
    const store = new CanvasReplicaStore((projection) => published.push(projection));
    let holdSubmit: Promise<void> = Promise.resolve();
    let releaseSubmit!: () => void;
    holdSubmit = new Promise((r) => {
      releaseSubmit = r;
    });
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, commandRevision), content };
      },
      async reconnect() {
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: {
              workspaceId: baseScope.workspaceId,
              projectId: baseScope.projectId,
              canvasId: baseScope.canvasId
            },
            afterRevision: commandRevision,
            headRevision: commandRevision,
            headContentDigest: content.canonicalDigest,
            entries: []
          }
        };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        await holdSubmit;
        const nextDoc = applyCanvasReplicaIntent(committedDoc, input.intent);
        const nextContent = encodeCanvasReplicaDocument(nextDoc);
        committedDoc = nextDoc;
        content = nextContent;
        commandRevision += 1;
        return {
          type: "canvas.command.accepted",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          operationId: input.operationId,
          revision: commandRevision,
          previousRevision: commandRevision - 1,
          contentDigest: nextContent.canonicalDigest,
          journalEntryId: `journal-${commandRevision}`,
          actor: { kind: "human", id: "human-self", displayName: "Self" },
          acceptedAt: "2026-08-02T12:00:00.000Z",
          idempotentReplay: false
        };
      }
    };
    const worker = new CanvasReplicaCommandWorker(store, transport, {
      random: () => 0,
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => undefined
    });
    await worker.bind(baseScope);

    const pendingA = worker.submit(baseScope, layoutIntent(50, "2026-08-02T12:02:00.000Z"));
    expect(store.pendingOperationIds(baseScope)).toHaveLength(1);

    // Peer B advances authority from revision 1 → 2 while A is still pending.
    const peerIntent = layoutIntent(77, "2026-08-02T12:02:30.000Z");
    const peerDoc = applyCanvasReplicaIntent(documentFixture(), peerIntent);
    // Peer applies on original baseline (revision 1 head), not on A's optimistic state.
    const peerContent = encodeCanvasReplicaDocument(peerDoc);
    const peerEntry = journalEntry({
      revision: 2,
      previousRevision: 1,
      operationId: "op-peer-b",
      intent: peerIntent,
      contentDigest: peerContent.canonicalDigest
    });
    // Server head after B (A not yet accepted):
    committedDoc = peerDoc;
    content = peerContent;
    commandRevision = 2;

    await worker.applyLiveEntry(baseScope, peerEntry);

    expect(store.revision(baseScope)).toBe(2);
    expect(store.pendingOperationIds(baseScope)).toHaveLength(1);
    // Projection = committed(B) + pending(A)
    expect(store.projection(baseScope)?.content.layout.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: "T-001", x: 50 })])
    );
    // Committed digest matches B only.
    expect(store.digest(baseScope)).toBe(peerContent.canonicalDigest);

    releaseSubmit();
    await pendingA;
    expect(store.pendingOperationIds(baseScope)).toEqual([]);
    expect(store.revision(baseScope)).toBe(3);
  });

  it("confirms a self operationId broadcast at most once without double-fold", async () => {
    const harness = await bindWorker();
    const intent = layoutIntent(11, "2026-08-02T12:03:00.000Z");
    let held = true;
    const original = harness.transport.submit.bind(harness.transport);
    harness.transport.submit = async (input) => {
      while (held) await new Promise((r) => setTimeout(r, 5));
      return original(input);
    };
    const pending = harness.worker.submit(baseScope, intent);
    await vi.waitFor(() => expect(harness.store.pendingOperationIds(baseScope)).toHaveLength(1));
    const operationId = harness.store.pendingOperationIds(baseScope)[0]!;
    const nextDoc = applyCanvasReplicaIntent(documentFixture(), intent);
    const nextContent = encodeCanvasReplicaDocument(nextDoc);
    const entry = journalEntry({
      revision: 2,
      previousRevision: 1,
      operationId,
      intent,
      contentDigest: nextContent.canonicalDigest
    });
    await harness.worker.applyLiveEntry(baseScope, entry);
    expect(harness.store.revision(baseScope)).toBe(2);
    expect(harness.store.pendingOperationIds(baseScope)).toEqual([]);

    // Duplicate live event is a no-op.
    const digestsBefore = harness.published.map((p) => p.contentDigest);
    await harness.worker.applyLiveEntry(baseScope, entry);
    expect(harness.store.revision(baseScope)).toBe(2);
    expect(harness.published.map((p) => p.contentDigest).length).toBe(digestsBefore.length);

    held = false;
    const outcome = await pending;
    expect(outcome.type).toBe("canvas.command.accepted");
    expect(outcome.operationId).toBe(operationId);
    expect(harness.store.revision(baseScope)).toBe(2);
  });

  it("triggers reconnect on revision gap and does not publish a partial head", async () => {
    const harness = await bindWorker();
    const baselineDigest = harness.store.digest(baseScope)!;
    const publishes: string[] = [];
    const storeSpy = harness.store;
    const originalPublishCount = harness.published.length;

    const gapEntry = journalEntry({
      revision: 3,
      previousRevision: 2,
      operationId: "op-gap",
      intent: layoutIntent(1, "2026-08-02T12:04:00.000Z"),
      contentDigest: "a".repeat(64)
    });

    // Snapshot at revision 3 with distinct content from the baseline.
    const snapDoc = applyCanvasReplicaIntent(
      documentFixture(),
      layoutIntent(333, "2026-08-02T12:04:00.000Z")
    );
    const snapContent = encodeCanvasReplicaDocument(snapDoc);
    harness.transport.reconnect = async (_scope, input) => {
      if (input.afterRevision === 0) {
        return {
          response: snapshotResponse(snapContent, 3),
          snapshotContent: snapContent
        };
      }
      // Delta path fails materialization so installReconnect upgrades to snapshot.
      return {
        response: {
          type: "canvas.reconnect.delta",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          afterRevision: 1,
          headRevision: 3,
          headContentDigest: "d".repeat(64),
          entries: [gapEntry]
        }
      };
    };

    await harness.worker.applyLiveEntry(baseScope, gapEntry);
    // Never published the unmaterializable gap digest as committed head.
    expect(harness.published.some((p) => p.contentDigest === "a".repeat(64))).toBe(false);
    expect(storeSpy.revision(baseScope)).toBe(3);
    expect(storeSpy.digest(baseScope)).toBe(snapContent.canonicalDigest);
    expect(storeSpy.digest(baseScope)).not.toBe(baselineDigest);
    void originalPublishCount;
    void publishes;
  });

  it("ignores late live entries after clear/rebind generation change", async () => {
    const harness = await bindWorker();
    const entry = harness.advanceRemote(layoutIntent(3, "2026-08-02T12:05:00.000Z"), "op-late");
    harness.worker.clear(baseScope);
    await harness.worker.applyLiveEntry(baseScope, entry);
    expect(harness.store.projection(baseScope)).toBeNull();
  });

  it("denies viewer submit while still applying remote live entries", async () => {
    const harness = await bindWorker({ canEdit: false });
    await expect(
      harness.worker.submit(baseScope, layoutIntent(1, "2026-08-02T12:06:00.000Z"))
    ).rejects.toMatchObject({ code: "canvas_replica_command_forbidden" });

    const entry = harness.advanceRemote(
      layoutIntent(8, "2026-08-02T12:06:01.000Z"),
      "op-viewer-sees"
    );
    const result = await harness.worker.applyLiveEntry(baseScope, entry);
    expect(result).toMatchObject({
      entryApplied: true,
      materializedHead: { revision: 2 }
    });
    expect(harness.store.revision(baseScope)).toBe(2);
    expect(harness.store.projection(baseScope)?.content.layout.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: "T-001", x: 8 })])
    );
  });

  it("returns recovered materialized head for cursor jump without entry confirmation", async () => {
    const harness = await bindWorker();
    const gapEntry = journalEntry({
      revision: 5,
      previousRevision: 4,
      operationId: "op-gap-no-ack",
      intent: layoutIntent(1, "2026-08-02T12:07:00.000Z"),
      contentDigest: "e".repeat(64)
    });
    const snapDoc = applyCanvasReplicaIntent(
      documentFixture(),
      layoutIntent(9, "2026-08-02T12:07:00.000Z")
    );
    const snapContent = encodeCanvasReplicaDocument(snapDoc);
    harness.transport.reconnect = async (_scope, input) => {
      if (input.afterRevision === 0) {
        return { response: snapshotResponse(snapContent, 5), snapshotContent: snapContent };
      }
      return {
        response: {
          type: "canvas.reconnect.delta",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          afterRevision: 1,
          headRevision: 5,
          headContentDigest: "e".repeat(64),
          entries: [gapEntry]
        }
      };
    };
    const result = await harness.worker.applyLiveEntry(baseScope, gapEntry);
    // Recovery installed a snapshot: entry not confirmed, but head is materialised for cursor.
    expect(result.entryApplied).toBe(false);
    expect(result.reason).toBe("recovered");
    expect(result.materializedHead?.revision).toBe(5);
    expect(harness.store.revision(baseScope)).toBe(5);
  });

  it("real facade recovery advances live cursor from revision 1 to materialized head 5", async () => {
    // Production path: CollaborationCanvasCommandFacade.startLiveSubscription →
    // worker.applyLiveEntry (gap) → recovered head → acknowledgeLiveSyncMaterializedHead.
    // Must instantiate the real facade — hand-copied branch tables would pass even if wiring is wrong.
    type SocketListener = (event: unknown) => void;
    class MiniSocket {
      static instances: MiniSocket[] = [];
      readyState = 0;
      sent: string[] = [];
      listeners = new Map<string, SocketListener[]>();
      constructor(
        public url: string,
        public options?: { headers?: Record<string, string> }
      ) {
        MiniSocket.instances.push(this);
      }
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 3;
        for (const listener of this.listeners.get("close") ?? []) listener({ code: 1000 });
      }
      addEventListener(type: string, listener: SocketListener) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      removeEventListener(type: string, listener: SocketListener) {
        this.listeners.set(
          type,
          (this.listeners.get(type) ?? []).filter((entry) => entry !== listener)
        );
      }
      emit(type: string, event: unknown = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    MiniSocket.instances = [];

    const baselineDoc = documentFixture();
    const baselineContent = encodeCanvasReplicaDocument(baselineDoc);
    const snapDoc = applyCanvasReplicaIntent(
      baselineDoc,
      layoutIntent(9, "2026-08-02T12:07:00.000Z")
    );
    const snapContent = encodeCanvasReplicaDocument(snapDoc);
    const store = new CanvasReplicaStore(() => undefined);
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(baselineContent, 1), content: baselineContent };
      },
      async reconnect(_scope, input) {
        if (input.afterRevision === 0) {
          return {
            response: snapshotResponse(snapContent, 5),
            snapshotContent: snapContent
          };
        }
        // Gap delta cannot materialize — installReconnect upgrades to snapshot head 5.
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: {
              workspaceId: baseScope.workspaceId,
              projectId: baseScope.projectId,
              canvasId: baseScope.canvasId
            },
            afterRevision: input.afterRevision,
            headRevision: 5,
            headContentDigest: "e".repeat(64),
            entries: [
              journalEntry({
                revision: 5,
                previousRevision: 4,
                operationId: "op-gap-facade",
                intent: layoutIntent(1, "2026-08-02T12:07:00.000Z"),
                contentDigest: "e".repeat(64)
              })
            ]
          }
        };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit() {
        throw new Error("unexpected submit");
      }
    };

    const clock = {
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      setTimeout: (cb: () => void) => {
        cb();
        return cb;
      },
      clearTimeout: () => undefined
    };
    const liveSync = new CanvasLiveSyncClient({
      profile: {
        profileId: "p",
        displayName: "d",
        serverBaseUrl: "https://example.com/",
        projectId: baseScope.projectId,
        allowInsecureTransport: false
      },
      credential: {
        getDeviceToken: () => "pw_hdev_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq"
      },
      WebSocketImpl: MiniSocket as never,
      clock,
      random: () => 0,
      reconnectInitialDelayMs: 1,
      reconnectMaxDelayMs: 1
    });

    const remoteSession = {
      canvasId: baseScope.canvasId,
      revision: 1,
      contentDigest: baselineContent.canonicalDigest,
      lastOperationId: null,
      lastJournalEntryId: null,
      pendingOperationId: null,
      lastConflict: null,
      lastRejectCode: null
    };
    const client = {
      projectId: baseScope.projectId,
      connectionProfile: {
        profileId: "p",
        serverBaseUrl: "https://example.com/",
        projectId: baseScope.projectId,
        allowInsecureTransport: false
      },
      submitCanvasCommand: vi.fn(),
      reconnectCanvasCommands: vi.fn(),
      fetchContentVersion: vi.fn(),
      bindCanvasCommandSession: vi.fn(),
      clearCanvasCommandSession: vi.fn(),
      canvasCommandSession: vi.fn(() => remoteSession),
      getCurrentCanvasAccess: vi.fn(async () => null),
      startLiveSync: (canvasId: string, lastRevision: number, handlers?: unknown) => {
        liveSync.start(canvasId, lastRevision, handlers as never);
      },
      stopLiveSync: () => liveSync.stop(),
      subscribeLiveSync: (handlers: {
        onMessage?: (message: unknown) => void;
        onStatus?: (status: unknown) => void;
      }) => liveSync.subscribe(handlers as never),
      acknowledgeLiveSyncRevision: (revision: number) => {
        liveSync.acknowledgeAppliedRevision(revision);
      },
      acknowledgeLiveSyncMaterializedHead: (revision: number) => {
        liveSync.acknowledgeMaterializedHead(revision);
      },
      reportLiveSyncCatchupRecovering: vi.fn()
    } as unknown as CollaborationClient;

    const facade = new CollaborationCanvasCommandFacade({
      resolveClient: () => client,
      resolveCanvasBinding: async () => ({
        kind: "local" as const,
        localProjectId: baseScope.localProjectId,
        canvasId: baseScope.localCanvasId,
        remoteProjectId: baseScope.projectId,
        remoteCanvasId: baseScope.canvasId
      }),
      resolveCanvasScope: async () => ({
        workspaceId: baseScope.workspaceId,
        projectId: baseScope.projectId,
        canvasId: baseScope.canvasId
      }),
      resolveAuthorityId: () => baseScope.authorityId,
      store,
      transport
    });

    await facade.bind({
      kind: "local",
      localProjectId: baseScope.localProjectId,
      canvasId: baseScope.localCanvasId
    });
    // Yield so CanvasLiveSyncClient async connect creates the socket.
    await Promise.resolve();
    await Promise.resolve();
    expect(liveSync.helloRevision()).toBe(1);
    expect(
      store.revision({
        authorityId: baseScope.authorityId,
        workspaceId: baseScope.workspaceId,
        projectId: baseScope.projectId,
        canvasId: baseScope.canvasId
      })
    ).toBe(1);

    const socket = MiniSocket.instances[0];
    expect(socket).toBeDefined();
    socket.emit("open");
    // Live frame with a revision gap (1 → 5): facade must recover via HTTP then jump the cursor.
    socket.emit("message", {
      data: JSON.stringify({
        type: "canvas.live.accepted_entry",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        entry: journalEntry({
          revision: 5,
          previousRevision: 4,
          operationId: "op-gap-facade",
          intent: layoutIntent(1, "2026-08-02T12:07:00.000Z"),
          contentDigest: "e".repeat(64)
        })
      })
    });

    await vi.waitFor(() => {
      expect(liveSync.helloRevision()).toBe(5);
    });
    expect(
      store.revision({
        authorityId: baseScope.authorityId,
        workspaceId: baseScope.workspaceId,
        projectId: baseScope.projectId,
        canvasId: baseScope.canvasId
      })
    ).toBe(5);
    // Strict +1 would have ignored 1 → 5; only materialized-head ack advances here.
    facade.clearAllSessions();
  });

  it("rejects a stale reconnect snapshot that would roll the head backwards", async () => {
    const harness = await bindWorker();
    const first = harness.advanceRemote(layoutIntent(2, "2026-08-02T12:08:00.000Z"), "op-1");
    await harness.worker.applyLiveEntry(baseScope, first);
    expect(harness.store.revision(baseScope)).toBe(2);

    const staleContent = encodeCanvasReplicaDocument(documentFixture());
    expect(() =>
      harness.store.replaceFromReconnect({
        scope: baseScope,
        response: snapshotResponse(staleContent, 1),
        snapshotContent: staleContent
      })
    ).toThrow(/canvas_replica_reconnect_stale_snapshot/);
    expect(harness.store.revision(baseScope)).toBe(2);
  });
});
