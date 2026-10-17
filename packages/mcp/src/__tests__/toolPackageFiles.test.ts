import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initManagedWorkspace,
  replacePackageFiles,
  validatePackageDraft,
  type PackageFileEntry,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import { exportCanvasPackage, importPackageFiles } from "../toolPackageFiles.js";

const packageFiles: PackageFileEntry[] = [
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

let home: string;
let caseInsensitive: boolean;

beforeAll(async () => {
  const probeRoot = await mkdtemp(join(tmpdir(), "planweave-mcp-case-probe-"));
  try {
    await writeFile(join(probeRoot, "case-probe"), "filesystem capability\n");
    try {
      caseInsensitive =
        (await readFile(join(probeRoot, "CASE-PROBE"), "utf8")) === "filesystem capability\n";
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      caseInsensitive = false;
    }
    console.info("MCP import temporary filesystem capability", { caseInsensitive });
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "planweave-mcp-home-"));
  const temporaryDirectory = join(home, "tmp");
  await mkdir(temporaryDirectory);
  vi.stubEnv("PLANWEAVE_HOME", home);
  for (const variable of ["TMPDIR", "TEMP", "TMP"]) {
    vi.stubEnv(variable, temporaryDirectory);
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

async function diskSnapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  async function visit(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        entries[relativePath] = "directory";
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        entries[relativePath] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      } else {
        throw new Error(`Unexpected snapshot entry: ${path}`);
      }
    }
  }
  await visit(root, "");
  return entries;
}

async function importTempDirectories(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("planweave-mcp-import-"))
    .sort();
}

function taskPackageFiles(prompt = "nodes/T-001/prompt.md"): PackageFileEntry[] {
  const manifest: PlanPackageManifest = JSON.parse(packageFiles[0].content);
  manifest.nodes = [
    {
      id: "T-001",
      type: "task",
      title: "Task",
      prompt,
      acceptance: ["Implementation completes"],
      blocks: [
        {
          id: "B-001",
          type: "implementation",
          title: "Implement",
          prompt: "nodes/T-001/blocks/B-001.md",
          depends_on: []
        }
      ]
    }
  ];
  return [
    { path: "manifest.json", content: JSON.stringify(manifest), encoding: "utf8" },
    { path: "nodes/T-001/blocks/B-001.md", content: "# Implement\n", encoding: "utf8" }
  ];
}

