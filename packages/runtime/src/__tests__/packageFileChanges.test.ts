import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPackageFileSnapshot, detectPackageFileChanges, refreshChangedPackagePrompts } from "../package/fileChanges.js";
import { affectedTasksForPackageFileChange } from "../graph/editGraph.js";
import { createExecutionGraphSession, drainGraphReadQueue, enqueueGraphEditOperations } from "../graph/session.js";
import { writeJsonFile } from "../json.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

describe("package file changes", () => {
  it("detects block prompt changes and refreshes rendered prompt surfaces", async () => {
    const { root, init } = await createTestWorkspace();
    const before = await createPackageFileSnapshot(root);
    await writeFile(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"), "updated block prompt\n", "utf8");

    const detected = await detectPackageFileChanges(root, before);
    const refreshed = await refreshChangedPackagePrompts(root, before);

    expect(detected.impact.ok).toBe(true);
    expect(detected.impact.fullRefresh).toBe(true);
    expect(detected.impact.affectedTasks).toEqual(["T-001"]);
    expect(refreshed.refreshed.map((prompt) => prompt.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
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

  it("applies structured graph ops incrementally and blocks local dependency cycles", async () => {
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const session = await createExecutionGraphSession(root);
    const graph = session.graph;

    enqueueGraphEditOperations(session, [{ type: "add_edge", edge: { from: "T-002", to: "T-001", type: "depends_on" } }]);
    const first = await drainGraphReadQueue(session);

    expect(first.diagnostics).toEqual([]);
    expect(session.graph).toBe(graph);
    expect(session.graph.taskDependenciesByTask.get("T-002")).toEqual(["T-001"]);
    expect(session.graph.taskReachable("T-002", "T-001")).toBe(true);

    enqueueGraphEditOperations(session, [{ type: "add_edge", edge: { from: "T-001", to: "T-002", type: "depends_on" } }]);
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
    expect(session.graph.blockRefsInManifestOrder.slice(0, 2)).toEqual(["T-001#B-001", "T-001#R-001"]);
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

    enqueueGraphEditOperations(session, [{ type: "add_edge", edge: { from: "MISSING", to: "T-001", type: "depends_on" } }]);
    const failed = await drainGraphReadQueue(session);

    expect(failed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["edge_from_missing"]);
    expect(session.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["edge_from_missing"]);

    enqueueGraphEditOperations(session, [{ type: "add_edge", edge: { from: "T-002", to: "T-001", type: "depends_on" } }]);
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
    expect(session.fileSnapshot.manifest.edges).not.toContainEqual({ from: "T-002", to: "T-001", type: "depends_on" });
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
    expect(session.fileSnapshot.manifest.edges).toContainEqual({ from: "T-002", to: "T-001", type: "depends_on" });
  });
});
