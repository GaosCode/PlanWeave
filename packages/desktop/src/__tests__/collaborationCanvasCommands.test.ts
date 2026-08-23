import { describe, expect, it, vi } from "vitest";
import type {
  CanvasCommandOutcome,
  CanvasReconnectResponse
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import type { CanvasLiveSyncHandlers } from "../main/collaboration/CanvasLiveSyncClient.js";
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
import { CanvasReplicaStore } from "../main/collaboration/CanvasReplicaStore.js";
import type { CanvasReplicaCommandTransport } from "../main/collaboration/CanvasReplicaCommandWorker.js";

const remoteBinding = {
  kind: "remote" as const,
  workspaceId: "workspace-001",
  projectId: "remote-project",
  canvasId: "remote-canvas"
};
const replicaScope = {
  authorityId: "authority-1",
  workspaceId: remoteBinding.workspaceId,
  projectId: remoteBinding.projectId,
  canvasId: remoteBinding.canvasId
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
        projectId: remoteBinding.projectId,
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
    scope: remoteBinding,
    reason: "truncated_journal",
    afterRevision: 0,
    snapshot: {
      metadata: {
        schemaVersion: "canvas-snapshot/v2",
        scope: remoteBinding,
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

function makeClient() {
  let handlers: CanvasLiveSyncHandlers | null = null;
  const session = {
    canvasId: remoteBinding.canvasId,
    revision: 1,
    contentDigest: "a".repeat(64),
    lastOperationId: null,
    lastJournalEntryId: null,
    pendingOperationId: null,
    lastConflict: null,
    lastRejectCode: null
  };
  const client = {
    projectId: remoteBinding.projectId,
    connectionProfile: {
      profileId: "profile-1",
      serverBaseUrl: "http://127.0.0.1:1/",
      projectId: remoteBinding.projectId,
      allowInsecureTransport: true
    },
    bindCanvasCommandSession: vi.fn(),
    clearCanvasCommandSession: vi.fn(),
    canvasCommandSession: vi.fn(() => session),
    startLiveSync: vi.fn(),
    stopLiveSync: vi.fn(),
    subscribeLiveSync: vi.fn((next: CanvasLiveSyncHandlers) => {
      handlers = next;
      return vi.fn();
    }),
    acknowledgeLiveSyncRevision: vi.fn(),
    acknowledgeLiveSyncMaterializedHead: vi.fn(),
    reportLiveSyncCatchupRecovering: vi.fn()
  } as unknown as CollaborationClient;
  return { client, handlers: () => handlers };
}

function createFacade(input?: {
  store?: CanvasReplicaStore;
  transport?: CanvasReplicaCommandTransport;
  snapshotCache?: { flush(): Promise<void> };
}) {
  const content = fixtureContent();
  const store = input?.store ?? new CanvasReplicaStore(() => undefined);
  const transport: CanvasReplicaCommandTransport = input?.transport ?? {
    async fetchReconnectBaseline() {
      return { response: snapshotResponse(content, 1), content };
    },
    async reconnect(_scope, reconnectInput) {
      return {
        response: {
          type: "canvas.reconnect.delta",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: remoteBinding,
          afterRevision: reconnectInput.afterRevision,
          headRevision: reconnectInput.afterRevision,
          headContentDigest: content.canonicalDigest,
          entries: []
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
  const clientFixture = makeClient();
  const resolveCanvasBinding = vi.fn(async () => ({
    ...remoteBinding,
    remoteProjectId: remoteBinding.projectId,
    remoteCanvasId: remoteBinding.canvasId
  }));
  const facade = new CollaborationCanvasCommandFacade({
    resolveClient: () => clientFixture.client,
    resolveCanvasBinding,
    resolveAuthorityId: () => replicaScope.authorityId,
    store,
    transport,
    snapshotCache: input?.snapshotCache
  });
  return { facade, store, content, resolveCanvasBinding, ...clientFixture };
}

describe("CollaborationCanvasCommandFacade", () => {
  it("binds a remote projection and submits without local materialization", async () => {
    let content = fixtureContent();
    const snapshotCache = { flush: vi.fn(async () => undefined) };
    const submitCalls: Array<{ operationId: string; expectedRevision: number }> = [];
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, 7), content };
      },
      async reconnect(_scope, reconnectInput) {
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: remoteBinding,
            afterRevision: reconnectInput.afterRevision,
            headRevision: reconnectInput.afterRevision,
            headContentDigest: content.canonicalDigest,
            entries: []
          }
        };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        submitCalls.push({
          operationId: input.operationId,
          expectedRevision: input.expectedRevision
        });
        content = encodeCanvasReplicaDocument(
          applyCanvasReplicaIntent(decodeCanvasReplicaDocument(content), input.intent)
        );
        const outcome: CanvasCommandOutcome = {
          type: "canvas.command.accepted",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: remoteBinding,
          operationId: input.operationId,
          revision: input.expectedRevision + 1,
          previousRevision: input.expectedRevision,
          contentDigest: content.canonicalDigest,
          journalEntryId: "journal-8",
          actor: { kind: "human", id: "human-1", displayName: "Owner" },
          acceptedAt: "2026-08-02T00:00:00.000Z",
          idempotentReplay: false
        };
        return outcome;
      }
    };
    const fixture = createFacade({ transport, snapshotCache });

    await expect(fixture.facade.bind(remoteBinding)).resolves.toMatchObject({
      canvasId: remoteBinding.canvasId
    });
    expect(fixture.resolveCanvasBinding).toHaveBeenCalledOnce();
    expect(fixture.client.bindCanvasCommandSession).toHaveBeenCalledWith(remoteBinding.canvasId);
    expect(fixture.store.projection(replicaScope)).toMatchObject({
      bindingKind: "remote",
      projectId: remoteBinding.projectId,
      canvasId: remoteBinding.canvasId
    });

    const result = await fixture.facade.submit({
      canvasId: remoteBinding.canvasId,
      intent: {
        kind: "update_layout",
        nodes: [
          { nodeId: "T-001", x: 1, y: 2 },
          { nodeId: "T-002", x: 30, y: 40 }
        ],
        updatedAt: "2026-08-02T00:00:00.000Z"
      }
    });
    expect(result.outcome.type).toBe("canvas.command.accepted");
    expect(submitCalls[0]).toMatchObject({ expectedRevision: 7 });
    expect(submitCalls[0]?.operationId).toMatch(/^op-/);
    await fixture.facade.flushSnapshotCache();
    expect(snapshotCache.flush).toHaveBeenCalledTimes(1);
  });

  it("rejects Local Canvas before scope resolution or collaboration binding", async () => {
    const fixture = createFacade();

    await expect(
      fixture.facade.bind({
        kind: "local",
        localProjectId: "local-project",
        canvasId: "local-canvas"
      })
    ).rejects.toMatchObject({ code: "workspace_canvas_remote_binding_required" });
    expect(fixture.client.bindCanvasCommandSession).not.toHaveBeenCalled();
    expect(fixture.store.projection(replicaScope)).toBeNull();
  });

  it("keeps command-facade live subscription and reconnect for remote sessions", async () => {
    const fixture = createFacade();
    await fixture.facade.bind(remoteBinding);

    expect(fixture.client.startLiveSync).toHaveBeenCalledWith(remoteBinding.canvasId, 1);
    expect(fixture.handlers()).not.toBeNull();
    await expect(
      fixture.facade.reconnect({ canvasId: remoteBinding.canvasId })
    ).resolves.toMatchObject({
      snapshotRequired: false,
      entriesToApply: []
    });

    fixture.facade.releaseBinding();
    expect(fixture.client.stopLiveSync).toHaveBeenCalled();
    expect(fixture.client.clearCanvasCommandSession).toHaveBeenCalled();
    expect(fixture.store.projection(replicaScope)).toBeNull();
  });
});
