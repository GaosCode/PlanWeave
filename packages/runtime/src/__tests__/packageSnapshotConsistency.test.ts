import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { commitPlanPackageGraphMutation } from "../graph/editGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import { PACKAGE_SNAPSHOT_MAX_FILE_BYTES } from "@planweave-ai/collaboration-protocol/core/limits";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    writeFile: vi.fn(actual.writeFile),
    realpath: vi.fn(actual.realpath)
  };
});
let actual: typeof fs;
const roots: string[] = [];
beforeEach(async () => {
  actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.stat).mockReset().mockImplementation(actual.stat);
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile);
  vi.mocked(fs.realpath).mockReset().mockImplementation(actual.realpath);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => actual.rm(root, { recursive: true, force: true }))
  );
  delete process.env.PLANWEAVE_HOME;
});

describe("snapshot capture consistency on real files", () => {
  it.each([
    "invalid-utf8",
    "oversized",
    "symlink-outside"
  ] as const)("preserves rejection of %s prompt content", async (mode) => {
    const { root, home, init } = await createTestWorkspace();
    roots.push(root, home);
    const prompt = join(init.workspace.packageDir, "nodes/T-001/prompt.md");
    if (mode === "invalid-utf8") await actual.writeFile(prompt, Buffer.from([0xff]));
    else if (mode === "oversized")
      await actual.truncate(prompt, PACKAGE_SNAPSHOT_MAX_FILE_BYTES + 1);
    else {
      const outside = join(root, "outside.md");
      await actual.writeFile(outside, "outside content");
      await actual.unlink(prompt);
      await actual.symlink(outside, prompt);
    }
    await expect(capturePackageSnapshot({ projectRoot: init.workspace })).rejects.toThrow(
      mode === "invalid-utf8"
        ? "package_snapshot_invalid_utf8"
        : mode === "oversized"
          ? "package_snapshot_file_too_large"
          : "must stay inside"
    );
  });
  it("waits for all graph side effects and manifest publication", async () => {
    const { root, home, init } = await createTestWorkspace();
    roots.push(root, home);
    const { manifest } = await loadPackage(init.workspace);
    const task = manifest.nodes[0]!;
    const first = join(init.workspace.packageDir, task.prompt);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(fs.writeFile).mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      await Reflect.apply(actual.writeFile, actual, args);
      if (args[0] === first) {
        entered();
        await resumed;
      }
    });
    const writer = commitPlanPackageGraphMutation({
      projectRoot: init.workspace,
      mutation: {
        nextManifest: { ...manifest, project: { ...manifest.project, title: "new version" } },
        affectedTasks: [task.id],
        sideEffects: [
          { kind: "writePrompt", packagePath: task.prompt, markdown: "new task" },
          { kind: "writePrompt", packagePath: task.blocks[0]!.prompt, markdown: "new block" }
        ]
      }
    });
    await paused;
    let attempting!: () => void;
    const attempt = new Promise<void>((resolve) => {
      attempting = resolve;
    });
    vi.mocked(fs.realpath).mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      const value = await Reflect.apply(actual.realpath, actual, args);
      if (args[0] === init.workspace.packageDir) attempting();
      return value;
    });
    const reader = capturePackageSnapshot({ projectRoot: init.workspace });
    try {
      await attempt;
    } finally {
      release();
    }
    await writer;
    const captured = await reader;
    expect(JSON.parse(captured.snapshot.files[0]!.content).project.title).toBe("new version");
    expect(captured.snapshot.files.find((file) => file.path === task.prompt)?.content).toBe(
      "new task"
    );
    expect(
      captured.snapshot.files.find((file) => file.path === task.blocks[0]!.prompt)?.content
    ).toBe("new block");
  });

  it("rejects a manifest changing its prompt closure during capture", async () => {
    const { root, home, init } = await createTestWorkspace();
    roots.push(root, home);
    const manifest = JSON.parse(await actual.readFile(init.workspace.manifestFile, "utf8"));
    manifest.nodes[0].prompt = "nodes/T-001/new.md";
    await actual.writeFile(join(init.workspace.packageDir, manifest.nodes[0].prompt), "new prompt");
    let changed = false;
    vi.mocked(fs.stat).mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const metadata = await Reflect.apply(actual.stat, actual, args);
      if (args[0] === init.workspace.manifestFile && !changed) {
        changed = true;
        await actual.writeFile(init.workspace.manifestFile, JSON.stringify(manifest));
      }
      return metadata;
    });
    await expect(capturePackageSnapshot({ projectRoot: init.workspace })).rejects.toThrow(
      "package_snapshot_conflict"
    );
    const captured = await capturePackageSnapshot({ projectRoot: init.workspace });
    expect(
      captured.snapshot.files.find((file) => file.path === manifest.nodes[0].prompt)?.content
    ).toBe("new prompt");
  });

  it.each([
    "rewrite",
    "delete",
    "replace-directory",
    "grow"
  ] as const)("rejects an earlier prompt %s while reading later members", async (mode) => {
    const { root, home, init } = await createTestWorkspace();
    roots.push(root, home);
    const early = join(init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md");
    const late = join(init.workspace.packageDir, "nodes/T-001/prompt.md");
    let changed = false;
    vi.mocked(fs.stat).mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      const metadata = await Reflect.apply(actual.stat, actual, args);
      if (args[0] === late && !changed) {
        changed = true;
        if (mode === "rewrite") await actual.writeFile(early, "changed earlier prompt");
        else if (mode === "delete") await actual.unlink(early);
        else if (mode === "grow") await actual.truncate(early, PACKAGE_SNAPSHOT_MAX_FILE_BYTES + 1);
        else {
          const backup = `${init.workspace.packageDir}-external-backup`;
          await actual.rename(init.workspace.packageDir, backup);
          await actual.cp(backup, init.workspace.packageDir, { recursive: true });
        }
      }
      return metadata;
    });
    await expect(capturePackageSnapshot({ projectRoot: init.workspace })).rejects.toThrow(
      "package_snapshot_conflict"
    );
  });
});
