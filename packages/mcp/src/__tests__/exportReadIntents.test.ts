import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { planweaveToolOutputSchemas } from "../toolSchemas.js";
import type { PlanweaveToolName } from "../toolTypes.js";
import * as runtime from "@planweave-ai/runtime";
import { runtimeGateway } from "../toolRuntime.js";
import { handlePlanweaveTool } from "../tools.js";
import { readJson } from "./toolTestHelpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});
// Use the production source read owners for syscall observation, retaining all other real runtime APIs.
vi.mock("@planweave-ai/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof runtime>();
  const reads = await import("../../../runtime/src/package/packageFiles.js");
  const prompt = await import("../../../runtime/src/projectPromptPolicy.js");
  return {
    ...actual,
    readPackageFiles: vi.fn(reads.readPackageFiles),
    readSelectedPackageFiles: vi.fn(reads.readSelectedPackageFiles),
    readPackageFileInventory: vi.fn(reads.readPackageFileInventory),
    readProjectPromptBytes: vi.fn(prompt.readProjectPromptBytes),
    readProjectPrompt: vi.fn(prompt.readProjectPrompt)
  };
});

let home: string;
let project: runtime.DesktopProjectSummary;
let activeId: string;
let packageDir: string;
let actual: typeof fs;

beforeEach(async () => {
  actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.readFile).mockReset().mockImplementation(actual.readFile);
  home = await fs.mkdtemp(join(tmpdir(), "planweave-export-intents-"));
  process.env.PLANWEAVE_HOME = home;
  project = await runtimeGateway.initProject("Intent IO");
  const active = await runtimeGateway.createCanvas(project.projectId, "Selected");
  activeId = active.canvasId;
  await runtime.selectTaskCanvas(project.rootPath, activeId);
  packageDir = (await runtime.resolveTaskCanvasWorkspace(project.rootPath, activeId)).packageDir;
  await fs.writeFile(join(packageDir, "a.md"), "A");
  await fs.writeFile(join(packageDir, "b.md"), "中文🙂");
  await fs.writeFile(join(packageDir, "large.md"), Buffer.alloc(2 * 1024 * 1024, 97));
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.PLANWEAVE_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

async function run<N extends PlanweaveToolName>(name: N, args: Record<string, unknown> = {}) {
  return z
    .object(planweaveToolOutputSchemas[name])
    .parse(
      readJson(
        await handlePlanweaveTool(name, { projectId: project.projectId, ...args }, runtimeGateway)
      )
    );
}

it("uses inventory for package/project summary aliases, counts malformed prompt/body UTF-8 exactly and retains no bodies", async () => {
  const malformed = Buffer.concat([
    Buffer.alloc(65535, 97),
    Buffer.from("🙂"),
    Buffer.from([255, 226, 130])
  ]);
  await fs.writeFile(join(packageDir, "malformed.md"), malformed);
  const workspace = await runtime.resolveProjectWorkspace(project.rootPath);
  await fs.writeFile(workspace.projectPromptFile, malformed);
  vi.clearAllMocks();
  const summary = await run("export_plan_package_summary");
  expect(summary).toMatchObject({
    planPackage: {
      files: expect.arrayContaining([
        {
          path: "malformed.md",
          encoding: "utf8",
          contentBytes: Buffer.byteLength(malformed.toString("utf8"), "utf8")
        }
      ])
    }
  });
  expect(await run("export_plan_package")).toEqual(summary);
  expect(runtime.readPackageFiles).not.toHaveBeenCalled();
  const projectSummary = await run("export_project_summary");
  expect(projectSummary).toMatchObject({
    projectExport: {
      projectPrompt: {
        contentIncluded: false,
        markdownBytes: Buffer.byteLength(malformed.toString("utf8"), "utf8")
      }
    }
  });
  expect(await run("export_project")).toEqual(projectSummary);
  expect(JSON.stringify(projectSummary)).not.toContain('"content"');
  expect(runtime.readPackageFiles).not.toHaveBeenCalled();
  expect(runtime.readProjectPrompt).not.toHaveBeenCalled();
  const bodyReads = vi
    .mocked(fs.readFile)
    .mock.calls.filter(
      (call) =>
        String(call[0]).startsWith(`${packageDir}${sep}`) &&
        !String(call[0]).endsWith("manifest.json")
    );
  expect(bodyReads).toEqual([]);
  expect(
    vi.mocked(fs.open).mock.calls.some((call) => String(call[0]).endsWith("malformed.md"))
  ).toBe(true);
});

it("selected project opens just requested bodies/canvas, preserves duplicates, and skips unreadable unselected bodies and prompt", async () => {
  const workspace = await runtime.resolveProjectWorkspace(project.rootPath);
  await fs.writeFile(workspace.projectPromptFile, Buffer.alloc(2 * 1024 * 1024));
  vi.clearAllMocks();
  vi.mocked(fs.readFile).mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("large.md") || String(args[0]) === workspace.projectPromptFile)
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    return actual.readFile(...args);
  });
  const output = await run("export_project_files", {
    packageFiles: [{ path: "b.md" }, { path: "a.md" }, { canvasId: null, path: "b.md" }]
  });
  expect(output).toMatchObject({
    projectExport: {
      planPackages: [
        {
          canvasId: activeId,
          files: [
            { path: "b.md", content: "中文🙂", encoding: "utf8" },
            { path: "a.md", content: "A", encoding: "utf8" },
            { path: "b.md", content: "中文🙂", encoding: "utf8" }
          ]
        }
      ]
    }
  });
  expect(runtime.readSelectedPackageFiles).toHaveBeenCalledTimes(1);
  expect(
    vi
      .mocked(fs.readFile)
      .mock.calls.filter(
        (call) =>
          String(call[0]).startsWith(`${packageDir}${sep}`) &&
          !String(call[0]).endsWith("manifest.json")
      )
      .map((call) => String(call[0]))
  ).toEqual([join(packageDir, "b.md"), join(packageDir, "a.md")]);
  expect(runtime.readProjectPrompt).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(fs.readFile)
      .mock.calls.some((call) => String(call[0]) === workspace.projectPromptFile)
  ).toBe(false);
  expect(
    vi.mocked(fs.open).mock.calls.some((call) => String(call[0]) === workspace.projectPromptFile)
  ).toBe(false);
  expect(vi.mocked(runtime.readSelectedPackageFiles).mock.calls[0]).toEqual([
    packageDir,
    ["b.md", "a.md", "b.md"]
  ]);
  await expect(
    run("export_project_files", { packageFiles: [{ path: "large.md" }] })
  ).rejects.toThrow("EACCES");
});

