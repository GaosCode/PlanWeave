import {
  mkdir,
  rename,
  lstat,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getGraphViewModel,
  getTaskDetail,
  redoDesktopPlanGraphCommand,
  removeTaskNode,
  undoDesktopPlanGraphCommand
} from "../desktop/index.js";
import * as json from "../json.js";
import { defaultPlanGraphCommandDependencies } from "../plangraph/adapters.js";
import {
  undoPlanGraphCommand,
  executePlanGraphCommand,
  createSqlitePlanGraphStore
} from "../plangraph/index.js";
import { manifestSchema } from "../schema/manifest.js";
import { writeJsonFile } from "../json.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

async function position(root: string) {
  const store = await createSqlitePlanGraphStore({ projectRoot: root });
  const undo = await store.log.latestUndoable();
  const redo = await store.log.latestRedoable();
  return { cursor: undo?.id ?? null, redo: redo?.id ?? null, canUndo: !!undo, canRedo: !!redo };
}

async function fixture(chain: boolean) {
  const manifest = basicManifest({ includeSecondTask: true });
  const f = await createTestWorkspace(manifest);
  await writeJsonFile(f.init.workspace.manifestFile, manifestSchema.parse(manifest));
  const packageDir = await realpath(f.init.workspace.packageDir);
  const task = join(packageDir, "nodes/T-001/prompt.md");
  const block = join(packageDir, "nodes/T-001/blocks/B-001.prompt.md");
  const orphan = join(packageDir, "orphan.md");
  const bytes = Buffer.from("# Dependency original\r\n中文\r\n\r\n");
  if (chain) {
    await writeFile(orphan, bytes);
    await rm(block);
    await symlink("../../../orphan.md", block);
  } else await writeFile(block, bytes);
  await rm(task);
  await symlink("blocks/B-001.prompt.md", task);
  return { ...f, packageDir, task, block, orphan, bytes, target: chain ? orphan : block };
}

describe("prompt link history restores dependencies from the same inverse", () => {
  it.each([
    false,
    true
  ])("restores removed target chain=%s through two complete cycles", async (chain) => {
    const f = await fixture(chain);
    const before = await readFile(f.init.workspace.manifestFile);
    const versionBefore = (await getGraphViewModel(f.root)).graphVersion;
    expect((await removeTaskNode(f.root, "T-001")).ok).toBe(true);
    const after = await readFile(f.init.workspace.manifestFile);
    const versionAfter = (await getGraphViewModel(f.root)).graphVersion;
    const positionAfter = await position(f.root);
    for (let cycle = 0; cycle < 2; cycle++) {
      await expect(lstat(f.task)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(f.block)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(after);
      expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionAfter);
      expect(await position(f.root)).toEqual(positionAfter);
      await expect(undoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
        ok: true,
        graphVersion: versionBefore
      });
      await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(before);
      await expect(readFile(f.task)).resolves.toEqual(f.bytes);
      await expect(readFile(f.block)).resolves.toEqual(f.bytes);
      expect((await lstat(f.task)).isSymbolicLink()).toBe(true);
      expect(await readlink(f.task)).toBe("blocks/B-001.prompt.md");
      expect((await lstat(f.block)).isSymbolicLink()).toBe(chain);
      if (chain) expect(await readlink(f.block)).toBe("../../../orphan.md");
      expect((await getGraphViewModel(f.root)).graphVersion).toBe(versionBefore);
      expect(await position(f.root)).toEqual({
        cursor: null,
        redo: positionAfter.cursor,
        canUndo: false,
        canRedo: true
      });
      const changed = `# Actual target edit ${cycle}\r\n`;
      await writeFile(f.target, changed);
      expect((await getTaskDetail(f.root, "T-001")).promptMarkdown).toBe(changed);
      await expect(readFile(f.task, "utf8")).resolves.toBe(changed);
      await expect(redoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
        ok: false,
        diagnostics: [expect.objectContaining({ code: "graph_version_conflict" })]
      });
      await writeFile(f.target, f.bytes);
      await expect(redoDesktopPlanGraphCommand(f.root)).resolves.toMatchObject({
        ok: true,
        graphVersion: versionAfter
      });
    }
  });
});

async function deleted(chain: boolean) {
  const f = await fixture(chain);
  expect((await removeTaskNode(f.root, "T-001")).ok).toBe(true);
  const store = await createSqlitePlanGraphStore({ projectRoot: f.root });
  const entry = await store.log.latestUndoable();
  if (!entry || Array.isArray(entry.inverse) || entry.inverse.type !== "restoreTask")
    throw new Error("Restore inverse missing.");
  return {
    ...f,
    inverse: entry.inverse,
    manifestAfter: await readFile(f.init.workspace.manifestFile),
    versionAfter: (await getGraphViewModel(f.root)).graphVersion,
    positionAfter: await position(f.root)
  };
}

