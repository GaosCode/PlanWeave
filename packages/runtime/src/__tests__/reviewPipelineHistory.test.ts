import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGraphViewModel,
  getReviewPipeline,
  redoDesktopPlanGraphCommand,
  undoDesktopPlanGraphCommand,
  updateReviewPipeline
} from "../desktop/index.js";
import { executeDesktopPlanGraphCommand } from "../desktop/graph/editModelCommand.js";
import { readJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import {
  createSqlitePlanGraphStore,
  executePlanGraphCommand,
  parsePlanGraphCommand,
  redoPlanGraphCommand,
  undoPlanGraphCommand
} from "../plangraph/index.js";
import { openDatabase } from "../plangraph/sqlite/connection.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

async function fixture() {
  const manifest = basicManifest();
  const task = manifest.nodes[0];
  if (task?.type !== "task") throw new Error("Fixture task missing.");
  const review = task.blocks.find((block) => block.type === "review");
  if (!review) throw new Error("Fixture review missing.");
  task.prompt = review.prompt;
  return { manifest, task, review, ...(await createTestWorkspace(manifest)) };
}

async function history(root: string) {
  const store = await createSqlitePlanGraphStore({ projectRoot: root });
  const entry = await store.log.latestUndoable();
  if (!entry || Array.isArray(entry.inverse) || entry.inverse.type !== "updateReviewPipeline") {
    throw new Error("Saved pipeline inverse missing.");
  }
  return { store, entry, inverse: entry.inverse };
}

describe("review pipeline prompt write intent", () => {
  it.each([
    ...["task", "block"].flatMap((owner) =>
      ["shared", "normalized", "symlink"].map((reference) => ({
        owner,
        reference,
        historyFormat: "current"
      }))
    ),
    { owner: "task", reference: "shared", historyFormat: "legacy-unmarked" },
    { owner: "task", reference: "shared", historyFormat: "legacy-restore" }
  ])("replays replacement IDs sharing a $owner prompt through $reference paths ($historyFormat)", async ({
    owner,
    reference,
    historyFormat
  }) => {
    const manifest = basicManifest();
    const task = manifest.nodes[0];
    if (task?.type !== "task") throw new Error("Fixture task missing.");
    const review = task.blocks.find((block) => block.type === "review");
    const implementation = task.blocks.find((block) => block.type === "implementation");
    if (!review || !implementation) throw new Error("Fixture blocks missing.");
    const target = "nodes/T-001/blocks/R-002.prompt.md";
    review.prompt =
      reference === "normalized" ? "nodes/T-001/blocks/../blocks/R-002.prompt.md" : target;
    if (owner === "task") task.prompt = target;
    else implementation.prompt = target;
    const f = await createTestWorkspace(manifest);
    if (reference === "symlink") {
      review.prompt = "nodes/T-001/blocks/alias.prompt.md";
      await symlink("R-002.prompt.md", join(f.init.workspace.packageDir, review.prompt));
      await writeFile(f.init.workspace.manifestFile, JSON.stringify(manifest));
    }
    const path = join(f.init.workspace.packageDir, target);
    const before = "# Before replacement\r\n中文\n";
    const after = "# Explicit replacement\n新正文\n";
    await writeFile(path, before);
    const manifestBefore = (await loadPackage(f.root)).manifest;
    const pipeline = await getReviewPipeline(f.root, task.id);
    const versionBefore = (await getGraphViewModel(f.root)).graphVersion;
    await expect(
      updateReviewPipeline(f.root, task.id, {
        packageDefaults: pipeline.packageDefaults,
        steps: pipeline.steps.map((step) => ({
          ...step,
          blockId: "",
          blockRef: null,
          promptMarkdown: after
        }))
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(path, "utf8")).resolves.toBe(after);
    const manifestAfter = await readJsonFile(f.init.workspace.manifestFile);
    expect((await getReviewPipeline(f.root, task.id)).steps).toEqual([
      expect.objectContaining({ blockId: "R-002", promptMarkdown: after })
    ]);
    const versionAfter = (await getGraphViewModel(f.root)).graphVersion;
    expect(versionAfter).not.toBe(versionBefore);
    const { store, entry } = await history(f.root);
    expect(entry).toMatchObject({
      graphVersionBefore: versionBefore,
      graphVersionAfter: versionAfter
    });
    if (historyFormat !== "current") {
      if (Array.isArray(entry.inverse) || entry.inverse.type !== "updateReviewPipeline")
        throw new Error("Pipeline inverse missing.");
      const saved = {
        ...entry.inverse,
        promptMarkdownByBlockId: entry.inverse.promptMarkdownByBlockId.map((item) =>
          historyFormat === "legacy-restore"
            ? { ...item, intent: "restore" }
            : { blockId: item.blockId, markdown: item.markdown }
        )
      };
      const db = await openDatabase(store.indexPath);
      try {
        db.prepare("UPDATE operation_log SET inverse_json = ? WHERE id = ?").run(
          JSON.stringify(saved),
          entry.id
        );
      } finally {
        db.close();
      }
    }
    await expect(store.log.latestRedoable()).resolves.toBeNull();
    await expect(undoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
      ok: true,
      graphVersion: versionBefore
    });
    await expect(readFile(path, "utf8")).resolves.toBe(before);
    await expect(readJsonFile(f.init.workspace.manifestFile)).resolves.toEqual(manifestBefore);
    expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionBefore);
    await expect(store.log.latestUndoable()).resolves.toBeNull();
    await expect(store.log.latestRedoable()).resolves.toMatchObject({ id: entry.id });
    await expect(redoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
      ok: true,
      graphVersion: versionAfter
    });
    await expect(readFile(path, "utf8")).resolves.toBe(after);
    await expect(readJsonFile(f.init.workspace.manifestFile)).resolves.toEqual(manifestAfter);
    expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionAfter);
    await expect(store.log.latestUndoable()).resolves.toMatchObject({ id: entry.id });
    await expect(store.log.latestRedoable()).resolves.toBeNull();
  });

  it.each([
    "different",
    "normalized",
    "symlink"
  ])("tracks the actual file when an existing ID switches to a %s path", async (reference) => {
    const f = await fixture();
    const oldPath = join(f.init.workspace.packageDir, f.review.prompt);
    const before = await readFile(oldPath, "utf8");
    const nextPath =
      reference === "different"
        ? "moved-review.md"
        : reference === "normalized"
          ? "nodes/T-001/blocks/../blocks/R-001.prompt.md"
          : "nodes/T-001/blocks/alias.prompt.md";
    if (reference === "symlink")
      await symlink("R-001.prompt.md", join(f.init.workspace.packageDir, nextPath));
    const moved = { ...f.review, prompt: nextPath };
    const after = "# Moved review explicit bytes\r\n中文\n";
    const manifestBefore = (await loadPackage(f.root)).manifest;
    const versionBefore = (await getGraphViewModel(f.root)).graphVersion;
    await expect(
      executeDesktopPlanGraphCommand(f.root, {
        type: "updateReviewPipeline",
        taskId: f.task.id,
        packageDefaults: f.manifest.review,
        reviewBlocks: [moved],
        promptMarkdownByBlockId: [{ blockId: moved.id, markdown: after }]
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(join(f.init.workspace.packageDir, nextPath), "utf8")).resolves.toBe(
      after
    );
    await expect(readFile(oldPath, "utf8")).resolves.toBe(
      reference === "different" ? before : after
    );
    const manifestAfter = await readJsonFile(f.init.workspace.manifestFile);
    const versionAfter = (await getGraphViewModel(f.root)).graphVersion;
    const { store, entry, inverse } = await history(f.root);
    expect(entry).toMatchObject({
      graphVersionBefore: versionBefore,
      graphVersionAfter: versionAfter
    });
    await expect(undoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
      ok: true,
      graphVersion: versionBefore
    });
    await expect(readFile(oldPath, "utf8")).resolves.toBe(before);
    await expect(readJsonFile(f.init.workspace.manifestFile)).resolves.toEqual(manifestBefore);
    expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionBefore);
    await expect(store.log.latestUndoable()).resolves.toBeNull();
    await expect(store.log.latestRedoable()).resolves.toMatchObject({ id: entry.id });
    await expect(redoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
      ok: true,
      graphVersion: versionAfter
    });
    await expect(readFile(join(f.init.workspace.packageDir, nextPath), "utf8")).resolves.toBe(
      after
    );
    await expect(readJsonFile(f.init.workspace.manifestFile)).resolves.toEqual(manifestAfter);
    expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionAfter);
    await expect(store.log.latestUndoable()).resolves.toMatchObject({ id: entry.id });
    await expect(store.log.latestRedoable()).resolves.toBeNull();
    if (reference === "different") {
      const survivor = "# Current survivor after path change\n";
      await writeFile(oldPath, survivor);
      await expect(executeDesktopPlanGraphCommand(f.root, inverse)).resolves.toMatchObject({
        ok: true
      });
      await expect(readFile(oldPath, "utf8")).resolves.toBe(survivor);
    }
  });

  it("accepts persisted restoration intent and rejects unknown intent", async () => {
    const f = await fixture();
    await updateReviewPipeline(f.root, f.task.id, {
      steps: [],
      packageDefaults: f.manifest.review
    });
    const { inverse } = await history(f.root);
    expect(parsePlanGraphCommand(inverse)).toEqual(inverse);
    expect(inverse.promptMarkdownByBlockId).toEqual([
      { blockId: f.review.id, markdown: expect.any(String), intent: "restore" }
    ]);
    expect(() =>
      parsePlanGraphCommand({
        ...inverse,
        promptMarkdownByBlockId: inverse.promptMarkdownByBlockId.map((item) => ({
          ...item,
          intent: "unknown"
        }))
      })
    ).toThrow();
  });

  it("uses original operation context for legacy undo but treats a bare legacy payload as edit", async () => {
    const f = await fixture();
    const path = join(f.init.workspace.packageDir, f.review.prompt);
    const before = await readFile(path, "utf8");
    await expect(
      updateReviewPipeline(f.root, f.task.id, { steps: [], packageDefaults: f.manifest.review })
    ).resolves.toMatchObject({ ok: true });
    const { store, entry, inverse } = await history(f.root);
    const legacy = {
      ...inverse,
      promptMarkdownByBlockId: inverse.promptMarkdownByBlockId.map(
        ({ intent: _intent, ...item }) => item
      )
    };
    const db = await openDatabase(store.indexPath);
    try {
      db.prepare("UPDATE operation_log SET inverse_json = ? WHERE id = ?").run(
        JSON.stringify(legacy),
        entry.id
      );
    } finally {
      db.close();
    }
    const undo = await undoPlanGraphCommand({ projectRoot: f.root });
    expect(undo.ok).toBe(true);
    if (undo.command.type !== "updateReviewPipeline") throw new Error("Replay command missing.");
    expect(undo.command.promptMarkdownByBlockId).toEqual([
      { blockId: f.review.id, markdown: before, intent: "restore" }
    ]);
    await expect(readFile(path, "utf8")).resolves.toBe(before);
    await expect(redoPlanGraphCommand({ projectRoot: f.root })).resolves.toMatchObject({
      ok: true
    });
    await writeFile(path, "# Edited after deletion\n");
    await expect(
      executePlanGraphCommand({ projectRoot: f.root, command: legacy })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(path, "utf8")).resolves.toBe(before);
  });

  it("keeps explicit shared prompt edit undo/redo byte-exact", async () => {
    const f = await fixture();
    const path = join(f.init.workspace.packageDir, f.review.prompt);
    const before = await readFile(path, "utf8");
    const expected = "# Explicit shared prompt edit\r\n中文\n";
    const pipeline = await getReviewPipeline(f.root, f.task.id);
    await expect(
      updateReviewPipeline(f.root, f.task.id, {
        packageDefaults: pipeline.packageDefaults,
        steps: pipeline.steps.map((step) => ({ ...step, promptMarkdown: expected }))
      })
    ).resolves.toMatchObject({ ok: true });
    const { inverse } = await history(f.root);
    expect(inverse.promptMarkdownByBlockId).toEqual([{ blockId: f.review.id, markdown: before }]);
    await expect(undoPlanGraphCommand({ projectRoot: f.root })).resolves.toMatchObject({
      ok: true
    });
    await expect(readFile(path, "utf8")).resolves.toBe(before);
    await expect(redoPlanGraphCommand({ projectRoot: f.root })).resolves.toMatchObject({
      ok: true
    });
    await expect(readFile(path, "utf8")).resolves.toBe(expected);
  });

  it.each(
    ["shared", "normalized", "symlink"].flatMap((reference) => [
      { reference, reverse: false },
      { reference, reverse: true }
    ])
  )("applies explicit edits beside $reference restoration writes (reverse: $reverse)", async ({
    reference,
    reverse
  }) => {
    const f = await fixture();
    const added = {
      ...f.review,
      id: "R-002",
      prompt:
        reference === "normalized"
          ? "nodes/T-001/blocks/../blocks/R-001.prompt.md"
          : reference === "symlink"
            ? "nodes/T-001/blocks/alias.prompt.md"
            : f.review.prompt
    };
    if (reference === "symlink")
      await symlink("R-001.prompt.md", join(f.init.workspace.packageDir, added.prompt));
    const expected = "# Intentional current user edit\n中文\n";
    const snapshot = "# Stale companion snapshot\n";
    const reviews = reverse ? [added, f.review] : [f.review, added];
    await expect(
      executePlanGraphCommand({
        projectRoot: f.root,
        command: {
          type: "updateReviewPipeline",
          taskId: f.task.id,
          packageDefaults: f.manifest.review,
          reviewBlocks: reviews,
          promptMarkdownByBlockId: reviews.map((block) =>
            block.id === added.id
              ? { blockId: block.id, markdown: snapshot, intent: "restore" }
              : { blockId: block.id, markdown: expected }
          )
        }
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(
      readFile(join(f.init.workspace.packageDir, f.review.prompt), "utf8")
    ).resolves.toBe(expected);
    await expect(readFile(join(f.init.workspace.packageDir, added.prompt), "utf8")).resolves.toBe(
      expected
    );
  });

  it.each([
    false,
    true
  ])("restores private prompt paths through edit undo/redo (content changed: %s)", async (changed) => {
    const manifest = basicManifest();
    const task = manifest.nodes[0];
    if (task?.type !== "task") throw new Error("Fixture task missing.");
    const review = task.blocks.find((block) => block.type === "review");
    if (!review) throw new Error("Fixture review missing.");
    const f = await createTestWorkspace(manifest);
    const beforePath = join(f.init.workspace.packageDir, review.prompt);
    const before = await readFile(beforePath, "utf8");
    const moved = { ...review, prompt: "moved-review.md" };
    const expected = changed ? "# Explicit changed target bytes\n" : before;
    const movedPath = join(f.init.workspace.packageDir, moved.prompt);
    await expect(
      executePlanGraphCommand({
        projectRoot: f.root,
        command: {
          type: "updateReviewPipeline",
          taskId: task.id,
          packageDefaults: manifest.review,
          reviewBlocks: [moved],
          promptMarkdownByBlockId: [{ blockId: moved.id, markdown: expected }]
        }
      })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(beforePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(undoPlanGraphCommand({ projectRoot: f.root })).resolves.toMatchObject({
      ok: true
    });
    await expect(readFile(beforePath, "utf8")).resolves.toBe(before);
    await expect(readFile(movedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(redoPlanGraphCommand({ projectRoot: f.root })).resolves.toMatchObject({
      ok: true
    });
    await expect(readFile(movedPath, "utf8")).resolves.toBe(expected);
    await expect(readFile(beforePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
