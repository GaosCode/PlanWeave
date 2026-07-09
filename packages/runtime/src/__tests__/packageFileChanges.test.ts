import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshPromptMockState = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  calls: [] as string[],
  failRefs: new Set<string>()
}));

vi.mock("../prompt/refreshPrompt.js", () => ({
  refreshPrompt: async (options: { ref: string }) => {
    refreshPromptMockState.active += 1;
    refreshPromptMockState.maxActive = Math.max(
      refreshPromptMockState.maxActive,
      refreshPromptMockState.active
    );
    refreshPromptMockState.calls.push(options.ref);
    await new Promise((resolve) => setTimeout(resolve, 5));
    refreshPromptMockState.active -= 1;
    if (refreshPromptMockState.failRefs.has(options.ref)) {
      throw new Error(`refresh failed for ${options.ref}`);
    }
    return { ref: options.ref, path: "", markdown: `rendered ${options.ref}` };
  }
}));
import {
  createPackageFileSnapshot,
  detectPackageFileChanges,
  normalizePackageChangedPaths,
  refreshChangedPackagePrompts,
  refreshChangedPackagePromptsForPaths
} from "../package/fileChanges.js";
import type { PromptRefreshStats } from "../package/fileChanges.js";
import { affectedTasksForPackageFileChange } from "../graph/editGraph.js";
import {
  createExecutionGraphSession,
  createExecutionGraphSessionFromSnapshot,
  drainGraphReadQueue,
  enqueueGraphEditOperations
} from "../graph/session.js";
import { writeJsonFile } from "../json.js";
import { createTaskCanvas, selectTaskCanvas } from "../desktop/index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

function expectRefreshStats(
  stats: PromptRefreshStats,
  expected: Omit<PromptRefreshStats, "elapsedMs">
): void {
  expect(stats).toMatchObject(expected);
  expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
}

