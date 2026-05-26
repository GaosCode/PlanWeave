import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addBlock,
  addDependencyEdge,
  addTaskNode,
  createTaskDraft,
  removeBlock,
  removeDependencyEdge,
  removeTaskNode,
  updateBlockExecutor,
  updateBlockTitle,
  updateTaskExecutor,
  updateTaskTitle,
  validateGraphEdit
} from "../desktop/index.js";
import { readJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop graph edit API", () => {
  it("writes task/block titles, executor overrides, and task dependency edges through the manifest", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(updateTaskTitle(root, "T-001", "Updated task title")).resolves.toMatchObject({ ok: true });
    await expect(updateBlockExecutor(root, "T-001#R-001", "manual")).resolves.toMatchObject({ ok: true });
    await expect(updateTaskExecutor(root, "T-001", "codex-auto")).resolves.toMatchObject({ ok: true });
    await expect(updateBlockTitle(root, "T-001#B-001", "Updated block title")).resolves.toMatchObject({ ok: true });
    await expect(updateBlockExecutor(root, "T-001#B-001", "manual")).resolves.toMatchObject({ ok: true });
    await expect(addDependencyEdge(root, "T-001", "T-002")).resolves.toMatchObject({ ok: true, affectedTasks: ["T-001"] });

    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(task.title).toBe("Updated task title");
    expect(task.executor).toBe("codex-auto");
    expect(task.blocks.find((block) => block.id === "B-001")).toMatchObject({
      title: "Updated block title",
      executor: "manual"
    });
    expect(task.blocks.find((block) => block.id === "R-001")).not.toHaveProperty("executor");
    expect(manifest.edges).toContainEqual({ from: "T-001", to: "T-002", type: "depends_on" });

    const cyclic = await addDependencyEdge(root, "T-002", "T-001");
    expect(cyclic.ok).toBe(false);
    expect(cyclic.diagnostics.map((diagnostic) => diagnostic.code)).toContain("depends_on_cycle");
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.edges).not.toContainEqual({ from: "T-002", to: "T-001", type: "depends_on" });

    await expect(updateBlockExecutor(root, "T-001#B-001", null)).resolves.toMatchObject({ ok: true });
    await expect(removeDependencyEdge(root, "T-001", "T-002")).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const updatedTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (updatedTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(updatedTask.blocks.find((block) => block.id === "B-001")).not.toHaveProperty("executor");
    expect(manifest.edges).not.toContainEqual({ from: "T-001", to: "T-002", type: "depends_on" });
  });

  it("validates graph edits without writing the manifest", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] }));

    const invalid = await validateGraphEdit(root, {
      kind: "addDependencyEdge",
      fromTaskId: "T-002",
      toTaskId: "T-001"
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toContain("depends_on_cycle");

    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.edges).not.toContainEqual({ from: "T-002", to: "T-001", type: "depends_on" });

    await expect(
      validateGraphEdit(root, {
        kind: "removeBlock",
        blockRef: "T-001#R-001"
      })
    ).resolves.toMatchObject({ ok: true, affectedTasks: ["T-001"] });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const firstTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (firstTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(firstTask.blocks.map((block) => block.id)).toEqual(["B-001", "R-001"]);
  });

  it("creates task drafts and writes new task nodes and blocks through package files", async () => {
    const { root, init } = await createTestWorkspace();

    const draft = await createTaskDraft(root, {
      mode: "task",
      text: "# Add export flow\n\nUsers can export the current plan."
    });
    expect(draft).toMatchObject({
      mode: "task",
      tasks: [
        {
          title: "Add export flow",
          blockTypes: ["implementation", "review"]
        }
      ]
    });

    await expect(addTaskNode(root, draft.tasks[0])).resolves.toMatchObject({ ok: true });
    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const createdTask = manifest.nodes.find((node) => node.type === "task" && node.title === "Add export flow");
    if (createdTask?.type !== "task") {
      throw new Error("Created task missing.");
    }
    expect(createdTask.id).toBe("T-ADD-EXPORT-FLOW");
    expect(createdTask.blocks.map((block) => block.type)).toEqual(["implementation", "review"]);
    expect(createdTask.blocks.map((block) => block.depends_on)).toEqual([[], ["B-001"]]);
    expect(await readFile(join(init.workspace.packageDir, createdTask.prompt), "utf8")).toContain("Users can export");
    expect(await readFile(join(init.workspace.packageDir, createdTask.blocks[0].prompt), "utf8")).toContain("Add export flow");

    await expect(
      addBlock(root, {
        taskId: createdTask.id,
        type: "implementation",
        title: "Implement export follow-up",
        promptMarkdown: "# Implement export follow-up\n"
      })
    ).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const updatedTask = manifest.nodes.find((node) => node.type === "task" && node.id === createdTask.id);
    if (updatedTask?.type !== "task") {
      throw new Error("Updated task missing.");
    }
    const addedBlock = updatedTask.blocks.at(-1);
    expect(addedBlock).toMatchObject({
      id: "B-002",
      type: "implementation",
      title: "Implement export follow-up",
      depends_on: ["R-001"]
    });
    expect(await readFile(join(init.workspace.packageDir, addedBlock?.prompt ?? ""), "utf8")).toBe("# Implement export follow-up\n");

    const appendDraft = await createTaskDraft(root, {
      mode: "blocks",
      targetTaskId: createdTask.id,
      text: "Add a follow-up validation block."
    });
    expect(appendDraft.blocks).toMatchObject([{ taskId: createdTask.id, type: "implementation", title: "Add a follow-up validation block." }]);
  });

  it("removes task/block package surfaces through graph APIs", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));

    await expect(removeBlock(root, "T-001#R-001")).resolves.toMatchObject({ ok: true, affectedTasks: ["T-001"] });
    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const firstTask = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (firstTask?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(firstTask.blocks.map((block) => block.id)).toEqual(["B-001"]);
    await expect(readFile(join(init.workspace.packageDir, "nodes", "T-001", "blocks", "R-001.prompt.md"), "utf8")).rejects.toThrow();

    await expect(removeTaskNode(root, "T-002")).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    expect(manifest.nodes.some((node) => node.id === "T-002")).toBe(false);
    expect(manifest.edges.some((edge) => edge.from === "T-002" || edge.to === "T-002")).toBe(false);
    await expect(readFile(join(init.workspace.packageDir, "nodes", "T-002", "prompt.md"), "utf8")).rejects.toThrow();
  });
});
