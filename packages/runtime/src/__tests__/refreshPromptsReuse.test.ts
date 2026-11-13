import { createHash } from "node:crypto";
import type { PathLike } from "node:fs";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  paths: [] as string[],
  failurePaths: new Set<string>()
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (path: PathLike | number, options?: Parameters<typeof actual.readFile>[1]) => {
      const name = typeof path === "number" ? null : path.toString();
      if (name !== null) {
        reads.paths.push(name);
      }
      if (name !== null && reads.failurePaths.has(name)) {
        throw Object.assign(new Error(`Read denied: ${name}`), { code: "EACCES" });
      }
      return actual.readFile(path as never, options as never);
    }
  };
});

import { writeJsonFile } from "../json.js";
import {
  canonicalProjectCanvasNode,
  projectCanvasWorkspace,
  projectGraphPath,
  writeProjectGraph
} from "../projectGraph/index.js";
import type { ProjectGraphManifest } from "../projectGraph/types.js";
import { refreshPrompts } from "../prompt/refreshPrompts.js";
import { createEmptyState, ensureStateForManifest, writeState } from "../state.js";
import { renderPromptSurface } from "../taskManager/promptRenderer.js";
import type { ManifestTaskNode, PlanPackageManifest } from "../types.js";
import { basicManifest, createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";

afterEach(() => {
  reads.paths = [];
  reads.failurePaths.clear();
});

function batchManifest(tasks: number, implementations: number): PlanPackageManifest {
  return {
    ...basicManifest(),
    nodes: Array.from({ length: tasks }, (_, taskIndex): ManifestTaskNode => {
      const id = `T-${String(taskIndex + 1).padStart(3, "0")}`;
      const implementationIds = Array.from(
        { length: implementations },
        (_, index) => `B-${String(index + 1).padStart(3, "0")}`
      );
      return {
        id,
        type: "task",
        title: `Batch task ${id}`,
        prompt: `nodes/${id}/prompt.md`,
        acceptance: [`acceptance-marker-${id}`],
        blocks: [
          ...implementationIds.map((blockId) => ({
            id: blockId,
            type: "implementation" as const,
            title: `Implement ${id}#${blockId}`,
            prompt: `nodes/${id}/blocks/${blockId}.prompt.md`,
            depends_on: []
          })),
          {
            id: "R-001",
            type: "review",
            title: `Review ${id}`,
            prompt: `nodes/${id}/blocks/R-001.prompt.md`,
            depends_on: implementationIds,
            review: { required: true, maxFeedbackCycles: 1, hook: null }
          }
        ]
      };
    })
  };
}

async function createBatchFixture(scale = { tasks: 2, implementations: 1, canvases: 2 }) {
  const manifest = batchManifest(scale.tasks, scale.implementations);
  const fixture = await createTestWorkspace(manifest);
  const { home, init } = fixture;
  const workspace = init.workspace;
  const globalPath = join(home, "config/global-prompt.md");
  const policyPath = join(workspace.workspaceRoot, "policy/prompt-policy.json");
  await writeFile(globalPath, "global-marker-one\n");
  await writeFile(workspace.projectPromptFile, "project-marker-one\n");
  await writeJsonFile(policyPath, { includeGlobalPrompt: true });
  const state = ensureStateForManifest(manifest, createEmptyState());
  const promptPaths: string[] = [];
  const reportPaths: string[] = [];
  for (const task of manifest.nodes) {
    promptPaths.push(join(workspace.packageDir, task.prompt));
    for (const block of task.blocks) {
      promptPaths.push(join(workspace.packageDir, block.prompt));
    }
    state.blocks[`${task.id}#B-001`] = { status: "completed", lastRunId: "RUN-001" };
    const reportPath = join(workspace.resultsDir, task.id, "blocks/B-001/runs/RUN-001/report.md");
    reportPaths.push(reportPath);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `report-marker-${task.id}-one\n`);
  }
  await writeState(workspace.stateFile, state);
  const canvases = [canonicalProjectCanvasNode({ id: "default", title: "Batch canvas" })];
  const crossManifestPaths: string[] = [];
  const crossStatePaths: string[] = [];
  const crossPromptPaths: string[] = [];
  for (let index = 1; index < scale.canvases; index += 1) {
    const canvas = canonicalProjectCanvasNode({
      id: `upstream-${index}`,
      title: `Upstream ${index}`
    });
    canvases.push(canvas);
    const crossWorkspace = projectCanvasWorkspace(workspace, canvas);
    const crossManifest = batchManifest(1, 1);
    await writeJsonFile(crossWorkspace.manifestFile, crossManifest);
    await writePromptFiles(crossWorkspace.packageDir, crossManifest);
    await writeState(crossWorkspace.stateFile, createEmptyState());
    crossManifestPaths.push(crossWorkspace.manifestFile);
    crossStatePaths.push(crossWorkspace.stateFile);
    crossPromptPaths.push(
      join(crossWorkspace.packageDir, "nodes/T-001/prompt.md"),
      join(crossWorkspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      join(crossWorkspace.packageDir, "nodes/T-001/blocks/R-001.prompt.md")
    );
  }
  const projectGraph: ProjectGraphManifest = {
    version: "plan-project/v1",
    canvases,
    edges: [{ from: "default", to: "upstream-1", type: "depends_on" }],
    crossTaskEdges: [
      {
        from: { canvasId: "default", taskId: "T-001" },
        to: { canvasId: "upstream-1", taskId: "T-001" },
        type: "depends_on"
      }
    ]
  };
  await writeProjectGraph(workspace, projectGraph);
  const inputPaths = [
    workspace.projectFile,
    workspace.manifestFile,
    workspace.stateFile,
    projectGraphPath(workspace),
    globalPath,
    workspace.projectPromptFile,
    policyPath,
    ...promptPaths,
    ...reportPaths,
    ...crossManifestPaths,
    ...crossStatePaths,
    ...crossPromptPaths
  ];
  const promptReadPaths = [
    ...promptPaths,
    ...(await Promise.all(promptPaths.map((path) => realpath(path))))
  ];
  return {
    ...fixture,
    manifest,
    state,
    projectGraph,
    workspace,
    globalPath,
    policyPath,
    promptPaths,
    promptReadPaths,
    reportPaths,
    crossManifestPaths,
    crossStatePaths,
    inputPaths
  };
}

async function hashes(paths: string[]) {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      hash: createHash("sha256")
        .update(await readFile(path))
        .digest("hex")
    }))
  );
}

