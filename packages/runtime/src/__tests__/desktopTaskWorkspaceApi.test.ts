import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "../json.js";
import {
  getTaskWorkspace,
  taskWorkspaceAgentTimeSchema,
  taskWorkspaceAnnotationSchema,
  taskWorkspaceDependencyProgressSchema,
  taskWorkspaceInputSchema,
  taskWorkspaceSchema,
  taskWorkspaceWaitingInteractionSchema,
  taskWorkspaceWallClockSchema
} from "../desktop/index.js";
import { readState, writeState } from "../state.js";
import { claimNext, submitBlockResult, submitReviewResult } from "../taskManager/index.js";
import type { PlanPackageManifest } from "../types.js";
import {
  basicManifest,
  createTestWorkspace,
  writeReport,
  writeReviewResult
} from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
});

function parallelManifest(): PlanPackageManifest {
  const manifest = basicManifest({ parallel: true, maxConcurrent: 2 });
  const task = manifest.nodes[0];
  task.blocks.splice(1, 0, {
    id: "B-002",
    type: "implementation",
    title: "Implement parallel work",
    prompt: "nodes/T-001/blocks/B-002.prompt.md",
    depends_on: [],
    parallel: { locks: ["parallel"] }
  });
  const review = task.blocks[2];
  if (review?.type === "review") review.depends_on = ["B-001", "B-002"];
  return manifest;
}

async function writeBlockRun(options: {
  resultsDir: string;
  blockId: string;
  runId: string;
  startedAt?: string;
  finishedAt?: string | null;
  report?: string;
  executionWaveId?: string;
}): Promise<void> {
  const ref = `T-001#${options.blockId}`;
  const runDir = join(
    options.resultsDir,
    "T-001",
    "blocks",
    options.blockId,
    "runs",
    options.runId
  );
  await mkdir(runDir, { recursive: true });
  await writeJsonFile(join(runDir, "metadata.json"), {
    runId: options.runId,
    ref,
    executor: "codex",
    adapter: "codex-exec",
    startedAt: options.startedAt,
    finishedAt: options.finishedAt,
    executionWaveId: options.executionWaveId,
    exitCode: options.finishedAt ? 0 : null
  });
  if (options.report !== undefined) {
    await writeFile(join(runDir, "report.md"), options.report, "utf8");
  }
}

async function writeFeedbackRun(options: {
  resultsDir: string;
  runId: string;
  feedbackId: string;
  sourceReviewBlockRef: string;
  taskId: string;
}): Promise<void> {
  const runDir = join(options.resultsDir, "feedback-runs", options.runId);
  await mkdir(runDir, { recursive: true });
  await writeJsonFile(join(runDir, "metadata.json"), {
    runId: options.runId,
    feedbackId: options.feedbackId,
    sourceReviewBlockRef: options.sourceReviewBlockRef,
    taskId: options.taskId,
    finishedAt: "2026-07-13T00:00:01.000Z",
    exitCode: 0
  });
}