it("package selected de-duplicates paths as before and keeps explicit full/compat content untruncated", async () => {
  const output = await run("export_plan_package_files", { paths: ["b.md", "a.md", "b.md"] });
  expect(output).toMatchObject({ planPackage: { files: [{ path: "b.md" }, { path: "a.md" }] } });
  const large = { path: "large.md", encoding: "utf8", content: "a".repeat(2 * 1024 * 1024) };
  const full = await run("export_plan_package_full");
  expect(full).toMatchObject({
    planPackage: { files: expect.arrayContaining([expect.objectContaining(large)]) }
  });
  const compatibility = await run("export_plan_package", { includeFiles: true });
  expect(compatibility).toMatchObject({
    planPackage: {
      contentIncluded: true,
      files: expect.arrayContaining([expect.objectContaining(large)])
    }
  });
});

it("prompt-only never invokes package readers and missing project prompt summary stays zero", async () => {
  await runtimeGateway.updateProjectPrompt(project.projectId, "Prompt");
  const output = await run("export_project_files", { includeProjectPrompt: true });
  expect(output).toMatchObject({
    projectExport: { projectPromptMarkdown: "Prompt", planPackages: [] }
  });
  expect(runtime.readPackageFiles).not.toHaveBeenCalled();
  expect(runtime.readSelectedPackageFiles).not.toHaveBeenCalled();
  expect(runtime.readPackageFileInventory).not.toHaveBeenCalled();
  const workspace = await runtime.resolveProjectWorkspace(project.rootPath);
  await fs.rm(workspace.projectPromptFile);
  expect(await run("export_project_summary")).toMatchObject({
    projectExport: { projectPrompt: { markdownBytes: 0 } }
  });
});

