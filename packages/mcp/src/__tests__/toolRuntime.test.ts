import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { undoDesktopPlanGraphCommand } from "@planweave-ai/runtime";
import { runtimeGateway } from "../toolRuntime.js";

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
  }
];

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

describe("MCP runtime gateway", () => {
  it("initializes new projects as managed PlanWeave workspaces without mcp-projects roots", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-mcp-home-"));
    process.env.PLANWEAVE_HOME = home;

    const project = await runtimeGateway.initProject("New Demo Project");

    expect(project.kind).toBe("managed");
    expect(project.rootPath).toBe(project.workspaceRoot);
    expect(project.sourceRoot).toBeNull();
    expect(project.workspaceRoot).toBe(join(home, "projects", project.projectId));
    await expect(access(join(home, "mcp-projects"))).rejects.toThrow();
  });

  it("imports and exports default package files through canonical canvas storage", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-mcp-home-"));
    process.env.PLANWEAVE_HOME = home;

    const imported = await runtimeGateway.importPlanPackage({
      name: "Imported Package",
      files: packageFiles
    });
    const projectRoot = join(home, "projects", imported.project.projectId);

    await expect(
      readFile(join(projectRoot, "canvases", "default", "package", "manifest.json"), "utf8")
    ).resolves.toBe(packageFiles[0].content);
    await expect(access(join(projectRoot, "package"))).rejects.toThrow();

    await expect(
      runtimeGateway.exportPlanPackage(imported.project.projectId)
    ).resolves.toMatchObject({
      canvasId: "default",
      files: packageFiles
    });
    await expect(runtimeGateway.exportProject(imported.project.projectId)).resolves.toMatchObject({
      planPackages: [
        {
          canvasId: "default",
          files: packageFiles
        }
      ]
    });
  });

  it("updates task fields through one runtime graph command", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-mcp-home-"));
    process.env.PLANWEAVE_HOME = home;
    const project = await runtimeGateway.initProject("Gateway Task Fields");

    await expect(
      runtimeGateway.createTask(project.projectId, undefined, {
        title: "MCP task fields",
        promptMarkdown: "# Original task prompt\n"
      })
    ).resolves.toMatchObject({ ok: true });

    const result = await runtimeGateway.updateTask(
      project.projectId,
      undefined,
      "T-MCP-TASK-FIELDS",
      {
        title: "Updated MCP task fields",
        promptMarkdown: "# Updated task prompt\n",
        executor: "codex-auto"
      }
    );

    expect(result).toMatchObject({
      ok: true,
      affectedTasks: ["T-MCP-TASK-FIELDS"],
      diagnostics: []
    });
    await expect(
      runtimeGateway.getTaskDetail(project.projectId, "T-MCP-TASK-FIELDS")
    ).resolves.toMatchObject({
      title: "Updated MCP task fields",
      executor: "codex-auto",
      promptMarkdown: "# Updated task prompt\n"
    });

    await expect(undoDesktopPlanGraphCommand(project.rootPath)).resolves.toMatchObject({
      ok: true
    });
    await expect(
      runtimeGateway.getTaskDetail(project.projectId, "T-MCP-TASK-FIELDS")
    ).resolves.toMatchObject({
      title: "MCP task fields",
      executor: null,
      promptMarkdown: "# Original task prompt\n"
    });
  });

  it("updates block fields through one runtime graph command", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-mcp-home-"));
    process.env.PLANWEAVE_HOME = home;
    const project = await runtimeGateway.initProject("Gateway Block Fields");

    await expect(
      runtimeGateway.createTask(project.projectId, undefined, {
        title: "MCP block fields",
        promptMarkdown: "# Original task prompt\n"
      })
    ).resolves.toMatchObject({ ok: true });

    const result = await runtimeGateway.updateBlock(
      project.projectId,
      undefined,
      "T-MCP-BLOCK-FIELDS#B-001",
      {
        title: "Updated MCP block fields",
        promptMarkdown: "# Updated block prompt\n",
        executor: "manual"
      }
    );

    expect(result).toMatchObject({
      ok: true,
      affectedTasks: ["T-MCP-BLOCK-FIELDS"],
      diagnostics: []
    });
    await expect(
      runtimeGateway.getBlockDetail(project.projectId, "T-MCP-BLOCK-FIELDS#B-001")
    ).resolves.toMatchObject({
      title: "Updated MCP block fields",
      executor: "manual",
      promptMarkdown: "# Updated block prompt\n"
    });

    await expect(undoDesktopPlanGraphCommand(project.rootPath)).resolves.toMatchObject({
      ok: true
    });
    await expect(
      runtimeGateway.getBlockDetail(project.projectId, "T-MCP-BLOCK-FIELDS#B-001")
    ).resolves.toMatchObject({
      title: "Implement work",
      executor: null,
      promptMarkdown: expect.stringContaining("# Implement work")
    });
  });
});
