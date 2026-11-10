import {
  mkdir,
  lstat,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGraphViewModel,
  getTaskDetail,
  getBlockDetail,
  getReviewPipeline,
  redoDesktopPlanGraphCommand,
  removeBlock,
  removeTaskNode,
  undoDesktopPlanGraphCommand,
  updateReviewPipeline
} from "../desktop/index.js";
import { defaultPlanGraphCommandDependencies } from "../plangraph/adapters.js";
import { openDatabase } from "../plangraph/sqlite/connection.js";
import {
  executePlanGraphCommand,
  undoPlanGraphCommand,
  createSqlitePlanGraphStore
} from "../plangraph/index.js";
import { manifestSchema } from "../schema/manifest.js";
import { writeJsonFile } from "../json.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

async function historyPosition(root: string) {
  const store = await createSqlitePlanGraphStore({ projectRoot: root });
  const undo = await store.log.latestUndoable();
  const redo = await store.log.latestRedoable();
  return { cursor: undo?.id ?? null, redo: redo?.id ?? null, canUndo: !!undo, canRedo: !!redo };
}

async function fixture(kind: string, absolute = false) {
  const manifest = basicManifest({ includeSecondTask: true });
  manifest.executors = {};
  const task = manifest.nodes[0];
  if (task?.type !== "task") throw new Error("Task missing.");
  const block = task.blocks.find((item) => item.type === "review");
  if (!block) throw new Error("Block missing.");
  const f = await createTestWorkspace(manifest);
  await writeJsonFile(f.init.workspace.manifestFile, manifestSchema.parse(manifest));
  const packageDir = await realpath(f.init.workspace.packageDir);
  const packagePath = kind === "task" ? task.prompt : block.prompt;
  const path = join(packageDir, packagePath);
  const target = join(packageDir, "orphan-target.md");
  const bytes = Buffer.from("# Original target\r\n中文\r\n\r\n");
  await writeFile(target, bytes);
  await rm(path);
  const link = absolute ? target : relative(dirname(path), target);
  await symlink(link, path);
  const remove = async () => {
    if (kind === "task") return removeTaskNode(f.root, task.id);
    if (kind === "block") return removeBlock(f.root, `${task.id}#${block.id}`);
    const pipeline = await getReviewPipeline(f.root, task.id);
    return updateReviewPipeline(f.root, task.id, {
      packageDefaults: pipeline.packageDefaults,
      steps: []
    });
  };
  return { ...f, kind, block, task, packageDir, packagePath, path, target, bytes, link, remove };
}

describe("successful deletion preserves prompt symlink history", () => {
  it.each(
    ["task", "block", "review"].flatMap((kind) =>
      [false, true].map((absolute) => ({ kind, absolute }))
    )
  )("restores $kind link identity and live target through two cycles (absolute=$absolute)", async ({
    kind,
    absolute
  }) => {
    const f = await fixture(kind, absolute);
    const manifestBefore = await readFile(f.init.workspace.manifestFile);
    const versionBefore = (await getGraphViewModel(f.root)).graphVersion;
    expect(await historyPosition(f.root)).toEqual({
      cursor: null,
      redo: null,
      canUndo: false,
      canRedo: false
    });
    expect((await lstat(f.path)).isSymbolicLink()).toBe(true);
    expect(await readlink(f.path)).toBe(f.link);
    await expect(readFile(f.path)).resolves.toEqual(f.bytes);
    expect((await f.remove()).ok).toBe(true);
    const manifestAfter = await readFile(f.init.workspace.manifestFile);
    const versionAfter = (await getGraphViewModel(f.root)).graphVersion;
    const positionAfter = await historyPosition(f.root);
    expect(versionAfter).not.toBe(versionBefore);
    expect(positionAfter).toEqual({
      cursor: expect.any(Number),
      redo: null,
      canUndo: true,
      canRedo: false
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(f.target)).resolves.toEqual(f.bytes);
      await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(manifestAfter);
      expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionAfter);
      expect(await historyPosition(f.root)).toEqual(positionAfter);
      const undo = await undoDesktopPlanGraphCommand(f.root);
      expect(undo).toMatchObject({ ok: true, graphVersion: versionBefore });
      await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(manifestBefore);
      await expect(readFile(f.path)).resolves.toEqual(f.bytes);
      expect((await lstat(f.path)).isSymbolicLink()).toBe(true);
      expect(await readlink(f.path)).toBe(f.link);
      expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionBefore);
      expect(await historyPosition(f.root)).toEqual({
        cursor: null,
        redo: positionAfter.cursor,
        canUndo: false,
        canRedo: true
      });
      const changed = Buffer.from(`# Target edit ${cycle}\r\n`);
      await writeFile(f.target, changed);
      await expect(readFile(f.path)).resolves.toEqual(changed);
      const detail =
        kind === "task"
          ? await getTaskDetail(f.root, f.task.id)
          : await getBlockDetail(f.root, `${f.task.id}#${f.block.id}`);
      expect(detail.promptMarkdown).toBe(changed.toString());
      await expect(redoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ code: "graph_version_conflict" })]
      });
      await writeFile(f.target, f.bytes);
      expect(await redoDesktopPlanGraphCommand(f.root)).toMatchObject({
        ok: true,
        graphVersion: versionAfter
      });
    }
  });
});

