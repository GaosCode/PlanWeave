import { access, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    const projectGraphBefore = await readFile(join(init.workspace.workspaceRoot, "project-graph.json"), "utf8");
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
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "default_canvas_legacy_root_conflict" })])
    });
    await expect(readFile(join(init.workspace.workspaceRoot, "project-graph.json"), "utf8")).resolves.toBe(projectGraphBefore);
    await expect(access(join(init.workspace.workspaceRoot, "package", "manifest.json"))).resolves.toBeUndefined();
    await expect(access(join(init.workspace.workspaceRoot, "migration-quarantine"))).rejects.toThrow();
  }, 20_000);
});
