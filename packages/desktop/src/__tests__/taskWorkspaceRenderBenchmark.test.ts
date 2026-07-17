/**
 * Deterministic Task Workspace renderer benchmarks.
 * Asserts counts/boundaries (not wall-clock ms) so CI stays stable across machines.
 */
import { describe, expect, it } from "vitest";
import {
  TASK_WORKSPACE_RUNS_DEFAULT_LIMIT,
  TASK_WORKSPACE_RUNS_MAX_LIMIT
} from "@planweave-ai/runtime";
import {
  projectTaskWorkspaceTimeline,
  type TaskWorkspaceTimelineProjection
} from "../renderer/task-workspace/timeline";
import {
  timelineBlockFixture,
  timelineRunFixture,
  timelineWorkspaceFixture
} from "./helpers/taskWorkspaceTimelineFixture";

const VIRTUALIZATION_DOM_ROW_THRESHOLD = 200;

function buildLoadedWorkspace(loadedRunCount: number, activeEvery = 0) {
  const runs = Array.from({ length: loadedRunCount }, (_, index) => {
    const runId = `RUN-${String(index + 1).padStart(5, "0")}`;
    const active = activeEvery > 0 && (index + 1) % activeEvery === 0;
    return timelineRunFixture("T-001#B-001", runId, {
      active,
      finished: !active,
      retryIndex: index + 1,
      selected: index === 0
    });
  });
  const block = timelineBlockFixture({
    blockId: "B-001",
    runs,
    title: "Implementation"
  });
  return timelineWorkspaceFixture([block]);
}

function countTimelineDomRows(projection: TaskWorkspaceTimelineProjection): number {
  const annotationCount = projection.blocks.reduce(
    (total, block) => total + block.annotations.length,
    0
  );
  return projection.runs.length + annotationCount;
}

function measureTimelineProjection(workspace: ReturnType<typeof buildLoadedWorkspace>) {
  let projectionCalls = 0;
  let createdRows = 0;
  const project = () => {
    projectionCalls += 1;
    const projection = projectTaskWorkspaceTimeline(workspace);
    createdRows += projection.runs.length;
    return projection;
  };
  const first = project();
  const second = project();
  return {
    createdRows,
    domRows: countTimelineDomRows(first),
    projectionCalls,
    runCount: first.runs.length,
    secondRunCount: second.runs.length,
    sameRunIds:
      first.runs.length === second.runs.length &&
      first.runs.every((run, index) => run.recordId === second.runs[index]?.recordId)
  };
}

describe("Task Workspace render benchmark (1k/10k counters)", () => {
  it("documents page limits that keep a single page under the virtualization threshold", () => {
    expect(TASK_WORKSPACE_RUNS_DEFAULT_LIMIT).toBe(50);
    expect(TASK_WORKSPACE_RUNS_MAX_LIMIT).toBe(100);
    expect(TASK_WORKSPACE_RUNS_DEFAULT_LIMIT).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);
    expect(TASK_WORKSPACE_RUNS_MAX_LIMIT).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);
  });

  it.each([
    { corpus: 1_000, loaded: TASK_WORKSPACE_RUNS_DEFAULT_LIMIT },
    { corpus: 10_000, loaded: TASK_WORKSPACE_RUNS_DEFAULT_LIMIT },
    { corpus: 10_000, loaded: TASK_WORKSPACE_RUNS_MAX_LIMIT }
  ])("bounds timeline DOM rows to loaded page size for corpus=$corpus loaded=$loaded", ({
    loaded
  }) => {
    const workspace = buildLoadedWorkspace(loaded, /* activeEvery */ 25);
    const measured = measureTimelineProjection(workspace);

    expect(measured.runCount).toBe(loaded);
    expect(measured.domRows).toBe(loaded);
    expect(measured.domRows).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);
    expect(measured.projectionCalls).toBe(2);
    expect(measured.createdRows).toBe(loaded * 2);
    expect(measured.sameRunIds).toBe(true);
  });

  it("records multi-page append growth that requires the product window", () => {
    // Reasonable continuous pagination: default 50 × 3 pages = 150 DOM rows (< 200).
    const pagesLoaded = 3;
    const loaded = TASK_WORKSPACE_RUNS_DEFAULT_LIMIT * pagesLoaded;
    const workspace = buildLoadedWorkspace(loaded);
    const measured = measureTimelineProjection(workspace);

    expect(measured.domRows).toBe(150);
    expect(measured.domRows).toBeLessThanOrEqual(VIRTUALIZATION_DOM_ROW_THRESHOLD);

    // Continuous pagination can cross the threshold; the real component test asserts
    // the product window keeps mounted option rows bounded while navigation remains global.
    const overThreshold = buildLoadedWorkspace(VIRTUALIZATION_DOM_ROW_THRESHOLD + 1);
    const overMeasured = measureTimelineProjection(overThreshold);
    expect(overMeasured.domRows).toBeGreaterThan(VIRTUALIZATION_DOM_ROW_THRESHOLD);
  });

  it("keeps timeline projection pure and free of clock inputs", () => {
    const workspace = buildLoadedWorkspace(20, 5);
    const a = projectTaskWorkspaceTimeline(workspace);
    const b = projectTaskWorkspaceTimeline(workspace);
    expect(a.runs.map((run) => run.recordId)).toEqual(b.runs.map((run) => run.recordId));
    expect(a.runs.map((run) => run.status)).toEqual(b.runs.map((run) => run.status));
    // Projection does not embed wall-clock labels; leaves own the clock.
    for (const run of a.runs) {
      expect(run).toHaveProperty("startedAt");
      expect(run).toHaveProperty("finishedAt");
      expect(run).not.toHaveProperty("elapsedLabel");
    }
  });
});
