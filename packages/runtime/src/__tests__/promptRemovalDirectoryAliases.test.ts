import {
  mkdtemp,
  lstat,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getGraphViewModel,
  getReviewPipeline,
  redoDesktopPlanGraphCommand,
  removeBlock,
  removeTaskNode,
  undoDesktopPlanGraphCommand,
  updateReviewPipeline
} from "../desktop/index.js";
import { layoutPathForWorkspace } from "../desktop/layoutStore.js";
import { writeJsonFile } from "../json.js";
import { createSqlitePlanGraphStore } from "../plangraph/index.js";
import { openDatabase } from "../plangraph/sqlite/connection.js";
import { manifestSchema } from "../schema/manifest.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

let unsupported: string | undefined;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "planweave-alias-capability-"));
  await writeFile(join(root, "target"), "probe");
  try {
    await symlink("target", join(root, "file-link"), "file");
    await symlink(".", join(root, "directory-link"), "dir");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(String(error.code))
    )
      unsupported = `Filesystem symlinks unavailable: ${error.code}`;
    else throw error;
  }
});

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

async function position(root: string) {
  const store = await createSqlitePlanGraphStore({ projectRoot: root });
  const undo = await store.log.latestUndoable();
  const redo = await store.log.latestRedoable();
  return { cursor: undo?.id ?? null, redo: redo?.id ?? null };
}

async function fixture(kind: "task" | "block" | "pipeline", dual = true, regular = false) {
  const manifest = basicManifest({ includeSecondTask: true });
  manifest.executors = {};
  const task = manifest.nodes[0];
  if (task?.type !== "task") throw new Error("Task missing.");
  const review = task.blocks.find((block) => block.type === "review");
  if (!review) throw new Error("Review missing.");
  const f = await createTestWorkspace(manifest);
  const packageDir = await realpath(f.init.workspace.packageDir);
  const packagePath = kind === "task" ? task.prompt : review.prompt;
  const path = join(packageDir, packagePath);
  const alias = "directory-alias";
  await symlink(relative(packageDir, dirname(path)), join(packageDir, alias), "dir");
  const aliasPath = `${alias}/${packagePath.split("/").at(-1)}`;
  if (kind === "task") {
    const block = task.blocks[0];
    if (!block) throw new Error("Block missing.");
    if (dual) block.prompt = aliasPath;
    else task.prompt = aliasPath;
  } else {
    if (dual && kind === "pipeline")
      task.blocks.push({ ...review, id: "R-002", prompt: aliasPath });
    else review.prompt = aliasPath;
  }
  const bytes = Buffer.from("# Directory alias target\r\n中文\r\n\r\n");
  const target = join(packageDir, "target.md");
  await writeFile(target, bytes);
  await rm(path);
  const link = relative(dirname(path), target);
  if (regular) await writeFile(path, bytes);
  else await symlink(link, path, "file");
  await writeJsonFile(f.init.workspace.manifestFile, manifestSchema.parse(manifest));
  const remove = async () => {
    if (kind === "task") return removeTaskNode(f.root, task.id);
    if (kind === "block") return removeBlock(f.root, `${task.id}#${review.id}`);
    const pipeline = await getReviewPipeline(f.root, task.id);
    return updateReviewPipeline(f.root, task.id, {
      packageDefaults: pipeline.packageDefaults,
      steps: []
    });
  };
  return {
    ...f,
    packageDir,
    manifest,
    packagePath,
    aliasPath,
    path,
    target,
    bytes,
    link,
    remove,
    regular
  };
}

async function optionalBytes(path: string) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    manifest: await readFile(f.init.workspace.manifestFile),
    version: (await getGraphViewModel(f.root)).graphVersion,
    position: await position(f.root),
    layout: await optionalBytes(layoutPathForWorkspace(f.init.workspace))
  };
}

