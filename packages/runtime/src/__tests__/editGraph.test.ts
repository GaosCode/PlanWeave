import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { addEdge, addNode, commitPlanPackageGraphMutation, updatePromptSurface } from "../graph/editGraph.js";
import { buildPlanPackageBlockFieldEditMutation, buildPlanPackageTaskFieldEditMutation } from "../graph/fieldEditMutation.js";
import { buildPlanPackageGraphMutation } from "../graph/mutation.js";
import { readJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

describe("editGraph", () => {
  it("builds graph mutation previews with commit-only prompt side effects", async () => {
    const { init } = await createTestWorkspace();
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    const mutation = buildPlanPackageGraphMutation(manifest, {
      kind: "removeBlock",
      blockRef: "T-001#R-001"
    });

    const task = mutation.nextManifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(task.blocks.map((block) => block.id)).toEqual(["B-001"]);
    expect(mutation.affectedTasks).toEqual(["T-001"]);
    expect(mutation.sideEffects).toEqual([{ kind: "removePrompt", packagePath: "nodes/T-001/blocks/R-001.prompt.md" }]);
  });

  it("builds task and block package surface side effects in the graph mutation seam", async () => {
    const { init } = await createTestWorkspace();
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const task = basicManifest({ includeSecondTask: true }).nodes.find((item) => item.type === "task" && item.id === "T-002");
    if (!task || task.type !== "task") {
      throw new Error("missing task");
    }

    const addTaskMutation = buildPlanPackageGraphMutation(manifest, {
      kind: "addTaskNode",
      node: task,
      taskPromptMarkdown: "# Task prompt\n",
      blockPromptMarkdown: task.blocks.map((block) => ({
        blockId: block.id,
        markdown: `# ${block.title}\n`
      }))
    });

    expect(addTaskMutation.nextManifest.nodes.some((node) => node.id === "T-002")).toBe(true);
    expect(addTaskMutation.affectedTasks).toEqual(["T-002"]);
    expect(addTaskMutation.sideEffects).toEqual([
      { kind: "writePrompt", packagePath: "nodes/T-002/prompt.md", markdown: "# Task prompt\n" },
      { kind: "writePrompt", packagePath: "nodes/T-002/blocks/B-001.prompt.md", markdown: "# Implement second task\n" },
      { kind: "writePrompt", packagePath: "nodes/T-002/blocks/R-001.prompt.md", markdown: "# Review second task\n" }
    ]);

    const block = task.blocks[0];
    const addBlockMutation = buildPlanPackageGraphMutation(manifest, {
      kind: "addBlock",
      taskId: "T-001",
      block,
      promptMarkdown: "# New block\n"
    });
    const updatedTask = addBlockMutation.nextManifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (updatedTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(updatedTask.blocks.at(-1)).toEqual(block);
    expect(addBlockMutation.affectedTasks).toEqual(["T-001"]);
    expect(addBlockMutation.sideEffects).toEqual([{ kind: "writePrompt", packagePath: block.prompt, markdown: "# New block\n" }]);
  });

  it("builds task and block field edits in the graph mutation seam", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    const manifestWithOverrides: PlanPackageManifest = {
      ...manifest,
      nodes: manifest.nodes.map((node) =>
        node.id === "T-001" && node.type === "task"
          ? {
              ...node,
              executor: "manual",
              blocks: node.blocks.map((block) => ({ ...block, executor: "manual" }))
            }
          : node
      )
    };

    const taskMutation = buildPlanPackageTaskFieldEditMutation(manifestWithOverrides, {
      taskId: "T-001",
      executor: "codex-auto"
    });
    const updatedTask = taskMutation.nextManifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (updatedTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(taskMutation.updatedFields).toEqual(["executor"]);
    expect(updatedTask.executor).toBe("codex-auto");
    expect(updatedTask.blocks.every((block) => !("executor" in block) || block.executor === undefined)).toBe(true);

    const blockMutation = buildPlanPackageBlockFieldEditMutation(taskMutation.nextManifest, {
      blockRef: "T-001#B-001",
      title: "Updated implementation",
      promptMarkdown: "# Updated implementation\n",
      executor: "manual",
      parallelSafe: false,
      parallelLocks: ["db"]
    });
    const blockTask = blockMutation.nextManifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (blockTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(blockMutation.updatedFields).toEqual(["title", "prompt", "executor", "parallel.safe", "parallel.locks"]);
    expect(blockMutation.sideEffects).toEqual([
      { kind: "writePrompt", packagePath: "nodes/T-001/blocks/B-001.prompt.md", markdown: "# Updated implementation\n" }
    ]);
    expect(blockTask.blocks.find((block) => block.id === "B-001")).toMatchObject({
      title: "Updated implementation",
      executor: "manual",
      parallel: { safe: false, locks: ["db"] }
    });
  });

  it("removes task package directories through commit-only mutation side effects", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    const mutation = buildPlanPackageGraphMutation(manifest, {
      kind: "removeNode",
      nodeId: "T-002",
      removeTaskDirectory: true
    });

    expect(mutation.sideEffects).toEqual([{ kind: "removeTaskDirectory", packagePath: "nodes/T-002" }]);
    await expect(readFile(`${init.workspace.packageDir}/nodes/T-002/prompt.md`, "utf8")).resolves.toContain("# T-002 task prompt");

    const result = await commitPlanPackageGraphMutation({ projectRoot: root, mutation });

    expect(result.ok).toBe(true);
    await expect(readFile(`${init.workspace.packageDir}/nodes/T-002/prompt.md`, "utf8")).rejects.toThrow();
  });

  it("adds v1 task nodes with prompt source files and reports affected tasks", async () => {
    const { root, init } = await createTestWorkspace();
    const node = basicManifest({ includeSecondTask: true }).nodes.find((item) => item.type === "task" && item.id === "T-002");
    if (!node || node.type !== "task") {
      throw new Error("missing task");
    }

    const result = await addNode({ projectRoot: root, node, promptMarkdown: "# New task\n" });
    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);

    expect(result.ok).toBe(true);
    expect(result.affectedTasks).toEqual(["T-002"]);
    expect(manifest.nodes.some((item) => item.id === "T-002")).toBe(true);
    await expect(readFile(`${init.workspace.packageDir}/nodes/T-002/prompt.md`, "utf8")).resolves.toContain("# New task");
  });

  it("validates edge endpoint contracts before writing", async () => {
    const { root } = await createTestWorkspace();

    const result = await addEdge({ projectRoot: root, edge: { from: "missing-task", to: "T-001", type: "depends_on" } });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("edge_from_missing");
  });

  it("updates the task prompt source rather than a rendered task surface", async () => {
    const { root, init } = await createTestWorkspace();

    const result = await updatePromptSurface({ projectRoot: root, taskId: "T-001", taskBody: "# Updated task prompt\n" });

    expect(result.ok).toBe(true);
    await expect(readFile(`${init.workspace.packageDir}/nodes/T-001/prompt.md`, "utf8")).resolves.toContain("# Updated task prompt");
  });
});
