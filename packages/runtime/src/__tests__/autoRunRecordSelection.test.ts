import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAutoRunStatus, claimNext } from "../index.js";
import { consumeAutoRunClaim } from "../autoRun/contract.js";
import type { AutoRunExecutorAdapter } from "../autoRun/contract.js";
import { writeJsonFile } from "../json.js";
import { createAutoRunExplanation } from "../taskManager/autoRun.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { runContractAutoRunStep, waitForAutoRunStatus } from "./autoRunTestBuilders.js";

function adapter(): AutoRunExecutorAdapter {
  return {
    executeBlock: async (claim) => ({
      kind: claim.blockType === "review" ? "review_result" : "block_report",
      ref: claim.ref,
      artifactPath: `${claim.ref}.md`
    }),
    handleFeedback: async (claim) => ({
      kind: "feedback_report",
      artifactPath: `${claim.content}.md`
    })
  };
}

describe("Auto Run record selection", () => {
  it("recognizes only the canonical feedback execution basename", async () => {
    const { root, init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "feedback-runs", "RUN-001");
    await mkdir(runDir, { recursive: true });
    await writeJsonFile(join(runDir, "metadata.json"), {
      runId: "RUN-001",
      feedbackId: "FE-001",
      sourceReviewBlockRef: "T-001#R-001",
      taskId: "T-001"
    });
    await writeFile(join(runDir, "report.md"), "obsolete feedback artifact\n", "utf8");

    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      latestRuns: expect.arrayContaining([
        expect.objectContaining({ kind: "feedback", status: "in_progress", reportPath: null })
      ])
    });

    await writeFile(join(runDir, "feedback-report.md"), "canonical feedback artifact\n", "utf8");
    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      latestRuns: expect.arrayContaining([
        expect.objectContaining({
          kind: "feedback",
          status: "resolved",
          reportPath: expect.stringContaining("feedback-report.md")
        })
      ])
    });
  });

  it("derives a block ref for failed nextAction from the latest record id when current ref is absent", () => {
    const explanation = createAutoRunExplanation({
      phase: "failed",
      currentRef: null,
      currentExecutor: "fake-codex",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/tmp/metadata.json",
      latestOutputSummary: "executor failed",
      error: "executor failed"
    });

    expect(explanation.nextAction).toMatchObject({
      kind: "inspect_record",
      ref: "T-001#B-001",
      targetPath: "/tmp/metadata.json"
    });
  });

  it("selects timestamped latest run records ahead of timestampless run ids", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    const oldRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-999"
    );
    const latestRunDir = join(
      init.workspace.resultsDir,
      "T-002",
      "blocks",
      "B-001",
      "runs",
      "RUN-001"
    );
    await mkdir(oldRunDir, { recursive: true });
    await mkdir(latestRunDir, { recursive: true });
    await writeJsonFile(join(oldRunDir, "metadata.json"), {
      runId: "RUN-999",
      ref: "T-001#B-001",
      executor: "codex",
      adapter: "codex-exec"
    });
    await writeJsonFile(join(latestRunDir, "metadata.json"), {
      runId: "RUN-001",
      ref: "T-002#B-001",
      executor: "opencode",
      adapter: "opencode-exec",
      finishedAt: "2026-05-23T02:00:00.000Z"
    });
    await writeJsonFile(join(latestRunDir, "heartbeat.json"), {
      status: "finished",
      pid: 23456,
      lastHeartbeatAt: "2026-05-23T01:59:59.000Z",
      finishedAt: "2026-05-23T02:00:00.000Z",
      exitCode: 0
    });

    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      explanation: {
        latestRecordId: "T-002#B-001::RUN-001",
        currentExecutor: "default"
      },
      latestRuns: expect.arrayContaining([
        expect.objectContaining({
          ref: "T-002#B-001",
          heartbeatStatus: "finished",
          heartbeatPid: 23456,
          lastHeartbeatAt: "2026-05-23T01:59:59.000Z",
          lastActivityAt: expect.any(String)
        })
      ])
    });
  });

  it("selects the current block run for run-status explanation before unrelated global latest records", async () => {
    const { root, init } = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    await claimNext({ projectRoot: root });
    const currentRunDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-001"
    );
    const unrelatedRunDir = join(
      init.workspace.resultsDir,
      "T-002",
      "blocks",
      "B-001",
      "runs",
      "RUN-001"
    );
    await mkdir(currentRunDir, { recursive: true });
    await mkdir(unrelatedRunDir, { recursive: true });
    await writeJsonFile(join(currentRunDir, "metadata.json"), {
      runId: "RUN-001",
      ref: "T-001#B-001",
      executor: "codex",
      adapter: "codex-exec",
      startedAt: "2026-05-23T01:00:00.000Z"
    });
    await writeJsonFile(join(unrelatedRunDir, "metadata.json"), {
      runId: "RUN-001",
      ref: "T-002#B-001",
      executor: "opencode",
      adapter: "opencode-exec",
      startedAt: "2026-05-23T02:00:00.000Z"
    });

    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      explanation: {
        phase: "running",
        currentRef: "T-001#B-001",
        latestRecordId: "T-001#B-001::RUN-001",
        currentExecutor: "codex"
      }
    });
  });

  it("routes Claim Result branches to an executor adapter without duplicating Task Manager state decisions", async () => {
    await expect(
      consumeAutoRunClaim(
        {
          kind: "block",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          blockType: "implementation",
          effectiveExecutor: "default"
        },
        adapter()
      )
    ).resolves.toEqual({
      kind: "submit_result",
      ref: "T-001#B-001",
      reportPath: "T-001#B-001.md"
    });
    await expect(
      consumeAutoRunClaim(
        {
          kind: "feedback",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          content: "fix",
          effectiveExecutor: "default"
        },
        adapter()
      )
    ).resolves.toEqual({
      kind: "submit_feedback",
      reportPath: "fix.md"
    });
    await expect(consumeAutoRunClaim({ kind: "none", reason: "done" }, adapter())).resolves.toEqual(
      {
        kind: "stop",
        reason: "done"
      }
    );
    await expect(
      consumeAutoRunClaim({ kind: "blocked", ref: "T-001#R-001", reason: "hook failed" }, adapter())
    ).resolves.toEqual({
      kind: "blocked",
      ref: "T-001#R-001",
      reason: "hook failed"
    });
  });

  it("reports runner status with executor, stdio summaries, state changes, and failure reason", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.error('stderr detail'); console.log('stdout report for ' + input.split('\\n')[0]); });"
        ]
      })
      .withExecutor("fake-local-review", {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          [
            "const result = {",
            "  reviewBlockRef: process.env.PLANWEAVE_REVIEW_BLOCK_REF,",
            "  taskId: process.env.PLANWEAVE_TASK_ID,",
            "  verdict: 'passed',",
            "  content: 'review passed after implementation'",
            "};",
            "console.log(JSON.stringify(result));"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-codex")
      .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "fake-codex" }))
      .withBlock("T-001", "R-001", (block) => ({ ...block, executor: "fake-local-review" }))
      .build();
    const { root } = await createTestWorkspace(manifest);

    await runContractAutoRunStep({ projectRoot: root });

    const implementationStatus = await getAutoRunStatus({ projectRoot: root });
    expect(implementationStatus).toMatchObject({
      current: {
        refs: [],
        feedbackId: null,
        reviewBlockRef: null
      },
      explanation: {
        phase: "idle",
        currentRef: null,
        currentExecutor: "fake-local-review",
        latestRecordId: "T-001#B-001::RUN-001",
        latestRecordPath: expect.stringContaining("metadata.json"),
        latestOutputSummary: expect.stringContaining("stderr detail"),
        error: null,
        nextAction: {
          kind: "start",
          command: null,
          ref: "T-001#R-001",
          message: "Continue Auto Run; claimable work is ready: T-001#R-001."
        }
      },
      latestRuns: [
        {
          ref: "T-001#B-001",
          executor: "fake-codex",
          adapter: "codex-exec",
          status: "completed",
          startedAt: expect.any(String),
          finishedAt: expect.any(String),
          stdoutSummary: expect.stringContaining("stdout report"),
          stderrSummary: expect.stringContaining("stderr detail"),
          failureReason: null
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await runContractAutoRunStep({ projectRoot: root });

    const reviewStatus = await getAutoRunStatus({ projectRoot: root });
    expect(reviewStatus.latestRuns.map((run) => run.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
    expect(reviewStatus).toMatchObject({
      explanation: {
        phase: "completed",
        currentRef: null,
        currentExecutor: "fake-local-review",
        latestRecordId: "T-001#R-001::RUN-001",
        latestRecordPath: expect.stringContaining(
          join("T-001", "blocks", "R-001", "runs", "RUN-001", "metadata.json")
        ),
        latestOutputSummary: expect.stringContaining("reviewBlockRef"),
        error: null,
        nextAction: {
          kind: "review_status",
          message: "Review the final status and latest run record."
        }
      }
    });
  });

  it("keeps the latest explanation record on an automatically submitted feedback run", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('feedback report for ' + input.split('\\n')[0]); });"
        ]
      })
      .withExecutor("needs-review", {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          [
            "const result = {",
            "  reviewBlockRef: process.env.PLANWEAVE_REVIEW_BLOCK_REF,",
            "  taskId: process.env.PLANWEAVE_TASK_ID,",
            "  verdict: 'needs_changes',",
            "  content: 'fix the implementation'",
            "};",
            "console.log(JSON.stringify(result));"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-codex")
      .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "fake-codex" }))
      .withBlock("T-001", "R-001", (block) => ({ ...block, executor: "needs-review" }))
      .build();
    const { root } = await createTestWorkspace(manifest);

    await runContractAutoRunStep({ projectRoot: root });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runContractAutoRunStep({ projectRoot: root });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runContractAutoRunStep({ projectRoot: root });

    const status = await waitForAutoRunStatus(root, (currentStatus) =>
      currentStatus.latestRuns.some(
        (run) =>
          run.kind === "feedback" &&
          run.feedbackId === "FE-001" &&
          run.sourceReviewBlockRef === "T-001#R-001" &&
          run.status === "resolved"
      )
    );
    expect(status.latestRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "feedback",
          ref: "FE-001",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          status: "resolved",
          metadataPath: expect.stringContaining(join("feedback-runs", "RUN-001", "metadata.json"))
        })
      ])
    );
    expect(status).toMatchObject({
      current: {
        refs: ["T-001#R-001"],
        feedbackId: null,
        reviewBlockRef: "T-001#R-001"
      },
      explanation: {
        phase: "idle",
        currentRef: "T-001#R-001",
        currentExecutor: "needs-review",
        latestRecordId: "FE-001::RUN-001",
        latestRecordPath: expect.stringContaining(
          join("feedback-runs", "RUN-001", "metadata.json")
        ),
        latestOutputSummary: expect.stringContaining("feedback report"),
        nextAction: {
          kind: "start",
          ref: "T-001#R-001"
        }
      }
    });
    expect(status.explanation.nextAction.kind).not.toBe("wait");
  });
});
