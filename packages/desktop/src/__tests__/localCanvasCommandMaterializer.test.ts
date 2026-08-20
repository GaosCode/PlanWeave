import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasCommandAcceptedSchema,
  canvasReconnectDeltaSchema,
  canvasReconnectSnapshotSchema
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import {
  applyAuthorizedCanvasCommand,
  captureAuthorizedCanvasContent,
  readAuthorizedCanvasContentDigest
} from "@planweave-ai/runtime";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { readJsonFile, writeJsonFile } from "../../../runtime/src/json.js";
import type { ProjectMetadata } from "../../../runtime/src/projectMetadata.js";
import { getDesktopLayoutDirect } from "../../../runtime/src/desktop/layoutStore.js";
import { LocalCanvasCommandMaterializer } from "../main/collaboration/LocalCanvasCommandMaterializer.js";
import { collaborationCanvasBindingInputSchema } from "../shared/collaboration.js";

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

function scope(projectId: string) {
  return { workspaceId: "workspace-001", projectId, canvasId: "default" };
}

describe("LocalCanvasCommandMaterializer", () => {
  it("uses the remote project identity when hashing independently imported replicas", async () => {
    const first = await createTestWorkspace(basicManifest());
    const second = await createTestWorkspace(basicManifest());
    directories.push(first.home, first.root, second.home, second.root);
    expect(first.init.workspace.id).not.toBe(second.init.workspace.id);

    const firstDigest = await readAuthorizedCanvasContentDigest({
      projectRoot: first.init.workspace,
      canvasId: "default",
      authorityProjectId: "remote-project"
    });
    const secondDigest = await readAuthorizedCanvasContentDigest({
      projectRoot: second.init.workspace,
      canvasId: "default",
      authorityProjectId: "remote-project"
    });
    if (!firstDigest.ok) throw new Error(firstDigest.code);
    if (!secondDigest.ok) throw new Error(secondDigest.code);

    expect(firstDigest.contentDigest).toBe(secondDigest.contentDigest);
  });

  it("binds from the registered project root without accepting a renderer path", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    process.env.PLANWEAVE_HOME = workspace.home;
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(workspace.home, "desktop-settings.json");

    expect(
      collaborationCanvasBindingInputSchema.parse({
        kind: "local",
        localProjectId: workspace.init.workspace.id,
        canvasId: "default"
      })
    ).toEqual({
      kind: "local",
      localProjectId: workspace.init.workspace.id,
      canvasId: "default"
    });
    expect(() =>
      collaborationCanvasBindingInputSchema.parse({
        kind: "local",
        localProjectId: workspace.init.workspace.id,
        canvasId: "default",
        projectRoot: workspace.root
      })
    ).toThrow();

    const binding = await new LocalCanvasCommandMaterializer().bind({
      projectId: workspace.init.workspace.id,
      canvasId: "default",
      authorityProjectId: workspace.init.workspace.id
    });
    expect(binding.projectRoot).toBe(await realpath(workspace.root));
  });

  it("fails closed when the connected project is not locally registered", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    process.env.PLANWEAVE_HOME = workspace.home;
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(workspace.home, "desktop-settings.json");

    await expect(
      new LocalCanvasCommandMaterializer().bind({
        projectId: "missing-project",
        canvasId: "default",
        authorityProjectId: "remote-project"
      })
    ).rejects.toMatchObject({ code: "collaboration_canvas_local_project_not_registered" });
  });

  it("materializes a server-confirmed content snapshot into the registered local replica", async () => {
    const source = await createTestWorkspace(basicManifest());
    directories.push(source.home, source.root);
    const projectId = source.init.workspace.id;
    const replicaHome = await mkdtemp(join(tmpdir(), "planweave-confirmed-replica-home-"));
    const replicaRoot = join(replicaHome, "projects", projectId);
    directories.push(replicaHome);
    await cp(source.init.workspace.workspaceRoot, replicaRoot, { recursive: true });
    const replicaProjectFile = join(replicaRoot, "project.json");
    const replicaMetadata = await readJsonFile<ProjectMetadata>(replicaProjectFile);
    await writeJsonFile(replicaProjectFile, {
      ...replicaMetadata,
      rootPath: replicaRoot,
      sourceRoot: replicaRoot
    });

    const updated = await applyAuthorizedCanvasCommand({
      projectRoot: source.init.workspace,
      canvasId: "default",
      authorityProjectId: projectId,
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# confirmed replica prompt\n"
      }
    });
    if (!updated.ok) throw new Error(updated.code);
    const captured = await captureAuthorizedCanvasContent({
      projectRoot: source.init.workspace,
      canvasId: "default",
      authorityProjectId: projectId
    });

    process.env.PLANWEAVE_HOME = replicaHome;
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(replicaHome, "desktop-settings.json");
    const materializer = new LocalCanvasCommandMaterializer();
    const binding = await materializer.bind({
      projectId,
      canvasId: "default",
      authorityProjectId: projectId
    });
    await materializer.materializeConfirmed(binding, {
      content: captured.content,
      contentDigest: updated.contentDigest
    });

    await expect(
      readFile(
        join(replicaRoot, "canvases", "default", "package", "nodes", "T-001", "prompt.md"),
        "utf8"
      )
    ).resolves.toBe("# confirmed replica prompt\n");
    expect(binding.expectedContentDigest).toBe(updated.contentDigest);
  });

  it("converges a delta into an independently rooted registered project and skips co-located accepted content", async () => {
    const source = await createTestWorkspace(basicManifest());
    directories.push(source.home, source.root);
    const projectId = source.init.workspace.id;
    const replicaHome = await mkdtemp(join(tmpdir(), "planweave-replica-home-"));
    const replicaRoot = join(replicaHome, "projects", projectId);
    directories.push(replicaHome);
    await cp(source.init.workspace.workspaceRoot, replicaRoot, { recursive: true });
    const replicaProjectFile = join(replicaRoot, "project.json");
    const replicaMetadata = await readJsonFile<ProjectMetadata>(replicaProjectFile);
    await writeJsonFile(replicaProjectFile, {
      ...replicaMetadata,
      rootPath: replicaRoot,
      sourceRoot: replicaRoot
    });

    const updateIntent = {
      kind: "update_task_prompt" as const,
      taskId: "T-001",
      promptMarkdown: "# replicated prompt\n"
    };
    const sourceResult = await applyAuthorizedCanvasCommand({
      projectRoot: source.init.workspace,
      canvasId: "default",
      intent: updateIntent
    });
    if (!sourceResult.ok) throw new Error(sourceResult.code);

    process.env.PLANWEAVE_HOME = replicaHome;
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(replicaHome, "desktop-settings.json");
    const replicaMaterializer = new LocalCanvasCommandMaterializer();
    const replicaBinding = await replicaMaterializer.bind({
      projectId,
      canvasId: "default"
    });
    expect(replicaBinding.projectRoot).toBe(replicaRoot);
    const delta = canvasReconnectDeltaSchema.parse({
      type: "canvas.reconnect.delta",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: scope(projectId),
      afterRevision: 0,
      headRevision: 1,
      headContentDigest: sourceResult.contentDigest,
      entries: [
        {
          schemaVersion: "canvas-journal/v1",
          entryId: "journal-001",
          scope: scope(projectId),
          revision: 1,
          previousRevision: 0,
          operationId: "operation-001",
          intent: updateIntent,
          intentDigest: "0".repeat(64),
          contentDigest: sourceResult.contentDigest,
          actor: { kind: "human", id: "human-001", displayName: "Replica writer" },
          acceptedAt: "2026-07-28T00:00:00.000Z"
        }
      ]
    });
    await replicaMaterializer.materializeReconnect(replicaBinding, {
      response: delta,
      entriesToApply: delta.entries,
      snapshotRequired: false
    });
    await expect(
      readFile(
        join(replicaRoot, "canvases", "default", "package", "nodes", "T-001", "prompt.md"),
        "utf8"
      )
    ).resolves.toBe("# replicated prompt\n");

    process.env.PLANWEAVE_HOME = source.home;
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(source.home, "desktop-settings.json");
    const sourceMaterializer = new LocalCanvasCommandMaterializer();
    const sourceBinding = await sourceMaterializer.bind({
      projectId,
      canvasId: "default"
    });
    const removeIntent = { kind: "remove_task" as const, taskId: "T-001" };
    const removed = await applyAuthorizedCanvasCommand({
      projectRoot: source.init.workspace,
      canvasId: "default",
      intent: removeIntent
    });
    if (!removed.ok) throw new Error(removed.code);
    const accepted = canvasCommandAcceptedSchema.parse({
      type: "canvas.command.accepted",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: scope(projectId),
      operationId: "operation-002",
      revision: 2,
      previousRevision: 1,
      contentDigest: removed.contentDigest,
      journalEntryId: "journal-002",
      actor: { kind: "human", id: "human-001", displayName: "Source writer" },
      acceptedAt: "2026-07-28T00:01:00.000Z",
      idempotentReplay: false
    });
    await expect(
      sourceMaterializer.materializeAccepted(sourceBinding, accepted, removeIntent)
    ).resolves.toBeUndefined();
    const captured = await captureAuthorizedCanvasContent({
      projectRoot: source.root,
      canvasId: "default",
      authorityProjectId: projectId
    });

    const snapshot = canvasReconnectSnapshotSchema.parse({
      type: "canvas.reconnect.snapshot",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: scope(projectId),
      reason: "retention_gap",
      afterRevision: 1,
      snapshot: {
        metadata: {
          schemaVersion: "canvas-snapshot/v2",
          scope: scope(projectId),
          revision: 2,
          contentDigest: removed.contentDigest,
          createdAt: "2026-07-28T00:01:00.000Z",
          sizeBytes: captured.content.totalBytes
        },
        encoding: "content_version_ref",
        content: {
          versionId: `version-${captured.content.canonicalDigest}`,
          canonicalDigest: captured.content.canonicalDigest,
          verification: "complete"
        }
      }
    });
    await expect(
      sourceMaterializer.materializeReconnect(sourceBinding, {
        response: snapshot,
        entriesToApply: [],
        snapshotRequired: true,
        snapshotContent: captured.content
      })
    ).resolves.toBeUndefined();
    expect(sourceBinding.expectedContentDigest).toBe(snapshot.snapshot.metadata.contentDigest);

    const staleBinding = await sourceMaterializer.bind({
      projectId: source.init.workspace.id,
      canvasId: "default",
      authorityProjectId: projectId
    });
    await expect(
      sourceMaterializer.materializeReconnect(staleBinding, {
        response: {
          ...snapshot,
          snapshot: {
            ...snapshot.snapshot,
            metadata: {
              ...snapshot.snapshot.metadata,
              contentDigest: "f".repeat(64)
            }
          }
        },
        entriesToApply: [],
        snapshotRequired: true,
        snapshotContent: captured.content
      })
    ).rejects.toMatchObject({
      code: "collaboration_canvas_snapshot_materialized_digest_mismatch",
      retryable: true
    });
  });

  it("materializes layout-only commands because command digests cover canonical layout content", async () => {
    const source = await createTestWorkspace(basicManifest());
    directories.push(source.home, source.root);
    const projectId = source.init.workspace.id;
    const replicaHome = await mkdtemp(join(tmpdir(), "planweave-layout-replica-home-"));
    const replicaRoot = join(replicaHome, "projects", projectId);
    directories.push(replicaHome);
    await cp(source.init.workspace.workspaceRoot, replicaRoot, { recursive: true });
    const replicaProjectFile = join(replicaRoot, "project.json");
    const replicaMetadata = await readJsonFile<ProjectMetadata>(replicaProjectFile);
    await writeJsonFile(replicaProjectFile, {
      ...replicaMetadata,
      rootPath: replicaRoot,
      sourceRoot: replicaRoot
    });

    process.env.PLANWEAVE_HOME = replicaHome;
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(replicaHome, "desktop-settings.json");
    const materializer = new LocalCanvasCommandMaterializer();
    const binding = await materializer.bind({
      projectId,
      canvasId: "default",
      authorityProjectId: projectId
    });
    const initialDigest = binding.expectedContentDigest;

    const intent = {
      kind: "update_layout" as const,
      nodes: [{ nodeId: "T-001", x: 321, y: 654 }],
      updatedAt: "2026-08-02T00:00:00.000Z"
    };
    const sourceResult = await applyAuthorizedCanvasCommand({
      projectRoot: source.init.workspace,
      canvasId: "default",
      intent
    });
    if (!sourceResult.ok) throw new Error(sourceResult.code);
    expect(sourceResult.contentDigest).not.toBe(initialDigest);

    const delta = canvasReconnectDeltaSchema.parse({
      type: "canvas.reconnect.delta",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: scope(projectId),
      afterRevision: 0,
      headRevision: 1,
      headContentDigest: sourceResult.contentDigest,
      entries: [
        {
          schemaVersion: "canvas-journal/v1",
          entryId: "journal-layout-001",
          scope: scope(projectId),
          revision: 1,
          previousRevision: 0,
          operationId: "operation-layout-001",
          intent,
          intentDigest: "0".repeat(64),
          contentDigest: sourceResult.contentDigest,
          actor: { kind: "human", id: "human-001", displayName: "Layout writer" },
          acceptedAt: "2026-08-02T00:00:00.000Z"
        }
      ]
    });
    await materializer.materializeReconnect(binding, {
      response: delta,
      entriesToApply: delta.entries,
      snapshotRequired: false
    });

    const replicaLayout = await getDesktopLayoutDirect(replicaRoot);
    expect(replicaLayout.nodes).toContainEqual({ nodeId: "T-001", x: 321, y: 654 });
    expect(replicaLayout.updatedAt).toBe(intent.updatedAt);
    expect(binding.expectedContentDigest).toBe(sourceResult.contentDigest);
  });
});
