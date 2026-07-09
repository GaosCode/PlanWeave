import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportCanvasPackage, importPackageFiles } from "../toolPackageFiles.js";

const packageFiles = [
  {
    path: "manifest.json",
    content: JSON.stringify({
      version: "plan-package/v1",
      project: { title: "Imported", description: "" },
      execution: { parallel: { enabled: false, maxConcurrent: 1 } },
      review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
      executors: {},
      nodes: [],
      edges: []
    }),
    encoding: "utf8" as const
  },
  { path: "nodes/T-001/prompt.md", content: "# Task\n", encoding: "utf8" as const }
];

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("toolPackageFiles", () => {
  it("rejects imported package paths that escape the package root", async () => {
    await expect(
      importPackageFiles(
        "Bad Import",
        [{ path: "../manifest.json", content: "{}", encoding: "utf8" }],
        false
      )
    ).rejects.toThrow("Invalid package file path");
  });

  it("imports package files into the managed project's canonical default canvas", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-mcp-home-"));
    process.env.PLANWEAVE_HOME = home;

    const result = await importPackageFiles("Canonical Import", packageFiles, false);

    expect(result.validation.ok).toBe(true);
    expect(result.importedFiles).toBe(packageFiles.length);
    await expect(
      readFile(
        join(result.project.rootPath, "canvases", "default", "package", "manifest.json"),
        "utf8"
      )
    ).resolves.toBe(packageFiles[0].content);
    await expect(
      readFile(
        join(
          result.project.rootPath,
          "canvases",
          "default",
          "package",
          "nodes",
          "T-001",
          "prompt.md"
        ),
        "utf8"
      )
    ).resolves.toBe("# Task\n");
    await expect(access(join(result.project.rootPath, "package"))).rejects.toThrow();
  });

  it("exports the canonical default canvas package when canvasId is omitted", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-mcp-home-"));
    process.env.PLANWEAVE_HOME = home;
    const imported = await importPackageFiles("Canonical Export", packageFiles, false);
    const legacyRootPackageDir = join(imported.project.rootPath, "package");
    await mkdir(legacyRootPackageDir, { recursive: true });
    await writeFile(join(legacyRootPackageDir, "manifest.json"), '{"legacy":true}', "utf8");

    const exported = await exportCanvasPackage(imported.project.projectId);

    expect(exported.canvasId).toBe("default");
    expect(exported.files).toEqual(packageFiles);
  });
});
