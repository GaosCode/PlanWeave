import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AuthoritativeContentVersion,
  CompleteContentVersion,
  ContentVersionAcknowledgement,
  FirstContentVersionPublishResult
} from "@planweave-ai/collaboration-protocol/content/version";
import type { ContentVersionAuthorityDiscoveryResult } from "@planweave-ai/collaboration-protocol/content/authority";
import {
  completedContentVersionRefSchema,
  type CompletedContentVersionRef
} from "@planweave-ai/collaboration-protocol/content/version";
import { ContentVersionFacade } from "../main/collaboration/ContentVersionFacade.js";
import {
  CollaborationContentReplicaStore,
  type CollaborationContentReplicaStorePort
} from "../main/collaboration/CollaborationContentReplicaStore.js";
import { CollaborationRuntimeAvailabilityStore } from "../main/collaboration/CollaborationRuntimeAvailabilityStore.js";
import {
  WorkspaceCanvasPublishReceiptStore,
  type WorkspaceCanvasPublishReceiptStorePort
} from "../main/collaboration/WorkspaceCanvasPublishReceiptStore.js";
import { CollaborationClientError } from "../main/collaboration/collaborationErrors.js";
import type { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  initManagedWorkspace,
  listProjects,
  planManagedProjectFromAuthoritativeContent
} from "../../../runtime/src/index.js";

const directories: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettingsFile = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettingsFile === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettingsFile;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function versionRef(content: CompleteContentVersion): CompletedContentVersionRef {
  return completedContentVersionRefSchema.parse({
    versionId: `version-${content.canonicalDigest}`,
    canonicalDigest: content.canonicalDigest,
    verification: "complete"
  });
}

function acknowledgement(
  projectId: string,
  content: CompletedContentVersionRef
): ContentVersionAcknowledgement {
  return {
    scope: { workspaceId: "workspace-test", projectId, canvasId: "default" },
    deviceSessionId: "device-session-test",
    content,
    acknowledgedAt: "2026-07-28T00:00:00.000Z"
  };
}

function head(projectId: string, content: CompletedContentVersionRef, canvasId = "default") {
  return {
    schemaVersion: "content-version/v1" as const,
    scope: { workspaceId: "workspace-test", projectId, canvasId },
    revision: 1,
    content,
    advancedAt: "2026-07-28T00:00:00.000Z"
  };
}

function bootstrapScope(projectId: string, workspaceId = "workspace-test") {
  return { workspaceId, projectId, canvasId: "default" };
}

