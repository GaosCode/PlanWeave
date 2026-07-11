import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ExecutorPreflightCheck,
  ExecutorPreflightResult
} from "../autoRun/executorPreflightTypes.js";
import { testExecutorProfile } from "../autoRun/executors.js";
import { resolveTaskCanvasWorkspace } from "../desktop/index.js";
import { writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
import {
  claimNext,
  explainBlock,
  getCurrentWork,
  getExecutionStatus,
  submitBlockResult,
  submitFeedback,
  submitReviewResult
} from "../taskManager/index.js";
import {
  basicManifest,
  createTestWorkspace,
  writePromptFiles,
  writeReport,
  writeReviewResult
} from "./promptTestHelpers.js";

function preflightCheck(
  result: ExecutorPreflightResult,
  check: ExecutorPreflightCheck["check"]
): ExecutorPreflightCheck {
  const item = result.checks.find((candidate) => candidate.check === check);
  if (!item) {
    throw new Error(`Missing executor preflight check '${check}'.`);
  }
  return item;
}

async function createFormalManualCanvasWorkspace() {
  const { root, init } = await createTestWorkspace();
  const packageDir = join(init.workspace.workspaceRoot, "manual-canvas", "package");
  const manifest = basicManifest();
  await writeJsonFile(join(packageDir, "manifest.json"), manifest);
  await writePromptFiles(packageDir, manifest);
  await writeProjectGraph(init.workspace, {
    version: "plan-project/v1",
    canvases: [
      canonicalProjectCanvasNode({ id: "default", title: "Runtime" }),
      {
        id: "manual-canvas",
        type: "canvas",
        title: "Manual Canvas",
        packageDir: "manual-canvas/package",
        stateFile: "manual-canvas/state.json",
        resultsDir: "manual-canvas/results"
      }
    ],
    edges: [],
    crossTaskEdges: []
  });
  return { root, workspace: await resolveTaskCanvasWorkspace(root, "manual-canvas") };
}

describe("executor API helpers", () => {
  it("preflights manual executors without requiring a command", async () => {
    const { root } = await createTestWorkspace();

    const result = await testExecutorProfile({ projectRoot: root, executorName: "manual" });

    expect(result).toMatchObject({
      name: "manual",
      adapter: "manual",
      profileAdapter: "manual",
      executionIntegration: "manual",
      ok: true,
      checks: [
        { check: "profile_exists", status: "passed" },
        { check: "adapter_supported", status: "passed" },
        { check: "cwd_resolved", status: "passed" },
        { check: "command_started", status: "skipped" },
        { check: "command_version", status: "skipped" }
      ]
    });
  });

  it("preflights executor commands with the lightweight version check", async () => {
    const manifest = basicManifest();
    manifest.executors = {
      "node-version": {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["exec", "-"]
      }
    };
    const { root } = await createTestWorkspace(manifest);

    const result = await testExecutorProfile({ projectRoot: root, executorName: "node-version" });

    expect(result.ok).toBe(true);
    expect(result.adapter).toBe("codex-exec");
    expect(result.profileAdapter).toBe("agent");
    expect(result.executionIntegration).toBe("codex-exec");
    expect(preflightCheck(result, "command_started")).toMatchObject({
      status: "passed",
      command: process.execPath
    });
    expect(preflightCheck(result, "command_version")).toMatchObject({
      status: "passed",
      output: expect.stringContaining("v"),
      exitCode: 0
    });
  });

  it("reports missing executor profiles as a machine-readable failed check", async () => {
    const { root } = await createTestWorkspace();

    const result = await testExecutorProfile({
      projectRoot: root,
      executorName: "missing-profile"
    });

    expect(result).toMatchObject({
      name: "missing-profile",
      adapter: null,
      profileAdapter: null,
      executionIntegration: null,
      ok: false
    });
    expect(preflightCheck(result, "profile_exists")).toMatchObject({
      status: "failed",
      message: "Executor profile 'missing-profile' does not exist."
    });
    expect(preflightCheck(result, "command_started")).toMatchObject({
      status: "skipped"
    });
  });

  it("reports executor command spawn failures without running agent prompts", async () => {
    const manifest = basicManifest();
    manifest.executors = {
      missing: {
        adapter: "codex-exec",
        command: `planweave-missing-executor-${Date.now()}`,
        args: ["exec", "-"]
      }
    };
    const { root } = await createTestWorkspace(manifest);

    const result = await testExecutorProfile({ projectRoot: root, executorName: "missing" });

    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe("missing_command");
    expect(preflightCheck(result, "command_started")).toMatchObject({
      status: "failed",
      failureCode: "missing_command",
      command: manifest.executors.missing.command
    });
    expect(preflightCheck(result, "command_version")).toMatchObject({
      status: "skipped"
    });
  });

  it("reports executor version failures as a distinct failed check", async () => {
    const { root } = await createTestWorkspace();
    const command = join(root, "failing-version.js");
    await writeFile(
      command,
      "#!/usr/bin/env node\nconsole.error('version probe failed');\nprocess.exit(7);\n",
      "utf8"
    );
    await chmod(command, 0o755);
    const manifest = basicManifest();
    manifest.executors = {
      "bad-version": {
        adapter: "codex-exec",
        command,
        args: ["exec", "-"]
      }
    };
    const { root: projectRoot } = await createTestWorkspace(manifest);

    const result = await testExecutorProfile({ projectRoot, executorName: "bad-version" });

    expect(result.ok).toBe(false);
    expect(result.failureCode).toBe("initialization_failed");
    expect(preflightCheck(result, "command_started")).toMatchObject({
      status: "passed",
      command
    });
    expect(preflightCheck(result, "command_version")).toMatchObject({
      status: "failed",
      failureCode: "initialization_failed",
      output: "version probe failed",
      exitCode: 7
    });
  });

  it("classifies executable permission errors as initialization failures", async () => {
    const { root } = await createTestWorkspace();
    const command = join(root, "not-executable.js");
    await writeFile(command, "#!/usr/bin/env node\nconsole.log('never runs');\n", "utf8");
    await chmod(command, 0o644);
    const manifest = basicManifest();
    manifest.executors = {
      "permission-denied": {
        adapter: "codex-exec",
        command,
        args: ["exec", "-"]
      }
    };
    const { root: projectRoot } = await createTestWorkspace(manifest);

    const result = await testExecutorProfile({
      projectRoot,
      executorName: "permission-denied"
    });

    expect(result).toMatchObject({ ok: false, failureCode: "initialization_failed" });
    expect(preflightCheck(result, "command_started")).toMatchObject({
      status: "failed",
      failureCode: "initialization_failed",
      command
    });
    expect(preflightCheck(result, "command_version")).toMatchObject({ status: "skipped" });
  });

  it("fails executor version checks when preflight output exceeds the executor stdout limit", async () => {
    const { root } = await createTestWorkspace();
    const command = join(root, "noisy-version.js");
    await writeFile(
      command,
      "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(2048));\n",
      "utf8"
    );
    await chmod(command, 0o755);
    const manifest = basicManifest();
    manifest.executors = {
      "noisy-version": {
        adapter: "codex-exec",
        command,
        args: ["exec", "-"],
        maxStdoutBytes: 128,
        maxStderrBytes: 128
      }
    };
    const { root: projectRoot } = await createTestWorkspace(manifest);

    const result = await testExecutorProfile({ projectRoot, executorName: "noisy-version" });

    expect(result.ok).toBe(false);
    expect(preflightCheck(result, "command_started")).toMatchObject({
      status: "passed",
      command
    });
    expect(preflightCheck(result, "command_version")).toMatchObject({
      status: "failed",
      output: expect.stringContaining("stdout output truncated after 128 bytes"),
      exitCode: 1
    });
  });

  it("times out executor version checks quickly with a failed machine-readable check", async () => {
    const { root } = await createTestWorkspace();
    const command = join(root, "hanging-version.js");
    await writeFile(command, "#!/usr/bin/env node\nsetTimeout(() => {}, 60_000);\n", "utf8");
    await chmod(command, 0o755);
    const manifest = basicManifest();
    manifest.executors = {
      "hanging-version": {
        adapter: "codex-exec",
        command,
        args: ["exec", "-"]
      }
    };
    const { root: projectRoot } = await createTestWorkspace(manifest);

    const result = await testExecutorProfile({
      projectRoot,
      executorName: "hanging-version",
      versionTimeoutMs: 50
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("Command version check timed out after 50ms.");
    expect(preflightCheck(result, "command_started")).toMatchObject({
      status: "passed",
      command
    });
    expect(preflightCheck(result, "command_version")).toMatchObject({
      status: "failed",
      message: "Command version check timed out after 50ms.",
      timedOut: true,
      exitCode: 124
    });
  });

  it("previews claim-next without mutating state", async () => {
    const { root } = await createTestWorkspace(basicManifest({ parallel: true }));

    const preview = await claimNext({ projectRoot: root, parallel: true, dryRun: true });
    const status = await getExecutionStatus({ projectRoot: root });

    expect(preview).toEqual({
      kind: "batch",
      refs: ["T-001#B-001"],
      effectiveExecutors: {
        "T-001#B-001": "default"
      }
    });
    expect(status.currentRefs).toEqual([]);
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("ready");
  });

  it("explains why a block is or is not claimable", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ includeSecondTask: true, taskDependsOn: ["T-002"] })
    );

    const explanation = await explainBlock({ projectRoot: root, ref: "T-001#B-001" });

    expect(explanation).toMatchObject({
      ref: "T-001#B-001",
      ready: false,
      blockedByTasks: ["T-002"],
      recommendedCommand: null,
      submitCommand: "planweave submit-result --canvas default T-001#B-001 --report <report.md>"
    });
    expect(explanation.promptPath).toContain("nodes/T-001/blocks/B-001.prompt.md");
  });

  it("reports the current executable block with prompt and submit command", async () => {
    const { root } = await createTestWorkspace();

    await claimNext({ projectRoot: root });

    expect(await getCurrentWork({ projectRoot: root })).toMatchObject({
      currentRefs: ["T-001#B-001"],
      currentFeedbackId: null,
      owner: {
        canvasId: "default",
        taskIds: ["T-001"]
      },
      items: [
        {
          kind: "block",
          ref: "T-001#B-001",
          effectiveExecutor: "default",
          promptPath: expect.stringContaining("nodes/T-001/blocks/B-001.prompt.md"),
          reportPath: "<report.md>",
          submitCommand: "planweave submit-result --canvas default T-001#B-001 --report <report.md>"
        }
      ]
    });
  });

  it("reports review submit commands for current review blocks", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });
    await claimNext({ projectRoot: root });

    expect(await getCurrentWork({ projectRoot: root })).toMatchObject({
      currentRefs: ["T-001#R-001"],
      items: [
        {
          kind: "block",
          ref: "T-001#R-001",
          reportPath: "<review-result.json>",
          submitCommand:
            "planweave submit-review --canvas default T-001#R-001 --result <review-result.json>"
        }
      ]
    });
  });

  it("reports active feedback as executable current work", async () => {
    const manifest = basicManifest();
    manifest.executors = {
      codex: { adapter: "manual" },
      manual: { adapter: "manual" },
      opencode: { adapter: "manual" }
    };
    const task = manifest.nodes[0];
    if (task.type !== "task") {
      throw new Error("Expected a task node.");
    }
    task.executor = "codex";
    task.blocks[0].executor = "opencode";
    task.blocks[1].executor = "codex";
    const { root } = await createTestWorkspace(manifest);
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix the implementation.")
    });
    await claimNext({ projectRoot: root });

    expect(await getCurrentWork({ projectRoot: root })).toMatchObject({
      currentRefs: [],
      currentFeedbackId: "FE-001",
      owner: {
        canvasId: "default",
        taskIds: ["T-001"]
      },
      items: [
        {
          kind: "feedback",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          effectiveExecutor: "opencode",
          promptPath: expect.stringContaining("results/T-001/feedback/FE-001/feedback.json"),
          reportPath: "<feedback-report.md>",
          submitCommand: "planweave submit-feedback --canvas default --report <feedback-report.md>"
        }
      ]
    });
  });

  it("scopes current and explain submit commands for formal project graph canvases with arbitrary package paths", async () => {
    const { root, workspace } = await createFormalManualCanvasWorkspace();

    await claimNext({ projectRoot: workspace });

    await expect(
      explainBlock({ projectRoot: workspace, ref: "T-001#B-001" })
    ).resolves.toMatchObject({
      submitCommand:
        "planweave submit-result --canvas manual-canvas T-001#B-001 --report <report.md>"
    });
    await expect(getCurrentWork({ projectRoot: workspace })).resolves.toMatchObject({
      owner: {
        canvasId: "manual-canvas"
      },
      items: [
        {
          kind: "block",
          ref: "T-001#B-001",
          submitCommand:
            "planweave submit-result --canvas manual-canvas T-001#B-001 --report <report.md>"
        }
      ]
    });

    await submitBlockResult({
      projectRoot: workspace,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });
    await claimNext({ projectRoot: workspace });
    await submitReviewResult({
      projectRoot: workspace,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix formal canvas work.")
    });
    await claimNext({ projectRoot: workspace });

    await expect(getCurrentWork({ projectRoot: workspace })).resolves.toMatchObject({
      owner: {
        canvasId: "manual-canvas"
      },
      items: [
        {
          kind: "feedback",
          submitCommand:
            "planweave submit-feedback --canvas manual-canvas --report <feedback-report.md>"
        }
      ]
    });
  });

  it("does not report resolved feedback as executable current work", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix the implementation.")
    });
    await claimNext({ projectRoot: root });
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback.md", "Fixed implementation.\n")
    });

    const current = await getCurrentWork({ projectRoot: root });

    expect(current).toMatchObject({
      currentRefs: ["T-001#R-001"],
      currentFeedbackId: null,
      owner: {
        canvasId: "default",
        taskIds: ["T-001"]
      },
      items: [
        {
          kind: "block",
          ref: "T-001#R-001",
          reportPath: "<review-result.json>",
          submitCommand:
            "planweave submit-review --canvas default T-001#R-001 --result <review-result.json>"
        }
      ]
    });
    expect(current.items).toHaveLength(1);
  });

  it("explains review blocks as gates", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });

    expect(await explainBlock({ projectRoot: root, ref: "T-001#R-001" })).toMatchObject({
      reviewGate: {
        isGate: true,
        required: true,
        requiredReason: "Required review gate for task completion.",
        executorRole: "reviewer",
        needsChangesReturnsTo: ["T-001#B-001"]
      }
    });
  });

  it("explains optional review blocks as not claimable", async () => {
    const manifest = basicManifest();
    const task = manifest.nodes.find((node) => node.type === "task" && node.id === "T-001");
    const reviewBlock =
      task?.type === "task" ? task.blocks.find((block) => block.id === "R-001") : null;
    if (reviewBlock?.type !== "review") {
      throw new Error("missing review block");
    }
    reviewBlock.review.required = false;
    const { root } = await createTestWorkspace(manifest);

    const explanation = await explainBlock({ projectRoot: root, ref: "T-001#R-001" });

    expect(explanation).toMatchObject({
      ready: false,
      statusReason:
        "Optional review gate is not required and is not claimable; task can complete without it.",
      recommendedCommand: null,
      reviewGate: {
        required: false,
        requiredReason: "Optional review gate; not required for task completion."
      }
    });
  });
});
