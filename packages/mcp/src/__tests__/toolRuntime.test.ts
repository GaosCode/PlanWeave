import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNext,
  openProject,
  redoDesktopPlanGraphCommand,
  resolveTaskCanvasWorkspace,
  selectTaskCanvas,
  undoDesktopPlanGraphCommand
} from "@planweave-ai/runtime";
import { runtimeGateway } from "../toolRuntime.js";

vi.mock("@planweave-ai/runtime", async (importOriginal) => {
  const runtime = await importOriginal<typeof import("@planweave-ai/runtime")>();
  return { ...runtime, openProject: vi.fn(runtime.openProject) };
});

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
  vi.unstubAllEnvs();
});

describe("MCP runtime gateway", () => {
  it.each([
    undefined,
    null,
    "default"
  ])("keeps status data and canvas identity together when selection changes (%s)", async (canvasId) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "planweave-mcp-status-")));
    vi.stubEnv("PLANWEAVE_HOME", home);
    const project = await runtimeGateway.initProject("Status snapshot");
    const second = await runtimeGateway.createCanvas(project.projectId, "Other status");
    await runtimeGateway.createTask(project.projectId, "default", { title: "Selected task" });
    await runtimeGateway.createTask(project.projectId, second.canvasId, { title: "Other task" });
    await runtimeGateway.createTask(project.projectId, second.canvasId, { title: "Extra task" });
    const selectedWorkspace = await resolveTaskCanvasWorkspace(project.workspaceRoot, "default");
    await expect(claimNext({ projectRoot: selectedWorkspace })).resolves.toMatchObject({
      kind: "block",
      ref: "T-SELECTED-TASK#B-001"
    });
    await selectTaskCanvas(project.workspaceRoot, "default");

    const unrelated = join(home, "projects", "broken-status-neighbor");
    await mkdir(unrelated);
    await writeFile(join(unrelated, "project.json"), "{");
    const before = await runtimeGateway.getStatus(project.projectId, "default");
    expect(before).toMatchObject({
      canvasId: "default",
      taskTotal: 1,
      blockTotal: 2,
      tasks: [{ taskId: "T-SELECTED-TASK", status: "in_progress" }],
      blocks: [
        { ref: "T-SELECTED-TASK#B-001", status: "in_progress" },
        { ref: "T-SELECTED-TASK#R-001", status: "planned" }
      ],
      currentRefs: ["T-SELECTED-TASK#B-001"]
    });
    const other = await runtimeGateway.getStatus(project.projectId, second.canvasId);
    expect(other).toMatchObject({
      canvasId: second.canvasId,
      taskTotal: 2,
      blockTotal: 4,
      tasks: [
        { taskId: "T-OTHER-TASK", status: "ready" },
        { taskId: "T-EXTRA-TASK", status: "ready" }
      ],
      currentRefs: []
    });

    let reached!: () => void;
    let resume!: () => void;
    const captured = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const runtime =
      await vi.importActual<typeof import("@planweave-ai/runtime")>("@planweave-ai/runtime");
    vi.mocked(openProject).mockImplementationOnce(async (options) => {
      const resolved = await runtime.openProject(options);
      reached();
      await released;
      return resolved;
    });
    const reading = runtimeGateway.getStatus(project.projectId, canvasId);
    try {
      await captured;
      await selectTaskCanvas(project.workspaceRoot, second.canvasId);
    } finally {
      resume();
    }
    const status = await reading;
    expect(status.canvasId).toBe("default");
    expect(status).toEqual(before);
    await expect(runtime.openProject({ projectId: project.projectId })).resolves.toMatchObject({
      activeCanvasId: second.canvasId
    });
  });

  it("isolates every exact project consumer from unrelated corrupt registrations and canvases", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "planweave-mcp-registry-")));
    vi.stubEnv("PLANWEAVE_HOME", home);
    const project = await runtimeGateway.initProject("Healthy target");
    const unrelated = await runtimeGateway.initProject("Unrelated broken canvas");
    await writeFile(
      join(unrelated.workspaceRoot, "canvases", "default", "package", "manifest.json"),
      "{"
    );
    const corruptRoot = join(home, "projects", "unrelated-0");
    await mkdir(corruptRoot);
    await writeFile(join(corruptRoot, "project.json"), "{");

    await expect(runtimeGateway.openProject(project.projectId)).resolves.toMatchObject({
      projectId: project.projectId,
      rootPath: project.workspaceRoot
    });
    for (let index = 1; index < 12; index++) {
      const root = join(home, "projects", `unrelated-${index}`);
      await mkdir(root);
      await writeFile(join(root, "project.json"), "{}");
    }
    const second = await runtimeGateway.createCanvas(project.projectId, "Second plan");
    expect(second.canvasId).not.toBe("default");
    await runtimeGateway.createTask(project.projectId, "default", {
      title: "First task",
      promptMarkdown: "# First task\n"
    });
    await runtimeGateway.createTask(project.projectId, second.canvasId, {
      title: "Second task",
      promptMarkdown: "# Second task\n"
    });
    await expect(runtimeGateway.validateProject(project.projectId)).resolves.toMatchObject({
      ok: true
    });
    const search = await runtimeGateway.searchProject(project.projectId, {
      query: "First task",
      kinds: ["task"]
    });
    expect(search.results).toContainEqual(
      expect.objectContaining({ canvasId: "default", ref: "T-FIRST-TASK", title: "First task" })
    );
    expect(search.results.every((item) => !("path" in item))).toBe(true);
    await expect(
      runtimeGateway.listReadyBlocks(project.projectId, "default")
    ).resolves.toMatchObject({
      readyBlocks: [expect.objectContaining({ canvasId: "default", ref: "T-FIRST-TASK#B-001" })]
    });
    await expect(
      runtimeGateway.addCanvasDependency(project.projectId, second.canvasId, "default")
    ).resolves.toMatchObject({
      ok: true,
      graph: { edges: [{ from: second.canvasId, to: "default", type: "depends_on" }] }
    });
    const from = { canvasId: second.canvasId, taskId: "T-SECOND-TASK" };
    const to = { canvasId: "default", taskId: "T-FIRST-TASK" };
    await expect(
      runtimeGateway.addCrossTaskDependency(project.projectId, from, to)
    ).resolves.toMatchObject({
      ok: true,
      graph: { crossTaskEdges: [{ from, to, type: "depends_on" }] }
    });
    await expect(
      runtimeGateway.removeCrossTaskDependency(project.projectId, from, to)
    ).resolves.toMatchObject({
      ok: true,
      graph: { crossTaskEdges: [] }
    });
    await expect(
      runtimeGateway.removeCanvasDependency(project.projectId, second.canvasId, "default")
    ).resolves.toMatchObject({ ok: true, graph: { edges: [] } });
    const markdown = "# Target policy\n";
    await expect(runtimeGateway.updateProjectPrompt(project.projectId, markdown)).resolves.toBe(
      markdown
    );
    await expect(runtimeGateway.readProjectPrompt(project.projectId)).resolves.toBe(markdown);
    expect(await readFile(join(project.workspaceRoot, "policy", "project-prompt.md"), "utf8")).toBe(
      markdown
    );

    const draftRoot = await mkdtemp(join(tmpdir(), "planweave-mcp-registry-draft-"));
    await writeFile(join(draftRoot, "manifest.json"), packageFiles[0].content);
    await writeFile(join(draftRoot, "scope.txt"), "imported into second canvas");
    const input = { projectId: project.projectId, canvasId: second.canvasId, draftRoot };
    const target = { projectRoot: project.workspaceRoot, canvasId: second.canvasId };
    await expect(runtimeGateway.previewPackageDraftImport(input)).resolves.toMatchObject({
      ok: true,
      target
    });
    await expect(runtimeGateway.importPackageDraft(input)).resolves.toMatchObject({
      ok: true,
      applied: true,
      target
    });
    expect(
      await readFile(
        join(project.workspaceRoot, "canvases", second.canvasId, "package", "scope.txt"),
        "utf8"
      )
    ).toBe("imported into second canvas");
    await expect(
      access(join(project.workspaceRoot, "canvases", "default", "package", "scope.txt"))
    ).rejects.toThrow();
    await expect(runtimeGateway.openProject(project.projectId)).resolves.toMatchObject({
      projectId: project.projectId
    });
    await expect(runtimeGateway.listProjects()).rejects.toThrow(/Project metadata|JSON/);
  });

  it.each([
    ["malformed", /malformed JSON/],
    ["schema", /metadata.*invalid/],
    ["identity", /does not match registry directory/],
    ["missing", /unavailable|ENOENT/],
    ["unavailable", /unavailable/],
    ["traversal", /registered project directory name/],
    ["absolute", /registered project directory name/]
  ] as const)("rejects %s exact targets without falling back to another project", async (mode, error) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "planweave-mcp-target-")));
    vi.stubEnv("PLANWEAVE_HOME", home);
    const healthy = await runtimeGateway.initProject("Healthy survivor");
    const target = await runtimeGateway.initProject("Bad target");
    const metadataPath = join(target.workspaceRoot, "project.json");
    let projectId = target.projectId;
    if (mode === "malformed" || mode === "schema") {
      await writeFile(metadataPath, mode === "malformed" ? "{" : "{}");
    } else if (mode === "identity" || mode === "unavailable") {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      await writeFile(
        metadataPath,
        JSON.stringify({
          ...metadata,
          ...(mode === "identity"
            ? { id: healthy.projectId }
            : {
                kind: "external",
                rootPath: join(home, "absent-source"),
                sourceRoot: join(home, "absent-source")
              })
        })
      );
    } else {
      projectId =
        mode === "missing"
          ? "missing-project"
          : mode === "traversal"
            ? `../${healthy.projectId}`
            : healthy.rootPath;
    }
    await expect(runtimeGateway.readProjectPrompt(projectId)).rejects.toThrow(error);
  });

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

  it.each([
    "single",
    "bulk-blocks",
    "bulk-policy"
  ] as const)("persists and replays canonical shared resources through the %s MCP gateway", async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "planweave-mcp-home-"));
    process.env.PLANWEAVE_HOME = home;
    const project = await runtimeGateway.initProject("Gateway Shared Resources");
    await runtimeGateway.createTask(project.projectId, undefined, {
      title: "MCP shared resources",
      promptMarkdown: "# MCP shared resources\n"
    });
    const manifestPath = join(
      project.workspaceRoot,
      "canvases",
      "default",
      "package",
      "manifest.json"
    );
    const readBlock = async (): Promise<Record<string, unknown>> => {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        nodes: Array<{
          id: string;
          title: string;
          blocks: Array<Record<string, unknown> & { id: string }>;
        }>;
      };
      const task = manifest.nodes.find((node) => node.title === "MCP shared resources");
      const block = task?.blocks.find((item) => item.id === "B-001");
      if (!task || !block) {
        throw new Error("Expected MCP shared resources implementation block.");
      }
      return { taskId: task.id, ...block };
    };
    const initialBlock = await readBlock();
    const blockRef = `${String(initialBlock.taskId)}#${String(initialBlock.id)}`;
    const expectResources = async (resources: string[] | undefined): Promise<void> => {
      const block = await readBlock();
      const parallel = block.parallel as Record<string, unknown> | undefined;
      expect(parallel?.sharedResources).toEqual(resources);
      if (parallel) {
        expect(parallel).not.toHaveProperty("safe");
        expect(parallel).not.toHaveProperty("locks");
      } else {
        expect(block).not.toHaveProperty("parallel");
      }
    };

    const resources = [mode];
    const result =
      mode === "single"
        ? await runtimeGateway.updateBlockPlanning(project.projectId, undefined, blockRef, {
            sharedResources: resources
          })
        : mode === "bulk-blocks"
          ? await runtimeGateway.bulkUpdateBlocks(project.projectId, undefined, [
              { blockRef, input: { sharedResources: resources } }
            ])
          : await runtimeGateway.bulkUpdateParallelPolicy(project.projectId, undefined, {
              blocks: [{ blockRef, input: { sharedResources: resources } }]
            });
    expect(result).toMatchObject({ ok: true });
    await expectResources(resources);
    await expect(undoDesktopPlanGraphCommand(project.workspaceRoot)).resolves.toMatchObject({
      ok: true
    });
    await expectResources(undefined);
    await expect(redoDesktopPlanGraphCommand(project.workspaceRoot)).resolves.toMatchObject({
      ok: true
    });
    await expectResources(resources);
  });
});
