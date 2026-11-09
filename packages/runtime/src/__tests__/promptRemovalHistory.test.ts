import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  redoDesktopPlanGraphCommand,
  removeBlock,
  removeTaskNode,
  undoDesktopPlanGraphCommand
} from "../desktop/index.js";
import { executePlanGraphCommand } from "../plangraph/executeCommand.js";
import { createSqlitePlanGraphStore } from "../plangraph/index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

describe("prompt removal history", () => {
  it.each([
    "task",
    "block",
    "normalized",
    "symlink"
  ])("restores a saved %s inverse without overwriting a surviving prompt reference", async (kind) => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes[0];
    const survivor = manifest.nodes[1];
    if (task?.type !== "task" || survivor?.type !== "task") {
      throw new Error("Fixture tasks missing.");
    }
    const block = task.blocks[1];
    if (!block) throw new Error("Fixture block missing.");
    const removedPath = kind === "block" ? block.prompt : task.prompt;
    survivor.prompt =
      kind === "normalized"
        ? `nodes/../${removedPath}`
        : kind === "symlink"
          ? "nodes/alias.md"
          : removedPath;
    const { root, init } = await createTestWorkspace(manifest);
    if (kind === "symlink") {
      await rm(join(init.workspace.packageDir, survivor.prompt));
      await symlink("T-001/prompt.md", join(init.workspace.packageDir, survivor.prompt));
    }
    await expect(
      kind === "block" ? removeBlock(root, "T-001#R-001") : removeTaskNode(root, task.id)
    ).resolves.toMatchObject({ ok: true });
    const store = await createSqlitePlanGraphStore({ projectRoot: root });
    const entry = await store.log.latestUndoable();
    if (!entry || Array.isArray(entry.inverse)) throw new Error("Saved inverse missing.");
    const survivorBytes = "# Survivor edited after removal\n中文\n";
    await writeFile(join(init.workspace.packageDir, survivor.prompt), survivorBytes);

    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "graph_version_conflict" })]
    });
    await expect(readFile(join(init.workspace.packageDir, survivor.prompt), "utf8")).resolves.toBe(
      survivorBytes
    );
    await expect(
      executePlanGraphCommand({ projectRoot: root, command: entry.inverse })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(init.workspace.packageDir, survivor.prompt), "utf8")).resolves.toBe(
      survivorBytes
    );
    await expect(readFile(join(init.workspace.packageDir, removedPath), "utf8")).resolves.toBe(
      survivorBytes
    );
  });

  it.each([
    "task",
    "block"
  ])("preserves exact removed and surviving bytes through %s undo and redo", async (kind) => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes[0];
    const survivor = manifest.nodes[1];
    if (task?.type !== "task" || survivor?.type !== "task") {
      throw new Error("Fixture tasks missing.");
    }
    const first = task.blocks[0];
    const review = task.blocks[1];
    if (!first || !review) throw new Error("Fixture blocks missing.");
    first.prompt = "outside-block.md";
    review.prompt = first.prompt;
    survivor.prompt = "survivor.md";
    const { root, init } = await createTestWorkspace(manifest);
    const promptPaths = [task.prompt, first.prompt, survivor.prompt];
    const bytes = ["# Task\r\n\r\n", "# Shared block\n中文\n", "# Survivor\n"];
    for (const [index, path] of promptPaths.entries()) {
      const content = bytes[index];
      if (content === undefined) throw new Error("Fixture prompt bytes missing.");
      await writeFile(join(init.workspace.packageDir, path), content);
    }
    const remove =
      kind === "task" ? removeTaskNode(root, task.id) : removeBlock(root, "T-001#R-001");
    await expect(remove).resolves.toMatchObject({ ok: true });
    const removed = kind === "task" ? [task.prompt, first.prompt] : [];
    for (const path of removed) {
      await expect(readFile(join(init.workspace.packageDir, path))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
    await expect(undoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    for (const [index, path] of promptPaths.entries()) {
      await expect(readFile(join(init.workspace.packageDir, path), "utf8")).resolves.toBe(
        bytes[index]
      );
    }
    await expect(redoDesktopPlanGraphCommand(root)).resolves.toMatchObject({ ok: true });
    for (const path of removed) {
      await expect(readFile(join(init.workspace.packageDir, path))).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
    await expect(readFile(join(init.workspace.packageDir, survivor.prompt), "utf8")).resolves.toBe(
      bytes[2]
    );
  });

  it.each([
    "task",
    "block",
    "pipeline"
  ])("restores missing shared prompt bytes from the saved %s inverse", async (kind) => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes[0];
    const survivor = manifest.nodes[1];
    if (task?.type !== "task" || survivor?.type !== "task")
      throw new Error("Fixture tasks missing.");
    const review = task.blocks.find((block) => block.type === "review");
    if (!review) throw new Error("Fixture review missing.");
    const removedPath = kind === "task" ? task.prompt : review.prompt;
    survivor.prompt = removedPath;
    const { root, init } = await createTestWorkspace(manifest);
    const path = join(init.workspace.packageDir, removedPath);
    const expected = "# Saved shared recovery bytes\r\n中文\n";
    await writeFile(path, expected);
    await expect(
      kind === "task"
        ? removeTaskNode(root, task.id)
        : kind === "block"
          ? removeBlock(root, `${task.id}#${review.id}`)
          : executePlanGraphCommand({
              projectRoot: root,
              command: {
                type: "updateReviewPipeline",
                taskId: task.id,
                packageDefaults: manifest.review,
                reviewBlocks: [],
                promptMarkdownByBlockId: []
              }
            })
    ).resolves.toMatchObject({ ok: true });
    const store = await createSqlitePlanGraphStore({ projectRoot: root });
    const entry = await store.log.latestUndoable();
    if (!entry || Array.isArray(entry.inverse)) throw new Error("Saved inverse missing.");
    await rm(path);
    await expect(
      executePlanGraphCommand({ projectRoot: root, command: entry.inverse })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(path, "utf8")).resolves.toBe(expected);
  });
});