it("full project bounds active real canvas reads to two, preserves order, and observes batch failures", async () => {
  await runtimeGateway.createCanvas(project.projectId, "Third");
  await runtimeGateway.createCanvas(project.projectId, "Fourth");
  const canvases = await runtime.listTaskCanvases(project.rootPath);
  const directories = await Promise.all(
    canvases.map(
      async (canvas) =>
        (await runtime.resolveTaskCanvasWorkspace(project.rootPath, canvas.canvasId)).packageDir
    )
  );
  const source = await import("../../../runtime/src/package/packageFiles.js");
  let active = 0;
  let maximum = 0;
  const gates: Array<() => void> = [];
  vi.mocked(runtime.readPackageFiles).mockImplementation(async (root) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => gates.push(resolve));
    try {
      return await source.readPackageFiles(root);
    } finally {
      active--;
    }
  });
  const exported = run("export_project_full_debug");
  await vi.waitFor(() => expect(gates).toHaveLength(2));
  expect(active).toBe(2);
  gates[0]!();
  gates[1]!();
  await vi.waitFor(() => expect(gates).toHaveLength(4));
  expect(active).toBe(2);
  gates[2]!();
  gates[3]!();
  const output = await exported;
  expect(maximum).toBe(2);
  expect(active).toBe(0);
  expect(output).toMatchObject({
    projectExport: { planPackages: canvases.map((canvas) => ({ canvasId: canvas.canvasId })) }
  });
  expect(
    vi
      .mocked(runtime.readPackageFiles)
      .mock.calls.map((call) => call[0])
      .sort()
  ).toEqual([...directories].sort());
  const finished: string[] = [];
  vi.mocked(runtime.readPackageFiles)
    .mockClear()
    .mockImplementation(async (root) => {
      try {
        if (root === directories[0]) throw new Error("first canvas failed");
        return await source.readPackageFiles(root);
      } finally {
        finished.push(root);
      }
    });
  await expect(run("export_project_full_debug")).rejects.toThrow("first canvas failed");
  expect(finished.sort()).toEqual(directories.slice(0, 2).sort());
  expect(runtime.readPackageFiles).toHaveBeenCalledTimes(2);
});

it.skipIf(process.platform === "win32")(
  "retains project first/package last selection for colliding POSIX archive members without reading unrelated bodies",
  async () => {
    await fs.mkdir(join(packageDir, "collision"));
    await fs.writeFile(join(packageDir, "collision", "item.md"), "actual-nested");
    await fs.writeFile(join(packageDir, "collision\\item.md"), "literal-backslash");
    vi.clearAllMocks();
    vi.mocked(fs.readFile).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("large.md"))
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      return actual.readFile(...args);
    });
    expect(
      await run("export_project_files", {
        packageFiles: [{ path: "collision/item.md" }, { path: "collision/item.md" }]
      })
    ).toMatchObject({
      projectExport: {
        planPackages: [
          {
            canvasId: activeId,
            files: [
              { path: "collision/item.md", content: "actual-nested", encoding: "utf8" },
              { path: "collision/item.md", content: "actual-nested", encoding: "utf8" }
            ]
          }
        ]
      }
    });
    expect(
      await run("export_plan_package_files", { paths: ["collision/item.md", "collision/item.md"] })
    ).toMatchObject({
      planPackage: {
        files: [{ path: "collision/item.md", content: "literal-backslash", encoding: "utf8" }]
      }
    });
    expect(
      vi
        .mocked(fs.readFile)
        .mock.calls.filter((call) => String(call[0]).includes("collision"))
        .map((call) => String(call[0]))
    ).toEqual([join(packageDir, "collision", "item.md"), join(packageDir, "collision\\item.md")]);
  }
);