function countReads(fixture: Awaited<ReturnType<typeof createBatchFixture>>) {
  const count = (paths: string[]) => reads.paths.filter((path) => paths.includes(path)).length;
  return {
    total: reads.paths.length,
    prompts: count(fixture.promptReadPaths),
    state: count([fixture.workspace.stateFile]),
    crossManifests: count(fixture.crossManifestPaths),
    crossStates: count(fixture.crossStatePaths),
    global: count([fixture.globalPath]),
    project: count([fixture.workspace.projectPromptFile]),
    policy: count([fixture.policyPath]),
    reports: count(fixture.reportPaths)
  };
}

describe("batch Prompt request reuse", () => {
  it.each([
    { tasks: 2, implementations: 1, canvases: 2 },
    { tasks: 2, implementations: 4, canvases: 2 },
    { tasks: 4, implementations: 4, canvases: 4 }
  ])("keeps real reads linear for $tasks tasks, $implementations implementations and $canvases canvases", async (scale) => {
    const fixture = await createBatchFixture(scale);
    const before = await hashes(fixture.inputPaths);
    reads.paths = [];

    const result = await refreshPrompts({ projectRoot: fixture.root });
    const counts = countReads(fixture);
    console.info("batch Prompt read counts", JSON.stringify({ scale, counts }));

    expect(result.prompts).toHaveLength(scale.tasks * (scale.implementations + 1));
    expect(counts.prompts).toBeGreaterThanOrEqual(fixture.promptPaths.length);
    expect(counts.prompts).toBeLessThanOrEqual(fixture.promptPaths.length * 4);
    expect(counts.state).toBeLessThanOrEqual(3);
    expect(counts.crossManifests).toBeGreaterThanOrEqual(scale.canvases - 1);
    expect(counts.crossManifests).toBeLessThanOrEqual((scale.canvases - 1) * 3);
    expect(counts.crossStates).toBeGreaterThanOrEqual(scale.canvases - 1);
    expect(counts.crossStates).toBeLessThanOrEqual((scale.canvases - 1) * 3);
    expect(counts.global).toBeLessThanOrEqual(2);
    expect(counts.project).toBeLessThanOrEqual(2);
    expect(counts.policy).toBeLessThanOrEqual(2);
    expect(counts.reports).toBeGreaterThanOrEqual(scale.tasks);
    expect(counts.reports).toBeLessThanOrEqual(scale.tasks * 2);
    expect(counts.total).toBeLessThanOrEqual(
      fixture.promptPaths.length * 4 + scale.canvases * 12 + 30
    );
    await expect(hashes(fixture.inputPaths)).resolves.toEqual(before);
  });

  it("preserves independent output markers and reloads changed inputs on later batches", async () => {
    const fixture = await createBatchFixture();
    const options = { projectRoot: fixture.root };
    const first = await refreshPrompts(options);
    expect(first.prompts.map(({ ref, path }) => ({ ref, path }))).toEqual([
      { ref: "T-001#B-001", path: "" },
      { ref: "T-001#R-001", path: "" },
      { ref: "T-002#B-001", path: "" },
      { ref: "T-002#R-001", path: "" }
    ]);
    for (const prompt of first.prompts) {
      const taskId = prompt.ref.split("#")[0];
      expect(prompt.markdown).toContain("global-marker-one");
      expect(prompt.markdown).toContain("project-marker-one");
      expect(prompt.markdown).toContain(`# ${taskId} task prompt`);
      expect(prompt.markdown).toContain(`acceptance-marker-${taskId}`);
      expect(prompt.markdown).toContain(`report-marker-${taskId}-one`);
      expect(prompt.markdown).toContain("- Upstream canvases: Upstream 1 (upstream-1)");
      expect(prompt.markdown).toContain(
        `# ${prompt.ref} ${prompt.ref.endsWith("R-001") ? "review" : "implementation"} prompt`
      );
      expect(prompt.markdown.includes("## Required Review Result JSON")).toBe(
        prompt.ref.endsWith("R-001")
      );
      await expect(renderPromptSurface({ ...options, ref: prompt.ref })).resolves.toMatchObject({
        markdown: prompt.markdown
      });
    }
    expect(first.prompts[0]?.markdown).toContain("- Block status: completed");
    expect(first.prompts[1]?.markdown).toContain("- Block status: ready");
    expect(first.prompts[0]?.markdown).toContain(
      "- Explicit cross-task blockers for default:T-001: upstream-1:T-001"
    );

    const taskPath = join(fixture.workspace.packageDir, "nodes/T-001/prompt.md");
    const blockPath = join(fixture.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md");
    await writeFile(taskPath, "task-marker-two\n");
    await writeFile(blockPath, "block-marker-two\n");
    const afterSource = await refreshPrompts(options);
    expect(afterSource.prompts[0]?.markdown).toContain("task-marker-two");
    expect(afterSource.prompts[0]?.markdown).toContain("block-marker-two");
    expect(afterSource.prompts[1]?.markdown).toContain("task-marker-two");
    expect(afterSource.prompts[2]?.markdown).not.toContain("task-marker-two");

    fixture.state.blocks["T-001#B-001"] = {
      status: "blocked",
      blockedReason: "new-state-marker",
      lastRunId: "RUN-002"
    };
    await writeState(fixture.workspace.stateFile, fixture.state);
    const newReport = join(
      fixture.workspace.resultsDir,
      "T-001/blocks/B-001/runs/RUN-002/report.md"
    );
    await mkdir(dirname(newReport), { recursive: true });
    await writeFile(newReport, "report-marker-two\n");
    const afterState = await refreshPrompts(options);
    expect(afterState.prompts[0]?.markdown).toContain("- Block status: blocked");
    expect(afterState.prompts[1]?.markdown).toContain("- T-001#B-001: blocked");
    expect(afterState.prompts[0]?.markdown).toContain("T-001#B-001 RUN-002: report-marker-two");
    expect(afterState.prompts[0]?.markdown).not.toContain("report-marker-T-001-one");

    fixture.projectGraph.canvases = fixture.projectGraph.canvases.map((canvas) =>
      canvas.id === "upstream-1" ? { ...canvas, title: "Upstream title two" } : canvas
    );
    await writeProjectGraph(fixture.workspace, fixture.projectGraph);
    const afterProjectGraph = await refreshPrompts(options);
    expect(afterProjectGraph.prompts[0]?.markdown).toContain(
      "- Upstream canvases: Upstream title two (upstream-1)"
    );

    await writeFile(fixture.globalPath, "global-marker-two\n");
    await writeFile(fixture.workspace.projectPromptFile, "project-marker-two\n");
    const afterConfig = await refreshPrompts(options);
    expect(
      afterConfig.prompts.every(
        ({ markdown }) =>
          markdown.includes("global-marker-two") && markdown.includes("project-marker-two")
      )
    ).toBe(true);
    await writeJsonFile(fixture.policyPath, { includeGlobalPrompt: false });
    const withoutGlobal = await refreshPrompts(options);
    expect(
      withoutGlobal.prompts.every(
        ({ markdown }) =>
          !markdown.includes("## PlanWeave Global Prompt") &&
          !markdown.includes("global-marker-two")
      )
    ).toBe(true);
    await writeJsonFile(fixture.policyPath, { includeGlobalPrompt: true });
    const beforeFinal = await hashes([...fixture.inputPaths, newReport]);
    const withGlobal = await refreshPrompts(options);
    expect(withGlobal.prompts.every(({ markdown }) => markdown.includes("global-marker-two"))).toBe(
      true
    );
    await expect(hashes([...fixture.inputPaths, newReport])).resolves.toEqual(beforeFinal);
  });

  it.each([
    "nodes/T-001/prompt.md",
    "nodes/T-001/blocks/B-001.prompt.md"
  ])("rejects a required source removed after a successful batch: %s", async (packagePath) => {
    const fixture = await createBatchFixture();
    await refreshPrompts({ projectRoot: fixture.root });
    await unlink(join(fixture.workspace.packageDir, packagePath));
    await expect(refreshPrompts({ projectRoot: fixture.root })).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it.each([
    "global",
    "project",
    "block",
    "report",
    "state",
    "policy"
  ] as const)("propagates an injected read failure after a successful batch: %s", async (source) => {
    const fixture = await createBatchFixture();
    await refreshPrompts({ projectRoot: fixture.root });
    const paths = {
      global: fixture.globalPath,
      project: fixture.workspace.projectPromptFile,
      block: join(fixture.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      report: join(fixture.workspace.resultsDir, "T-001/blocks/B-001/runs/RUN-001/report.md"),
      state: fixture.workspace.stateFile,
      policy: fixture.policyPath
    };
    reads.failurePaths.add(paths[source]);
    if (source === "block") reads.failurePaths.add(await realpath(paths.block));
    await expect(refreshPrompts({ projectRoot: fixture.root })).rejects.toMatchObject({
      code: "EACCES"
    });
  });

  it("preserves missing optional sources and legacy project graph diagnostics", async () => {
    const { root, home, init } = await createTestWorkspace();
    await unlink(join(home, "config/global-prompt.md"));
    await unlink(init.workspace.projectPromptFile);
    await unlink(projectGraphPath(init.workspace));
    const batch = await refreshPrompts({ projectRoot: root });
    expect(batch.prompts[0]?.markdown).toContain("- No global prompt.");
    expect(batch.prompts[0]?.markdown).toContain("- No project prompt.");
    expect(batch.prompts[0]?.markdown).toContain(
      "Warning: project_graph_missing_legacy_registry_used"
    );
    const single = await renderPromptSurface({ projectRoot: root, ref: "T-001#B-001" });
    expect(single.markdown).toBe(batch.prompts[0]?.markdown);
    expect(single.sources.filter(({ missing }) => missing).map(({ kind }) => kind)).toEqual([
      "global",
      "project",
      "projectGraph"
    ]);
  });

  it("rejects invalid project graph diagnostics rather than rendering a cached success", async () => {
    const fixture = await createBatchFixture();
    await refreshPrompts({ projectRoot: fixture.root });
    await writeProjectGraph(fixture.workspace, {
      version: "plan-project/v1",
      canvases: [canonicalProjectCanvasNode({ id: "default", title: "Batch canvas" })],
      edges: [],
      crossTaskEdges: [
        {
          from: { canvasId: "default", taskId: "T-001" },
          to: { canvasId: "default", taskId: "T-missing" },
          type: "depends_on"
        }
      ]
    });
    await expect(refreshPrompts({ projectRoot: fixture.root })).rejects.toThrow(
      "Project graph is invalid; prompt context cannot be rendered."
    );
  });

  it("returns an empty batch without reading state or prompt policy", async () => {
    const manifest = { ...basicManifest(), nodes: [], edges: [] };
    const { root, init } = await createTestWorkspace(manifest);
    const policyPath = join(init.workspace.workspaceRoot, "policy/prompt-policy.json");
    await writeFile(init.workspace.stateFile, "invalid state JSON");
    await writeFile(policyPath, "invalid policy JSON");
    const paths = [init.workspace.manifestFile, init.workspace.stateFile, policyPath];
    const before = await hashes(paths);
    reads.paths = [];
    await expect(refreshPrompts({ projectRoot: root })).resolves.toEqual({ prompts: [] });
    expect(reads.paths).not.toContain(init.workspace.stateFile);
    expect(reads.paths).not.toContain(policyPath);
    await expect(hashes(paths)).resolves.toEqual(before);
  });
});
