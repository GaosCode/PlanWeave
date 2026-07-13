import { describe, expect, it } from "vitest";
import {
  defaultTimelineSelection,
  projectTaskWorkspaceTimeline
} from "../renderer/task-workspace/timeline";
import {
  parallelWaveId,
  reviewAnnotationFixture,
  singletonWaveId,
  timelineBlockFixture,
  timelineRunFixture,
  timelineWorkspaceFixture
} from "./helpers/taskWorkspaceTimelineFixture";

describe("Task Workspace timeline projection", () => {
  it("preserves graph block order and stabilizes retries by retry index then record id", () => {
    const secondRef = "T-001#B-002";
    const firstBlock = timelineBlockFixture({
      blockId: "B-002",
      runs: [
        timelineRunFixture(secondRef, "RUN-Z", { retryIndex: 2 }),
        timelineRunFixture(secondRef, "RUN-B", { retryIndex: 1 }),
        timelineRunFixture(secondRef, "RUN-A", { retryIndex: 1 })
      ]
    });
    const secondBlock = timelineBlockFixture({ blockId: "B-001" });

    const projection = projectTaskWorkspaceTimeline(
      timelineWorkspaceFixture([firstBlock, secondBlock])
    );

    expect(projection.blocks.map((block) => block.ref)).toEqual(["T-001#B-002", "T-001#B-001"]);
    expect(projection.blocks[0]?.runs.map((run) => run.runId)).toEqual(["RUN-A", "RUN-B", "RUN-Z"]);
    expect(projection.blocks[0]?.runs.map((run) => run.isRetry)).toEqual([false, false, true]);
  });

  it("marks only repeated non-null execution wave ids as parallel", () => {
    const firstRef = "T-001#B-001";
    const secondRef = "T-001#B-002";
    const workspace = timelineWorkspaceFixture([
      timelineBlockFixture({
        blockId: "B-001",
        runs: [
          timelineRunFixture(firstRef, "RUN-W1", { executionWaveId: parallelWaveId }),
          timelineRunFixture(firstRef, "RUN-LEGACY-1", { executionWaveId: null }),
          timelineRunFixture(firstRef, "RUN-SINGLE", { executionWaveId: singletonWaveId })
        ]
      }),
      timelineBlockFixture({
        blockId: "B-002",
        runs: [
          timelineRunFixture(secondRef, "RUN-W2", { executionWaveId: parallelWaveId }),
          timelineRunFixture(secondRef, "RUN-LEGACY-2", { executionWaveId: null })
        ]
      })
    ]);

    const runs = projectTaskWorkspaceTimeline(workspace).runs;

    expect(runs.filter((run) => run.executionWave?.waveId === parallelWaveId)).toHaveLength(2);
    expect(runs.find((run) => run.runId === "RUN-W1")?.executionWave).toMatchObject({
      index: 1,
      total: 2
    });
    expect(runs.find((run) => run.runId === "RUN-W2")?.executionWave).toMatchObject({
      index: 2,
      total: 2
    });
    expect(runs.find((run) => run.runId === "RUN-SINGLE")?.executionWave).toBeNull();
    expect(
      runs.filter((run) => run.runId.includes("LEGACY")).every((run) => run.executionWave === null)
    ).toBe(true);
  });

  it("derives waiting, active, failed and completed states while retaining retry identity", () => {
    const ref = "T-001#B-001";
    const block = timelineBlockFixture({
      blockId: "B-001",
      runs: [
        timelineRunFixture(ref, "RUN-WAIT", { active: true, finished: false, waiting: true }),
        timelineRunFixture(ref, "RUN-ACTIVE", { active: true, finished: false }),
        timelineRunFixture(ref, "RUN-FAILED", { exitCode: 1, retryIndex: 2 }),
        timelineRunFixture(ref, "RUN-DONE")
      ]
    });

    const runs = projectTaskWorkspaceTimeline(timelineWorkspaceFixture([block])).runs;

    expect(Object.fromEntries(runs.map((run) => [run.runId, run.status]))).toMatchObject({
      "RUN-WAIT": "waiting",
      "RUN-ACTIVE": "active",
      "RUN-FAILED": "failed",
      "RUN-DONE": "completed"
    });
    expect(runs.find((run) => run.runId === "RUN-FAILED")?.isRetry).toBe(true);
  });

  it("keeps review and feedback records as Review Block annotations instead of runs", () => {
    const ref = "T-001#R-001";
    const annotations = [
      reviewAnnotationFixture(ref),
      reviewAnnotationFixture(ref, "feedback"),
      reviewAnnotationFixture(ref, "feedback_run")
    ];
    const reviewBlock = timelineBlockFixture({
      annotations,
      blockId: "R-001",
      runs: [timelineRunFixture(ref, "RUN-REVIEW")],
      type: "review"
    });

    const projection = projectTaskWorkspaceTimeline(timelineWorkspaceFixture([reviewBlock]));

    expect(projection.runs.map((run) => run.runId)).toEqual(["RUN-REVIEW"]);
    expect(projection.blocks[0]?.annotations).toEqual(annotations);
  });

  it("selects history, active, block latest, then task first without live updates stealing history", () => {
    const firstRef = "T-001#B-001";
    const secondRef = "T-001#B-002";
    const history = timelineRunFixture(firstRef, "RUN-HISTORY", { retryIndex: 1 });
    const active = timelineRunFixture(secondRef, "RUN-ACTIVE", {
      active: true,
      finished: false,
      retryIndex: 1
    });
    const latest = timelineRunFixture(firstRef, "RUN-LATEST", { retryIndex: 2 });
    const workspace = timelineWorkspaceFixture([
      timelineBlockFixture({ blockId: "B-001", runs: [latest, history] }),
      timelineBlockFixture({ blockId: "B-002", runs: [active] })
    ]);

    expect(
      defaultTimelineSelection(workspace, { historyRecordId: history.run.record.recordId })
    ).toEqual({
      blockRef: firstRef,
      recordId: history.run.record.recordId
    });
    expect(defaultTimelineSelection(workspace)).toEqual({
      blockRef: secondRef,
      recordId: active.run.record.recordId
    });

    const inactiveWorkspace = timelineWorkspaceFixture([
      timelineBlockFixture({ blockId: "B-001", runs: [latest, history] }),
      timelineBlockFixture({ blockId: "B-002" })
    ]);
    expect(defaultTimelineSelection(inactiveWorkspace, { entryBlockRef: firstRef })).toEqual({
      blockRef: firstRef,
      recordId: latest.run.record.recordId
    });
    expect(defaultTimelineSelection(inactiveWorkspace)).toEqual({
      blockRef: firstRef,
      recordId: history.run.record.recordId
    });
    expect(defaultTimelineSelection(timelineWorkspaceFixture([]))).toBeNull();
  });
});