describe("package file changes", () => {
  beforeEach(() => {
    refreshPromptMockState.active = 0;
    refreshPromptMockState.maxActive = 0;
    refreshPromptMockState.calls = [];
    refreshPromptMockState.failRefs.clear();
  });

  it("detects block prompt changes and refreshes rendered prompt surfaces", async () => {
    const { root, init } = await createTestWorkspace();
    const before = await createPackageFileSnapshot(root);
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"),
      "updated block prompt\n",
      "utf8"
    );

    const detected = await detectPackageFileChanges(root, before);
    const refreshed = await refreshChangedPackagePrompts(root, before);

    expect(detected.impact.ok).toBe(true);
    expect(detected.impact.fullRefresh).toBe(true);
    expect(detected.impact.affectedTasks).toEqual(["T-001"]);
    expect(refreshed.refreshed.map((prompt) => prompt.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
    expectRefreshStats(refreshed.refreshStats, {
      requested: 2,
      refreshed: 2,
      concurrency: null,
      changedPathCount: 1,
      refreshedRefs: 2,
      mode: "full"
    });
  });

  it("refreshes a changed block prompt path incrementally", async () => {
    const { root, init } = await createTestWorkspace();
    const before = await createPackageFileSnapshot(root);
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"),
      "updated block prompt\n",
      "utf8"
    );

    const refreshed = await refreshChangedPackagePromptsForPaths(root, before, [
      "package/nodes/T-001/blocks/B-001.prompt.md"
    ]);

    expect(refreshed.incremental).toBe(true);
    expect(refreshed.changedPackagePaths).toEqual(["nodes/T-001/blocks/B-001.prompt.md"]);
    expect(refreshed.impact).toMatchObject({
      ok: true,
      fullRefresh: false,
      affectedTasks: ["T-001"],
      diagnostics: []
    });
    expect(refreshed.refreshed.map((prompt) => prompt.ref)).toEqual(["T-001#B-001"]);
    expectRefreshStats(refreshed.refreshStats, {
      requested: 1,
      refreshed: 1,
      concurrency: 4,
      changedPathCount: 1,
      refreshedRefs: 1,
      mode: "incremental"
    });
  });

  it("refreshes a changed task prompt path incrementally", async () => {
    const { root, init } = await createTestWorkspace();
    const before = await createPackageFileSnapshot(root);
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"),
      "updated task prompt\n",
      "utf8"
    );

    const refreshed = await refreshChangedPackagePromptsForPaths(root, before, [
      "nodes/T-001/prompt.md"
    ]);

    expect(refreshed.incremental).toBe(true);
    expect(refreshed.changedPackagePaths).toEqual(["nodes/T-001/prompt.md"]);
    expect(refreshed.impact).toMatchObject({
      ok: true,
      fullRefresh: false,
      affectedTasks: ["T-001"],
      diagnostics: []
    });
    expect(refreshed.refreshed.map((prompt) => prompt.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
    expectRefreshStats(refreshed.refreshStats, {
      requested: 2,
      refreshed: 2,
      concurrency: 4,
      changedPathCount: 1,
      refreshedRefs: 2,
      mode: "incremental"
    });
  });

  it("dedupes refresh refs for batched task and block prompt changed paths", async () => {
    const { root, init } = await createTestWorkspace();
    const before = await createPackageFileSnapshot(root);
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"),
      "updated task prompt\n",
      "utf8"
    );
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"),
      "updated block prompt\n",
      "utf8"
    );

    const refreshed = await refreshChangedPackagePromptsForPaths(root, before, [
      "package/nodes/T-001/blocks/B-001.prompt.md",
      "nodes/T-001/prompt.md",
      "package/nodes/T-001/prompt.md"
    ]);

    expect(refreshed.incremental).toBe(true);
    expect(refreshed.changedPackagePaths).toEqual([
      "nodes/T-001/blocks/B-001.prompt.md",
      "nodes/T-001/prompt.md"
    ]);
    expect(refreshPromptMockState.calls).toEqual(["T-001#B-001", "T-001#R-001"]);
    expect(refreshed.refreshed.map((prompt) => prompt.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
    expectRefreshStats(refreshed.refreshStats, {
      requested: 2,
      refreshed: 2,
      concurrency: 4,
      changedPathCount: 2,
      refreshedRefs: 2,
      mode: "incremental"
    });
  });

  it("limits incremental prompt refresh concurrency and preserves ref order", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.id === "T-001");
    if (!task || task.type !== "task") {
      throw new Error("missing T-001 task");
    }
    task.blocks = Array.from({ length: 6 }, (_, index) => {
      const id = `B-${String(index + 1).padStart(3, "0")}`;
      return {
        id,
        type: "implementation" as const,
        title: `Implement ${id}`,
        prompt: `nodes/T-001/blocks/${id}.prompt.md`,
        depends_on: [],
        parallel: { locks: [id] }
      };
    });
    const { root, init } = await createTestWorkspace(manifest);
    const before = await createPackageFileSnapshot(root);
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"),
      "updated task prompt\n",
      "utf8"
    );

    const refreshed = await refreshChangedPackagePromptsForPaths(root, before, [
      "nodes/T-001/prompt.md"
    ]);

    const expectedRefs = [
      "T-001#B-001",
      "T-001#B-002",
      "T-001#B-003",
      "T-001#B-004",
      "T-001#B-005",
      "T-001#B-006"
    ];
    expect(refreshPromptMockState.maxActive).toBeLessThanOrEqual(4);
    expect(refreshPromptMockState.calls).toEqual(expectedRefs);
    expect(refreshed.refreshed.map((prompt) => prompt.ref)).toEqual(expectedRefs);
    expectRefreshStats(refreshed.refreshStats, {
      requested: 6,
      refreshed: 6,
      concurrency: 4,
      changedPathCount: 1,
      refreshedRefs: 6,
      mode: "incremental"
    });
  });

  it("normalizes custom prompt refresh concurrency to at least one", async () => {
    const { root, init } = await createTestWorkspace();
    const before = await createPackageFileSnapshot(root);
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "prompt.md"),
      "updated task prompt\n",
      "utf8"
    );

    const refreshed = await refreshChangedPackagePromptsForPaths(
      root,
      before,
      ["nodes/T-001/prompt.md"],
      { refreshConcurrency: 0 }
    );

    expect(refreshPromptMockState.maxActive).toBe(1);
    expectRefreshStats(refreshed.refreshStats, {
      requested: 2,
      refreshed: 2,
      concurrency: 1,
      changedPathCount: 1,
      refreshedRefs: 2,
      mode: "incremental"
    });
  });

  it("falls back to a full refresh when an incremental prompt refresh fails", async () => {
    const { root, init } = await createTestWorkspace();
    const before = await createPackageFileSnapshot(root);
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"),
      "updated block prompt\n",
      "utf8"
    );
    refreshPromptMockState.failRefs.add("T-001#B-001");

    const refreshed = await refreshChangedPackagePromptsForPaths(root, before, [
      "package/nodes/T-001/blocks/B-001.prompt.md"
    ]);

    expect(refreshed.incremental).toBe(false);
    expect(refreshed.refreshed.map((prompt) => prompt.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
    expectRefreshStats(refreshed.refreshStats, {
      requested: 2,
      refreshed: 2,
      concurrency: null,
      changedPathCount: 1,
      refreshedRefs: 2,
      mode: "full"
    });
    expect(refreshed.impact.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "package_change_incremental_refresh_failed"
    );
  });

  it("falls back to a full refresh for manifest, unknown, empty, and coarse watcher paths", async () => {
    const { root } = await createTestWorkspace();
    const before = await createPackageFileSnapshot(root);

    await expect(
      refreshChangedPackagePromptsForPaths(root, before, ["package/manifest.json"])
    ).resolves.toMatchObject({
      incremental: false,
      changedPackagePaths: ["manifest.json"],
      refreshStats: expect.objectContaining({
        changedPathCount: 1,
        mode: "full"
      }),
      impact: {
        ok: true,
        diagnostics: [
          expect.objectContaining({ code: "package_change_manifest_requires_full_refresh" })
        ]
      }
    });
    await expect(
      refreshChangedPackagePromptsForPaths(root, before, ["package/nodes/T-001"])
    ).resolves.toMatchObject({
      incremental: false,
      changedPackagePaths: ["nodes/T-001"],
      refreshStats: expect.objectContaining({
        changedPathCount: 1,
        mode: "full"
      }),
      impact: {
        ok: true,
        diagnostics: [
          expect.objectContaining({ code: "package_change_coarse_path_requires_full_refresh" })
        ]
      }
    });
    await expect(
      refreshChangedPackagePromptsForPaths(root, before, ["package/results/report.md"])
    ).resolves.toMatchObject({
      incremental: false,
      changedPackagePaths: ["results/report.md"],
      impact: {
        ok: true,
        diagnostics: [
          expect.objectContaining({ code: "package_change_unknown_path_requires_full_refresh" })
        ]
      }
    });
    await expect(refreshChangedPackagePromptsForPaths(root, before, [])).resolves.toMatchObject({
      incremental: false,
      changedPackagePaths: ["manifest.json"],
      refreshStats: expect.objectContaining({
        changedPathCount: 1,
        mode: "full"
      }),
      impact: {
        ok: true,
        diagnostics: [expect.objectContaining({ code: "package_change_paths_empty" })]
      }
    });
  });

  it("does not treat the project prompt policy path as a package prompt", async () => {
    const { root } = await createTestWorkspace();
    const before = await createPackageFileSnapshot(root);

    const refreshed = await refreshChangedPackagePromptsForPaths(root, before, [
      "policy/project-prompt.md"
    ]);

    expect(refreshed.incremental).toBe(false);
    expect(refreshed.changedPackagePaths).toEqual(["policy/project-prompt.md"]);
    expect(refreshed.impact.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "package_change_non_package_prompt"
    );
    expect(refreshed.snapshot?.promptFiles).toEqual(before.promptFiles);
  });

  it("treats a missing nodes directory as an empty prompt file snapshot", async () => {
    const { root, init } = await createTestWorkspace();
    await rm(join(init.workspace.packageDir, "nodes"), { recursive: true, force: true });

    const snapshot = await createPackageFileSnapshot(root);

    expect(snapshot.promptFiles).toEqual({});
  });

  it("falls back to a full refresh for added prompt files that are not in the current graph", async () => {
    const { root, init } = await createTestWorkspace();
    const before = await createPackageFileSnapshot(root);
    await mkdir(join(init.workspace.packageDir, "nodes", "T-001", "blocks"), { recursive: true });
    await writeFile(
      join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-002.prompt.md"),
      "new prompt\n",
      "utf8"
    );

    const refreshed = await refreshChangedPackagePromptsForPaths(root, before, [
      "package/nodes/T-001/blocks/B-002.prompt.md"
    ]);

    expect(refreshed.incremental).toBe(false);
    expect(refreshed.impact.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "package_change_prompt_not_in_graph"
    );
  });

  it("reports incremental refresh failure and falls back when a referenced prompt file is deleted", async () => {
    const { root, init } = await createTestWorkspace();
    const before = await createPackageFileSnapshot(root);
    await rm(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"));

    const refreshed = await refreshChangedPackagePromptsForPaths(root, before, [
      "package/nodes/T-001/blocks/B-001.prompt.md"
    ]);

    expect(refreshed.incremental).toBe(false);
    expect(refreshed.snapshot).toBeNull();
    expect(refreshed.changedPackagePaths).toEqual(["nodes/T-001/blocks/B-001.prompt.md"]);
    expect(refreshed.indexPackagePaths).toEqual(["manifest.json"]);
    expect(refreshed.impact.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["package_change_incremental_refresh_failed", "prompt_missing"])
    );
  });

  it("normalizes watcher path prefixes and trailing separators for package prompt files", () => {
    expect(
      normalizePackageChangedPaths([
        "./package/nodes/T-001/prompt.md///",
        "nodes\\T-001\\blocks\\B-001.prompt.md\\",
        "nodes/T-001/prompt.md"
      ])
    ).toEqual({
      changedPackagePaths: ["nodes/T-001/prompt.md", "nodes/T-001/blocks/B-001.prompt.md"],
      diagnostics: [],
      incremental: true
    });
  });

  it("drains Graph Read Queue prompt changes into dirty prompt refs without replacing plan truth", async () => {
    const { root } = await createTestWorkspace();
    const session = await createExecutionGraphSession(root);

    session.readQueue.fileChanges.push({
      path: "nodes/T-001/blocks/B-001.prompt.md",
      type: "changed"
    });
    await drainGraphReadQueue(session);

    expect(session.readQueue.fileChanges).toEqual([]);
    expect([...session.dirtyPromptRefs]).toEqual(["T-001#B-001"]);
    expect(session.graph.blocksByRef.has("T-001#B-001")).toBe(true);
  });

  it("creates execution graph sessions from the package snapshot graph", async () => {
    const { root, init } = await createTestWorkspace();
    const snapshot = await createPackageFileSnapshot(root);
    const session = createExecutionGraphSessionFromSnapshot({
      projectRoot: init.workspace,
      workspace: init.workspace,
      snapshot
    });
    const loadedSession = await createExecutionGraphSession(root);

    expect(session.graph).toBe(snapshot.graph);
    expect(session.fileSnapshot).toBe(snapshot);
    expect(session.fileSnapshot.graph).toBe(session.graph);
    expect(session.fileSnapshot.manifest).toBe(snapshot.manifest);
    expect(session.diagnostics).toEqual([
      ...snapshot.graph.diagnostics.errors,
      ...snapshot.graph.diagnostics.warnings
    ]);
    expect(loadedSession.fileSnapshot.graph).toBe(loadedSession.graph);
    expect(loadedSession.diagnostics).toEqual([]);
  });

  it("rebuilds graph sessions from their original package root after the active canvas changes", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const session = await createExecutionGraphSession(root);
    const originalPackageRoot = session.packageRoot;
    const secondCanvas = await createTaskCanvas(root, { name: "Second plan" });
    await selectTaskCanvas(root, secondCanvas.canvasId);

    enqueueGraphEditOperations(session, [
      { type: "add_edge", edge: { from: "T-002", to: "T-001", type: "depends_on" } }
    ]);
    await drainGraphReadQueue(session);
    enqueueGraphEditOperations(session, [
      { type: "add_edge", edge: { from: "T-001", to: "T-002", type: "depends_on" } }
    ]);
    const result = await drainGraphReadQueue(session);

    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("depends_on_cycle");
    expect(session.packageRoot).toBe(originalPackageRoot);
    expect(session.fileSnapshot.manifest.nodes.map((node) => node.id)).toEqual(["T-001", "T-002"]);
    expect(session.graph.taskNodesInManifestOrder).toEqual(["T-001", "T-002"]);
  });

  it("applies structured graph ops incrementally and blocks local dependency cycles", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const session = await createExecutionGraphSession(root);
    const graph = session.graph;

    enqueueGraphEditOperations(session, [
      { type: "add_edge", edge: { from: "T-002", to: "T-001", type: "depends_on" } }
    ]);
    const first = await drainGraphReadQueue(session);

    expect(first.diagnostics).toEqual([]);
    expect(session.graph).toBe(graph);
    expect(session.graph.taskDependenciesByTask.get("T-002")).toEqual(["T-001"]);
    expect(session.graph.taskReachable("T-002", "T-001")).toBe(true);

    enqueueGraphEditOperations(session, [
      { type: "add_edge", edge: { from: "T-001", to: "T-002", type: "depends_on" } }
    ]);
    const second = await drainGraphReadQueue(session);

    expect(second.diagnostics.map((diagnostic) => diagnostic.code)).toContain("depends_on_cycle");
    expect(session.graph.taskDependenciesByTask.get("T-001")).toEqual([]);
  });

  it("keeps indexes and manifest order stable when incrementally updating a task node", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const session = await createExecutionGraphSession(root);
    const graph = session.graph;
    const current = session.graph.tasksById.get("T-001");
    if (!current) {
      throw new Error("missing T-001");
    }
    const updated = {
      ...current,
      title: "Updated task title",
      acceptance: [...current.acceptance, "Updated acceptance."]
    };

    enqueueGraphEditOperations(session, [{ type: "update_node", node: updated }]);
    const drained = await drainGraphReadQueue(session);

    expect(drained.diagnostics).toEqual([]);
    expect(session.graph).toBe(graph);
    expect(session.graph.nodesById.get("T-001")).toMatchObject({ title: "Updated task title" });
    expect(session.graph.tasksById.get("T-001")).toMatchObject({ title: "Updated task title" });
    expect(session.graph.taskNodesInManifestOrder).toEqual(["T-001", "T-002"]);
    expect(session.graph.blockRefsInManifestOrder.slice(0, 2)).toEqual([
      "T-001#B-001",
      "T-001#R-001"
    ]);
    expect(session.graph.blocksByTask.get("T-001")).toEqual(["T-001#B-001", "T-001#R-001"]);
  });

  it("removes dirty prompt refs for deleted task blocks", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const session = await createExecutionGraphSession(root);
    session.dirtyPromptRefs.add("T-001#B-001");
    session.dirtyPromptRefs.add("T-002#B-001");

    enqueueGraphEditOperations(session, [{ type: "remove_node", nodeId: "T-001" }]);
    const drained = await drainGraphReadQueue(session);

    expect(drained.diagnostics).toEqual([]);
    expect([...session.dirtyPromptRefs]).toEqual(["T-002#B-001"]);
    expect(session.graph.blocksByRef.has("T-001#B-001")).toBe(false);
  });

  it("clears stale graph op diagnostics after a later successful drain", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const session = await createExecutionGraphSession(root);

    enqueueGraphEditOperations(session, [
      { type: "add_edge", edge: { from: "MISSING", to: "T-001", type: "depends_on" } }
    ]);
    const failed = await drainGraphReadQueue(session);

    expect(failed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["edge_from_missing"]);
    expect(session.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["edge_from_missing"]);

    enqueueGraphEditOperations(session, [
      { type: "add_edge", edge: { from: "T-002", to: "T-001", type: "depends_on" } }
    ]);
    const succeeded = await drainGraphReadQueue(session);

    expect(succeeded.diagnostics).toEqual([]);
    expect(session.diagnostics).toEqual([]);
    expect(session.graph.taskDependenciesByTask.get("T-002")).toEqual(["T-001"]);
  });

  it("rebuilds from package truth instead of keeping partial graph op batch changes after failure", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const session = await createExecutionGraphSession(root);

    enqueueGraphEditOperations(session, [
      { type: "add_edge", edge: { from: "T-002", to: "T-001", type: "depends_on" } },
      { type: "add_edge", edge: { from: "MISSING", to: "T-001", type: "depends_on" } }
    ]);
    const drained = await drainGraphReadQueue(session);

    expect(drained.diagnostics.map((diagnostic) => diagnostic.code)).toContain("edge_from_missing");
    expect(session.fileSnapshot.manifest.edges).not.toContainEqual({
      from: "T-002",
      to: "T-001",
      type: "depends_on"
    });
    expect(session.graph.taskDependenciesByTask.get("T-002")).toEqual([]);
  });

  it("reports manifest change affected tasks without treating every task as dirty", async () => {
    const before = basicManifest({ includeSecondTask: true });
    const after = {
      ...before,
      edges: [...before.edges, { from: "T-002", to: "T-001", type: "depends_on" as const }]
    };

    const impact = affectedTasksForPackageFileChange({ kind: "manifest", before, after });

    expect(impact.ok).toBe(true);
    expect(impact.fullRefresh).toBe(false);
    expect(impact.affectedTasks).toEqual(["T-002"]);
  });

  it("drains manifest file changes through incremental graph index updates before rebuild fallback", async () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const { root, init } = await createTestWorkspace(manifest);
    const session = await createExecutionGraphSession(root);
    const graph = session.graph;
    const nextManifest = {
      ...manifest,
      edges: [...manifest.edges, { from: "T-002", to: "T-001", type: "depends_on" as const }]
    };

    await writeJsonFile(init.workspace.manifestFile, nextManifest);
    session.readQueue.fileChanges.push({ path: "manifest.json", type: "changed" });
    const drained = await drainGraphReadQueue(session);

    expect(drained.diagnostics).toEqual([]);
    expect(session.graph).toBe(graph);
    expect(session.graph.taskDependenciesByTask.get("T-002")).toEqual(["T-001"]);
    expect(session.graph.taskReachable("T-002", "T-001")).toBe(true);
    expect(session.fileSnapshot.manifest.edges).toContainEqual({
      from: "T-002",
      to: "T-001",
      type: "depends_on"
    });
  });
});