function fakeClient(
  projectId: string,
  options: {
    registered?: boolean;
    visibility?: "private" | "shared";
    failPublish?: boolean;
  } = {}
) {
  let published: AuthoritativeContentVersion | null = null;
  const registeredCanvasIds = options.registered === false ? [] : ["default"];
  const workspacePublished = new Map<
    string,
    {
      operationId: string;
      localSource: { localProjectId: string; localCanvasId: string };
      serverCanvasId: string;
      version: AuthoritativeContentVersion;
    }
  >();
  const visibility = options.visibility ?? "shared";
  const resolvePublished = (canvasId?: string): AuthoritativeContentVersion | null => {
    if (canvasId) {
      const match = [...workspacePublished.values()].find(
        (entry) => entry.serverCanvasId === canvasId
      );
      if (match) return match.version;
    }
    return published;
  };
  const discoverContentAuthority = vi.fn(
    async (input: {
      canvasId?: string;
      localReplica: CompletedContentVersionRef | null;
    }): Promise<ContentVersionAuthorityDiscoveryResult> => {
      const version = resolvePublished(input.canvasId);
      if (!version) {
        return {
          authoritativeHead: null,
          localReplica: input.localReplica,
          lastAcknowledgement: null,
          replicaStatus: "snapshot_required",
          recoveryAction: "await_initial_publish",
          canPublishInitial: true,
          canMaterialize: false,
          canRecover: true
        };
      }
      if (!input.localReplica) {
        return {
          authoritativeHead: head(projectId, version.completed, version.scope.canvasId),
          localReplica: null,
          lastAcknowledgement: null,
          replicaStatus: "snapshot_required",
          recoveryAction: "fetch_head",
          canPublishInitial: false,
          canMaterialize: true,
          canRecover: true
        };
      }
      const inSync = input.localReplica.versionId === version.completed.versionId;
      return {
        authoritativeHead: head(projectId, version.completed, version.scope.canvasId),
        localReplica: input.localReplica,
        lastAcknowledgement: acknowledgement(projectId, version.completed),
        replicaStatus: inSync ? "in_sync" : "diverged",
        recoveryAction: inSync ? "none" : "fetch_head",
        canPublishInitial: false,
        canMaterialize: true,
        canRecover: true
      };
    }
  );
  const publishWorkspaceCanvas = vi.fn(
    async (input: {
      operationId: string;
      localSource: { localProjectId: string; localCanvasId: string };
      content: CompleteContentVersion;
    }) => {
      if (options.failPublish) throw new Error("storage_unavailable");
      const localKey = `${input.localSource.localProjectId}\u0000${input.localSource.localCanvasId}`;
      const existing = workspacePublished.get(localKey);
      if (existing) {
        return {
          outcome: "reused" as const,
          operationId: existing.operationId,
          recoveryToken: `wp-${existing.operationId}`,
          scope: {
            workspaceId: "workspace-test",
            projectId,
            canvasId: existing.serverCanvasId
          },
          revision: 1,
          content: existing.version.completed,
          visibility: "private" as const
        };
      }
      if (
        [...workspacePublished.values()].some((entry) => entry.operationId === input.operationId)
      ) {
        return {
          outcome: "rejected" as const,
          reason: "operation_conflict" as const,
          retryable: false,
          detail: "operation_conflict",
          scope: null,
          recoveryToken: null
        };
      }
      const completed = versionRef(input.content);
      const serverCanvasId = `wsc-${randomUUID()}`;
      const version: AuthoritativeContentVersion = {
        schemaVersion: "content-version/v1",
        scope: { workspaceId: "workspace-test", projectId, canvasId: serverCanvasId },
        content: input.content,
        completed,
        createdAt: "2026-07-28T00:00:00.000Z",
        createdBy: { kind: "human", id: "human-owner", displayName: "Owner" }
      };
      workspacePublished.set(localKey, {
        operationId: input.operationId,
        localSource: input.localSource,
        serverCanvasId,
        version
      });
      published = version;
      if (!registeredCanvasIds.includes(serverCanvasId)) registeredCanvasIds.push(serverCanvasId);
      return {
        outcome: "published" as const,
        operationId: input.operationId,
        recoveryToken: `wp-${input.operationId}`,
        scope: {
          workspaceId: "workspace-test",
          projectId,
          canvasId: serverCanvasId
        },
        revision: 1,
        content: completed,
        visibility: "private" as const
      };
    }
  );
  const publishInitialContent = vi.fn(
    async (input: {
      content: CompleteContentVersion;
    }): Promise<FirstContentVersionPublishResult> => {
      const completed = versionRef(input.content);
      published = {
        schemaVersion: "content-version/v1",
        scope: { workspaceId: "workspace-test", projectId, canvasId: "default" },
        content: input.content,
        completed,
        createdAt: "2026-07-28T00:00:00.000Z",
        createdBy: { kind: "human", id: "human-owner", displayName: "Owner" }
      };
      return { outcome: "published", version: published, head: head(projectId, completed) };
    }
  );
  const fetchContentVersion = vi.fn(async (): Promise<AuthoritativeContentVersion> => {
    if (!published) throw new Error("content_not_published");
    return published;
  });
  const acknowledgeContentVersion = vi.fn(async (input: { content: CompletedContentVersionRef }) =>
    acknowledgement(projectId, input.content)
  );
  /** Independent command revision (7) vs content-authority head revision (1). */
  const reconnectCanvasCommands = vi.fn(async () => {
    if (!published) throw new Error("content_not_published");
    return {
      response: {
        type: "canvas.reconnect.snapshot" as const,
        protocolVersion: 1 as const,
        schemaVersion: "canvas-command/v1" as const,
        scope: {
          workspaceId: "workspace-test",
          projectId,
          canvasId: "default"
        },
        reason: "truncated_journal" as const,
        afterRevision: 0,
        snapshot: {
          metadata: {
            schemaVersion: "canvas-snapshot/v2" as const,
            scope: {
              workspaceId: "workspace-test",
              projectId,
              canvasId: "default"
            },
            revision: 7,
            contentDigest: published.content.canonicalDigest,
            createdAt: "2026-07-28T00:00:00.000Z",
            sizeBytes: published.content.totalBytes
          },
          encoding: "content_version_ref" as const,
          content: published.completed
        }
      },
      entriesToApply: [],
      snapshotRequired: true,
      session: null
    };
  });
  const readRuntimeAvailability = vi.fn(async () => ({
    schemaVersion: "canvas-runtime-view/v1" as const,
    state: {
      kind: "initialized" as const,
      runtimeRevision: 1,
      status: {
        schemaVersion: "canvas-runtime-status/v2" as const,
        scope: { workspaceId: "workspace-test", projectId, canvasId: "default" },
        packageFingerprint: `pkg-${"a".repeat(64)}`,
        capturedAt: "2026-08-20T00:00:00.000Z",
        tasks: [],
        blocks: []
      }
    },
    execution: {
      schemaVersion: "canvas-runtime-availability/v1" as const,
      kind: "unavailable" as const,
      reason: "runtime_not_attached" as const
    }
  }));
  const importRuntimeStatus = vi.fn(async (_canvasId: string, input: { status: unknown }) => ({
    kind: "initialized" as const,
    runtimeRevision: 1,
    status: input.status
  }));
  const resetRuntime = vi.fn(async (_canvasId: string, input: { operationId: string }) => ({
    type: "canvas.runtime.reset.rejected" as const,
    operationId: input.operationId,
    code: "host_offline" as const,
    detail: "runtime_host_offline",
    retryable: true
  }));
  const canvasRecord = (canvasId: string) => ({
    schemaVersion: "project-access/v1" as const,
    registry: {
      projectRegistryId: "project-registry-test",
      canvasRegistryId: `canvas-registry-${canvasId}`,
      workspaceId: "workspace-test",
      projectId,
      canvasId
    },
    visibility,
    acl: { revision: 1, updatedAt: "2026-07-28T00:00:00.000Z" },
    owner: "human-owner",
    updatedAt: "2026-07-28T00:00:00.000Z"
  });
  const registerCanvas = vi.fn(async () => {
    if (!registeredCanvasIds.includes("default")) registeredCanvasIds.push("default");
    return canvasRecord("default");
  });
  return {
    client: {
      projectId,
      connectionProfile: {
        profileId: "profile-test",
        serverBaseUrl: "http://127.0.0.1:50653/",
        projectId,
        allowInsecureTransport: true
      },
      registry: () => ({
        listCanvases: vi.fn(async () => ({
          items: registeredCanvasIds.map((canvasId) => canvasRecord(canvasId)),
          nextCursor: null
        })),
        registerCanvas
      }),
      discoverContentAuthority,
      publishInitialContent,
      publishWorkspaceCanvas,
      fetchContentVersion,
      acknowledgeContentVersion,
      reconnectCanvasCommands,
      readRuntimeAvailability,
      importRuntimeStatus,
      resetRuntime
    } as unknown as CollaborationClient,
    calls: {
      discoverContentAuthority,
      publishInitialContent,
      publishWorkspaceCanvas,
      fetchContentVersion,
      acknowledgeContentVersion,
      reconnectCanvasCommands,
      readRuntimeAvailability,
      importRuntimeStatus,
      resetRuntime,
      registerCanvas
    }
  };
}