function projectDraftFiles(graphPath: string, rootManifest: string): PackageFileEntry[] {
  return [
    { path: "manifest.json", content: rootManifest, encoding: "utf8" },
    {
      path: graphPath,
      content: JSON.stringify({
        version: "plan-project/v1",
        canvases: [
          {
            id: "default",
            type: "canvas",
            title: "Default",
            packageDir: "canvases/default/package",
            stateFile: "canvases/default/state.json",
            resultsDir: "canvases/default/results"
          }
        ],
        edges: [],
        crossTaskEdges: []
      }),
      encoding: "utf8"
    },
    { ...packageFiles[0], path: "canvases/default/package/manifest.json" }
  ];
}

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
    const unrelated = await initManagedWorkspace({ name: "Unrelated" });
    const unrelatedBefore = await diskSnapshot(unrelated.workspace.workspaceRoot);
    const registeredBefore = await readdir(join(home, "projects"));
    const tempBefore = await importTempDirectories();

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
    expect((await readdir(join(home, "projects"))).sort()).toEqual(
      [...registeredBefore, result.project.projectId].sort()
    );
    expect(await diskSnapshot(unrelated.workspace.workspaceRoot)).toEqual(unrelatedBefore);
    expect(await importTempDirectories()).toEqual(tempBefore);
  });

  it("exports the canonical default canvas package when canvasId is omitted", async () => {
    const imported = await importPackageFiles("Canonical Export", packageFiles, false);
    const legacyRootPackageDir = join(imported.project.rootPath, "package");
    await mkdir(legacyRootPackageDir, { recursive: true });
    await writeFile(join(legacyRootPackageDir, "manifest.json"), '{"legacy":true}', "utf8");

    const exported = await exportCanvasPackage(imported.project.projectId);

    expect(exported.canvasId).toBe("default");
    expect(exported.files).toEqual(packageFiles);
  });

  it.each([
    {
      name: "invalid manifest",
      files: [{ path: "manifest.json", content: "{}", encoding: "utf8" as const }],
      code: "manifest_schema"
    },
    { name: "missing prompt", files: taskPackageFiles(), code: "prompt_missing" },
    {
      name: "escaping prompt",
      files: taskPackageFiles("../outside.md"),
      code: "package_path_outside"
    }
  ])("rejects $name without changing home or leaving temporary resources", async ({
    files,
    code
  }) => {
    await initManagedWorkspace({ name: "Unrelated" });
    const before = await diskSnapshot(home);
    const tempBefore = await importTempDirectories();

    await expect(importPackageFiles("Invalid Import", files, false)).rejects.toThrow(code);

    expect(await diskSnapshot(home)).toEqual(before);
    expect(await importTempDirectories()).toEqual(tempBefore);
  });

  it("rejects duplicate names without changing registered data", async () => {
    await initManagedWorkspace({ name: "Unrelated" });
    await importPackageFiles("Existing Import", packageFiles, false);
    const before = await diskSnapshot(home);
    const tempBefore = await importTempDirectories();

    await expect(importPackageFiles("Existing Import", packageFiles, false)).rejects.toThrow(
      "Imported project already exists. Pass overwrite: true"
    );

    expect(await diskSnapshot(home)).toEqual(before);
    expect(await importTempDirectories()).toEqual(tempBefore);
  });

  it.each([
    { overwrite: false, rootManifest: "{}" },
    { overwrite: true, rootManifest: "{}" },
    { overwrite: false, rootManifest: packageFiles[0].content },
    { overwrite: true, rootManifest: packageFiles[0].content }
  ])("rejects a project-mode package before registration or replacement ($overwrite, $rootManifest)", async ({
    overwrite,
    rootManifest
  }) => {
    await initManagedWorkspace({ name: "Unrelated" });
    const target = await importPackageFiles("Existing Import", packageFiles, false);
    const packageDir = join(target.project.rootPath, "canvases", "default", "package");
    await writeFile(join(packageDir, "sentinel.md"), "original package\n");
    const before = await diskSnapshot(home);
    const tempBefore = await importTempDirectories();
    const files = projectDraftFiles("project-graph.json", rootManifest);

    const error = await importPackageFiles(
      overwrite ? "Existing Import" : "New Invalid Import",
      files,
      overwrite
    ).then(
      () => null,
      (reason: unknown) => reason
    );

    expect(await diskSnapshot(home)).toEqual(before);
    expect(await readFile(join(packageDir, "manifest.json"), "utf8")).toBe(packageFiles[0].content);
    expect(await readFile(join(packageDir, "sentinel.md"), "utf8")).toBe("original package\n");
    expect(await importTempDirectories()).toEqual(tempBefore);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", expect.stringContaining("single-canvas"));
  });

  for (const { graphPath, overwrite, rootManifest } of [
    "project-graph.json/",
    "PROJECT-GRAPH.JSON"
  ].flatMap((graphPath) =>
    [false, true].flatMap((overwrite) =>
      ["{}", packageFiles[0].content].map((rootManifest) => ({
        graphPath,
        overwrite,
        rootManifest
      }))
    )
  )) {
    it(`rejects actual project mode for ${graphPath} before persistence (overwrite=${overwrite}, validRoot=${rootManifest !== "{}"})`, async ({
      skip
    }) => {
      if (graphPath === "PROJECT-GRAPH.JSON" && !caseInsensitive) {
        skip("Temporary filesystem is case-sensitive; uppercase alias does not form project mode.");
      }
      await initManagedWorkspace({ name: "Unrelated" });
      const target = await importPackageFiles("Existing Import", packageFiles, false);
      const packageDir = join(target.project.rootPath, "canvases", "default", "package");
      await writeFile(join(packageDir, "sentinel.md"), "original package\n");
      const before = await diskSnapshot(home);
      const tempBefore = await importTempDirectories();
      const files = projectDraftFiles(graphPath, rootManifest);

      const controlRoot = await mkdtemp(join(tmpdir(), "planweave-mcp-mode-control-"));
      try {
        await replacePackageFiles(join(controlRoot, "draft"), files);
        const control = await validatePackageDraft({ draftRoot: join(controlRoot, "draft") });
        expect(control).toMatchObject({ mode: "project", validation: { ok: true } });
      } finally {
        await rm(controlRoot, { recursive: true, force: true });
      }
      expect(await diskSnapshot(home)).toEqual(before);

      const error = await importPackageFiles(
        overwrite ? "Existing Import" : "New Invalid Import",
        files,
        overwrite
      ).then(
        () => null,
        (reason: unknown) => reason
      );

      expect.soft(await diskSnapshot(home)).toEqual(before);
      expect
        .soft(await readFile(join(packageDir, "manifest.json"), "utf8"))
        .toBe(packageFiles[0].content);
      await expect
        .soft(readFile(join(packageDir, "sentinel.md"), "utf8"))
        .resolves.toBe("original package\n");
      expect(await importTempDirectories()).toEqual(tempBefore);
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining(
          "Imported PlanWeave package is invalid: this import accepts a single-canvas"
        )
      );
    });
  }

  it("imports nested package assets without treating them as a project draft", async () => {
    const files: PackageFileEntry[] = [
      ...packageFiles,
      { ...packageFiles[0], path: "assets/package/manifest.json" },
      { path: "assets/project-graph.json", content: "{}", encoding: "utf8" }
    ];
    const imported = await importPackageFiles("Nested Assets", files, false);

    expect(imported.validation.ok).toBe(true);
    expect((await exportCanvasPackage(imported.project.projectId)).files).toEqual(
      [...files].sort((left, right) => left.path.localeCompare(right.path))
    );
  });

  it("overwrites only the selected package and does not follow its existing symlinks", async () => {
    const unrelated = await initManagedWorkspace({ name: "Unrelated" });
    const target = await initManagedWorkspace({ name: "Existing Import" });
    const outside = join(unrelated.workspace.workspaceRoot, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "prompt.md"), "outside unchanged\n");
    await symlink(outside, join(target.workspace.packageDir, "linked"), "dir");
    const unrelatedBefore = await diskSnapshot(unrelated.workspace.workspaceRoot);
    const registeredBefore = (await readdir(join(home, "projects"))).sort();
    const stateBefore = await readFile(target.workspace.stateFile, "utf8");
    const metadataBefore = await readFile(target.workspace.projectFile, "utf8");
    const tempBefore = await importTempDirectories();
    const replacement = [
      ...packageFiles,
      { path: "linked/prompt.md", content: "replacement\n", encoding: "utf8" as const }
    ];

    const imported = await importPackageFiles("Existing Import", replacement, true);

    expect(imported.validation.ok).toBe(true);
    expect(await readFile(join(target.workspace.packageDir, "linked/prompt.md"), "utf8")).toBe(
      "replacement\n"
    );
    expect(await readFile(target.workspace.stateFile, "utf8")).toBe(stateBefore);
    expect(await readFile(target.workspace.projectFile, "utf8")).toBe(metadataBefore);
    expect(await diskSnapshot(unrelated.workspace.workspaceRoot)).toEqual(unrelatedBefore);
    expect((await readdir(join(home, "projects"))).sort()).toEqual(registeredBefore);
    expect(await importTempDirectories()).toEqual(tempBefore);
  });
});