async function history(f: Awaited<ReturnType<typeof fixture>>) {
  const store = await createSqlitePlanGraphStore({ projectRoot: f.root });
  const entry = await store.log.latestUndoable();
  if (!entry || Array.isArray(entry.inverse) || !("promptLinkRestores" in entry.inverse))
    throw new Error("Restorable inverse missing.");
  const link = entry.inverse.promptLinkRestores?.[0];
  if (!link) throw new Error("Prompt link metadata missing.");
  return { store, entry, inverse: entry.inverse, link };
}

async function replaceInverse(f: Awaited<ReturnType<typeof fixture>>, inverse: unknown) {
  const { store } = await history(f);
  const db = await openDatabase(store.indexPath);
  try {
    db.prepare(
      "UPDATE operation_log SET inverse_json = ? WHERE id = (SELECT MAX(id) FROM operation_log)"
    ).run(JSON.stringify(inverse));
  } finally {
    db.close();
  }
}

describe("directory aliases retain one physical prompt entry", () => {
  it.each([
    { kind: "task" as const, dual: true, regular: false },
    { kind: "task" as const, dual: false, regular: false },
    { kind: "block" as const, dual: false, regular: false },
    { kind: "pipeline" as const, dual: true, regular: false },
    { kind: "pipeline" as const, dual: false, regular: false },
    { kind: "task" as const, dual: true, regular: true }
  ])("restores $kind dual=$dual regular=$regular through two complete cycles", async ({
    kind,
    dual,
    regular
  }, context) => {
    if (unsupported) context.skip(unsupported);
    const f = await fixture(kind, dual, regular);
    const before = await snapshot(f);
    expect(before.position).toEqual({ cursor: null, redo: null });
    expect((await f.remove()).ok).toBe(true);
    const removed = await snapshot(f);
    expect(removed.version).not.toBe(before.version);
    expect(removed.position).toEqual({ cursor: expect.any(Number), redo: null });
    for (let cycle = 0; cycle < 2; cycle++) {
      await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(join(f.packageDir, f.aliasPath))).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readFile(f.target)).resolves.toEqual(f.bytes);
      expect(await snapshot(f)).toEqual(removed);
      await expect(undoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
        ok: true,
        graphVersion: before.version
      });
      expect(await snapshot(f)).toEqual({
        ...before,
        position: { cursor: null, redo: removed.position.cursor }
      });
      const actual = await lstat(f.path);
      const aliased = await lstat(join(f.packageDir, f.aliasPath));
      expect({ dev: actual.dev, ino: actual.ino }).toEqual({ dev: aliased.dev, ino: aliased.ino });
      expect(actual.isSymbolicLink()).toBe(!regular);
      if (!regular) {
        expect(await readlink(f.path)).toBe(f.link);
        expect(await readlink(join(f.packageDir, f.aliasPath))).toBe(f.link);
      }
      await expect(readFile(f.path)).resolves.toEqual(f.bytes);
      const changed = Buffer.from(`# Edited ${cycle}\r\n`);
      await writeFile(f.target, changed);
      await expect(readFile(f.path)).resolves.toEqual(regular ? f.bytes : changed);
      if (!regular) {
        const edited = await snapshot(f);
        await expect(redoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
          ok: false,
          diagnostics: [expect.objectContaining({ code: "graph_version_conflict" })]
        });
        expect(await snapshot(f)).toEqual(edited);
      }
      await writeFile(f.target, f.bytes);
      await expect(redoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
        ok: true,
        graphVersion: removed.version
      });
      if (!regular) expect((await history(f)).inverse.promptLinkRestores).toHaveLength(1);
    }
    expect(await snapshot(f)).toEqual(removed);
  });

  it.each([
    "same-path",
    "directory-alias",
    "target-directory-alias"
  ])("accepts equivalent persisted %s duplicates", async (mode, context) => {
    if (unsupported) context.skip(unsupported);
    const f = await fixture("task", true);
    const before = await snapshot(f);
    expect((await f.remove()).ok).toBe(true);
    const removed = await snapshot(f);
    const { inverse, link } = await history(f);
    await symlink(".", join(f.packageDir, "root-alias"), "dir");
    await replaceInverse(f, {
      ...inverse,
      promptLinkRestores: [
        link,
        {
          ...link,
          packagePath: mode === "same-path" ? link.packagePath : f.aliasPath,
          targetPackagePath:
            mode === "target-directory-alias" ? "root-alias/target.md" : link.targetPackagePath
        }
      ]
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      await expect(undoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
        ok: true,
        graphVersion: before.version
      });
      expect(await snapshot(f)).toEqual({
        ...before,
        position: { cursor: null, redo: removed.position.cursor }
      });
      expect(await readlink(f.path)).toBe(f.link);
      await expect(readFile(f.path)).resolves.toEqual(f.bytes);
      await expect(redoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
        ok: true,
        graphVersion: removed.version
      });
      expect(await snapshot(f)).toEqual(removed);
    }
  });

  it.each(
    ["same-path", "directory-alias"].flatMap((path) =>
      ["hash", "link", "target"].map((field) => ({ path, field }))
    )
  )("rejects conflicting persisted $path $field metadata before any writes", async ({
    path,
    field
  }, context) => {
    if (unsupported) context.skip(unsupported);
    const f = await fixture("task", true);
    expect((await f.remove()).ok).toBe(true);
    const before = await snapshot(f);
    const { inverse, link } = await history(f);
    await writeFile(join(f.packageDir, "other-target.md"), f.bytes);
    const conflict = {
      ...link,
      packagePath: path === "same-path" ? link.packagePath : f.aliasPath
    };
    if (field === "hash") conflict.targetContentHash = "0".repeat(64);
    if (field === "link") conflict.linkTarget = "../../other-target.md";
    if (field === "target") conflict.targetPackagePath = "other-target.md";
    await replaceInverse(f, { ...inverse, promptLinkRestores: [link, conflict] });
    const saved = (await history(f)).entry;
    const rejected = await undoDesktopPlanGraphCommand(f.root);
    expect(rejected).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "command_validation_failed" })]
    });
    expect(await snapshot(f)).toEqual(before);
    expect((await history(f)).entry).toEqual(saved);
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(f.target)).resolves.toEqual(f.bytes);
    await expect(readFile(join(f.packageDir, "other-target.md"))).resolves.toEqual(f.bytes);
  });

  it("protects the same physical directory entry still owned by another task", async (context) => {
    if (unsupported) context.skip(unsupported);
    const f = await fixture("task", true);
    const survivor = f.manifest.nodes[1];
    if (survivor?.type !== "task") throw new Error("Survivor missing.");
    survivor.prompt = f.aliasPath;
    await writeJsonFile(f.init.workspace.manifestFile, manifestSchema.parse(f.manifest));
    const before = await snapshot(f);
    expect((await f.remove()).ok).toBe(true);
    const store = await createSqlitePlanGraphStore({ projectRoot: f.root });
    expect((await store.log.latestUndoable())?.inverse).not.toHaveProperty("promptLinkRestores");
    expect(await readlink(f.path)).toBe(f.link);
    await expect(readFile(f.path)).resolves.toEqual(f.bytes);
    expect((await undoDesktopPlanGraphCommand(f.root)).ok).toBe(true);
    expect((await snapshot(f)).manifest).toEqual(before.manifest);
  });

  it("rejects a directory alias moved outside the package before undo without writes", async (context) => {
    if (unsupported) context.skip(unsupported);
    const f = await fixture("block", false);
    expect((await f.remove()).ok).toBe(true);
    const outside = await mkdtemp(join(tmpdir(), "planweave-alias-escape-"));
    await writeFile(join(outside, "untouched.md"), f.bytes);
    await rm(join(f.packageDir, "directory-alias"));
    await symlink(outside, join(f.packageDir, "directory-alias"), "dir");
    const before = await snapshot(f);
    const saved = (await history(f)).entry;
    await expect(undoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "command_validation_failed" })]
    });
    expect(await snapshot(f)).toEqual(before);
    expect((await history(f)).entry).toEqual(saved);
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(outside, "R-001.prompt.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outside, "untouched.md"))).resolves.toEqual(f.bytes);
    await expect(readFile(f.target)).resolves.toEqual(f.bytes);
  });
});