describe("ContentVersionFacade", () => {
  it("publishes a local canvas to a Workspace locator without deleting the local source", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id, {
      registered: false,
      visibility: "private"
    });
    const facade = new ContentVersionFacade(() => fake.client);
    const originalPrompt = await readFile(
      join(workspace.init.workspace.packageDir, "nodes/T-001/prompt.md"),
      "utf8"
    );

    await expect(facade.listWorkspaceCanvasSharingCandidates()).resolves.toEqual([
      expect.objectContaining({
        localProjectId: workspace.init.project.id,
        canvasId: "default",
        state: "local_only",
        visibility: null,
        authority: null
      })
    ]);

    const published = await facade.publishWorkspaceCanvas({
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    expect(published).toMatchObject({
      outcome: "published",
      locator: {
        kind: "workspace",
        connectionProfileId: "profile-test",
        workspaceId: "workspace-test",
        projectId: workspace.init.workspace.id
      },
      localSourceRetained: true,
      candidate: { state: "published_private", visibility: "private" }
    });
    expect(published.locator.canvasId).toMatch(/^wsc-[0-9a-f-]{36}$/);
    expect(published.locator.canvasId).not.toBe("default");
    expect(fake.calls.registerCanvas).not.toHaveBeenCalled();
    expect(fake.calls.publishWorkspaceCanvas).toHaveBeenCalledOnce();
    expect(fake.calls.publishInitialContent).not.toHaveBeenCalled();
    await expect(
      readFile(join(workspace.init.workspace.packageDir, "nodes/T-001/prompt.md"), "utf8")
    ).resolves.toBe(originalPrompt);

    await expect(facade.listWorkspaceCanvasSharingCandidates()).resolves.toEqual([
      expect.objectContaining({ state: "published_private", visibility: "private" })
    ]);

    await writeFile(
      join(workspace.init.workspace.packageDir, "nodes/T-001/prompt.md"),
      "# changed after sharing\n",
      "utf8"
    );
    await expect(facade.listWorkspaceCanvasSharingCandidates()).resolves.toEqual([
      expect.objectContaining({ state: "published_private", visibility: "private" })
    ]);
    expect(fake.calls.discoverContentAuthority).toHaveBeenLastCalledWith(
      expect.objectContaining({ localReplica: null, canvasId: published.locator.canvasId })
    );

    const replayed = await facade.publishWorkspaceCanvas({
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    expect(replayed.outcome).toBe("reused");
    expect(replayed.locator.canvasId).toBe(published.locator.canvasId);
    expect(fake.calls.publishWorkspaceCanvas).toHaveBeenCalledTimes(2);
    expect(fake.calls.publishWorkspaceCanvas.mock.calls[0]?.[0].operationId).toBe(
      fake.calls.publishWorkspaceCanvas.mock.calls[1]?.[0].operationId
    );
  });

  it("leaves the local canvas unchanged when Server publish fails", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id, {
      registered: false,
      failPublish: true
    });
    const facade = new ContentVersionFacade(() => fake.client);

    await expect(
      facade.publishWorkspaceCanvas({
        localProjectId: workspace.init.project.id,
        canvasId: "default"
      })
    ).rejects.toThrow("storage_unavailable");
    await expect(facade.listWorkspaceCanvasSharingCandidates()).resolves.toEqual([
      expect.objectContaining({ state: "local_only", visibility: null })
    ]);
    expect(fake.client.registry().listCanvases).toBeDefined();
    await expect(fake.client.registry().listCanvases()).resolves.toEqual({
      items: [],
      nextCursor: null
    });
  });

  it("assigns distinct Server canvasIds to two local default canvases", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const second = await initManagedWorkspace({ name: "Second Local", projectGraph: true });
    const fake = fakeClient(workspace.init.workspace.id, {
      registered: false,
      visibility: "private"
    });
    const facade = new ContentVersionFacade(() => fake.client);
    const first = await facade.publishWorkspaceCanvas({
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    const other = await facade.publishWorkspaceCanvas({
      localProjectId: second.project.id,
      canvasId: "default"
    });
    expect(first.locator.canvasId).toMatch(/^wsc-[0-9a-f-]{36}$/);
    expect(other.locator.canvasId).toMatch(/^wsc-[0-9a-f-]{36}$/);
    expect(first.locator.canvasId).not.toBe(other.locator.canvasId);
    expect(first.locator.canvasId).not.toBe("default");
    expect(other.locator.canvasId).not.toBe("default");
  });

  it("reuses the persisted operationId after a new Desktop process instance", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id, {
      registered: false,
      visibility: "private"
    });
    const receipts = new WorkspaceCanvasPublishReceiptStore(
      join(workspace.home, "workspace-canvas-publish-receipts.json")
    );
    const first = new ContentVersionFacade(
      () => fake.client,
      undefined,
      undefined,
      undefined,
      receipts
    );
    const published = await first.publishWorkspaceCanvas({
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    const restarted = new ContentVersionFacade(
      () => fake.client,
      undefined,
      undefined,
      undefined,
      new WorkspaceCanvasPublishReceiptStore(
        join(workspace.home, "workspace-canvas-publish-receipts.json")
      )
    );
    const replayed = await restarted.publishWorkspaceCanvas({
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    expect(replayed.outcome).toBe("reused");
    expect(replayed.locator.canvasId).toBe(published.locator.canvasId);
    expect(fake.calls.publishWorkspaceCanvas.mock.calls[0]?.[0].operationId).toBe(
      fake.calls.publishWorkspaceCanvas.mock.calls[1]?.[0].operationId
    );
  });

  it("recovers the Workspace locator from Server after a lost local receipt", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id, {
      registered: false,
      visibility: "private"
    });
    const published = await new ContentVersionFacade(
      () => fake.client,
      undefined,
      undefined,
      undefined,
      new WorkspaceCanvasPublishReceiptStore(join(workspace.home, "first-receipts.json"))
    ).publishWorkspaceCanvas({
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    const recovered = await new ContentVersionFacade(
      () => fake.client,
      undefined,
      undefined,
      undefined,
      new WorkspaceCanvasPublishReceiptStore(join(workspace.home, "empty-receipts.json"))
    ).publishWorkspaceCanvas({
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    expect(recovered.outcome).toBe("reused");
    expect(recovered.operationId).toBe(published.operationId);
    expect(recovered.locator.canvasId).toBe(published.locator.canvasId);
    expect(fake.calls.publishWorkspaceCanvas.mock.calls[0]?.[0].operationId).not.toBe(
      fake.calls.publishWorkspaceCanvas.mock.calls[1]?.[0].operationId
    );
  });

  it("returns the Workspace locator when local receipt commit fails after Server publish", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id, {
      registered: false,
      visibility: "private"
    });
    const backing = new WorkspaceCanvasPublishReceiptStore(
      join(workspace.home, "workspace-canvas-publish-receipts.json")
    );
    const commit = vi.fn(async () => {
      throw new Error("workspace_canvas_publish_receipt_store_invalid");
    });
    const receipts: WorkspaceCanvasPublishReceiptStorePort = {
      find: (key) => backing.find(key),
      rememberPending: (input) => backing.rememberPending(input),
      commit
    };
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const published = await new ContentVersionFacade(
        () => fake.client,
        undefined,
        undefined,
        undefined,
        receipts
      ).publishWorkspaceCanvas({
        localProjectId: workspace.init.project.id,
        canvasId: "default"
      });
      expect(published.outcome).toBe("published");
      expect(published.locator).toMatchObject({
        kind: "workspace",
        workspaceId: "workspace-test",
        projectId: workspace.init.workspace.id
      });
      expect(published.locator.canvasId).toMatch(/^wsc-[0-9a-f-]{36}$/);
      expect(commit).toHaveBeenCalledOnce();
      expect(diagnostics).toHaveBeenCalledWith(
        "Failed to persist workspace canvas publish receipt.",
        expect.any(Error)
      );
    } finally {
      diagnostics.mockRestore();
    }
  });

  it("downloads a Workspace revision as a new local fork without writeback mapping", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id, {
      registered: false,
      visibility: "private"
    });
    const replicas = new CollaborationContentReplicaStore(
      join(workspace.home, "content-replicas.json")
    );
    const facade = new ContentVersionFacade(() => fake.client, replicas);
    const published = await facade.publishWorkspaceCanvas({
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });

    const downloaded = await facade.downloadWorkspaceCanvasFork({
      workspaceId: published.locator.workspaceId,
      projectId: published.locator.projectId,
      canvasId: published.locator.canvasId,
      revision: published.revision,
      content: published.content
    });

    expect(downloaded.writeback).toBe(false);
    expect(downloaded.localProjectId).not.toBe(workspace.init.project.id);
    expect(downloaded.localCanvasId).toBe("default");
    expect(downloaded.lineage).toMatchObject({
      writeback: false,
      source: {
        scope: {
          workspaceId: published.locator.workspaceId,
          projectId: published.locator.projectId,
          canvasId: published.locator.canvasId
        },
        revision: published.revision
      }
    });
    await expect(replicas.list()).resolves.toEqual([]);
    await expect(
      facade.resolveCanvasScope({
        kind: "local",
        localProjectId: downloaded.localProjectId,
        canvasId: downloaded.localCanvasId
      })
    ).resolves.toBeNull();
    await expect(listProjects()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: workspace.init.project.id }),
        expect.objectContaining({ projectId: downloaded.localProjectId })
      ])
    );
  });

  it("imports the exact local working-copy Runtime status without supporting remote bindings", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const facade = new ContentVersionFacade(() => fake.client);

    await expect(
      facade.importLocalRuntimeStatus({
        kind: "local",
        localProjectId: workspace.init.project.id,
        canvasId: "default"
      })
    ).resolves.toMatchObject({ kind: "initialized" });
    expect(fake.calls.importRuntimeStatus).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        status: expect.objectContaining({
          scope: {
            workspaceId: "workspace-test",
            projectId: workspace.init.workspace.id,
            canvasId: "default"
          }
        })
      })
    );
    await expect(
      facade.importLocalRuntimeStatus({
        kind: "remote",
        workspaceId: "workspace-test",
        projectId: workspace.init.workspace.id,
        canvasId: "default"
      })
    ).rejects.toMatchObject({ code: "runtime_status_local_working_copy_required" });
  });

  it("binds an authorized remote canvas with an empty local catalog", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-remote-canvas-"));
    directories.push(home);
    process.env.PLANWEAVE_HOME = home;
    const fake = fakeClient("remote-project");
    const facade = new ContentVersionFacade(() => fake.client);
    const remote = {
      kind: "remote" as const,
      workspaceId: "workspace-test",
      projectId: "remote-project",
      canvasId: "default"
    };

    await expect(facade.bind(remote)).resolves.toMatchObject({
      authoritativeHead: null,
      localReplica: null
    });
    await expect(listProjects()).resolves.toEqual([]);
    expect(fake.calls.discoverContentAuthority).toHaveBeenCalledWith({
      canvasId: "default",
      localReplica: null,
      knownRevision: null
    });
    await expect(facade.resolveCanvasBinding(remote)).resolves.toMatchObject(remote);
    await expect(
      facade.resolveCanvasBinding({ ...remote, workspaceId: "workspace-other" })
    ).rejects.toMatchObject({ code: "content_remote_canvas_not_authorized" });
    await expect(
      facade.resolveCanvasBinding({ ...remote, projectId: "project-other" })
    ).resolves.toBeNull();
    await expect(facade.bind({ ...remote, projectId: "project-other" })).rejects.toMatchObject({
      code: "content_remote_project_profile_mismatch"
    });
  });

  it("publishes local-only content, discovers the head, materializes it, and acknowledges it", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const facade = new ContentVersionFacade(() => fake.client);

    await expect(
      facade.bind({ kind: "local", localProjectId: workspace.init.project.id, canvasId: "default" })
    ).resolves.toMatchObject({
      authoritativeHead: null,
      replicaStatus: "snapshot_required",
      canPublishInitial: true
    });
    await expect(facade.publishInitial()).resolves.toMatchObject({
      replicaStatus: "in_sync",
      canMaterialize: true
    });
    await expect(facade.materializeHead()).resolves.toMatchObject({ replicaStatus: "in_sync" });

    expect(fake.calls.publishInitialContent).toHaveBeenCalledWith(
      expect.objectContaining({
        canvasId: "default",
        content: expect.objectContaining({
          canonicalDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      })
    );
    expect(fake.calls.discoverContentAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        canvasId: "default",
        localReplica: expect.objectContaining({ verification: "complete" })
      })
    );
    expect(fake.calls.fetchContentVersion).toHaveBeenCalledWith(
      expect.objectContaining({ scope: expect.objectContaining({ canvasId: "default" }) })
    );
    expect(fake.calls.acknowledgeContentVersion).toHaveBeenCalledTimes(2);
  });

  it("reads replica baseline content without exposing the independent authority revision", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const facade = new ContentVersionFacade(() => fake.client);
    await facade.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    await facade.publishInitial();

    const baseline = await facade.readCanvasReplicaBaseline({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });

    expect(baseline.contentDigest).toBe(baseline.content.canonicalDigest);
    expect("revision" in baseline).toBe(false);
    expect(baseline.scope.authorityId).toContain("profile-test");
    // Must use reconnect snapshot path, never discover(content head) for command baseline.
    expect(fake.calls.reconnectCanvasCommands).toHaveBeenCalledWith({
      canvasId: "default",
      afterRevision: 0
    });
    expect(fake.calls.fetchContentVersion).toHaveBeenCalled();
  });

  it("keeps a rejected initial publish redacted and typed as a boundary failure", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    fake.client.publishInitialContent = vi.fn(async () => ({
      outcome: "rejected" as const,
      reason: "authorization_revoked" as const,
      retryable: false,
      detail: "owner access revoked",
      head: null
    }));
    const facade = new ContentVersionFacade(() => fake.client);
    await facade.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });

    await expect(facade.publishInitial()).rejects.toMatchObject({
      name: "CollaborationClientError",
      code: "content_initial_publish_authorization_revoked",
      retryable: false
    });
  });

  it("fails closed while disconnected before accepting a renderer canvas input", async () => {
    const facade = new ContentVersionFacade(() => null);

    await expect(
      facade.bind({ kind: "local", localProjectId: "missing", canvasId: "default" })
    ).rejects.toBeInstanceOf(CollaborationClientError);
    await expect(
      facade.bind({ kind: "local", localProjectId: "missing", canvasId: "default" })
    ).rejects.toMatchObject({
      code: "collaboration_content_offline",
      retryable: true
    });
  });

  it("does not expose persisted runtime availability without an active client", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const availabilityStore = new CollaborationRuntimeAvailabilityStore(
      join(workspace.home, "runtime-availability.json")
    );
    const contentReplicas = new CollaborationContentReplicaStore(
      join(workspace.home, "content-replicas.json")
    );
    const authority = {
      profileId: "profile-test",
      serverOrigin: "http://127.0.0.1:50653",
      projectId: workspace.init.workspace.id
    };
    const online = new ContentVersionFacade(
      () => fake.client,
      contentReplicas,
      () => authority,
      availabilityStore
    );

    const availability = await online.readRuntimeAvailability({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    expect(availability?.state.kind).toBe("initialized");
    expect(fake.calls.readRuntimeAvailability).toHaveBeenCalledWith("default");

    const offline = new ContentVersionFacade(
      () => null,
      contentReplicas,
      () => authority,
      new CollaborationRuntimeAvailabilityStore(join(workspace.home, "runtime-availability.json"))
    );
    await expect(
      offline.readRuntimeAvailability({
        kind: "local",
        localProjectId: workspace.init.project.id,
        canvasId: "default"
      })
    ).rejects.toMatchObject({
      code: "collaboration_content_offline",
      retryable: true
    });
  });

  it("preserves unavailable and rejects an available status for a different resolved scope", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    fake.client.readRuntimeAvailability = vi.fn(async () => ({
      schemaVersion: "canvas-runtime-view/v1" as const,
      state: { kind: "uninitialized" as const },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1" as const,
        kind: "unavailable" as const,
        reason: "runtime_not_attached" as const
      }
    }));
    const facade = new ContentVersionFacade(() => fake.client);
    await expect(
      facade.readRuntimeAvailability({
        kind: "local",
        localProjectId: workspace.init.project.id,
        canvasId: "default"
      })
    ).resolves.toMatchObject({
      state: { kind: "uninitialized" },
      execution: { kind: "unavailable", reason: "runtime_not_attached" }
    });

    fake.client.readRuntimeAvailability = vi.fn(async () => ({
      schemaVersion: "canvas-runtime-view/v1" as const,
      state: {
        kind: "initialized" as const,
        status: {
          schemaVersion: "canvas-runtime-status/v2" as const,
          scope: {
            workspaceId: "workspace-other",
            projectId: workspace.init.workspace.id,
            canvasId: "default"
          },
          packageFingerprint: `pkg-${"a".repeat(64)}`,
          capturedAt: "2026-08-20T00:00:00.000Z",
          tasks: [],
          blocks: []
        }
      },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1" as const,
        kind: "unavailable" as const,
        reason: "runtime_not_attached" as const
      }
    }));
    await expect(
      facade.readRuntimeAvailability({
        kind: "local",
        localProjectId: workspace.init.project.id,
        canvasId: "default"
      })
    ).rejects.toMatchObject({ code: "runtime_availability_scope_mismatch" });
  });

  it("derives the reset content revision from the authoritative content head", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const facade = new ContentVersionFacade(() => fake.client);
    await facade.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    await facade.publishInitial();

    await expect(
      facade.resetRuntime(
        {
          kind: "remote",
          workspaceId: "workspace-test",
          projectId: workspace.init.workspace.id,
          canvasId: "default"
        },
        {
          operationId: "reset-authority-revision",
          expectedSourceRevision: `snapshot:${"b".repeat(64)}`,
          expectedGraphFingerprint: `pkg-${"a".repeat(64)}`
        }
      )
    ).resolves.toMatchObject({
      type: "canvas.runtime.reset.rejected",
      code: "host_offline"
    });
    expect(fake.calls.resetRuntime).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        operationId: "reset-authority-revision",
        expectedContentRevision: 1
      })
    );
  });

  it("resolves only a persisted shared replica while disconnected", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const storePath = join(workspace.home, "offline-replicas.json");
    const store = new CollaborationContentReplicaStore(storePath);
    const authority = {
      profileId: "profile-test",
      serverOrigin: "http://127.0.0.1:50653",
      projectId: "remote-project"
    };
    const now = "2026-08-05T00:00:00.000Z";
    await store.add({
      remote: {
        serverOrigin: authority.serverOrigin,
        workspaceId: "workspace-test",
        projectId: authority.projectId,
        canvasId: "remote-canvas"
      },
      local: { projectId: "local-replica", canvasId: "default" },
      phase: "ready",
      projectName: "Shared project",
      reservationToken: null,
      createdAt: now,
      updatedAt: now
    });
    const offline = new ContentVersionFacade(
      () => null,
      store,
      () => authority
    );

    await expect(
      offline.resolveCanvasScope({
        kind: "local",
        localProjectId: "local-replica",
        canvasId: "default"
      })
    ).resolves.toEqual({
      workspaceId: "workspace-test",
      projectId: "remote-project",
      canvasId: "remote-canvas"
    });
    await expect(
      offline.resolveCanvasScope({
        kind: "local",
        localProjectId: "local-only",
        canvasId: "default"
      })
    ).resolves.toBeNull();
  });

  it("bootstraps a missing local package from Server authority and restores the mapping after restart", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const storePath = join(workspace.home, "desktop", "collaboration", "content-replicas.json");
    const owner = new ContentVersionFacade(
      () => fake.client,
      new CollaborationContentReplicaStore(storePath)
    );
    await owner.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    await owner.publishInitial();
    await rm(workspace.init.workspace.workspaceRoot, { recursive: true, force: true });

    const member = new ContentVersionFacade(
      () => fake.client,
      new CollaborationContentReplicaStore(storePath)
    );
    await expect(member.listBootstrapCandidates()).resolves.toEqual([
      expect.objectContaining({
        workspaceId: "workspace-test",
        projectId: workspace.init.workspace.id,
        canvasId: "default",
        localReplica: null,
        authority: expect.objectContaining({ canMaterialize: true })
      })
    ]);
    const imported = await member.bootstrap({
      workspaceId: "workspace-test",
      projectId: workspace.init.workspace.id,
      canvasId: "default"
    });
    expect(imported).toMatchObject({
      outcome: "created",
      localCanvasId: "default",
      acknowledgement: "acknowledged",
      authority: {
        replicaStatus: "in_sync",
        localReplica: expect.objectContaining({ verification: "complete" })
      }
    });
    expect(imported.localProjectId).not.toBe(workspace.init.project.id);

    const restarted = new ContentVersionFacade(
      () => fake.client,
      new CollaborationContentReplicaStore(storePath)
    );
    await expect(restarted.listBootstrapCandidates()).resolves.toEqual([
      expect.objectContaining({
        localReplica: {
          projectId: imported.localProjectId,
          canvasId: "default"
        }
      })
    ]);
    await expect(
      restarted.bootstrap({
        workspaceId: "workspace-test",
        projectId: workspace.init.workspace.id,
        canvasId: "default"
      })
    ).resolves.toMatchObject({
      outcome: "reused",
      localProjectId: imported.localProjectId
    });
    await expect(
      restarted.resolveCanvasScope({
        kind: "local",
        localProjectId: imported.localProjectId,
        canvasId: "default"
      })
    ).resolves.toEqual({
      workspaceId: "workspace-test",
      projectId: workspace.init.workspace.id,
      canvasId: "default"
    });
  });

  it("matches the complete remote identity when workspaces expose the same canvas id", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const originalRegistry = fake.client.registry();
    fake.client.registry = (() => ({
      listCanvases: vi.fn(async () => ({
        items: [
          {
            schemaVersion: "project-access/v1" as const,
            registry: {
              projectRegistryId: "project-registry-other",
              canvasRegistryId: "canvas-registry-other",
              workspaceId: "workspace-other",
              projectId: workspace.init.workspace.id,
              canvasId: "default"
            },
            visibility: "shared" as const,
            acl: { revision: 1, updatedAt: "2026-07-28T00:00:00.000Z" },
            owner: "human-owner",
            updatedAt: "2026-07-28T00:00:00.000Z"
          },
          ...(
            await originalRegistry.listCanvases({
              projectId: workspace.init.workspace.id,
              cursor: 0,
              limit: 100
            })
          ).items
        ],
        nextCursor: null
      }))
    })) as CollaborationClient["registry"];
    const owner = new ContentVersionFacade(() => fake.client);
    await owner.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    await owner.publishInitial();
    await rm(workspace.init.workspace.workspaceRoot, { recursive: true, force: true });

    const member = new ContentVersionFacade(() => fake.client);
    await expect(
      member.bootstrap(bootstrapScope(workspace.init.workspace.id, "workspace-test"))
    ).resolves.toMatchObject({ outcome: "created" });
  });

  it("clears the cached authority model when the active profile changes", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const first = fakeClient(workspace.init.workspace.id);
    const second = fakeClient(workspace.init.workspace.id);
    second.client.connectionProfile.profileId = "profile-other";
    let active = first.client;
    const facade = new ContentVersionFacade(() => active);
    await facade.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    await expect(facade.read()).resolves.not.toBeNull();

    active = second.client;
    await expect(facade.read()).resolves.toBeNull();
  });

  it("removes a stale mapping when its local project no longer exists", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const storePath = join(workspace.home, "replicas-stale.json");
    const store = new CollaborationContentReplicaStore(storePath);
    const owner = new ContentVersionFacade(() => fake.client, store);
    await owner.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    await owner.publishInitial();
    await rm(workspace.init.workspace.workspaceRoot, { recursive: true, force: true });
    const member = new ContentVersionFacade(() => fake.client, store);
    const imported = await member.bootstrap(bootstrapScope(workspace.init.workspace.id));
    const importedProject = (await listProjects()).find(
      (project) => project.projectId === imported.localProjectId
    );
    expect(importedProject).toBeDefined();
    await rm(importedProject!.rootPath, { recursive: true, force: true });

    await expect(member.listBootstrapCandidates()).resolves.toEqual([
      expect.objectContaining({ localReplica: null })
    ]);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("resumes an importing reservation after completion was interrupted", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const store = new CollaborationContentReplicaStore(
      join(workspace.home, "replicas-resume.json")
    );
    const owner = new ContentVersionFacade(() => fake.client);
    await owner.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    await owner.publishInitial();
    await rm(workspace.init.workspace.workspaceRoot, { recursive: true, force: true });
    let interruptCompletion = true;
    const interruptedStore: CollaborationContentReplicaStorePort = {
      list: () => store.list(),
      add: (replica) => store.add(replica),
      reserve: (replica) => store.reserve(replica),
      complete: (remote) => {
        if (interruptCompletion) {
          interruptCompletion = false;
          return Promise.reject(new Error("simulated_process_interruption"));
        }
        return store.complete(remote);
      },
      remove: (remote) => store.remove(remote)
    };
    const member = new ContentVersionFacade(() => fake.client, interruptedStore);
    const before = await listProjects();
    await expect(member.bootstrap(bootstrapScope(workspace.init.workspace.id))).rejects.toThrow(
      "simulated_process_interruption"
    );
    const afterInterruption = await listProjects();
    expect(afterInterruption).toHaveLength(before.length + 1);
    await expect(store.list()).resolves.toEqual([expect.objectContaining({ phase: "importing" })]);

    const restarted = new ContentVersionFacade(() => fake.client, store);
    await expect(
      restarted.bootstrap(bootstrapScope(workspace.init.workspace.id))
    ).resolves.toMatchObject({ outcome: "created" });
    await expect(listProjects()).resolves.toHaveLength(afterInterruption.length);
    await expect(store.list()).resolves.toEqual([expect.objectContaining({ phase: "ready" })]);
  });

  it("preserves and resumes an importing reservation when only its ownership marker exists", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const owner = new ContentVersionFacade(() => fake.client);
    await owner.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    const published = await owner.publishInitial();
    const fetched = await fake.client.fetchContentVersion({
      scope: published.authoritativeHead!.scope,
      content: published.authoritativeHead!.content
    });
    await rm(workspace.init.workspace.workspaceRoot, { recursive: true, force: true });
    const planned = await planManagedProjectFromAuthoritativeContent({ content: fetched.content });
    const token = "marker-only-interrupted-import";
    const store = new CollaborationContentReplicaStore(
      join(workspace.home, "replicas-marker-only.json")
    );
    const timestamp = "2026-08-01T00:00:00.000Z";
    await store.reserve({
      remote: {
        serverOrigin: "http://127.0.0.1:50653",
        ...bootstrapScope(workspace.init.workspace.id)
      },
      local: { projectId: planned.projectId, canvasId: planned.canvasId },
      phase: "importing",
      projectName: planned.projectName,
      reservationToken: token,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const reservedRoot = join(workspace.home, "projects", planned.projectId);
    await mkdir(reservedRoot, { recursive: true });
    await writeFile(join(reservedRoot, ".planweave-content-replica-reservation"), `${token}\n`);

    const restarted = new ContentVersionFacade(() => fake.client, store);
    await expect(restarted.listBootstrapCandidates()).resolves.toEqual([
      expect.objectContaining({ localReplica: null })
    ]);
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ phase: "importing", reservationToken: token })
    ]);
    await expect(
      restarted.bootstrap(bootstrapScope(workspace.init.workspace.id))
    ).resolves.toMatchObject({ outcome: "created" });
    await expect(store.list()).resolves.toEqual([expect.objectContaining({ phase: "ready" })]);
  });

  it("never resumes into an unrelated project that appeared after reservation", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const owner = new ContentVersionFacade(() => fake.client);
    await owner.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    const published = await owner.publishInitial();
    const headRef = published.authoritativeHead!.content;
    const fetched = await fake.client.fetchContentVersion({
      scope: published.authoritativeHead!.scope,
      content: headRef
    });
    await rm(workspace.init.workspace.workspaceRoot, { recursive: true, force: true });
    const planned = await planManagedProjectFromAuthoritativeContent({ content: fetched.content });
    const store = new CollaborationContentReplicaStore(join(workspace.home, "replicas-owner.json"));
    const timestamp = "2026-08-01T00:00:00.000Z";
    await store.reserve({
      remote: {
        serverOrigin: "http://127.0.0.1:50653",
        ...bootstrapScope(workspace.init.workspace.id)
      },
      local: { projectId: planned.projectId, canvasId: planned.canvasId },
      phase: "importing",
      projectName: planned.projectName,
      reservationToken: "reservation-owned-by-interrupted-import",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const unrelated = await initManagedWorkspace({ name: planned.projectName, projectGraph: true });
    expect(unrelated.created).toBe(true);

    const member = new ContentVersionFacade(() => fake.client, store);
    await expect(member.bootstrap(bootstrapScope(workspace.init.workspace.id))).rejects.toThrow(
      "content_local_project_reservation_conflict"
    );
    await expect(listProjects()).resolves.toEqual([
      expect.objectContaining({ projectId: unrelated.project.id })
    ]);
  });

  it("rejects fetched content whose Server scope differs from the selected registry entry", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const owner = new ContentVersionFacade(() => fake.client);
    await owner.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    await owner.publishInitial();
    await rm(workspace.init.workspace.workspaceRoot, { recursive: true, force: true });
    const originalFetch = fake.client.fetchContentVersion.bind(fake.client);
    fake.client.fetchContentVersion = vi.fn(async (input) => ({
      ...(await originalFetch(input)),
      scope: {
        workspaceId: "workspace-other",
        projectId: workspace.init.workspace.id,
        canvasId: "default"
      }
    }));

    const member = new ContentVersionFacade(() => fake.client);
    await expect(
      member.bootstrap(bootstrapScope(workspace.init.workspace.id))
    ).rejects.toMatchObject({ code: "content_authoritative_scope_mismatch" });
  });

  it("does not create a local project when the replica reservation cannot be persisted", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const owner = new ContentVersionFacade(
      () => fake.client,
      new CollaborationContentReplicaStore(join(workspace.home, "owner-replicas.json"))
    );
    await owner.bind({
      kind: "local",
      localProjectId: workspace.init.project.id,
      canvasId: "default"
    });
    await owner.publishInitial();
    await rm(workspace.init.workspace.workspaceRoot, { recursive: true, force: true });
    const before = await listProjects();
    const failingStore: CollaborationContentReplicaStorePort = {
      list: async () => [],
      add: async () => {
        throw new Error("mapping_commit_failed");
      },
      reserve: async () => {
        throw new Error("mapping_commit_failed");
      },
      complete: async () => {
        throw new Error("mapping_commit_failed");
      },
      remove: async () => undefined
    };

    const member = new ContentVersionFacade(() => fake.client, failingStore);
    await expect(
      member.bootstrap({
        workspaceId: "workspace-test",
        projectId: workspace.init.workspace.id,
        canvasId: "default"
      })
    ).rejects.toThrow("mapping_commit_failed");
    await expect(listProjects()).resolves.toEqual(before);
    expect(fake.calls.acknowledgeContentVersion).toHaveBeenCalledTimes(1);
  });
});
