import { access, cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, runShellCommand, runCliExpectFailure, withoutInitCwd, shellQuoteArg, installPlanweaveShim, repoRoot, type ValidationReport, type GraphQualityJsonReport, type CreateCanvasWorkspaceJsonResult } from "./support/cliTestHarness.js";

describe("STEP-1 CLI contract: canvas", () => {
  it("creates a canvas through the CLI and returns stable JSON paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    const rootArgs = ["--project-root", root];
    await runCli([...rootArgs, "init", "--project-graph", "--json"], env);

    const result = JSON.parse(
      (await runCli([...rootArgs, "canvas", "create", "--title", "Optimization Plan", "--json"], env)).stdout
    ) as CreateCanvasWorkspaceJsonResult;

    expect(Object.keys(result)).toEqual([
      "canvasId",
      "title",
      "created",
      "activated",
      "projectGraphPath",
      "canvasRoot",
      "packageDir",
      "manifestPath",
      "taskPromptsDir",
      "blockPromptsDir",
      "statePath",
      "resultsDir",
      "canvasValidationCommand",
      "projectValidationCommand",
      "qualityCommand"
    ]);
    expect(result).toMatchObject({
      canvasId: "optimization-plan",
      title: "Optimization Plan",
      created: true,
      activated: false,
      canvasValidationCommand: `planweave --project-root ${shellQuoteArg(root)} validate --canvas optimization-plan --json`,
      projectValidationCommand: `planweave --project-root ${shellQuoteArg(root)} validate --json`,
      qualityCommand: `planweave --project-root ${shellQuoteArg(root)} graph quality --canvas optimization-plan --json`
    });
    await expect(access(result.manifestPath)).resolves.toBeUndefined();
    await expect(access(result.statePath)).resolves.toBeUndefined();
    await expect(access(result.resultsDir)).resolves.toBeUndefined();

    const shimBin = await mkdtemp(join(tmpdir(), "planweave-bin-"));
    await installPlanweaveShim(shimBin);
    const replayEnv = { ...env, PATH: `${shimBin}:${env.PATH ?? ""}` };
    const unrelatedCwd = await mkdtemp(join(tmpdir(), "planweave-unrelated-"));

    const validation = JSON.parse((await runShellCommand(result.canvasValidationCommand, replayEnv, unrelatedCwd)).stdout) as ValidationReport;
    expect(validation.ok).toBe(true);
    const projectValidation = JSON.parse((await runShellCommand(result.projectValidationCommand, replayEnv, unrelatedCwd)).stdout) as ValidationReport;
    expect(projectValidation.ok).toBe(true);
    const quality = JSON.parse((await runShellCommand(result.qualityCommand, replayEnv, unrelatedCwd)).stdout) as GraphQualityJsonReport;
    expect(quality.ok).toBe(true);
  }, 20_000);

  it("returns replayable canvas commands when project root was passed as a relative path", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-relative-project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    await runCli(["--project-root", root, "init", "--project-graph", "--json"], env);

    const shimBin = await mkdtemp(join(tmpdir(), "planweave-bin-"));
    await installPlanweaveShim(shimBin);
    const replayEnv = { ...env, PATH: `${shimBin}:${env.PATH ?? ""}` };
    const result = JSON.parse(
      (await runShellCommand(`planweave --project-root . canvas create --title ${shellQuoteArg("Relative Root Plan")} --json`, replayEnv, root)).stdout
    ) as CreateCanvasWorkspaceJsonResult;
    const replayProjectRoot = await realpath(root);

    expect(result).toMatchObject({
      canvasId: "relative-root-plan",
      canvasValidationCommand: `planweave --project-root ${shellQuoteArg(replayProjectRoot)} validate --canvas relative-root-plan --json`,
      projectValidationCommand: `planweave --project-root ${shellQuoteArg(replayProjectRoot)} validate --json`,
      qualityCommand: `planweave --project-root ${shellQuoteArg(replayProjectRoot)} graph quality --canvas relative-root-plan --json`
    });

    const unrelatedCwd = await mkdtemp(join(tmpdir(), "planweave-unrelated-"));
    const validation = JSON.parse((await runShellCommand(result.canvasValidationCommand, replayEnv, unrelatedCwd)).stdout) as ValidationReport;
    expect(validation.ok).toBe(true);
    const projectValidation = JSON.parse((await runShellCommand(result.projectValidationCommand, replayEnv, unrelatedCwd)).stdout) as ValidationReport;
    expect(projectValidation.ok).toBe(true);
    const quality = JSON.parse((await runShellCommand(result.qualityCommand, replayEnv, unrelatedCwd)).stdout) as GraphQualityJsonReport;
    expect(quality.ok).toBe(true);
  }, 20_000);

  it("dedupes conflicting canvas ids through the CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    const rootArgs = ["--project-root", root];
    await runCli([...rootArgs, "init", "--project-graph", "--json"], env);

    const first = JSON.parse(
      (await runCli([...rootArgs, "canvas", "create", "--id", "release-plan", "--title", "Release Plan", "--json"], env)).stdout
    ) as CreateCanvasWorkspaceJsonResult;
    const second = JSON.parse(
      (await runCli([...rootArgs, "canvas", "create", "--id", "release-plan", "--title", "Release Plan Again", "--json"], env)).stdout
    ) as CreateCanvasWorkspaceJsonResult;

    expect(first.canvasId).toBe("release-plan");
    expect(second.canvasId).toBe("release-plan-2");
    await expect(access(first.canvasRoot)).resolves.toBeUndefined();
    await expect(access(second.canvasRoot)).resolves.toBeUndefined();
  }, 20_000);

  it("keeps canvas create dry-runs free of filesystem side effects", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    const rootArgs = ["--project-root", root];
    const init = JSON.parse((await runCli([...rootArgs, "init", "--project-graph", "--json"], env)).stdout);
    const graphBefore = await readFile(init.projectGraph.path, "utf8");

    const result = JSON.parse(
      (await runCli([...rootArgs, "canvas", "create", "--title", "Dry Run Plan", "--dry-run", "--json"], env)).stdout
    ) as CreateCanvasWorkspaceJsonResult;

    expect(result).toMatchObject({
      canvasId: "dry-run-plan",
      created: false,
      activated: false
    });
    await expect(access(result.canvasRoot)).rejects.toThrow();
    await expect(readFile(init.projectGraph.path, "utf8")).resolves.toBe(graphBefore);
  }, 20_000);

  it("activates a newly created canvas when requested", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    const rootArgs = ["--project-root", root];
    await runCli([...rootArgs, "init", "--project-graph", "--json"], env);

    const result = JSON.parse(
      (await runCli([...rootArgs, "canvas", "create", "--title", "Active Plan", "--activate", "--json"], env)).stdout
    ) as CreateCanvasWorkspaceJsonResult;
    const paths = JSON.parse((await runCli([...rootArgs, "paths", "--json"], env)).stdout) as { activeCanvasId: string | null };

    expect(result).toMatchObject({
      canvasId: "active-plan",
      created: true,
      activated: true
    });
    expect(paths.activeCanvasId).toBe("active-plan");
  }, 20_000);

  it("scopes validation only when --canvas is passed", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = { ...process.env, PLANWEAVE_HOME: home, INIT_CWD: root, PLANWEAVE_CANVAS_ID: "valid-canvas" };
    const init = JSON.parse((await runCli(["--project-root", root, "init", "--project-graph", "--json"], env)).stdout);
    const validCanvasId = "valid-canvas";
    const validPackageDir = join(init.workspace.workspaceRoot, "canvases", validCanvasId, "package");

    await mkdir(join(init.workspace.workspaceRoot, "canvases", validCanvasId), { recursive: true });
    await cp(join(repoRoot, "examples/basic-plan-package/package"), validPackageDir, { recursive: true, force: true });
    await writeFile(
      join(init.workspace.workspaceRoot, "canvases", validCanvasId, "state.json"),
      JSON.stringify({ currentRefs: [], currentFeedbackId: null, currentReviewBlockRef: null, tasks: {}, blocks: {}, feedback: {} }, null, 2),
      "utf8"
    );
    await mkdir(join(init.workspace.workspaceRoot, "canvases", validCanvasId, "results"), { recursive: true });
    const projectGraph = JSON.parse(await readFile(init.projectGraph.path, "utf8")) as {
      canvases: Array<Record<string, unknown>>;
    };
    projectGraph.canvases.push({
      id: validCanvasId,
      type: "canvas",
      title: "Valid canvas",
      packageDir: `canvases/${validCanvasId}/package`,
      stateFile: `canvases/${validCanvasId}/state.json`,
      resultsDir: `canvases/${validCanvasId}/results`
    });
    await writeFile(init.projectGraph.path, `${JSON.stringify(projectGraph, null, 2)}\n`, "utf8");
    await writeFile(init.workspace.manifestFile, "{ invalid json", "utf8");

    const scopedValidation = JSON.parse(
      (await runCli(["--project-root", init.project.rootPath, "validate", "--canvas", validCanvasId, "--json"], env)).stdout
    ) as ValidationReport;
    expect(scopedValidation.ok).toBe(true);

    const fullValidationFailure = await runCliExpectFailure(["--project-root", init.project.rootPath, "validate", "--json"], env);
    const fullValidation = JSON.parse(fullValidationFailure.stdout) as ValidationReport;
    expect(fullValidation.ok).toBe(false);
    expect(fullValidation.errors.map((error) => error.code)).toContain("manifest_read_failed");
  }, 20_000);

  it("operates a non-default canvas in a formal multi-canvas project", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    const rootArgs = ["--project-root", root];
    const init = JSON.parse((await runCli([...rootArgs, "init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });
    const desktopPackageDir = join(init.workspace.workspaceRoot, "canvases", "desktop", "package");
    await cp(join(repoRoot, "examples/basic-plan-package/package"), desktopPackageDir, {
      recursive: true,
      force: true
    });
    await writeFile(
      join(desktopPackageDir, "nodes", "T-001", "blocks", "B-001.prompt.md"),
      "Desktop canvas block prompt.\n",
      "utf8"
    );
    await writeFile(
      join(init.workspace.workspaceRoot, "project-graph.json"),
      `${JSON.stringify(
        {
          version: "plan-project/v1",
          canvases: [
            {
              id: "default",
              type: "canvas",
              title: "Default",
              packageDir: "canvases/default/package",
              stateFile: "canvases/default/state.json",
              resultsDir: "canvases/default/results"
            },
            {
              id: "desktop",
              type: "canvas",
              title: "Desktop",
              packageDir: "canvases/desktop/package",
              stateFile: "canvases/desktop/state.json",
              resultsDir: "canvases/desktop/results"
            }
          ],
          edges: [],
          crossTaskEdges: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const paths = JSON.parse((await runCli([...rootArgs, "paths", "--json"], env)).stdout);
    expect(paths.projectGraphPath).toBe(join(init.workspace.workspaceRoot, "project-graph.json"));
    expect(paths.activeCanvasId).toBe("default");
    expect(paths.canvases.map((canvas: { canvasId: string }) => canvas.canvasId)).toEqual(["default", "desktop"]);

    const initialDesktopStatus = JSON.parse((await runCli([...rootArgs, "status", "--json", "--canvas", "desktop"], env)).stdout);
    expect(initialDesktopStatus.claimHints.find((hint: { ref: string }) => hint.ref === "T-001#B-001")?.recommendedCommand).toContain(
      "planweave claim --canvas desktop"
    );
    const desktopRunStatusJson = JSON.parse((await runCli([...rootArgs, "run-status", "--json", "--canvas", "desktop"], env)).stdout) as {
      explanation: { nextAction: { command: string | null } };
    };
    expect(desktopRunStatusJson.explanation.nextAction.command).toBeNull();
    const desktopRunStatusText = (await runCli([...rootArgs, "run-status", "--canvas", "desktop"], env)).stdout;
    expect(desktopRunStatusText).toContain(`next command: planweave --project-root '${root}' run --canvas desktop`);
    expect(desktopRunStatusText).not.toContain("next command: planweave run --canvas desktop");
    expect(desktopRunStatusText).not.toContain("next command: planweave run\n");
    expect(JSON.parse((await runCli([...rootArgs, "claim-next", "--canvas", "desktop"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#B-001"
    });
    const desktopPrompt = (await runCli([...rootArgs, "prompt", "--canvas", "desktop", "T-001#B-001"], env)).stdout;
    expect(desktopPrompt).toContain("Desktop canvas block prompt");
    expect(desktopPrompt).toContain("planweave submit-result --canvas desktop T-001#B-001 --report");
    const desktopStatus = JSON.parse((await runCli([...rootArgs, "status", "--json", "--canvas", "desktop"], env)).stdout);
    expect(desktopStatus.currentRefs).toEqual(["T-001#B-001"]);

    const runtimeStatus = JSON.parse((await runCli([...rootArgs, "status", "--json"], env)).stdout);
    expect(runtimeStatus.currentRefs).toEqual([]);
    expect(JSON.parse((await runCli([...rootArgs, "current", "--canvas", "desktop"], env)).stdout).items[0].submitCommand).toContain(
      "--canvas desktop"
    );
  }, 20_000);
});