async function remainsDeleted(f: Awaited<ReturnType<typeof deleted>>) {
  await expect(readFile(f.init.workspace.manifestFile)).resolves.toEqual(f.manifestAfter);
  expect((await getGraphViewModel(f.root)).graphVersion).toBe(f.versionAfter);
  expect(await position(f.root)).toEqual(f.positionAfter);
  await expect(lstat(f.task)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("dependency restoration validates the complete final write set", () => {
  it.each([
    "wrong-hash",
    "escape",
    "cycle",
    "replacement-file",
    "replacement-link"
  ])("rejects %s before any dependency write", async (change) => {
    const f = await deleted(change === "cycle");
    const link = f.inverse.promptLinkRestores?.[0];
    if (!link) throw new Error("Link metadata missing.");
    const outside = join(f.root, "outside.md");
    const replacement = Buffer.from("# Concurrent target\r\n");
    if (change === "wrong-hash") {
      const prompt = f.inverse.snapshot.blockPromptMarkdown.find(
        (item) => item.blockId === "B-001"
      );
      if (!prompt) throw new Error("Block snapshot missing.");
      prompt.markdown = "# Wrong planned bytes\n";
    }
    if (change === "escape") {
      await writeFile(outside, f.bytes);
      link.linkTarget = outside;
    }
    if (change === "cycle") {
      const blockLink = f.inverse.promptLinkRestores?.find((item) =>
        item.packagePath.endsWith("B-001.prompt.md")
      );
      if (!blockLink) throw new Error("Block link missing.");
      blockLink.linkTarget = "../prompt.md";
    }
    if (change === "replacement-file") await writeFile(f.block, replacement);
    if (change === "replacement-link") {
      await writeFile(f.orphan, f.bytes);
      await symlink("../../../orphan.md", f.block);
    }
    await expect(
      executePlanGraphCommand({ projectRoot: f.root, command: f.inverse })
    ).resolves.toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "command_validation_failed" })]
    });
    await remainsDeleted(f);
    if (change === "replacement-file")
      await expect(readFile(f.block)).resolves.toEqual(replacement);
    else if (change === "replacement-link")
      expect(await readlink(f.block)).toBe("../../../orphan.md");
    else await expect(lstat(f.block)).rejects.toMatchObject({ code: "ENOENT" });
    if (change === "escape") await expect(readFile(outside)).resolves.toEqual(f.bytes);
  });

  it.each([
    "last-write-wrong",
    "last-remove",
    "last-write-correct"
  ])("uses the actual final target when the transaction has %s", async (mode) => {
    const f = await deleted(false);
    const result = undoPlanGraphCommand({
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
                  {
                    kind: "writePrompt",
                    packagePath: "nodes/T-001/blocks/B-001.prompt.md",
                    markdown: "# Wrong intermediate\n"
                  },
                  ...(mode === "last-remove"
                    ? [
                        {
                          kind: "removePrompt" as const,
                          packagePath: "nodes/T-001/blocks/B-001.prompt.md"
                        }
                      ]
                    : mode === "last-write-correct"
                      ? [
                          {
                            kind: "writePrompt" as const,
                            packagePath: "nodes/T-001/blocks/B-001.prompt.md",
                            markdown: f.bytes.toString()
                          }
                        ]
                      : [])
                ]
              }
            })
        }
      }
    });
    if (mode === "last-write-correct") {
      expect((await result).ok).toBe(true);
      await expect(readFile(f.task)).resolves.toEqual(f.bytes);
      expect((await lstat(f.task)).isSymbolicLink()).toBe(true);
    } else {
      await expect(result).rejects.toThrow(/restore|unreferenced/i);
      await remainsDeleted(f);
      await expect(lstat(f.block)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each([
    false,
    true
  ])("rolls back the complete restored chain after a real final rename failure (chain=%s)", async (chain) => {
    const f = await deleted(chain);
    const failureDirectory = join(f.packageDir, "publication-failure");
    await mkdir(failureDirectory);
    const write = json.writeJsonFile;
    let observed = false;
    vi.spyOn(json, "writeJsonFile").mockImplementation(async (path, data, options) => {
      if (path !== f.init.workspace.manifestFile) return write(path, data, options);
      return write(path, data, {
        ...options,
        rename: async (temporary) => {
          expect((await lstat(f.task)).isSymbolicLink()).toBe(true);
          expect((await lstat(f.block)).isSymbolicLink()).toBe(chain);
          expect(await readlink(f.task)).toBe("blocks/B-001.prompt.md");
          await expect(readFile(f.task)).resolves.toEqual(f.bytes);
          observed = true;
          await rename(temporary, failureDirectory);
        }
      });
    });
    await expect(undoDesktopPlanGraphCommand(f.root)).rejects.toMatchObject({ code: "EISDIR" });
    expect(observed).toBe(true);
    await remainsDeleted(f);
    await expect(lstat(f.block)).rejects.toMatchObject({ code: "ENOENT" });
    if (chain) await expect(readFile(f.orphan)).resolves.toEqual(f.bytes);
  });
});