async function savedEntry(root: string) {
  const store = await createSqlitePlanGraphStore({ projectRoot: root });
  const entry = await store.log.latestUndoable();
  if (!entry || Array.isArray(entry.inverse)) throw new Error("Inverse missing.");
  return { store, entry, inverse: entry.inverse };
}

async function replaceInverse(root: string, inverse: unknown) {
  const store = await createSqlitePlanGraphStore({ projectRoot: root });
  const db = await openDatabase(store.indexPath);
  try {
    db.prepare(
      "UPDATE operation_log SET inverse_json = ? WHERE id = (SELECT MAX(id) FROM operation_log)"
    ).run(JSON.stringify(inverse));
  } finally {
    db.close();
  }
}

describe("prompt link history conflict and ownership boundaries", () => {
  it.each([
    "changed-target",
    "missing-target",
    "different-link",
    "regular-replacement",
    "target-identity",
    "escaped-target"
  ])("rejects %s without changing manifest, survivor bytes, version or cursor", async (change) => {
    const f = await fixture("review");
    expect((await f.remove()).ok).toBe(true);
    const manifest = await readFile(f.init.workspace.manifestFile);
    const position = await historyPosition(f.root);
    const version = (await getGraphViewModel(f.root)).graphVersion;
    const replacement = Buffer.from("# Concurrent replacement\r\n");
    const second = join(f.packageDir, "second-target.md");
    await writeFile(second, change === "target-identity" ? f.bytes : replacement);
    if (change === "changed-target") await writeFile(f.target, replacement);
    if (["missing-target", "target-identity", "escaped-target"].includes(change))
      await rm(f.target);
    if (change === "target-identity") await symlink("second-target.md", f.target);
    if (change === "different-link") await symlink("../../../second-target.md", f.path);
    if (change === "regular-replacement") await writeFile(f.path, replacement);
    const outside = join(f.root, "outside.md");
    if (change === "escaped-target") {
      await writeFile(outside, replacement);
      await symlink(outside, f.target);
    }
    const rejected = await undoDesktopPlanGraphCommand(f.root);
    expect(rejected).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "command_validation_failed" })]
    });
    await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(manifest);
    expect((await getGraphViewModel(f.root)).graphVersion).toBe(version);
    expect(await historyPosition(f.root)).toEqual(position);
    if (change === "regular-replacement" || change === "different-link")
      await expect(readFile(f.path)).resolves.toEqual(replacement);
    else await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    if (change === "escaped-target") await expect(readFile(outside)).resolves.toEqual(replacement);
    if (change === "changed-target") await expect(readFile(f.target)).resolves.toEqual(replacement);
  });

  it("preserves an identically recreated link without overwriting its target", async () => {
    const f = await fixture("task");
    const before = await readFile(f.init.workspace.manifestFile);
    expect((await f.remove()).ok).toBe(true);
    await symlink(f.link, f.path);
    expect((await undoDesktopPlanGraphCommand(f.root)).ok).toBe(true);
    expect((await lstat(f.path)).isSymbolicLink()).toBe(true);
    expect(await readlink(f.path)).toBe(f.link);
    await expect(readFile(f.target)).resolves.toEqual(f.bytes);
    await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(before);
  });

  it.each([
    "task",
    "block",
    "review"
  ])("captures no deleted-link metadata for a %s surviving physical owner", async (kind) => {
    const f = await fixture(kind);
    const manifest = manifestSchema.parse(
      JSON.parse((await readFile(f.init.workspace.manifestFile)).toString())
    );
    const survivor = manifest.nodes[1];
    if (survivor?.type !== "task") throw new Error("Surviving task missing.");
    survivor.prompt = "surviving-alias.md";
    await symlink("orphan-target.md", join(f.packageDir, "surviving-alias.md"));
    await writeJsonFile(f.init.workspace.manifestFile, manifestSchema.parse(manifest));
    expect((await f.remove()).ok).toBe(true);
    const { inverse } = await savedEntry(f.root);
    expect(inverse).not.toHaveProperty("promptLinkRestores");
    expect((await lstat(f.path)).isSymbolicLink()).toBe(true);
    const changed = "# Surviving owner edit\r\n";
    await writeFile(f.target, changed);
    await expect(undoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "graph_version_conflict" })]
    });
    await expect(
      executePlanGraphCommand({ projectRoot: f.root, command: inverse })
    ).resolves.toMatchObject({ ok: true });
    await expect(readFile(f.path, "utf8")).resolves.toBe(changed);
    expect((await lstat(f.path)).isSymbolicLink()).toBe(true);
  });

  it.each([
    "distinct-aliases",
    "same-path"
  ])("restores every last-owner %s once within one task transaction", async (mode) => {
    const f = await fixture("task");
    const manifest = manifestSchema.parse(
      JSON.parse((await readFile(f.init.workspace.manifestFile)).toString())
    );
    const task = manifest.nodes[0];
    if (task?.type !== "task") throw new Error("Task missing.");
    const links = [{ path: f.path, target: f.link }];
    for (const block of task.blocks) {
      if (mode === "same-path") block.prompt = task.prompt;
      else {
        const path = join(f.packageDir, block.prompt);
        await rm(path);
        const target = relative(dirname(path), f.target);
        await symlink(target, path);
        links.push({ path, target });
      }
    }
    await writeJsonFile(f.init.workspace.manifestFile, manifest);
    const before = await readFile(f.init.workspace.manifestFile);
    const version = (await getGraphViewModel(f.root)).graphVersion;
    expect((await f.remove()).ok).toBe(true);
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const link of links)
        await expect(lstat(link.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(undoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
        ok: true,
        graphVersion: version
      });
      for (const link of links) {
        expect((await lstat(link.path)).isSymbolicLink()).toBe(true);
        expect(await readlink(link.path)).toBe(link.target);
        await expect(readFile(link.path)).resolves.toEqual(f.bytes);
      }
      await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(before);
      expect((await redoDesktopPlanGraphCommand(f.root)).ok).toBe(true);
    }
  });

  it("rolls newly restored links back after a real later file write failure", async () => {
    const f = await fixture("task");
    expect((await f.remove()).ok).toBe(true);
    const before = await readFile(f.init.workspace.manifestFile);
    const position = await historyPosition(f.root);
    const version = (await getGraphViewModel(f.root)).graphVersion;
    await mkdir(join(f.packageDir, "fail-write"));
    await expect(
      undoPlanGraphCommand({
        projectRoot: f.root,
        dependencies: {
          repository: {
            ...defaultPlanGraphCommandDependencies.repository,
            commit: (options) =>
              defaultPlanGraphCommandDependencies.repository.commit({
                ...options,
                mutation: {
                  ...options.mutation,
                  sideEffects: [
                    ...options.mutation.sideEffects,
                    { kind: "writePrompt", packagePath: "fail-write", markdown: "fails" }
                  ]
                }
              })
          }
        }
      })
    ).rejects.toMatchObject({ code: "EISDIR" });
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(f.target)).resolves.toEqual(f.bytes);
    await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(before);
    expect((await getGraphViewModel(f.root)).graphVersion).toBe(version);
    expect(await historyPosition(f.root)).toEqual(position);
    expect((await undoDesktopPlanGraphCommand(f.root)).ok).toBe(true);
    expect((await lstat(f.path)).isSymbolicLink()).toBe(true);
  });

  it("rejects corrupted persisted link metadata before mutation", async () => {
    const f = await fixture("review");
    expect((await f.remove()).ok).toBe(true);
    const { inverse } = await savedEntry(f.root);
    if (inverse.type !== "updateReviewPipeline" || !inverse.promptLinkRestores?.[0])
      throw new Error("Link metadata missing.");
    const before = await readFile(f.init.workspace.manifestFile);
    const position = await historyPosition(f.root);
    await replaceInverse(f.root, {
      ...inverse,
      promptLinkRestores: [{ ...inverse.promptLinkRestores[0], unknown: true }]
    });
    await expect(undoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "history_command_invalid" })]
    });
    await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(before);
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    await replaceInverse(f.root, inverse);
    expect(await historyPosition(f.root)).toEqual(position);
  });

  it("reads legacy body-only history without inventing link identity", async () => {
    const f = await fixture("review");
    expect((await f.remove()).ok).toBe(true);
    const { inverse } = await savedEntry(f.root);
    if (inverse.type !== "updateReviewPipeline") throw new Error("Review inverse missing.");
    delete inverse.promptLinkRestores;
    await replaceInverse(f.root, inverse);
    expect((await undoDesktopPlanGraphCommand(f.root)).ok).toBe(true);
    expect((await lstat(f.path)).isFile()).toBe(true);
    await expect(readFile(f.path)).resolves.toEqual(f.bytes);
    await writeFile(f.target, "# Target edited\n");
    await expect(readFile(f.path)).resolves.toEqual(f.bytes);
  });
});
