import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtime from "@planweave-ai/runtime";
import { runtimeGateway } from "../toolRuntime.js";
import { handlePlanweaveTool } from "../tools.js";
import { readJson } from "./toolTestHelpers.js";

// Only the project snapshot boundary is wrapped; disk/gateway operations use runtime implementations.
vi.mock("@planweave-ai/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@planweave-ai/runtime")>();
  return { ...actual, openProject: vi.fn(actual.openProject) };
});

let home: string;
let project: runtime.DesktopProjectSummary;
let activeId: string;
const activeContent = "# Active package\n";
const otherContent = "# Other package\n";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "planweave-export-selection-"));
  process.env.PLANWEAVE_HOME = home;
  const actual = await vi.importActual<typeof runtime>("@planweave-ai/runtime");
  vi.mocked(runtime.openProject).mockReset().mockImplementation(actual.openProject);
  project = await runtimeGateway.initProject("Selection contract");
  const active = await runtimeGateway.createCanvas(project.projectId, "Selected nondefault");
  activeId = active.canvasId;
  await runtime.selectTaskCanvas(project.rootPath, activeId);
  const activeWorkspace = await runtime.resolveTaskCanvasWorkspace(project.rootPath, activeId);
  const otherWorkspace = await runtime.resolveTaskCanvasWorkspace(project.rootPath, "default");
  await writeFile(join(activeWorkspace.packageDir, "selected.md"), activeContent);
  await writeFile(join(otherWorkspace.packageDir, "selected.md"), otherContent);
  await runtimeGateway.updateProjectPrompt(project.projectId, "# Project selection prompt\n");
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.PLANWEAVE_HOME;
  await rm(home, { recursive: true, force: true });
});

async function exportFiles(packageFiles: unknown[], includeProjectPrompt = false) {
  return readJson(
    await handlePlanweaveTool(
      "export_project_files",
      {
        projectId: project.projectId,
        packageFiles,
        includeProjectPrompt
      },
      runtimeGateway
    )
  );
}

describe("project export selection through the production gateway", () => {
  it.each([
    "omitted",
    "null",
    "explicit"
  ])("resolves %s canvas selection to the active nondefault package", async (mode) => {
    const request = {
      path: "selected.md",
      ...(mode === "omitted" ? {} : { canvasId: mode === "null" ? null : activeId })
    };
    expect(await exportFiles([request])).toMatchObject({
      projectExport: {
        project: { activeCanvasId: activeId },
        planPackages: [
          { canvasId: activeId, files: [{ path: "selected.md", content: activeContent }] }
        ]
      }
    });
  });

  it("uses the first canvas when there is no persisted active selection", async () => {
    await rm(join(project.workspaceRoot, "desktop", "active-canvas.json"));
    expect(await exportFiles([{ path: "selected.md" }])).toMatchObject({
      projectExport: {
        planPackages: [{ canvasId: "default", files: [{ content: otherContent }] }]
      }
    });
  });

  it("preserves first-seen canvas grouping, path order and duplicate requests", async () => {
    expect(
      await exportFiles(
        [
          { canvasId: "default", path: "selected.md" },
          { path: "selected.md" },
          { canvasId: "default", path: "manifest.json" },
          { canvasId: null, path: "selected.md" }
        ],
        true
      )
    ).toMatchObject({
      projectExport: {
        projectPromptMarkdown: "# Project selection prompt\n",
        planPackages: [
          {
            canvasId: "default",
            files: [{ path: "selected.md", content: otherContent }, { path: "manifest.json" }]
          },
          {
            canvasId: activeId,
            files: [
              { path: "selected.md", content: activeContent },
              { path: "selected.md", content: activeContent }
            ]
          }
        ]
      }
    });
  });

  it.each([
    "unknown",
    "",
    "   "
  ])("rejects an invalid explicit canvas ID %j instead of falling back", async (canvasId) => {
    await expect(exportFiles([{ canvasId, path: "selected.md" }])).rejects.toThrow();
  });

  it.each([
    "missing.md",
    "../project.json",
    "/etc/passwd",
    "./selected.md"
  ])("rejects unavailable or noncanonical path %j without a fallback", async (path) => {
    await expect(exportFiles([{ path }])).rejects.toThrow();
  });

  it("uses one snapshot even when the active canvas changes immediately after it is read", async () => {
    const actual = await vi.importActual<typeof runtime>("@planweave-ai/runtime");
    vi.mocked(runtime.openProject).mockImplementationOnce(async (input) => {
      const snapshot = await actual.openProject(input);
      await runtime.selectTaskCanvas(project.rootPath, "default");
      return snapshot;
    });
    expect(
      await exportFiles([{ path: "selected.md" }, { canvasId: null, path: "selected.md" }])
    ).toMatchObject({
      projectExport: {
        planPackages: [
          { canvasId: activeId, files: [{ content: activeContent }, { content: activeContent }] }
        ]
      }
    });
    expect(vi.mocked(runtime.openProject)).toHaveBeenCalledTimes(1);
    expect(await actual.openProject({ projectId: project.projectId })).toMatchObject({
      activeCanvasId: "default"
    });
  });

  it("exports project prompt alone without reading unrelated package bodies", async () => {
    const workspace = await runtime.resolveTaskCanvasWorkspace(project.rootPath, activeId);
    await rm(workspace.packageDir, { recursive: true, force: true });
    await expect(runtimeGateway.exportProject(project.projectId)).rejects.toThrow();
    expect(await exportFiles([], true)).toMatchObject({
      projectExport: {
        projectPromptMarkdown: "# Project selection prompt\n",
        planPackages: []
      }
    });
  });

  it("allows project prompt requests with packageFiles omitted", async () => {
    expect(
      readJson(
        await handlePlanweaveTool(
          "export_project_files",
          {
            projectId: project.projectId,
            includeProjectPrompt: true
          },
          runtimeGateway
        )
      )
    ).toMatchObject({
      projectExport: {
        projectPromptMarkdown: "# Project selection prompt\n",
        planPackages: []
      }
    });
  });

  it("allows prompt-only with an empty project snapshot but rejects requested packages", async () => {
    const snapshot = { ...project, activeCanvasId: null, taskCanvases: [] };
    vi.mocked(runtime.openProject).mockResolvedValue(snapshot);
    expect(await exportFiles([], true)).toMatchObject({
      projectExport: {
        projectPromptMarkdown: "# Project selection prompt\n",
        planPackages: []
      }
    });
    await expect(exportFiles([{ path: "selected.md" }])).rejects.toThrow(
      "Project has no task canvas."
    );
  });
});
