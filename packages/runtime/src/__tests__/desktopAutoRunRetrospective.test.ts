import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAutoRunRetrospective,
  getLatestAutoRunSummary,
  getLatestAutoRunRetrospective,
  listAutoRunEvents,
  startAutoRun,
  stopAutoRun
} from "../desktop/index.js";
import { createAutoRunExplanation } from "../taskManager/autoRun.js";
import type { DesktopAutoRunState } from "../desktop/index.js";
import type { ProjectWorkspace } from "../types.js";
import { writeJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

const startedRunIds = new Set<string>();
const noTmux = { tmuxEnabled: false } as const;

afterEach(async () => {
  await Promise.all([...startedRunIds].map((runId) => stopAutoRun(runId).catch(() => undefined)));
  startedRunIds.clear();
  delete process.env.PLANWEAVE_HOME;
});

async function waitForRunSummary(
  projectRoot: string,
  canvasId: string | null,
  runId: string,
  predicate: (state: NonNullable<Awaited<ReturnType<typeof getLatestAutoRunSummary>>>) => boolean
) {
  let state = await getLatestAutoRunSummary(projectRoot, canvasId);
  for (
    let attempt = 0;
    attempt < 500 && (!state || state.runId !== runId || !predicate(state));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await getLatestAutoRunSummary(projectRoot, canvasId);
  }
  if (!state || state.runId !== runId) {
    throw new Error(`Auto Run '${runId}' was not the latest summary.`);
  }
  return state;
}

async function writeAutoRunState(state: DesktopAutoRunState): Promise<void> {
  await mkdir(dirname(state.statePath), { recursive: true });
  await writeJsonFile(state.statePath, state);
}

async function writeAutoRunEvents(
  state: DesktopAutoRunState,
  lines: Array<Record<string, unknown>>
): Promise<void> {
  await mkdir(dirname(state.eventLogPath), { recursive: true });
  await writeFile(
    state.eventLogPath,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
}

function persistedState(
  workspace: ProjectWorkspace,
  patch: Partial<Omit<DesktopAutoRunState, "explanation">> = {}
): DesktopAutoRunState {
  const runId = patch.runId ?? "DESKTOP-RUN-1001";
  const runRoot = join(workspace.resultsDir, "auto-runs", runId);
  const base = {
    runId,
    projectRoot: workspace.rootPath,
    canvasId: null,
    scope: { kind: "project" },
    phase: "completed",
    stepCount: 1,
    stepLimit: 20,
    currentRef: null,
    currentExecutor: "fake-codex",
    elapsedMs: 1000,
    latestOutputSummary: "done",
    latestRecordId: "T-001#B-001::RUN-001",
    latestRecordPath: join(
      workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs",
      "RUN-001",
      "metadata.json"
    ),
    statePath: join(runRoot, "state.json"),
    eventLogPath: join(runRoot, "events.ndjson"),
    options: { tmuxEnabled: false },
    error: null,
    startedAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:01.000Z",
    ...patch
  } satisfies Omit<DesktopAutoRunState, "explanation">;
  return {
    ...base,
    explanation: createAutoRunExplanation({
      phase: base.phase,
      currentRef: base.currentRef,
      currentExecutor: base.currentExecutor,
      latestRecordId: base.latestRecordId,
      latestRecordPath: base.latestRecordPath,
      latestOutputSummary: base.latestOutputSummary,
      error: base.error
    })
  };
}

describe("desktop auto run retrospective API", () => {
  it("summarizes a completed run from persisted state, event log, and records", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('retrospective implementation ' + input.split('\\n')[0]); });"
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
            "  content: 'retrospective review passed'",
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

    const run = await startAutoRun(root, null, { kind: "project" }, 5, noTmux);
    startedRunIds.add(run.runId);
    const state = await waitForRunSummary(
      root,
      null,
      run.runId,
      (nextState) => nextState.phase !== "running"
    );
    expect(state.phase).toBe("completed");

    const eventLog = await listAutoRunEvents(root, null, run.runId);
    expect(eventLog.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "step_finish",
          data: expect.objectContaining({
            stepKind: "submitted",
            claimRefs: ["T-001#B-001"],
            completedRefs: ["T-001#B-001"],
            recordId: "T-001#B-001::RUN-001",
            recordPath: expect.stringContaining("metadata.json"),
            reviewAttemptId: null,
            reviewVerdict: null
          })
        }),
        expect.objectContaining({
          type: "step_finish",
          data: expect.objectContaining({
            stepKind: "submitted",
            claimRefs: ["T-001#R-001"],
            completedRefs: ["T-001#R-001"],
            recordId: "T-001#R-001::RUN-001",
            recordPath: expect.stringContaining("metadata.json"),
            reviewAttemptId: "REV-001",
            reviewVerdict: "passed"
          })
        })
      ])
    );

    const summary = await getAutoRunRetrospective(root, null, run.runId);

    expect(summary).toMatchObject({
      runId: run.runId,
      projectRoot: root,
      canvasId: null,
      phase: "completed",
      stepCount: state.stepCount,
      completedBlockRefs: ["T-001#B-001", "T-001#R-001"],
      blockedRef: null,
      failedReason: null,
      latestRecordId: "T-001#R-001::RUN-001",
      latestRecordPath: expect.stringContaining(
        join("T-001", "blocks", "R-001", "runs", "RUN-001", "metadata.json")
      ),
      latestReportPath: null,
      nextAction: {
        kind: "review_status"
      },
      diagnostics: []
    });
    expect(summary.reviewVerdicts).toEqual([
      {
        ref: "T-001#R-001",
        attemptId: "REV-001",
        verdict: "passed",
        contentPreview: "retrospective review passed"
      }
    ]);
    await expect(getLatestAutoRunRetrospective(root, null)).resolves.toMatchObject({
      runId: run.runId
    });
  });

  it("returns blocked failure facts and actionable ref without requiring a record", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("throws", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "process.exit(2);"]
      })
      .withDefaultExecutor("throws")
      .build();
    const { root } = await createTestWorkspace(manifest);

    const run = await startAutoRun(root, null, { kind: "project" }, 5, noTmux);
    startedRunIds.add(run.runId);
    const state = await waitForRunSummary(
      root,
      null,
      run.runId,
      (nextState) => nextState.phase !== "running"
    );
    expect(state.phase).toBe("blocked");

    const summary = await getAutoRunRetrospective(root, null, run.runId);

    expect(summary).toMatchObject({
      phase: "blocked",
      completedBlockRefs: [],
      blockedRef: "T-001#B-001",
      failedReason: expect.stringContaining("exited with code 2"),
      latestRecordId: "T-001#B-001::RUN-001",
      nextAction: {
        kind: "inspect_record",
        ref: "T-001#B-001"
      }
    });
  });

  it("keeps old event logs readable and diagnoses missing claim refs without inventing completed refs", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const state = persistedState(init.workspace);
    await writeAutoRunState(state);
    await writeAutoRunEvents(state, [
      {
        timestamp: "2026-06-23T00:00:00.000Z",
        runId: state.runId,
        type: "step_finish",
        phase: "completed",
        stepCount: 1,
        currentRef: "T-001#B-001",
        stepKind: "submitted"
      }
    ]);

    const summary = await getAutoRunRetrospective(root, null, state.runId);

    expect(summary.completedBlockRefs).toEqual([]);
    expect(summary.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "auto_run_retrospective_missing_completed_refs",
          message: expect.stringContaining("completedBlockRefs were not inferred")
        })
      ])
    );
  });

  it("reports corrupt requested Auto Run state diagnostics", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const state = persistedState(init.workspace, { runId: "DESKTOP-RUN-2001", projectRoot: root });
    await mkdir(dirname(state.statePath), { recursive: true });
    await writeFile(state.statePath, "{", "utf8");

    await expect(getAutoRunRetrospective(root, null, state.runId)).rejects.toThrow(
      "auto_run_state_invalid_json"
    );
  });

  it("includes skipped corrupt latest state diagnostics in latest retrospective", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const valid = persistedState(init.workspace, { runId: "DESKTOP-RUN-2002", projectRoot: root });
    const corrupt = persistedState(init.workspace, {
      runId: "DESKTOP-RUN-2003",
      projectRoot: root
    });
    await writeAutoRunState(valid);
    await writeAutoRunEvents(valid, []);
    await mkdir(dirname(corrupt.statePath), { recursive: true });
    await writeFile(corrupt.statePath, "{", "utf8");

    const summary = await getLatestAutoRunRetrospective(root, null);

    expect(summary).toMatchObject({
      runId: valid.runId,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "auto_run_state_invalid_json",
          path: corrupt.statePath
        })
      ])
    });
  });

  it("keeps the latest effective run when a newer Auto Run has no claimable work", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const effective = persistedState(init.workspace, {
      runId: "DESKTOP-RUN-2101",
      runSessionId: "SESSION-0001",
      projectRoot: root,
      stepCount: 4,
      elapsedMs: 164_000,
      updatedAt: "2026-06-23T00:02:44.000Z"
    });
    const noWork = persistedState(init.workspace, {
      runId: "DESKTOP-RUN-2102",
      runSessionId: "SESSION-0002",
      projectRoot: root,
      stepCount: 0,
      elapsedMs: 37,
      latestOutputSummary: "no_claimable_blocks",
      latestRecordId: null,
      latestRecordPath: null,
      updatedAt: "2026-06-23T00:03:00.037Z"
    });
    await writeAutoRunState(effective);
    await writeAutoRunEvents(effective, []);
    await writeAutoRunState(noWork);
    await writeAutoRunEvents(noWork, []);

    await expect(getLatestAutoRunRetrospective(root, null)).resolves.toMatchObject({
      runId: effective.runId,
      runSessionId: "SESSION-0001",
      stepCount: 4,
      elapsedMs: 164_000
    });
  });

  it("does not count feedback-only or needs-changes review steps as completed blocks", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const state = persistedState(init.workspace, {
      phase: "manual",
      currentRef: "T-001#R-001",
      latestRecordId: null,
      latestRecordPath: null,
      error: "Manual feedback pending."
    });
    await writeAutoRunState(state);
    await writeAutoRunEvents(state, [
      {
        timestamp: "2026-06-23T00:00:00.000Z",
        runId: state.runId,
        type: "step_finish",
        phase: "manual",
        stepCount: 1,
        currentRef: "T-001#R-001",
        stepKind: "submitted",
        claimRefs: ["T-001#R-001"],
        completedRefs: [],
        reviewAttemptId: "REV-001",
        reviewVerdict: "needs_changes"
      },
      {
        timestamp: "2026-06-23T00:00:01.000Z",
        runId: state.runId,
        type: "step_finish",
        phase: "manual",
        stepCount: 2,
        currentRef: null,
        stepKind: "submitted",
        claimRefs: ["T-001#R-001"],
        completedRefs: []
      }
    ]);

    const summary = await getAutoRunRetrospective(root, null, state.runId);

    expect(summary.completedBlockRefs).toEqual([]);
  });

  it("uses the review attempt id recorded in the Auto Run event", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const state = persistedState(init.workspace, {
      latestRecordId: "T-001#R-001::RUN-001",
      latestRecordPath: join(
        init.workspace.resultsDir,
        "T-001",
        "blocks",
        "R-001",
        "runs",
        "RUN-001",
        "metadata.json"
      )
    });
    const attemptRoot = join(init.workspace.resultsDir, "T-001", "reviews", "R-001", "attempts");
    await mkdir(join(attemptRoot, "REV-001"), { recursive: true });
    await mkdir(join(attemptRoot, "REV-002"), { recursive: true });
    await writeJsonFile(join(attemptRoot, "REV-001", "review-result.json"), {
      reviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      verdict: "passed",
      content: "first run review"
    });
    await writeJsonFile(join(attemptRoot, "REV-002", "review-result.json"), {
      reviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      verdict: "needs_changes",
      content: "future review"
    });
    await writeAutoRunState(state);
    await writeAutoRunEvents(state, [
      {
        timestamp: "2026-06-23T00:00:00.000Z",
        runId: state.runId,
        type: "step_finish",
        phase: "completed",
        stepCount: 1,
        currentRef: "T-001#R-001",
        stepKind: "submitted",
        claimRefs: ["T-001#R-001"],
        completedRefs: ["T-001#R-001"],
        reviewAttemptId: "REV-001",
        reviewVerdict: "passed"
      }
    ]);

    const summary = await getAutoRunRetrospective(root, null, state.runId);

    expect(summary.reviewVerdicts).toEqual([
      {
        ref: "T-001#R-001",
        attemptId: "REV-001",
        verdict: "passed",
        contentPreview: "first run review"
      }
    ]);
  });
});
