import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addBlock, addTaskNode } from "../desktop/index.js";
import { readJsonFile } from "../json.js";
import type { PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("desktop graph creation default behavior", () => {
  it("writes default task block templates through package files", async () => {
    const { root, init } = await createTestWorkspace();

    await expect(
      addTaskNode(root, {
        title: "Add export flow",
        promptMarkdown: "# Add export flow\n\nUsers can export the current plan.",
        acceptance: ["Users can export the current plan."],
        blockTypes: ["implementation", "review"]
      })
    ).resolves.toMatchObject({ ok: true });

    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const createdTask = manifest.nodes.find(
      (node) => node.type === "task" && node.title === "Add export flow"
    );
    if (createdTask?.type !== "task") {
      throw new Error("Created task missing.");
    }
    expect(createdTask.id).toBe("T-ADD-EXPORT-FLOW");
    expect(createdTask.acceptance).toEqual(["Users can export the current plan."]);
    expect(createdTask.blocks.map((block) => block.type)).toEqual(["implementation", "review"]);
    expect(createdTask.blocks.map((block) => block.depends_on)).toEqual([[], ["B-001"]]);
    expect(await readFile(join(init.workspace.packageDir, createdTask.prompt), "utf8")).toContain(
      "Users can export"
    );
    expect(
      await readFile(join(init.workspace.packageDir, createdTask.blocks[0].prompt), "utf8")
    ).toContain("Add export flow");

    await expect(
      addTaskNode(root, {
        title: "Fallback default blocks",
        promptMarkdown: "# Fallback default blocks\n"
      })
    ).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const fallbackTask = manifest.nodes.find(
      (node) => node.type === "task" && node.title === "Fallback default blocks"
    );
    if (fallbackTask?.type !== "task") {
      throw new Error("Fallback task missing.");
    }
    expect(fallbackTask.acceptance).toEqual(["Task is implemented."]);
    expect(fallbackTask.blocks.map((block) => block.type)).toEqual(["implementation", "review"]);
    expect(fallbackTask.blocks.map((block) => block.depends_on)).toEqual([[], ["B-001"]]);
  });

  it("honors explicit blockTypes overrides", async () => {
    const { root, init } = await createTestWorkspace();

    await expect(
      addTaskNode(root, {
        title: "Implementation only",
        promptMarkdown: "# Implementation only\n",
        blockTypes: ["implementation"]
      })
    ).resolves.toMatchObject({ ok: true });
    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const implementationOnlyTask = manifest.nodes.find(
      (node) => node.type === "task" && node.title === "Implementation only"
    );
    if (implementationOnlyTask?.type !== "task") {
      throw new Error("Implementation-only task missing.");
    }
    expect(implementationOnlyTask.blocks.map((block) => block.type)).toEqual(["implementation"]);
    expect(implementationOnlyTask.blocks.map((block) => block.depends_on)).toEqual([[]]);

    await expect(
      addTaskNode(root, {
        title: "Manual review gate",
        promptMarkdown: "# Manual review gate\n",
        acceptance: ["Manual review remains opt-in."],
        blockTypes: ["implementation", "review"]
      })
    ).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const reviewedTask = manifest.nodes.find(
      (node) => node.type === "task" && node.title === "Manual review gate"
    );
    if (reviewedTask?.type !== "task") {
      throw new Error("Explicit review task missing.");
    }
    expect(reviewedTask.blocks.map((block) => block.type)).toEqual(["implementation", "review"]);
    expect(reviewedTask.blocks.map((block) => block.depends_on)).toEqual([[], ["B-001"]]);
  });

  it("places default implementation blocks before the review tail", async () => {
    const { root, init } = await createTestWorkspace();

    await expect(
      addTaskNode(root, {
        title: "Add export flow",
        promptMarkdown: "# Add export flow\n\nUsers can export the current plan."
      })
    ).resolves.toMatchObject({ ok: true });

    let manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const createdTask = manifest.nodes.find(
      (node) => node.type === "task" && node.title === "Add export flow"
    );
    if (createdTask?.type !== "task") {
      throw new Error("Created task missing.");
    }

    await expect(
      addBlock(root, {
        taskId: createdTask.id,
        type: "implementation",
        title: "Implement export follow-up",
        promptMarkdown: "# Implement export follow-up\n"
      })
    ).resolves.toMatchObject({ ok: true });
    manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const updatedTask = manifest.nodes.find(
      (node) => node.type === "task" && node.id === createdTask.id
    );
    if (updatedTask?.type !== "task") {
      throw new Error("Updated task missing.");
    }
    expect(updatedTask.blocks.map((block) => block.id)).toEqual(["B-001", "B-002", "R-001"]);
    expect(updatedTask.blocks.map((block) => block.depends_on)).toEqual([[], ["B-001"], ["B-002"]]);
    const addedBlock = updatedTask.blocks.find((block) => block.id === "B-002");
    expect(addedBlock).toMatchObject({
      id: "B-002",
      type: "implementation",
      title: "Implement export follow-up",
      depends_on: ["B-001"]
    });
    expect(await readFile(join(init.workspace.packageDir, addedBlock?.prompt ?? ""), "utf8")).toBe(
      "# Implement export follow-up\n"
    );
  });

  it("honors explicit block dependencies when appending implementation blocks", async () => {
    const { root, init } = await createTestWorkspace();

    await expect(
      addBlock(root, {
        taskId: "T-001",
        type: "implementation",
        title: "Implement review follow-up",
        promptMarkdown: "# Implement review follow-up\n",
        dependsOn: ["R-001"]
      })
    ).resolves.toMatchObject({ ok: true });

    const manifest = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    expect(task.blocks.map((block) => block.id)).toEqual(["B-001", "R-001", "B-002"]);
    expect(task.blocks.find((block) => block.id === "B-002")).toMatchObject({
      type: "implementation",
      depends_on: ["R-001"]
    });
    expect(task.blocks.find((block) => block.id === "R-001")?.depends_on).toEqual(["B-001"]);
  });

  it("places default implementation blocks before the final review gate", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("Fixture task missing.");
    }
    task.blocks.push({
      id: "R-002",
      type: "review",
      title: "Final review",
      prompt: "nodes/T-001/blocks/R-002.prompt.md",
      depends_on: ["R-001"],
      review: { required: true, maxFeedbackCycles: 1, hook: null }
    });
    const { root, init } = await createTestWorkspace(manifest);

    await expect(
      addBlock(root, {
        taskId: "T-001",
        type: "implementation",
        title: "Implement before reviews",
        promptMarkdown: "# Implement before reviews\n"
      })
    ).resolves.toMatchObject({ ok: true });

    const written = await readJsonFile<PlanPackageManifest>(init.workspace.manifestFile);
    const updatedTask = written.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (updatedTask?.type !== "task") {
      throw new Error("Updated fixture task missing.");
    }
    expect(updatedTask.blocks.map((block) => block.id)).toEqual([
      "B-001",
      "R-001",
      "B-002",
      "R-002"
    ]);
    expect(updatedTask.blocks.map((block) => block.depends_on)).toEqual([
      [],
      ["B-001"],
      ["R-001"],
      ["B-002"]
    ]);
  });
});