describe("desktop Task Workspace aggregate API", () => {
  it("uses graph order, deterministic retries, overlap-safe wall clock, and summed agent time", async () => {
    const { root, init } = await createTestWorkspace(parallelManifest());
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:10.000Z"
    });
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-002",
      runId: "RUN-002",
      startedAt: "2026-07-13T00:00:05.000Z",
      finishedAt: "2026-07-13T00:00:15.000Z",
      report: "latest artifact\n"
    });
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-003",
      startedAt: "2026-07-13T00:00:20.000Z",
      finishedAt: "2026-07-13T00:00:25.000Z"
    });

    const workspace = await getTaskWorkspace(
      { projectRoot: root, canvasId: "default", taskId: "T-001" },
      { now: new Date("2026-07-13T00:01:00.000Z") }
    );

    expect(taskWorkspaceSchema.parse(workspace)).toEqual(workspace);
    expect(workspace.blocks.map((block) => block.ref)).toEqual([
      "T-001#B-001",
      "T-001#B-002",
      "T-001#R-001"
    ]);
    expect(
      workspace.blocks[0]?.runs.map((item) => [item.retryIndex, item.run.record.runId])
    ).toEqual([
      [1, "RUN-001"],
      [2, "RUN-003"]
    ]);
    expect(workspace.duration.wallClock).toMatchObject({ available: true, totalMs: 25_000 });
    expect(workspace.duration.agentTime).toEqual({
      availability: "complete",
      totalMs: 25_000,
      includedRunCount: 3,
      missingRunCount: 0,
      reason: null
    });
    expect(workspace.latestArtifact).toMatchObject({
      recordId: "T-001#B-002::RUN-002",
      legacy: true,
      reference: null
    });
    expect(workspace.usage.taskTokens).toMatchObject({ available: false, totalTokens: null });
    expect(workspace.usage.taskCost).toMatchObject({ available: false, totals: null });
    expect(
      workspace.blocks
        .flatMap((block) => block.runs)
        .every((item) => item.run.executionWaveId === null)
    ).toBe(true);
  });

  it("marks only the latest unfinished current-ref run active and defaults selection to it", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: null
    });
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-002",
      startedAt: "2026-07-13T00:00:01.000Z",
      finishedAt: null
    });

    const workspace = await getTaskWorkspace(
      { projectRoot: root, canvasId: "default", taskId: "T-001" },
      { now: new Date("2026-07-13T00:00:11.000Z") }
    );

    expect(workspace.activeRecordIds).toEqual(["T-001#B-001::RUN-002"]);
    expect(workspace.selectedRecordId).toBe("T-001#B-001::RUN-002");
    expect(workspace.blocks[0]?.runs.map((item) => item.active)).toEqual([false, true]);
    expect(workspace.duration.wallClock.totalMs).toBe(11_000);
  });

  it("keeps Task Overview as the default when parallel blocks are both active", async () => {
    const { root, init } = await createTestWorkspace(parallelManifest());
    const state = await readState(init.workspace.stateFile);
    state.currentRefs = ["T-001#B-001", "T-001#B-002"];
    state.tasks["T-001"] = { status: "in_progress", openFeedbackCount: 0 };
    state.blocks["T-001#B-001"] = { status: "in_progress" };
    state.blocks["T-001#B-002"] = { status: "in_progress" };
    await writeState(init.workspace.stateFile, state);
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: null
    });
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-002",
      runId: "RUN-002",
      startedAt: "2026-07-13T00:00:01.000Z",
      finishedAt: null
    });

    const workspace = await getTaskWorkspace(
      { projectRoot: root, canvasId: "default", taskId: "T-001" },
      { now: new Date("2026-07-13T00:00:05.000Z") }
    );

    expect(workspace.activeRecordIds).toEqual(["T-001#B-001::RUN-001", "T-001#B-002::RUN-002"]);
    expect(workspace.selectedRecordId).toBeNull();
    expect(
      workspace.blocks.flatMap((block) => block.runs).filter((item) => item.selected)
    ).toHaveLength(0);
  });

  it("uses numeric run ordinals for missing and mixed start times and default selection", async () => {
    const { root, init } = await createTestWorkspace();
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-10"
    });
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-2"
    });

    const undated = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    expect(undated.blocks[0]?.runs.map((item) => item.run.record.runId)).toEqual([
      "RUN-2",
      "RUN-10"
    ]);
    expect(undated.selectedRecordId).toBe("T-001#B-001::RUN-10");

    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-3",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z"
    });
    const mixed = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    expect(mixed.blocks[0]?.runs.map((item) => item.run.record.runId)).toEqual([
      "RUN-2",
      "RUN-3",
      "RUN-10"
    ]);
    expect(mixed.selectedRecordId).toBe("T-001#B-001::RUN-10");
  });

  it("keeps review attempts, feedback, and feedback runs as explicitly unassociated annotations", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "implementation.md")
    });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Please revise this work.")
    });
    const feedbackRunDir = join(init.workspace.resultsDir, "feedback-runs", "RUN-FEEDBACK-001");
    await mkdir(feedbackRunDir, { recursive: true });
    await writeJsonFile(join(feedbackRunDir, "metadata.json"), {
      runId: "RUN-FEEDBACK-001",
      feedbackId: "FE-001",
      sourceReviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:01.000Z",
      exitCode: 0
    });
    await writeFile(join(feedbackRunDir, "feedback-report.md"), "Feedback applied.\n", "utf8");

    const workspace = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    const review = workspace.blocks.find((block) => block.type === "review");

    expect(review?.runs.every((item) => item.run.kind === "block")).toBe(true);
    expect(review?.annotations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "review_attempt",
          associatedRunRecordId: null,
          verdict: "needs_changes"
        }),
        expect.objectContaining({
          kind: "feedback",
          associatedRunRecordId: null,
          contentPreview: "Please revise this work."
        }),
        expect.objectContaining({
          kind: "feedback_run",
          associatedRunRecordId: null,
          recordId: "FE-001::RUN-FEEDBACK-001"
        })
      ])
    );
  });

  it("reports partial duration without inventing zero and rejects invalid input or foreign selection", async () => {
    const { root, init } = await createTestWorkspace();
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-001"
    });
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-002",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: "2026-07-13T00:00:02.000Z"
    });

    const workspace = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    expect(workspace.duration.agentTime).toMatchObject({
      availability: "partial",
      totalMs: 2_000,
      includedRunCount: 1,
      missingRunCount: 1
    });
    expect(() =>
      taskWorkspaceInputSchema.parse({
        projectRoot: root,
        canvasId: "default",
        taskId: "T-001",
        extra: true
      })
    ).toThrow();
    await expect(
      getTaskWorkspace({
        projectRoot: root,
        canvasId: "default",
        taskId: "T-001",
        selectedRecordId: "T-999#B-001::RUN-001"
      })
    ).rejects.toThrow("does not belong to task 'T-001'");
  });

  it("fails closed when a feedback run names an implementation Block as its source", async () => {
    const { root, init } = await createTestWorkspace();
    const feedbackRunDir = join(init.workspace.resultsDir, "feedback-runs", "RUN-INVALID-001");
    await mkdir(feedbackRunDir, { recursive: true });
    await writeJsonFile(join(feedbackRunDir, "metadata.json"), {
      runId: "RUN-INVALID-001",
      feedbackId: "FE-INVALID-001",
      sourceReviewBlockRef: "T-001#B-001",
      taskId: "T-001",
      finishedAt: "2026-07-13T00:00:01.000Z",
      exitCode: 0
    });

    await expect(
      getTaskWorkspace({ projectRoot: root, canvasId: "default", taskId: "T-001" })
    ).rejects.toThrow("must identify an existing Review Block");
  });

  it("fails closed when state feedback names an implementation Block as its source", async () => {
    const { root, init } = await createTestWorkspace();
    const state = await readState(init.workspace.stateFile);
    state.feedback["FE-INVALID-STATE"] = {
      status: "resolved",
      sourceReviewBlockRef: "T-001#B-001",
      latestSubmissionId: null,
      content: "Invalid source"
    };
    await writeState(init.workspace.stateFile, state);

    await expect(
      getTaskWorkspace({ projectRoot: root, canvasId: "default", taskId: "T-001" })
    ).rejects.toThrow("must identify an existing Review Block");
  });

  it("fails closed when a Task feedback run names a missing source Block", async () => {
    const { root, init } = await createTestWorkspace();
    await writeFeedbackRun({
      resultsDir: init.workspace.resultsDir,
      runId: "RUN-MISSING-BLOCK",
      feedbackId: "FE-MISSING-BLOCK",
      sourceReviewBlockRef: "T-001#MISSING",
      taskId: "T-001"
    });

    await expect(
      getTaskWorkspace({ projectRoot: root, canvasId: "default", taskId: "T-001" })
    ).rejects.toThrow("identifies a missing Block");
  });

  it("fails closed when feedback run taskId disagrees with its source ref", async () => {
    const { root, init } = await createTestWorkspace();
    await writeFeedbackRun({
      resultsDir: init.workspace.resultsDir,
      runId: "RUN-TASK-MISMATCH",
      feedbackId: "FE-TASK-MISMATCH",
      sourceReviewBlockRef: "T-001#R-001",
      taskId: "T-999"
    });

    await expect(
      getTaskWorkspace({ projectRoot: root, canvasId: "default", taskId: "T-001" })
    ).rejects.toThrow("taskId 'T-999' does not match sourceReviewBlockRef 'T-001#R-001'");
  });

  it("fails closed when Task state feedback names a missing source Block", async () => {
    const { root, init } = await createTestWorkspace();
    const state = await readState(init.workspace.stateFile);
    state.feedback["FE-MISSING-STATE-BLOCK"] = {
      status: "resolved",
      sourceReviewBlockRef: "T-001#MISSING",
      latestSubmissionId: null,
      content: "Missing source"
    };
    await writeState(init.workspace.stateFile, state);

    await expect(
      getTaskWorkspace({ projectRoot: root, canvasId: "default", taskId: "T-001" })
    ).rejects.toThrow("identifies a missing Block");
  });

  it("fails closed when Task state feedback names a missing task identity", async () => {
    const { root, init } = await createTestWorkspace();
    const state = await readState(init.workspace.stateFile);
    state.feedback["FE-STATE-TASK-MISMATCH"] = {
      status: "resolved",
      sourceReviewBlockRef: "T-002#R-001",
      latestSubmissionId: null,
      content: "Mismatched task source"
    };
    await writeState(init.workspace.stateFile, state);

    await expect(
      getTaskWorkspace({ projectRoot: root, canvasId: "default", taskId: "T-001" })
    ).rejects.toThrow("identifies missing Task 'T-002'");
  });

  it("rejects cross-field-inconsistent aggregate DTO values", async () => {
    expect(
      taskWorkspaceAnnotationSchema.safeParse({
        kind: "feedback",
        annotationId: "feedback:FE-001",
        sourceReviewBlockRef: "T-001#R-001",
        associatedRunRecordId: "T-001#R-001::RUN-001",
        feedbackId: "FE-001",
        status: "open",
        latestSubmissionId: null,
        contentPreview: "Feedback"
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceWallClockSchema.safeParse({
        available: false,
        startedAt: null,
        endedAt: null,
        calculatedAt: "2026-07-13T00:00:00.000Z",
        totalMs: 0,
        unavailableReason: "Missing start"
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceWallClockSchema.safeParse({
        available: true,
        startedAt: "2026-07-13T00:00:00.000Z",
        endedAt: "2026-07-13T00:00:01.000Z",
        calculatedAt: "2026-07-13T00:00:01.000Z",
        totalMs: 999,
        unavailableReason: null
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceAgentTimeSchema.safeParse({
        availability: "partial",
        totalMs: 100,
        includedRunCount: 1,
        missingRunCount: 0,
        reason: "Partial"
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceDependencyProgressSchema.safeParse({
        total: 1,
        completed: 2,
        percent: 100,
        status: "completed",
        blockers: []
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceDependencyProgressSchema.safeParse({
        total: 2,
        completed: 1,
        percent: 100,
        status: "completed",
        blockers: ["T-001#B-001"]
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceWaitingInteractionSchema.safeParse({
        active: false,
        count: 1,
        kinds: ["permission"]
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceWaitingInteractionSchema.safeParse({
        active: true,
        count: 0,
        kinds: []
      }).success
    ).toBe(false);

    const { root } = await createTestWorkspace();
    const workspace = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    expect(
      taskWorkspaceSchema.safeParse({ ...workspace, selectedRecordId: "missing::RUN-1" }).success
    ).toBe(false);
    expect(
      taskWorkspaceSchema.safeParse({ ...workspace, activeRecordIds: ["missing::RUN-1"] }).success
    ).toBe(false);
  });

  it("rejects an ACP canonical identity from a different project", async () => {
    const { root, init } = await createTestWorkspace();
    await writeBlockRun({
      resultsDir: init.workspace.resultsDir,
      blockId: "B-001",
      runId: "RUN-ACP-001",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: null
    });
    const runDir = join(
      init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-ACP-001"
    );
    await writeJsonFile(join(runDir, "metadata.json"), {
      runId: "RUN-ACP-001",
      ref: "T-001#B-001",
      executor: "codex-acp",
      adapter: "agent",
      runnerKind: "acp",
      agentId: "codex",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: null,
      exitCode: null
    });
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify({
        version: "planweave.runner-event/v1",
        sequence: 1,
        timestamp: "2026-07-13T00:00:00.000Z",
        identity: {
          projectId: "foreign-project",
          canvasId: "default",
          taskId: "T-001",
          blockId: "B-001",
          claimRef: "T-001#B-001",
          runId: "RUN-ACP-001",
          runOwner: "executor",
          runSessionId: null,
          desktopRunId: null,
          executorRunId: "RUN-ACP-001"
        },
        runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
        body: { kind: "lifecycle", state: "running", message: "Running" }
      })}\n`,
      "utf8"
    );

    await expect(
      getTaskWorkspace({ projectRoot: root, canvasId: "default", taskId: "T-001" })
    ).rejects.toThrow("does not match Task Workspace record");
  });
});
