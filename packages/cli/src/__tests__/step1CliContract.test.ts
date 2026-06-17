import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../../..");
const cliWorkflowTimeoutMs = 60_000;

async function planweave(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("pnpm", ["--silent", "--filter", "@planweave-ai/cli", "planweave", ...args], {
    cwd: repoRoot,
    env
  });
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

    const init = JSON.parse((await planweave(["init", "--project-graph", "--json"], env)).stdout);
    expect(init.projectGraph).toMatchObject({
      path: join(init.workspace.workspaceRoot, "project-graph.json"),
      created: true,
      source: "legacy_default_canvas",
      canvasCount: 1
    });
    expect(JSON.parse(await readFile(init.projectGraph.path, "utf8"))).toMatchObject({
      version: "plan-project/v1",
      canvases: [expect.objectContaining({ id: "default", packageDir: "package" })]
    });

    const migrate = JSON.parse((await planweave(["project-graph", "migrate", "--json"], env)).stdout);
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

    await expect(planweave(["project-graph", "migrate", "--json"], env)).rejects.toMatchObject({
      stderr: expect.stringContaining("planweave init --project-graph --json")
    });
  }, 20_000);

  it("runs the block-level review feedback loop", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await planweave(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const validation = JSON.parse((await planweave(["validate", "--json"], env)).stdout);
    expect(validation.ok).toBe(true);

    expect(JSON.parse((await planweave(["claim-next"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#B-001"
    });
    expect((await planweave(["prompt", "T-001#B-001"], env)).stdout).toContain("Create a small implementation report");
    const implementation = join(home, "implementation.md");
    await writeFile(implementation, "Implemented.\n", "utf8");
    const submitResult = JSON.parse(
      (await planweave(["submit-result", "T-001#B-001", "--report", implementation, "--json"], env)).stdout
    ) as {
      ref: string;
      status: string;
    };
    expect(submitResult).toMatchObject({
      ref: "T-001#B-001",
      status: "completed"
    });

    expect(JSON.parse((await planweave(["claim", "--type", "review"], env)).stdout)).toMatchObject({
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
      (await planweave(["submit-review", "T-001#R-001", "--result", review, "--json"], env)).stdout
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
    expect(JSON.parse((await planweave(["claim-next"], env)).stdout)).toEqual({
      kind: "feedback",
      feedbackId: "FE-001",
      sourceReviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      content: "Adjust the implementation report."
    });
    const feedback = join(home, "feedback.md");
    await writeFile(feedback, "Adjusted.\n", "utf8");
    const submitFeedback = JSON.parse((await planweave(["submit-feedback", "--report", feedback, "--json"], env)).stdout) as {
      status: string;
      nextCommand: string;
    };
    expect(submitFeedback).toMatchObject({
      status: "accepted",
      nextCommand: "planweave claim-next"
    });

    expect(JSON.parse((await planweave(["claim-next"], env)).stdout)).toMatchObject({
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
    const passedReview = JSON.parse((await planweave(["submit-review", "T-001#R-001", "--result", review, "--json"], env)).stdout) as {
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
    const status = JSON.parse((await planweave(["status", "--json"], env)).stdout) as ExampleStatus;
    expectCompletedExampleStatus(status);
    expectNoOrphanValidation(JSON.parse((await planweave(["validate", "--json"], env)).stdout) as ValidationReport);
  }, cliWorkflowTimeoutMs);

  it("reports explainable Auto Run status in JSON and text output", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await planweave(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const initial = JSON.parse((await planweave(["run-status", "--json"], env)).stdout) as {
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

    await planweave(["run", "--once", "--executor", "manual"], env);
    const status = JSON.parse((await planweave(["run-status", "--json"], env)).stdout) as {
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

    const text = (await planweave(["run-status"], env)).stdout;
    expect(text).toContain("latest record: T-001#B-001::RUN-001");
    expect(text).toContain("next action: Complete the manual step, then submit the result.");
  }, 20_000);

  it("operates a non-default canvas in a formal multi-canvas project", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    const rootArgs = ["--project-root", root];
    const init = JSON.parse((await planweave([...rootArgs, "init", "--json"], env)).stdout);
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
              id: "runtime",
              type: "canvas",
              title: "Runtime",
              packageDir: "package",
              stateFile: "state.json",
              resultsDir: "results"
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

    const paths = JSON.parse((await planweave([...rootArgs, "paths", "--json"], env)).stdout);
    expect(paths.projectGraphPath).toBe(join(init.workspace.workspaceRoot, "project-graph.json"));
    expect(paths.activeCanvasId).toBe("runtime");
    expect(paths.canvases.map((canvas: { canvasId: string }) => canvas.canvasId)).toEqual(["runtime", "desktop"]);

    const initialDesktopStatus = JSON.parse((await planweave([...rootArgs, "status", "--json", "--canvas", "desktop"], env)).stdout);
    expect(initialDesktopStatus.claimHints.find((hint: { ref: string }) => hint.ref === "T-001#B-001")?.recommendedCommand).toContain(
      "planweave claim --canvas desktop"
    );
    const desktopRunStatusJson = JSON.parse((await planweave([...rootArgs, "run-status", "--json", "--canvas", "desktop"], env)).stdout) as {
      explanation: { nextAction: { command: string | null } };
    };
    expect(desktopRunStatusJson.explanation.nextAction.command).toBeNull();
    const desktopRunStatusText = (await planweave([...rootArgs, "run-status", "--canvas", "desktop"], env)).stdout;
    expect(desktopRunStatusText).toContain("next command: planweave run --canvas desktop");
    expect(desktopRunStatusText).not.toContain("next command: planweave run\n");
    expect(JSON.parse((await planweave([...rootArgs, "claim-next", "--canvas", "desktop"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#B-001"
    });
    const desktopPrompt = (await planweave([...rootArgs, "prompt", "--canvas", "desktop", "T-001#B-001"], env)).stdout;
    expect(desktopPrompt).toContain("Desktop canvas block prompt");
    expect(desktopPrompt).toContain("planweave submit-result --canvas desktop T-001#B-001 --report");
    const desktopStatus = JSON.parse((await planweave([...rootArgs, "status", "--json", "--canvas", "desktop"], env)).stdout);
    expect(desktopStatus.currentRefs).toEqual(["T-001#B-001"]);

    const runtimeStatus = JSON.parse((await planweave([...rootArgs, "status", "--json"], env)).stdout);
    expect(runtimeStatus.currentRefs).toEqual([]);
    expect(JSON.parse((await planweave([...rootArgs, "current", "--canvas", "desktop"], env)).stdout).items[0].submitCommand).toContain(
      "--canvas desktop"
    );
  }, 20_000);
});
