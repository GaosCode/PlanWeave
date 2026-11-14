import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compilePackageGraph, compileTaskGraph, parseBlockRef } from "../graph/compileTaskGraph.js";
import { basicManifest, writePromptFiles } from "./promptTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    stat: vi.fn(actual.stat)
  };
});

let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(readFile).mockImplementation((path, options) => actualFs.readFile(path, options));
  vi.mocked(readdir).mockImplementation((path, options) => actualFs.readdir(path, options));
  vi.mocked(stat).mockImplementation((path, options) => actualFs.stat(path, options));
});

function nodeIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code} simulated`), { code });
}

function pathEndsWith(path: string | Buffer | URL, suffix: string): boolean {
  return String(path).split("\\").join("/").endsWith(suffix);
}

async function createPackageDir(): Promise<string> {
  const packageDir = await mkdtemp(join(tmpdir(), "planweave-compile-graph-"));
  await writePromptFiles(packageDir, basicManifest());
  return packageDir;
}

describe("compileTaskGraph", () => {
  it("indexes block refs, block dependencies, and review blocks", () => {
    const graph = compileTaskGraph(basicManifest());

    expect(graph.blockRefsInManifestOrder).toEqual(["T-001#B-001", "T-001#R-001"]);
    expect(graph.blockDependenciesByRef.get("T-001#R-001")).toEqual(["T-001#B-001"]);
    expect(graph.reviewBlocksByTask.get("T-001")).toEqual(["T-001#R-001"]);
    expect(graph.diagnostics.errors).toEqual([]);
  });

  it("accepts tasks without review blocks", () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.blocks = task.blocks.filter((block) => block.type !== "review");

    const graph = compileTaskGraph(manifest);

    expect(graph.blockRefsInManifestOrder).toEqual(["T-001#B-001"]);
    expect(graph.reviewBlocksByTask.get("T-001")).toEqual([]);
    expect(graph.diagnostics.errors).toEqual([]);
  });

  it("keeps block dependencies scoped to the same task", () => {
    const manifest = basicManifest({ includeSecondTask: true });
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.blocks[0].depends_on = ["T-002#B-001"];

    const graph = compileTaskGraph(manifest);

    expect(graph.diagnostics.errors.map((error) => error.code)).toContain(
      "block_dependency_missing"
    );
  });

  it("detects task and block dependency cycles", () => {
    const manifest = basicManifest({ includeSecondTask: true });
    manifest.edges.push({ from: "T-001", to: "T-002", type: "depends_on" });
    manifest.edges.push({ from: "T-002", to: "T-001", type: "depends_on" });
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    if (task?.type !== "task") {
      throw new Error("missing task");
    }
    task.blocks[0].depends_on = ["R-001"];

    const graph = compileTaskGraph(manifest);

    expect(graph.diagnostics.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(["depends_on_cycle", "block_depends_on_cycle"])
    );
  });

  it.each([
    ["T-001", "B-001"],
    ["任务 实作.+[]", ".block"],
    ["a".repeat(257), "乙".repeat(257)]
  ])("parses '%s#%s' without changing either segment", (taskId, blockId) => {
    expect(parseBlockRef(`${taskId}#${blockId}`)).toEqual({ taskId, blockId });
  });

  it.each([
    "T-001",
    "#B-001",
    "T-001#",
    "T-001#B-001#R-001"
  ])("rejects malformed block ref %j", (ref) => {
    expect(() => parseBlockRef(ref)).toThrow("Invalid block ref");
  });
});

