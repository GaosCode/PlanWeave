import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonFile } from "../json.js";
import { buildBlockDetail, buildTaskDetail } from "../desktop/graph/readModel.js";
import { createTaskWorkspaceReadContext } from "../desktop/taskWorkspaceReadContext.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

describe("Task Workspace read-context snapshot", () => {
  it("keeps manifest, state, and package prompts stable until the next request", async () => {
    const initialManifest = basicManifest();
    const { home, root, init } = await createTestWorkspace(initialManifest);
    const globalPromptPath = join(home, "config", "global-prompt.md");
    const promptPolicyPath = join(init.workspace.workspaceRoot, "policy", "prompt-policy.json");
    await mkdir(join(home, "config"), { recursive: true });
    await mkdir(join(init.workspace.workspaceRoot, "policy"), { recursive: true });
    await writeFile(globalPromptPath, "initial global prompt\n", "utf8");
    await writeFile(init.workspace.projectPromptFile, "initial project prompt\n", "utf8");
    const context = await createTaskWorkspaceReadContext({ projectRoot: root });

    const nextManifest = structuredClone(initialManifest);
    const task = nextManifest.nodes[0];
    if (!task || task.type !== "task") {
      throw new Error("Snapshot fixture must contain T-001.");
    }
    task.title = "Changed task title";
    task.blocks[0]!.title = "Changed block title";
    await writeJsonFile(init.workspace.manifestFile, nextManifest);

    const nextState = structuredClone(context.runtime.state);
    nextState.tasks["T-001"]!.status = "in_progress";
    nextState.blocks["T-001#B-001"]!.status = "in_progress";
    nextState.currentRefs = ["T-001#B-001"];
    await writeJsonFile(init.workspace.stateFile, nextState);
    await writeFile(
      `${init.workspace.packageDir}/nodes/T-001/prompt.md`,
      "# changed task prompt\n",
      "utf8"
    );
    await writeFile(
      `${init.workspace.packageDir}/nodes/T-001/blocks/B-001.prompt.md`,
      "# changed block prompt\n",
      "utf8"
    );
    await writeFile(globalPromptPath, "changed global prompt\n", "utf8");
    await writeFile(init.workspace.projectPromptFile, "changed project prompt\n", "utf8");
    await writeJsonFile(promptPolicyPath, { includeGlobalPrompt: false });

    await expect(buildTaskDetail(context, "T-001")).resolves.toMatchObject({
      title: "Implement test task",
      status: "ready",
      promptMarkdown: "# T-001 task prompt\n"
    });
    const currentBlock = await buildBlockDetail(context, "T-001#B-001");
    expect(currentBlock).toMatchObject({
      title: "Implement task",
      status: "ready",
      promptMarkdown: "# T-001#B-001 implementation prompt\n"
    });
    expect(currentBlock.promptSurfaceMarkdown).toContain("initial global prompt");
    expect(currentBlock.promptSurfaceMarkdown).toContain("initial project prompt");

    const nextContext = await createTaskWorkspaceReadContext({ projectRoot: root });
    await expect(buildTaskDetail(nextContext, "T-001")).resolves.toMatchObject({
      title: "Changed task title",
      status: "in_progress",
      promptMarkdown: "# changed task prompt\n"
    });
    const nextBlock = await buildBlockDetail(nextContext, "T-001#B-001");
    expect(nextBlock).toMatchObject({
      title: "Changed block title",
      status: "in_progress",
      promptMarkdown: "# changed block prompt\n"
    });
    expect(nextBlock.promptSurfaceMarkdown).not.toContain("initial global prompt");
    expect(nextBlock.promptSurfaceMarkdown).toContain("changed project prompt");
    expect(nextBlock.promptSources).toContainEqual(
      expect.objectContaining({ kind: "global", included: false })
    );
  });
});
