import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
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

  it("parses block refs explicitly", () => {
    expect(parseBlockRef("T-001#B-001")).toEqual({ taskId: "T-001", blockId: "B-001" });
    expect(() => parseBlockRef("T-001")).toThrow("Invalid block ref");
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

  it("reports EIO while reading prompt contents with the underlying error code", async () => {
    const packageDir = await createPackageDir();
    vi.mocked(readFile).mockImplementation((path, options) => {
      if (pathEndsWith(path, "nodes/T-001/blocks/B-001.prompt.md")) {
        throw nodeIoError("EIO");
      }
      return actualFs.readFile(path, options);
    });

    const graph = await compilePackageGraph(basicManifest(), packageDir);

    expect(graph.diagnostics.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "prompt_read_failed",
          message: expect.stringContaining("EIO"),
          path: "nodes/T-001/blocks/B-001.prompt.md"
        })
      ])
    );
  });
});