describe("compilePackageGraph", () => {
  it("reports EACCES while checking a referenced prompt instead of treating it as missing", async () => {
    const packageDir = await createPackageDir();
    vi.mocked(stat).mockImplementation((path, options) => {
      if (pathEndsWith(path, "nodes/T-001/prompt.md")) {
        throw nodeIoError("EACCES");
      }
      return actualFs.stat(path, options);
    });

    const graph = await compilePackageGraph(basicManifest(), packageDir);

    expect(graph.diagnostics.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_access_failed",
          message: expect.stringContaining("EACCES"),
          path: "nodes/T-001/prompt.md"
        })
      ])
    );
    expect(graph.diagnostics.errors).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_missing",
          path: "nodes/T-001/prompt.md"
        })
      ])
    );
  });

  it("reports EPERM while scanning prompt directories instead of returning an empty stale prompt set", async () => {
    const packageDir = await createPackageDir();
    vi.mocked(readdir).mockImplementation((path, options) => {
      if (pathEndsWith(path, "nodes/T-001/blocks")) {
        throw nodeIoError("EPERM");
      }
      return actualFs.readdir(path, options);
    });

    const graph = await compilePackageGraph(basicManifest(), packageDir);

    expect(graph.diagnostics.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_directory_read_failed",
          message: expect.stringContaining("EPERM"),
          path: "nodes/T-001/blocks"
        })
      ])
    );
  });

  it.each([
    "EACCES",
    "EIO"
  ])("reports %s when reading a referenced non-Markdown file", async (code) => {
    const packageDir = await createPackageDir();
    const manifest = basicManifest();
    const prompt = "shared/failing.txt";
    manifest.nodes[0].blocks[0].prompt = prompt;
    await mkdir(join(packageDir, "shared"));
    const promptPath = join(packageDir, prompt);
    await writeFile(promptPath, "Shared content");
    const promptTarget = await realpath(promptPath);
    vi.mocked(readFile).mockImplementation((path, options) => {
      if (path === promptPath || path === promptTarget) {
        throw nodeIoError(code);
      }
      return actualFs.readFile(path, options);
    });

    const graph = await compilePackageGraph(manifest, packageDir);

    expect(graph.diagnostics.errors).toEqual([
      {
        code: "prompt_read_failed",
        message: `Prompt '${prompt}' could not be read: ${code}.`,
        path: prompt
      }
    ]);
  });

  it("reads a shared prompt once and only warns about orphan Markdown files", async () => {
    const packageDir = await mkdtemp(join(tmpdir(), "planweave-compile-graph-"));
    const manifest = basicManifest({ includeSecondTask: true });
    const shared = "shared/foo.txt";
    for (const task of manifest.nodes) {
      task.prompt = shared;
      for (const block of task.blocks) {
        block.prompt = "./shared/foo.txt";
      }
    }
    await mkdir(join(packageDir, "shared"));
    await mkdir(join(packageDir, "nodes"));
    await writeFile(join(packageDir, shared), "Shared prompt");
    await writeFile(join(packageDir, "shared", "unused.md"), "Not a prompt reference");
    await writeFile(join(packageDir, "nodes", "orphan.md"), "Not a prompt reference");
    vi.mocked(readFile).mockClear();

    const graph = await compilePackageGraph(manifest, packageDir);

    expect(graph.diagnostics.errors).toEqual([]);
    expect(graph.diagnostics.warnings).toEqual([
      expect.objectContaining({ code: "stale_prompt_reference", path: "nodes/orphan.md" })
    ]);
    expect(vi.mocked(readFile).mock.calls.map(([path]) => path)).toEqual([
      await realpath(join(packageDir, shared))
    ]);
  });

  it("checks file types and missing paths without reading any contents in metadata mode", async () => {
    const packageDir = await realpath(await createPackageDir());
    const manifest = basicManifest();
    const task = manifest.nodes[0];
    task.blocks[0].prompt = "nodes/T-001/blocks";
    task.blocks[1].prompt = "nodes/absent.md";
    vi.mocked(readFile).mockClear();

    const graph = await compilePackageGraph(manifest, packageDir, {
      validatePromptContents: false
    });

    expect(graph.diagnostics.errors).toEqual([
      expect.objectContaining({ code: "prompt_not_file", path: "nodes/T-001/blocks" }),
      expect.objectContaining({ code: "prompt_missing", path: "nodes/absent.md" })
    ]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("accepts in-package file symlinks and attributes rejected links to their manifest paths", async ({
    skip
  }) => {
    const packageDir = await createPackageDir();
    const externalDir = await createPackageDir();
    const manifest = basicManifest({ includeSecondTask: true });
    const [task, otherTask] = manifest.nodes;
    task.prompt = "file-link.md";
    task.blocks[0].prompt = "directory-link.md";
    task.blocks[1].prompt = "dangling-link.md";
    otherTask.prompt = "outside-link.md";
    for (const block of otherTask.blocks) {
      block.prompt = task.prompt;
    }
    otherTask.blocks[0].prompt = "outside-dangling-chain.md";
    try {
      await symlink(
        join(packageDir, "nodes/T-001/prompt.md"),
        join(packageDir, task.prompt),
        "file"
      );
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        skip("The Windows test process lacks permission to create file symlinks.");
      }
      throw error;
    }
    await symlink(join(packageDir, "nodes/T-001"), join(packageDir, task.blocks[0].prompt), "dir");
    const aliasedPackageDir = join(externalDir, "package-alias");
    await symlink(packageDir, aliasedPackageDir, "junction");
    await symlink(
      join(aliasedPackageDir, "absent.md"),
      join(packageDir, task.blocks[1].prompt),
      "file"
    );
    await symlink(
      join(externalDir, "nodes/T-001/prompt.md"),
      join(packageDir, otherTask.prompt),
      "file"
    );
    const outsideLink = join(externalDir, "back-to-package.md");
    await symlink(join(packageDir, "absent.md"), outsideLink, "file");
    await symlink(outsideLink, join(packageDir, otherTask.blocks[0].prompt), "file");
    vi.mocked(readFile).mockClear();

    const graph = await compilePackageGraph(manifest, packageDir);

    expect(graph.diagnostics.errors).toHaveLength(4);
    expect(graph.diagnostics.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "prompt_missing", path: "dangling-link.md" }),
        expect.objectContaining({ code: "prompt_not_file", path: "directory-link.md" }),
        expect.objectContaining({ code: "package_path_outside", path: "outside-link.md" }),
        expect.objectContaining({
          code: "package_path_outside",
          path: "outside-dangling-chain.md"
        })
      ])
    );
    expect(vi.mocked(readFile).mock.calls.map(([path]) => path)).toEqual([
      await realpath(join(packageDir, task.prompt))
    ]);
  });

  it("does not emit stale_prompt_reference for referenced package prompts", async () => {
    const packageDir = await createPackageDir();
    const graph = await compilePackageGraph(basicManifest(), packageDir);
    expect(graph.diagnostics.warnings.map((warning) => warning.code)).not.toContain(
      "stale_prompt_reference"
    );
    expect(graph.diagnostics.errors).toEqual([]);
  });
});
