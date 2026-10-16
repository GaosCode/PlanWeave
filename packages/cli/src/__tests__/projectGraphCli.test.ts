import { access, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { customDefaultCanvasMigrationFixture } from "../../../runtime/src/__tests__/customDefaultCanvasMigrationFixture.js";
import { runtimeGateway } from "../../../mcp/src/toolRuntime.js";
import { handlePlanweaveTool } from "../../../mcp/src/tools.js";
import { readJson } from "../../../mcp/src/__tests__/toolTestHelpers.js";
import { runCli, runCliExpectFailure } from "./support/cliTestHarness.js";

describe("STEP-1 CLI contract: project graph", () => {
  it("initializes and materializes a formal project graph through the CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = { ...process.env, PLANWEAVE_HOME: home, INIT_CWD: root };

    const init = JSON.parse((await runCli(["init", "--project-graph", "--json"], env)).stdout);
    expect(init.projectGraph).toMatchObject({
      path: join(init.workspace.workspaceRoot, "project-graph.json"),
      created: true,
      source: "legacy_default_canvas",
      canvasCount: 1
    });
    expect(JSON.parse(await readFile(init.projectGraph.path, "utf8"))).toMatchObject({
      version: "plan-project/v1",
      canvases: [expect.objectContaining({ id: "default", packageDir: "canvases/default/package" })]
    });

    const migrate = JSON.parse((await runCli(["project-graph", "migrate", "--json"], env)).stdout);
    expect(migrate).toMatchObject({
      path: init.projectGraph.path,
      created: false,
      source: "project_graph",
      canvasCount: 1
    });
  }, 20_000);

  it("rejects project-graph migrate before init", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = { ...process.env, PLANWEAVE_HOME: home, INIT_CWD: root };

    await expect(runCli(["project-graph", "migrate", "--json"], env)).rejects.toMatchObject({
      stderr: expect.stringContaining("planweave init --project-graph --json")
    });
  }, 20_000);

  it("reports default canvas migration conflicts without writing or quarantining root data", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = { ...process.env, PLANWEAVE_HOME: home, INIT_CWD: root };
    const init = JSON.parse((await runCli(["init", "--project-graph", "--json"], env)).stdout);
    const projectGraphBefore = await readFile(
      join(init.workspace.workspaceRoot, "project-graph.json"),
      "utf8"
    );
    const legacyPackageDir = join(init.workspace.workspaceRoot, "package");
    await cp(init.workspace.packageDir, legacyPackageDir, { recursive: true });
    await writeFile(
      join(legacyPackageDir, "manifest.json"),
      JSON.stringify(
        {
          version: "plan-package/v1",
          project: { title: "Conflicting root package" },
          execution: { parallel: { enabled: false, maxConcurrent: 1 } },
          review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
          nodes: [],
          edges: []
        },
        null,
        2
      ),
      "utf8"
    );

    const failure = await runCliExpectFailure(["project-graph", "migrate", "--json"], env);
    const result = JSON.parse(failure.stdout);

    expect(failure.code).not.toBe(0);
    expect(result).toMatchObject({
      action: "conflict",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "default_canvas_legacy_root_conflict" })
      ])
    });
    await expect(
      readFile(join(init.workspace.workspaceRoot, "project-graph.json"), "utf8")
    ).resolves.toBe(projectGraphBefore);
    await expect(
      access(join(init.workspace.workspaceRoot, "package", "manifest.json"))
    ).resolves.toBeUndefined();
    await expect(
      access(join(init.workspace.workspaceRoot, "migration-quarantine"))
    ).rejects.toThrow();
  }, 20_000);

  it.each([
    { absolute: false, residue: false },
    { absolute: false, residue: true },
    { absolute: true, residue: false },
    { absolute: true, residue: true }
  ])("migrates registered custom storage via CLI ($absolute absolute, $residue root residue)", async ({
    absolute,
    residue
  }) => {
    const f = await customDefaultCanvasMigrationFixture(absolute, residue);
    const env = { ...process.env, PLANWEAVE_HOME: f.home, INIT_CWD: f.root };
    const result = JSON.parse((await runCli(["project-graph", "migrate", "--json"], env)).stdout);
    expect(result).toMatchObject({ action: "migrate", legacyPaths: f.sourcePaths });
    expect(await readFile(f.init.workspace.stateFile, "utf8")).toBe(f.sourceStateBytes);
    expect(await readFile(join(f.init.workspace.resultsDir, f.reportRelativePath), "utf8")).toBe(
      f.report
    );
    expect(
      readJson(
        await handlePlanweaveTool("get_status", { projectId: f.init.project.id }, runtimeGateway)
      )
    ).toMatchObject({
      currentRefs: ["T-001#R-001"],
      blocks: expect.arrayContaining([
        expect.objectContaining({ ref: "T-001#B-001", status: "completed" })
      ])
    });
    expect(
      readJson(
        await handlePlanweaveTool(
          "list_ready_blocks",
          { projectId: f.init.project.id },
          runtimeGateway
        )
      )
    ).toMatchObject({
      readyBlocks: [expect.objectContaining({ ref: "T-002#B-001", canvasId: "default" })]
    });
    expect(
      await runtimeGateway.getBlockDetail(f.init.project.id, "T-001#B-001", "default")
    ).toMatchObject({ status: "completed", latestRunId: "RUN-001" });
    expect(
      (await runtimeGateway.getPrompt(f.init.project.id, "default", "T-001#R-001")).markdown
    ).toContain(f.report.trim());
    if (residue)
      expect(
        await readFile(join(f.init.workspace.workspaceRoot, "results", "unrelated.txt"), "utf8")
      ).toBe("Root residue");
  }, 20_000);
});
