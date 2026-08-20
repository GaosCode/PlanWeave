import { describe, expect, it, vi } from "vitest";
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
import { CanvasReplicaStore } from "../main/collaboration/CanvasReplicaStore.js";
import type { CanvasReplicaCommandTransport } from "../main/collaboration/CanvasReplicaCommandWorker.js";
import type { CollaborationCanvasCommandSessionView } from "../shared/collaboration.js";

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

function makeClient(overrides: Partial<CollaborationClient> = {}) {
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
    canvasCommandSession: vi.fn<CollaborationClient["canvasCommandSession"]>(() => remoteSession),
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

describe("CollaborationCanvasCommandFacade", () => {
  it("binds via reconnect snapshot and submits without local disk materialization hooks", async () => {
    let content = fixtureContent();
    const store = new CanvasReplicaStore(() => undefined);
    const submitCalls: Array<{ expectedRevision: number; operationId: string }> = [];
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, 7), content };
      },
      async reconnect() {
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: {
              workspaceId: "workspace-001",
              projectId: "remote-project",
              canvasId: "remote-canvas"
            },
            afterRevision: 7,
            headRevision: 7,
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
          expectedRevision: input.expectedRevision,
          operationId: input.operationId
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
          journalEntryId: "journal-8",
          actor: { kind: "human", id: "human-1", displayName: "Owner" },
          acceptedAt: "2026-08-02T00:00:00.000Z",
          idempotentReplay: false
        };
        return outcome;
      }
    };
    const client = makeClient();
    const mirror = {
      bind: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn()
    };
    const facade = new CollaborationCanvasCommandFacade({
      resolveClient: () => client,
      resolveCanvasBinding: async () => ({
        kind: "local" as const,
        localProjectId: "local-project",
        canvasId: "local-canvas",
        remoteProjectId: "remote-project",
        remoteCanvasId: "remote-canvas"
      }),
      resolveCanvasScope: async () => ({
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: "remote-canvas"
      }),
      resolveAuthorityId: () => "authority-1",
      store,
      mirror,
      transport
    });

    await expect(
      facade.bind({ kind: "local", localProjectId: "local-project", canvasId: "local-canvas" })
    ).resolves.toEqual(remoteSession);
    expect(client.bindCanvasCommandSession).toHaveBeenCalledWith("remote-canvas");
    expect(mirror.bind).toHaveBeenCalledWith({
      bindingKind: "local",
      authorityId: "authority-1",
      localProjectId: "local-project",
      localCanvasId: "local-canvas",
      workspaceId: "workspace-001",
      projectId: "remote-project",
      canvasId: "remote-canvas"
    });
    await facade.flushMaterialization();
    expect(mirror.flush).toHaveBeenCalledTimes(1);
    expect(
      store.revision({
        authorityId: "authority-1",
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: "remote-canvas"
      })
    ).toBe(7);

    const result = await facade.submit({
      canvasId: "remote-canvas",
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
    expect(submitCalls[0]?.expectedRevision).toBe(7);
    // Renderer/main never lets the caller stamp operationId.
    expect(submitCalls[0]?.operationId).toMatch(/^op-/);
  });

  it("reconnects through the replica worker without materializing disk as a success gate", async () => {
    const content = fixtureContent();
    const store = new CanvasReplicaStore(() => undefined);
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, 1), content };
      },
      async reconnect(_scope, input) {
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: {
              workspaceId: "workspace-001",
              projectId: "remote-project",
              canvasId: "remote-canvas"
            },
            afterRevision: input.afterRevision,
            headRevision: input.afterRevision,
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
    const client = makeClient();
    const facade = new CollaborationCanvasCommandFacade({
      resolveClient: () => client,
      resolveCanvasBinding: async () => ({
        kind: "local" as const,
        localProjectId: "local-project",
        canvasId: "local-canvas",
        remoteProjectId: "remote-project",
        remoteCanvasId: "remote-canvas"
      }),
      resolveCanvasScope: async () => ({
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: "remote-canvas"
      }),
      resolveAuthorityId: () => "authority-1",
      store,
      transport
    });
    await facade.bind({ kind: "local", localProjectId: "local-project", canvasId: "local-canvas" });
    const result = await facade.reconnect({ canvasId: "remote-canvas", afterRevision: 1 });
    expect(result.response.type).toBe("canvas.reconnect.delta");
    expect(result.snapshotRequired).toBe(false);
  });

  it("binds a remote canvas replica without creating a disk mirror binding", async () => {
    const content = fixtureContent();
    const store = new CanvasReplicaStore(() => undefined);
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, 1), content };
      },
      async reconnect() {
        return { response: snapshotResponse(content, 1) };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit() {
        throw new Error("unexpected submit");
      }
    };
    const client = makeClient();
    const mirror = {
      bind: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn()
    };
    const remote = {
      kind: "remote" as const,
      workspaceId: "workspace-001",
      projectId: "remote-project",
      canvasId: "remote-canvas"
    };
    const facade = new CollaborationCanvasCommandFacade({
      resolveClient: () => client,
      resolveCanvasBinding: async () => ({
        ...remote,
        remoteProjectId: remote.projectId,
        remoteCanvasId: remote.canvasId
      }),
      resolveCanvasScope: async () => ({
        workspaceId: remote.workspaceId,
        projectId: remote.projectId,
        canvasId: remote.canvasId
      }),
      resolveAuthorityId: () => "authority-remote",
      store,
      mirror,
      transport
    });

    await facade.bind(remote);
    expect(mirror.bind).not.toHaveBeenCalled();
    expect(facade.projectionForBinding(remote)).toMatchObject({
      bindingKind: "remote",
      workspaceId: remote.workspaceId,
      projectId: remote.projectId,
      canvasId: remote.canvasId
    });
    expect(facade.projectionForBinding(remote)).not.toHaveProperty("localProjectId");
    facade.clearAllSessions();
    expect(facade.projectionForBinding(remote)).toBeNull();
  });

  it("clears replica sessions so late work cannot rebind an old authority", async () => {
    const content = fixtureContent();
    const store = new CanvasReplicaStore(() => undefined);
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, 1), content };
      },
      async reconnect() {
        throw new Error("unexpected");
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit() {
        throw new Error("unexpected");
      }
    };
    const client = makeClient();
    const facade = new CollaborationCanvasCommandFacade({
      resolveClient: () => client,
      resolveCanvasBinding: async () => ({
        kind: "local" as const,
        localProjectId: "local-project",
        canvasId: "local-canvas",
        remoteProjectId: "remote-project",
        remoteCanvasId: "remote-canvas"
      }),
      resolveCanvasScope: async () => ({
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: "remote-canvas"
      }),
      resolveAuthorityId: () => "authority-1",
      store,
      transport
    });
    await facade.bind({ kind: "local", localProjectId: "local-project", canvasId: "local-canvas" });
    facade.clearAllSessions();
    expect(
      facade.projectionForBinding({
        kind: "local",
        localProjectId: "local-project",
        canvasId: "local-canvas"
      })
    ).toBeNull();
  });

  it("leaves the facade unbound and clears client session when rebind fails", async () => {
    const content = fixtureContent();
    const store = new CanvasReplicaStore(() => undefined);
    let bindAttempts = 0;
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        bindAttempts += 1;
        if (bindAttempts === 1) {
          return { response: snapshotResponse(content, 1), content };
        }
        throw new Error("second canvas baseline failed");
      },
      async reconnect() {
        throw new Error("unexpected");
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit() {
        throw new Error("unexpected");
      }
    };
    const clearCanvasCommandSession = vi.fn();
    const client = makeClient({
      clearCanvasCommandSession
    } as Partial<CollaborationClient>);
    const facade = new CollaborationCanvasCommandFacade({
      resolveClient: () => client,
      resolveCanvasBinding: async (input) => ({
        kind: "local" as const,
        localProjectId: input.localProjectId,
        canvasId: input.canvasId,
        remoteProjectId: "remote-project",
        remoteCanvasId: input.canvasId === "local-canvas" ? "remote-canvas" : "remote-canvas-b"
      }),
      resolveCanvasScope: async (input) => ({
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: input.canvasId === "local-canvas" ? "remote-canvas" : "remote-canvas-b"
      }),
      resolveAuthorityId: () => "authority-1",
      store,
      transport
    });

    await facade.bind({ kind: "local", localProjectId: "local-project", canvasId: "local-canvas" });
    await expect(
      facade.bind({ kind: "local", localProjectId: "local-project", canvasId: "local-canvas-b" })
    ).rejects.toThrow(/second canvas baseline failed/);

    expect(
      facade.projectionForBinding({
        kind: "local",
        localProjectId: "local-project",
        canvasId: "local-canvas"
      })
    ).toBeNull();
    expect(
      facade.projectionForBinding({
        kind: "local",
        localProjectId: "local-project",
        canvasId: "local-canvas-b"
      })
    ).toBeNull();
    expect(
      store.projection({
        authorityId: "authority-1",
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: "remote-canvas-b"
      })
    ).toBeNull();
    expect(clearCanvasCommandSession).toHaveBeenCalled();
    await expect(
      facade.submit({
        canvasId: "remote-canvas",
        intent: {
          kind: "update_layout",
          nodes: [
            { nodeId: "T-001", x: 1, y: 2 },
            { nodeId: "T-002", x: 30, y: 40 }
          ],
          updatedAt: "2026-08-02T00:00:00.000Z"
        }
      })
    ).rejects.toMatchObject({ code: "collaboration_canvas_local_binding_required" });
  });

  it("fully unbinds worker scope and client session when rebind mapping is unmapped", async () => {
    const content = fixtureContent();
    const store = new CanvasReplicaStore(() => undefined);
    let submitCalls = 0;
    let submitGate: { promise: Promise<void>; resolve: () => void } | null = null;
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, 1), content };
      },
      async reconnect() {
        throw new Error("unexpected reconnect");
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        submitCalls += 1;
        if (!submitGate) {
          let resolve!: () => void;
          const promise = new Promise<void>((r) => {
            resolve = r;
          });
          submitGate = { promise, resolve };
        }
        await submitGate.promise;
        const next = encodeCanvasReplicaDocument(
          applyCanvasReplicaIntent(decodeCanvasReplicaDocument(content), input.intent)
        );
        return {
          type: "canvas.command.accepted" as const,
          protocolVersion: 1 as const,
          schemaVersion: "canvas-command/v1" as const,
          scope: {
            workspaceId: "workspace-001",
            projectId: "remote-project",
            canvasId: "remote-canvas"
          },
          operationId: input.operationId,
          revision: 2,
          previousRevision: 1,
          contentDigest: next.canonicalDigest,
          journalEntryId: "journal-late",
          actor: { kind: "human" as const, id: "human-1", displayName: "Owner" },
          acceptedAt: "2026-08-02T00:00:00.000Z",
          idempotentReplay: false
        };
      }
    };
    const clearCanvasCommandSession = vi.fn();
    const client = makeClient({
      clearCanvasCommandSession
    } as Partial<CollaborationClient>);
    const facade = new CollaborationCanvasCommandFacade({
      resolveClient: () => client,
      resolveCanvasBinding: async (input) => {
        if (input.canvasId === "missing-canvas") return null;
        return {
          kind: "local" as const,
          localProjectId: "local-project",
          canvasId: "local-canvas",
          remoteProjectId: "remote-project",
          remoteCanvasId: "remote-canvas"
        };
      },
      resolveCanvasScope: async () => ({
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: "remote-canvas"
      }),
      resolveAuthorityId: () => "authority-1",
      store,
      transport
    });

    await facade.bind({ kind: "local", localProjectId: "local-project", canvasId: "local-canvas" });
    const inFlight = facade.submit({
      canvasId: "remote-canvas",
      intent: {
        kind: "update_layout",
        nodes: [
          { nodeId: "T-001", x: 5, y: 6 },
          { nodeId: "T-002", x: 30, y: 40 }
        ],
        updatedAt: "2026-08-02T01:00:00.000Z"
      }
    });
    await vi.waitFor(() => expect(submitCalls).toBe(1));

    // Mapping failure must tear down the old worker before the late network reply.
    await expect(
      facade.bind({ kind: "local", localProjectId: "local-project", canvasId: "missing-canvas" })
    ).rejects.toMatchObject({ code: "collaboration_canvas_scope_unmapped" });

    expect(clearCanvasCommandSession).toHaveBeenCalled();
    expect(
      facade.projectionForBinding({
        kind: "local",
        localProjectId: "local-project",
        canvasId: "local-canvas"
      })
    ).toBeNull();
    expect(
      store.projection({
        authorityId: "authority-1",
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: "remote-canvas"
      })
    ).toBeNull();

    submitGate!.resolve();
    await expect(inFlight).rejects.toMatchObject({
      code: "canvas_replica_session_disconnected"
    });
  });

  it("fully unbinds when rebind scope resolution mismatches remote canvas", async () => {
    const content = fixtureContent();
    const store = new CanvasReplicaStore(() => undefined);
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, 1), content };
      },
      async reconnect() {
        throw new Error("unexpected");
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit() {
        throw new Error("unexpected");
      }
    };
    const clearCanvasCommandSession = vi.fn();
    const client = makeClient({
      clearCanvasCommandSession
    } as Partial<CollaborationClient>);
    const facade = new CollaborationCanvasCommandFacade({
      resolveClient: () => client,
      resolveCanvasBinding: async (input) => {
        if (input.canvasId === "local-canvas-b") {
          return {
            kind: "local" as const,
            localProjectId: "local-project",
            canvasId: "local-canvas-b",
            remoteProjectId: "remote-project",
            remoteCanvasId: "remote-canvas-b"
          };
        }
        return {
          kind: "local" as const,
          localProjectId: "local-project",
          canvasId: "local-canvas",
          remoteProjectId: "remote-project",
          remoteCanvasId: "remote-canvas"
        };
      },
      resolveCanvasScope: async (input) => {
        if (input.canvasId === "local-canvas-b") {
          // Binding maps to remote-canvas-b, but scope resolution returns a different canvas.
          return {
            workspaceId: "workspace-001",
            projectId: "remote-project",
            canvasId: "other-canvas"
          };
        }
        return {
          workspaceId: "workspace-001",
          projectId: "remote-project",
          canvasId: "remote-canvas"
        };
      },
      resolveAuthorityId: () => "authority-1",
      store,
      transport
    });

    await facade.bind({ kind: "local", localProjectId: "local-project", canvasId: "local-canvas" });
    clearCanvasCommandSession.mockClear();
    await expect(
      facade.bind({ kind: "local", localProjectId: "local-project", canvasId: "local-canvas-b" })
    ).rejects.toMatchObject({ code: "collaboration_canvas_scope_unmapped" });

    expect(clearCanvasCommandSession).toHaveBeenCalled();
    expect(
      facade.projectionForBinding({
        localProjectId: "local-project",
        canvasId: "local-canvas"
      })
    ).toBeNull();
    expect(
      store.projection({
        authorityId: "authority-1",
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: "remote-canvas"
      })
    ).toBeNull();
  });
});
