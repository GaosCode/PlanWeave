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

type GraphQualityJsonReport = {
  ok: boolean;
  diagnostics: Array<{ code: string }>;
};

type GraphTestBlock = {
  id: string;
  prompt: string;
  type?: string;
  [key: string]: unknown;
};

type GraphTestTask = {
  id: string;
  title: string;
  prompt: string;
  blocks: GraphTestBlock[];
  [key: string]: unknown;
};

type GraphTestManifest = {
  nodes: GraphTestTask[];
  edges: Array<{ from: string; to: string; type: "depends_on" }>;
  [key: string]: unknown;
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

async function installTwoTaskGraphPackage(packageDir: string): Promise<void> {
  await cp(join(repoRoot, "examples/basic-plan-package/package"), packageDir, {
    recursive: true,
    force: true
  });
  const manifestPath = join(packageDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GraphTestManifest;
  const firstTask = manifest.nodes[0];
  if (!firstTask) {
    throw new Error("Expected the basic package manifest to contain T-001.");
  }

  await cp(join(packageDir, "nodes", "T-001"), join(packageDir, "nodes", "T-002"), {
    recursive: true,
    force: true
  });
  const secondTask: GraphTestTask = {
    ...firstTask,
    id: "T-002",
    title: "Second graph task",
    prompt: "nodes/T-002/prompt.md",
    blocks: firstTask.blocks.map((block) => ({
      ...block,
      prompt: `nodes/T-002/blocks/${block.id}.prompt.md`
    }))
  };
  manifest.nodes = [firstTask, secondTask];
  manifest.edges = [{ from: "T-002", to: "T-001", type: "depends_on" }];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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

  it("runs the block-level review feedback loop", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--project-graph", "--json"], env)).stdout);
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
      content: "Adjust the implementation report.",
      effectiveExecutor: "manual"
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

  it("exposes graph inspect and quality through the real CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await installTwoTaskGraphPackage(init.workspace.packageDir);

    const summaryOutput = (await runCli(["graph", "inspect", "--view", "summary", "--json"], env)).stdout;
    const summary = JSON.parse(summaryOutput) as {
      counts: { taskCount: number; blockCount: number; taskDependencyCount: number };
    };
    expect(summary.counts).toMatchObject({
      taskCount: 2,
      blockCount: 4,
      taskDependencyCount: 1
    });
    expect(summaryOutput).not.toContain("# T-001: Implement a tiny example change");
    expect(summaryOutput).not.toContain("promptSurfaceMarkdown");

    const tasks = JSON.parse((await runCli(["graph", "inspect", "--view", "tasks", "--limit", "1", "--json"], env)).stdout) as {
      tasks: Array<{ taskId: string }>;
      page: { limit: number; total: number; nextCursor: string | null; truncated: boolean };
    };
    expect(tasks.tasks.map((task) => task.taskId)).toEqual(["T-001"]);
    expect(tasks.page).toMatchObject({ limit: 1, total: 2, nextCursor: "next:1", truncated: true });

    const slice = JSON.parse((await runCli(["graph", "inspect", "--view", "slice", "--task", "T-001", "--json"], env)).stdout) as {
      blocks: { items: Array<{ ref: string }>; total: number; truncated: boolean };
    };
    expect(slice.blocks.items.map((block) => block.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
    expect(slice.blocks).toMatchObject({ total: 2, truncated: false });
    expect(JSON.stringify(slice)).not.toContain("nextCursor");
    const sliceCursorFailure = await runCliExpectFailure(["graph", "inspect", "--view", "slice", "--task", "T-001", "--cursor", "next:1"], env);
    expect(sliceCursorFailure.stderr).toContain("--cursor is not supported for graph inspect --view slice");

    const quality = JSON.parse((await runCli(["graph", "quality", "--json"], env)).stdout) as {
      ok: boolean;
      summary: { taskCount: number; blockCount: number };
      diagnostics: unknown[];
    };
    expect(quality).toMatchObject({
      ok: true,
      summary: { taskCount: 2, blockCount: 4 }
    });
    expect(Array.isArray(quality.diagnostics)).toBe(true);
  }, 20_000);

  it("returns a non-zero exit code for failing graph quality JSON reports", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const manifestPath = join(init.workspace.packageDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GraphTestManifest;
    manifest.nodes = manifest.nodes.map((task) => ({
      ...task,
      blocks: task.blocks.filter((block) => block.type !== "review")
    }));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const failure = await runCliExpectFailure(["graph", "quality", "--review-policy", "required", "--strict", "--json"], env);
    const result = JSON.parse(failure.stdout) as GraphQualityJsonReport;

    expect(failure.code).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "task_missing_review_block" })]));
  }, 20_000);

  it("returns a non-zero exit code for graph quality compile errors", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const manifestPath = join(init.workspace.packageDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GraphTestManifest;
    manifest.edges = [{ from: "T-001", to: "MISSING", type: "depends_on" }];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const failure = await runCliExpectFailure(["graph", "quality", "--json"], env);
    const result = JSON.parse(failure.stdout) as GraphQualityJsonReport;

    expect(failure.code).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "edge_to_missing" })]));
  }, 20_000);

  it("validates and imports package drafts through the real CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const draftRoot = await mkdtemp(join(tmpdir(), "planweave-draft-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), draftRoot, {
      recursive: true,
      force: true
    });
    const draftManifestPath = join(draftRoot, "manifest.json");
    const draftManifest = JSON.parse(await readFile(draftManifestPath, "utf8")) as GraphTestManifest & {
      project: { title: string; description: string };
    };
    draftManifest.project.title = "Draft Import Title";
    await writeFile(draftManifestPath, `${JSON.stringify(draftManifest, null, 2)}\n`, "utf8");

    const draftValidation = JSON.parse((await runCli(["package-draft", "validate", "--draft-root", draftRoot, "--json"], env)).stdout) as {
      ok: boolean;
      mode: string;
      validation: { summary: { errorCount: number } };
    };
    const draftQuality = JSON.parse((await runCli(["package-draft", "quality", "--draft-root", draftRoot, "--json"], env)).stdout) as {
      ok: boolean;
      canvases: Array<{ graphQuality: { ok: boolean } }>;
    };
    const dryRun = JSON.parse((await runCli(["package", "import", "--from", draftRoot, "--dry-run", "--canvas", "default", "--json"], env)).stdout) as {
      ok: boolean;
      target: { canvasId: string };
      summary: { changed: number };
    };
    const targetManifestBeforeApply = JSON.parse(await readFile(join(init.workspace.packageDir, "manifest.json"), "utf8")) as {
      project: { title: string };
    };
    const applied = JSON.parse((await runCli(["package", "import", "--from", draftRoot, "--apply", "--canvas", "default", "--json"], env)).stdout) as {
      ok: boolean;
      applied: boolean;
    };
    const targetManifestAfterApply = JSON.parse(await readFile(join(init.workspace.packageDir, "manifest.json"), "utf8")) as {
      project: { title: string };
    };
    const validationAfterApply = JSON.parse((await runCli(["validate", "--json"], env)).stdout) as ValidationReport;
    const qualityAfterApply = JSON.parse((await runCli(["graph", "quality", "--json"], env)).stdout) as GraphQualityJsonReport;

    expect(draftValidation).toMatchObject({ ok: true, mode: "single-canvas", validation: { summary: { errorCount: 0 } } });
    expect(draftQuality).toMatchObject({ ok: true, canvases: [{ graphQuality: { ok: true } }] });
    expect(dryRun).toMatchObject({ ok: true, target: { canvasId: "default" } });
    expect(dryRun.summary.changed).toBeGreaterThan(0);
    expect(targetManifestBeforeApply.project.title).not.toBe("Draft Import Title");
    expect(applied).toMatchObject({ ok: true, applied: true });
    expect(targetManifestAfterApply.project.title).toBe("Draft Import Title");
    expect(validationAfterApply.ok).toBe(true);
    expect(qualityAfterApply.ok).toBe(true);
  }, 20_000);

  it("returns a non-zero exit code for invalid package draft quality", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const draftRoot = await mkdtemp(join(tmpdir(), "planweave-bad-draft-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    await cp(join(repoRoot, "examples/basic-plan-package/package"), draftRoot, {
      recursive: true,
      force: true
    });
    const manifestPath = join(draftRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GraphTestManifest;
    manifest.edges = [{ from: "T-001", to: "MISSING", type: "depends_on" }];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const failure = await runCliExpectFailure(["package-draft", "quality", "--draft-root", draftRoot, "--json"], env);
    const result = JSON.parse(failure.stdout) as { ok: boolean; canvases: Array<{ graphQuality: { diagnostics: Array<{ code: string }> } }> };

    expect(failure.code).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.canvases[0]?.graphQuality.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "edge_to_missing" })]));
  }, 20_000);

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
      latestRuns: Array<{ tmuxSessionName: string | null; tmuxAttachCommand: string | null; tmuxReadOnlyAttachCommand: string | null }>;
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
    expect(status.latestRuns[0]).toMatchObject({
      tmuxSessionName: null,
      tmuxAttachCommand: null,
      tmuxReadOnlyAttachCommand: null
    });

    const text = (await runCli(["run-status"], env)).stdout;
    expect(text).toContain("latest record: T-001#B-001::RUN-001");
    expect(text).toContain("next action: Complete the manual step, then submit the result.");
  }, cliWorkflowTimeoutMs);

  it("creates CLI run and reset sessions that can be queried", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const run = JSON.parse((await runCli(["run", "--once", "--executor", "manual", "--scope", "block", "--block", "T-001#B-001", "--json"], env)).stdout) as {
      session: { sessionId: string; kind: string; phase: string; latestRecordId: string | null; scope: { kind: string; blockRef?: string } };
      steps: Array<{ kind: string }>;
      ok: boolean;
      terminalReason: string;
    };
    expect(run).toMatchObject({
      session: {
        sessionId: "SESSION-0001",
        kind: "run",
        phase: "manual",
        scope: { kind: "block", blockRef: "T-001#B-001" },
        latestRecordId: "T-001#B-001::RUN-001"
      },
      steps: [{ kind: "manual" }],
      ok: true,
      terminalReason: "manual"
    });

    const reset = JSON.parse((await runCli(["reset", "--force", "--reason", "  rerun acceptance  ", "--json"], env)).stdout) as {
      sessionId: string;
      statePath: string;
      reason: string | null;
      forced: boolean;
      session: { sessionId: string; kind: string; phase: string; reset: { reason: string | null } };
    };
    expect(reset).toMatchObject({
      sessionId: "SESSION-0002",
      reason: "rerun acceptance",
      forced: true,
      session: { sessionId: "SESSION-0002", kind: "reset", phase: "completed", reset: { reason: "rerun acceptance" } }
    });
    expect(reset.statePath).toContain("canvases/default/state.json");

    const taskRun = JSON.parse((await runCli(["run", "--once", "--executor", "manual", "--scope", "task", "--task", "T-001", "--json"], env)).stdout) as {
      session: { sessionId: string; kind: string; phase: string; latestRecordId: string | null; scope: { kind: string; taskId?: string } };
      steps: Array<{ kind: string }>;
      ok: boolean;
      terminalReason: string;
    };
    expect(taskRun).toMatchObject({
      session: {
        sessionId: "SESSION-0003",
        kind: "run",
        phase: "manual",
        scope: { kind: "task", taskId: "T-001" },
        latestRecordId: "T-001#B-001::RUN-002"
      },
      steps: [{ kind: "manual" }],
      ok: true,
      terminalReason: "manual"
    });

    const sessions = JSON.parse((await runCli(["run-sessions", "--json"], env)).stdout) as {
      sessions: Array<{ sessionId: string; kind: string }>;
      diagnostics: unknown[];
    };
    expect(sessions.diagnostics).toEqual([]);
    expect(sessions.sessions.map((session) => session.sessionId)).toEqual(["SESSION-0003", "SESSION-0002", "SESSION-0001"]);
    expect(sessions.sessions.map((session) => session.kind)).toEqual(["run", "reset", "run"]);

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
