import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../../..");
const cliWorkflowTimeoutMs = 120_000;

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("pnpm", ["--silent", "--filter", "@planweave-ai/cli", "planweave", ...args], {
    cwd: repoRoot,
    env
  });
}

type CliFailure = Error & {
  code: number;
  stdout: string;
  stderr: string;
};

function isCliFailure(error: unknown): error is CliFailure {
  const candidate = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  return error instanceof Error && typeof candidate.code === "number" && typeof candidate.stdout === "string" && typeof candidate.stderr === "string";
}

async function runCliExpectFailure(args: string[], env: NodeJS.ProcessEnv): Promise<CliFailure> {
  try {
    await runCli(args, env);
  } catch (error) {
    if (isCliFailure(error)) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expected planweave ${args.join(" ")} to fail.`);
}

function withoutInitCwd(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.INIT_CWD;
  return next;
}

type ExampleStatus = {
  tasks: Array<{ taskId: string; status: string; openFeedbackCount: number }>;
  blocks: Array<{ ref: string; status: string }>;
  currentRefs: string[];
  currentFeedbackId: string | null;
  currentReviewBlockRef: string | null;
  openFeedback: Array<unknown>;
  counts: {
    tasks: Record<string, number>;
    blocks: Record<string, number>;
    feedback: Record<string, number>;
  };
  orphanState: Array<unknown>;
  orphanResults: Array<unknown>;
};

type ValidationReport = {
  ok: boolean;
  warnings: Array<{ code: string }>;
};

function expectCompletedExampleStatus(status: ExampleStatus): void {
  expect(status.tasks.find((task) => task.taskId === "T-001")).toMatchObject({
    taskId: "T-001",
    status: "implemented",
    openFeedbackCount: 0
  });
  expect(status.blocks.find((block) => block.ref === "T-001#B-001")).toMatchObject({
    ref: "T-001#B-001",
    status: "completed"
  });
  expect(status.blocks.find((block) => block.ref === "T-001#R-001")).toMatchObject({
    ref: "T-001#R-001",
    status: "completed"
  });
  expect(status.currentRefs).toEqual([]);
  expect(status.currentFeedbackId).toBeNull();
  expect(status.currentReviewBlockRef).toBeNull();
  expect(status.openFeedback).toEqual([]);
  expect(status.counts.tasks.implemented).toBe(1);
  expect(status.counts.blocks.completed).toBe(2);
  expect(status.counts.feedback).toMatchObject({
    open: 0,
    in_progress: 0,
    resolved: 1,
    dismissed: 0
  });
  expect(status.orphanState).toEqual([]);
  expect(status.orphanResults).toEqual([]);
}

function expectNoOrphanValidation(report: ValidationReport): void {
  expect(report.ok).toBe(true);
  expect(report.warnings.filter((warning) => warning.code === "orphan_state" || warning.code === "orphan_result")).toEqual([]);
}

describe("STEP-1 CLI contract", () => {
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
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
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

  it("runs the block-level review feedback loop", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const validation = JSON.parse((await runCli(["validate", "--json"], env)).stdout);
    expect(validation.ok).toBe(true);

    expect(JSON.parse((await runCli(["claim-next"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#B-001"
    });
    expect((await runCli(["prompt", "T-001#B-001"], env)).stdout).toContain("Create a small implementation report");
    const implementation = join(home, "implementation.md");
    await writeFile(implementation, "Implemented.\n", "utf8");
    const submitResult = JSON.parse(
      (await runCli(["submit-result", "T-001#B-001", "--report", implementation, "--json"], env)).stdout
    ) as {
      ref: string;
      status: string;
    };
    expect(submitResult).toMatchObject({
      ref: "T-001#B-001",
      status: "completed"
    });

    expect(JSON.parse((await runCli(["claim", "--type", "review"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#R-001"
    });
    const review = join(home, "review.json");
    await writeFile(
      review,
      JSON.stringify({
        reviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        verdict: "needs_changes",
        content: "Adjust the implementation report."
      }),
      "utf8"
    );
    const needsChangesReview = JSON.parse(
      (await runCli(["submit-review", "T-001#R-001", "--result", review, "--json"], env)).stdout
    ) as {
      ref: string;
      verdict: string;
      status: string;
      feedbackCreated: boolean;
    };
    expect(needsChangesReview).toMatchObject({
      ref: "T-001#R-001",
      verdict: "needs_changes",
      status: "in_progress",
      feedbackCreated: true
    });
    expect(JSON.parse((await runCli(["claim-next"], env)).stdout)).toEqual({
      kind: "feedback",
      feedbackId: "FE-001",
      sourceReviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      content: "Adjust the implementation report."
    });
    const feedback = join(home, "feedback.md");
    await writeFile(feedback, "Adjusted.\n", "utf8");
    const submitFeedback = JSON.parse((await runCli(["submit-feedback", "--report", feedback, "--json"], env)).stdout) as {
      status: string;
      nextCommand: string;
    };
    expect(submitFeedback).toMatchObject({
      status: "accepted",
      nextCommand: "planweave claim-next"
    });

    expect(JSON.parse((await runCli(["claim-next"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#R-001",
      reason: "feedback_resolved"
    });
    await writeFile(
      review,
      JSON.stringify({
        reviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        verdict: "passed",
        content: "Passed."
      }),
      "utf8"
    );
    const passedReview = JSON.parse((await runCli(["submit-review", "T-001#R-001", "--result", review, "--json"], env)).stdout) as {
      ref: string;
      verdict: string;
      status: string;
      feedbackCreated: boolean;
    };
    expect(passedReview).toMatchObject({
      ref: "T-001#R-001",
      verdict: "passed",
      status: "completed",
      feedbackCreated: false
    });
    const status = JSON.parse((await runCli(["status", "--json"], env)).stdout) as ExampleStatus;
    expectCompletedExampleStatus(status);
    expectNoOrphanValidation(JSON.parse((await runCli(["validate", "--json"], env)).stdout) as ValidationReport);
  }, cliWorkflowTimeoutMs);

  it("reports explainable Auto Run status in JSON and text output", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const initial = JSON.parse((await runCli(["run-status", "--json"], env)).stdout) as {
      explanation: { phase: string; nextAction: { kind: string; command: string | null; message: string } };
    };
    expect(initial.explanation).toMatchObject({
      phase: "idle",
      nextAction: {
        kind: "start",
        command: null,
        message: "Continue Auto Run; claimable work is ready: T-001#B-001."
      }
    });

    await runCli(["run", "--once", "--executor", "manual"], env);
    const status = JSON.parse((await runCli(["run-status", "--json"], env)).stdout) as {
      explanation: {
        phase: string;
        currentRef: string | null;
        currentExecutor: string | null;
        latestRecordId: string | null;
        latestRecordPath: string | null;
        nextAction: { kind: string; message: string };
      };
    };
    expect(status.explanation).toMatchObject({
      phase: "manual",
      currentRef: "T-001#B-001",
      currentExecutor: "manual",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: expect.stringContaining("metadata.json"),
      nextAction: {
        kind: "submit_manual_result",
        message: "Complete the manual step, then submit the result."
      }
    });

    const text = (await runCli(["run-status"], env)).stdout;
    expect(text).toContain("latest record: T-001#B-001::RUN-001");
    expect(text).toContain("next action: Complete the manual step, then submit the result.");
  }, 20_000);

  it("creates CLI run and reset sessions that can be queried", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const run = JSON.parse((await runCli(["run", "--once", "--executor", "manual", "--json"], env)).stdout) as {
      session: { sessionId: string; kind: string; phase: string; latestRecordId: string | null };
      steps: Array<{ kind: string }>;
      ok: boolean;
      terminalReason: string;
    };
    expect(run).toMatchObject({
      session: {
        sessionId: "SESSION-0001",
        kind: "run",
        phase: "manual",
        latestRecordId: "T-001#B-001::RUN-001"
      },
      steps: [{ kind: "manual" }],
      ok: true,
      terminalReason: "manual"
    });

    const reset = JSON.parse((await runCli(["reset", "--force", "--reason", "rerun acceptance", "--json"], env)).stdout) as {
      sessionId: string;
      statePath: string;
      forced: boolean;
      session: { sessionId: string; kind: string; phase: string };
    };
    expect(reset).toMatchObject({
      sessionId: "SESSION-0002",
      forced: true,
      session: { sessionId: "SESSION-0002", kind: "reset", phase: "completed" }
    });
    expect(reset.statePath).toContain("canvases/default/state.json");

    const sessions = JSON.parse((await runCli(["run-sessions", "--json"], env)).stdout) as {
      sessions: Array<{ sessionId: string; kind: string }>;
      diagnostics: unknown[];
    };
    expect(sessions.diagnostics).toEqual([]);
    expect(sessions.sessions.map((session) => session.sessionId)).toEqual(["SESSION-0002", "SESSION-0001"]);
    expect(sessions.sessions.map((session) => session.kind)).toEqual(["reset", "run"]);

    const detail = JSON.parse((await runCli(["run-session", "SESSION-0001", "--json"], env)).stdout) as {
      session: { sessionId: string; kind: string };
      events: Array<{ type: string }>;
      diagnostics: unknown[];
    };
    expect(detail).toMatchObject({
      session: { sessionId: "SESSION-0001", kind: "run" },
      diagnostics: []
    });
    expect(detail.events.map((event) => event.type)).toEqual(expect.arrayContaining(["session_started", "step_finish", "session_manual"]));
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
