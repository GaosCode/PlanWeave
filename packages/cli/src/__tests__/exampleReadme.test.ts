import { execFile } from "node:child_process";
import { cp, readFile, mkdtemp, realpath, writeFile } from "node:fs/promises";
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

function parseJson<T = unknown>(stdout: string): T {
  return JSON.parse(stdout) as T;
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

describe("basic Plan Package README workflow", () => {
  it("uses a pnpm wrapper that preserves JSON stdout", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const { stdout, stderr } = await planweave(["init", "--json"], { ...process.env, PLANWEAVE_HOME: home });

    expect(stderr).toBe("");
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(parseJson<{ workspace: { packageDir: string } }>(stdout).workspace.packageDir).toEqual(expect.stringContaining(home));
  });

  it("can target a project root explicitly from a different cwd without INIT_CWD", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "planweave-project-"));
    const env = withoutInitCwd({ ...process.env, PLANWEAVE_HOME: home });
    const rootArgs = ["--project-root", projectRoot];
    const init = parseJson<{ workspace: { packageDir: string }; project: { rootPath: string } }>(
      (await planweave([...rootArgs, "init", "--json"], env)).stdout
    );
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    expect(init.project.rootPath).toBe(await realpath(projectRoot));
    expect(parseJson<ValidationReport>((await planweave([...rootArgs, "validate", "--json"], env)).stdout).ok).toBe(true);
    expect(parseJson<ExampleStatus>((await planweave([...rootArgs, "status", "--json"], env)).stdout).tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: "T-001" })])
    );
  }, cliWorkflowTimeoutMs);

  it("runs the documented block/review/feedback retry workflow", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = parseJson<{ workspace: { packageDir: string } }>((await planweave(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    expect(parseJson<{ ok: boolean }>((await planweave(["validate", "--json"], env)).stdout).ok).toBe(true);
    const manualRun = parseJson<{ kind: string; claim: { ref: string }; adapterResult: { promptPath: string } }>(
      (await planweave(["run", "--once", "--executor", "manual", "--json"], env)).stdout
    );
    expect(manualRun).toMatchObject({
      kind: "manual",
      claim: { ref: "T-001#B-001" },
      adapterResult: { promptPath: expect.stringContaining("prompt.md") }
    });
    expect(parseJson<{ kind: string; ref: string }>((await planweave(["claim-next"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#B-001"
    });
    await planweave(["prompt", "T-001#B-001"], env);

    const implementation = join(home, "implementation-1.md");
    await writeFile(implementation, "First implementation.\n", "utf8");
    await planweave(["submit-result", "T-001#B-001", "--report", implementation], env);

    expect(parseJson<{ kind: string; ref: string }>((await planweave(["claim-next"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#R-001"
    });
    await planweave(["prompt", "T-001#R-001"], env);

    const firstReview = join(home, "review-1.json");
    await writeFile(
      firstReview,
      JSON.stringify({
        reviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        verdict: "needs_changes",
        content: "Needs a test adjustment."
      }),
      "utf8"
    );
    await planweave(["submit-review", "T-001#R-001", "--result", firstReview], env);

    expect(parseJson<{ kind: string; content: string }>((await planweave(["claim-next"], env)).stdout)).toMatchObject({
      kind: "feedback",
      content: "Needs a test adjustment."
    });
    const feedback = join(home, "feedback-1.md");
    await writeFile(feedback, "Handled requested test adjustment.\n", "utf8");
    await planweave(["submit-feedback", "--report", feedback], env);

    expect(parseJson<{ kind: string; ref: string; reason: string }>((await planweave(["claim-next"], env)).stdout)).toMatchObject({
      kind: "block",
      ref: "T-001#R-001",
      reason: "feedback_resolved"
    });
    const secondReview = join(home, "review-2.json");
    await writeFile(
      secondReview,
      JSON.stringify({
        reviewBlockRef: "T-001#R-001",
        taskId: "T-001",
        verdict: "passed",
        content: "Passed."
      }),
      "utf8"
    );
    await planweave(["submit-review", "T-001#R-001", "--result", secondReview], env);

    const status = parseJson<ExampleStatus>((await planweave(["status", "--json"], env)).stdout);
    expectCompletedExampleStatus(status);
    expectNoOrphanValidation(parseJson<ValidationReport>((await planweave(["validate", "--json"], env)).stdout));
  }, cliWorkflowTimeoutMs);

  it("runs the documented manual auto-run entrypoint without auto-submitting work", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = parseJson<{ workspace: { packageDir: string } }>((await planweave(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const run = parseJson<{ kind: string; adapterResult: { promptPath: string } }>(
      (await planweave(["run", "--once", "--executor", "manual", "--json"], env)).stdout
    );

    expect(run.kind).toBe("manual");
    expect(run.adapterResult.promptPath).toContain("prompt.md");
    expect(await readFile(run.adapterResult.promptPath, "utf8")).toContain("# T-001#B-001");
    const status = parseJson<{ latestRuns: Array<{ ref: string; status: string }> }>((await planweave(["run-status", "--json"], env)).stdout);
    expect(status.latestRuns.find((run) => run.ref === "T-001#B-001")?.status).toBe("in_progress");
  }, cliWorkflowTimeoutMs);
});
