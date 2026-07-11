import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAutoRunState,
  getLatestAutoRunSummary,
  listAutoRunEvents,
  pauseAutoRun,
  resetDesktopRuntimeState,
  resumeAutoRun,
  startAutoRun,
  stopAutoRun
} from "../desktop/index.js";
import type { DesktopAutoRunPhase } from "../desktop/index.js";
import { isTmuxAvailable } from "../autoRun/tmuxExecutor.js";
import { getRunSession, listRunSessions } from "../runSessions/index.js";
import type {
  RunSessionAutoRunSummary,
  RunSessionEvent,
  RunSessionPhase,
  RunSessionState
} from "../runSessions/index.js";
import { readState } from "../state.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

const startedRunIds = new Set<string>();
const noTmux = { tmuxEnabled: false } as const;
const finalRunSessionEventTypes = [
  "session_completed",
  "session_manual",
  "session_blocked",
  "session_failed",
  "session_stopped"
] as const;

type FinalRunSessionEventType = (typeof finalRunSessionEventTypes)[number];
type AutoRunEventLogEntry = {
  type: string;
  phase: DesktopAutoRunPhase;
  previousPhase?: DesktopAutoRunPhase;
  nextPhase?: DesktopAutoRunPhase;
  stepKind?: string;
  pausedAfterStep?: boolean;
  stoppedPhase?: DesktopAutoRunPhase;
};
type AutoRunSessionConsistency = {
  phase: DesktopAutoRunPhase;
  latestAutoRunEvent: string;
  sessionPhase: RunSessionPhase;
  stepCount: number;
  stopReason: RunSessionAutoRunSummary["stopReason"];
  finalSessionEvent: FinalRunSessionEventType | null;
};

afterEach(async () => {
  await Promise.all([...startedRunIds].map((runId) => stopAutoRun(runId).catch(() => undefined)));
  startedRunIds.clear();
  delete process.env.PLANWEAVE_HOME;
});

async function waitForRun(
  runId: string,
  predicate: (state: Awaited<ReturnType<typeof getAutoRunState>>) => boolean
) {
  let state = await getAutoRunState(runId);
  for (let attempt = 0; attempt < 500 && !predicate(state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await getAutoRunState(runId);
  }
  return state;
}

async function waitForLatestRunSummary(
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

async function readAutoRunEvents(eventLogPath: string): Promise<AutoRunEventLogEntry[]> {
  const log = await readFile(eventLogPath, "utf8");
  return log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AutoRunEventLogEntry);
}

async function waitForAutoRunEvent(
  eventLogPath: string,
  predicate: (event: AutoRunEventLogEntry) => boolean
): Promise<void> {
  let events: AutoRunEventLogEntry[] = [];
  for (let attempt = 0; attempt < 500; attempt += 1) {
    events = await readAutoRunEvents(eventLogPath).catch(() => []);
    if (events.some(predicate)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for Auto Run event. Observed events: ${events.map((event) => event.type).join(", ")}`
  );
}

function runSessionIdFor(state: Awaited<ReturnType<typeof getAutoRunState>>): string {
  expect(state.runSessionId).toEqual(expect.any(String));
  if (!state.runSessionId) {
    throw new Error(`Auto Run '${state.runId}' is missing runSessionId.`);
  }
  return state.runSessionId;
}

function finalSessionEvents(events: RunSessionEvent[]): RunSessionEvent[] {
  return events.filter((event) =>
    finalRunSessionEventTypes.includes(event.type as FinalRunSessionEventType)
  );
}

function expectFinalSessionEvent(
  events: RunSessionEvent[],
  expected: FinalRunSessionEventType | null
): void {
  const terminalEvents = finalSessionEvents(events);
  if (expected === null) {
    expect(terminalEvents).toHaveLength(0);
    return;
  }
  expect(terminalEvents).toEqual([expect.objectContaining({ type: expected })]);
}

async function expectAutoRunSessionConsistency(
  projectRoot: string,
  state: Awaited<ReturnType<typeof getAutoRunState>>,
  expected: AutoRunSessionConsistency
): Promise<void> {
  expect(state.phase).toBe(expected.phase);
  const sessionId = runSessionIdFor(state);
  const eventLog = await listAutoRunEvents(projectRoot, state.canvasId, state.runId);
  expect(eventLog.diagnostics).toEqual([]);
  expect(eventLog.events.at(-1)).toMatchObject({ type: expected.latestAutoRunEvent });

  const detail = await getRunSession(projectRoot, sessionId);
  expect(detail.diagnostics).toEqual([]);
  expect(detail.session).toMatchObject({
    phase: expected.sessionPhase,
    autoRun: {
      desktopRunId: state.runId,
      stepCount: expected.stepCount,
      stopReason: expected.stopReason
    }
  });
  expectFinalSessionEvent(detail.events, expected.finalSessionEvent);
}

async function latestResetSession(projectRoot: string): Promise<RunSessionState> {
  const result = await listRunSessions(projectRoot);
  expect(result.diagnostics).toEqual([]);
  const session = result.sessions.find((item) => item.kind === "reset");
  if (!session) {
    throw new Error("Expected a reset run session.");
  }
  return session;
}

describe("desktop auto run API", () => {
  it("preserves ACP profile identity when a Desktop run fails closed before a record", async () => {
    const manifest = manifestTestBuilder()
      .withDefaultExecutor("codex-acp")
      .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "codex-acp" }))
      .build();
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(started.runId);
    const blocked = await waitForLatestRunSummary(
      root,
      null,
      started.runId,
      (state) => state.phase === "blocked"
    );

    expect(blocked).toMatchObject({
      phase: "blocked",
      currentExecutor: "codex-acp",
      latestRecordId: null
    });
    await expect(getRunSession(root, runSessionIdFor(blocked))).resolves.toMatchObject({
      session: {
        phase: "blocked",
        autoRun: {
          effectiveExecutor: "codex-acp",
          agentId: "codex",
          runnerKind: "acp"
        }
      }
    });
  });

  it("starts, pauses, resumes, stops, and summarizes project-level Auto Run", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('desktop auto run ' + input.split('\\n')[0]); });"
        ]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(started.runId);
    expect(started.phase).toBe("running");
    expect(started.options.tmuxEnabled).toBe(false);

    const current = await waitForRun(started.runId, (nextState) => nextState.phase !== "running");

    expect(current).toMatchObject({
      runSessionId: "SESSION-0001",
      phase: "paused",
      stepCount: 1,
      currentExecutor: "fake-codex",
      error: "Step limit reached."
    });
    expect(current.startedAt).toEqual(expect.any(String));
    expect(current.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(current.latestOutputSummary).toContain("desktop auto run");
    expect(current.latestRecordId).toBe("T-001#B-001::RUN-001");
    expect(current.latestRecordPath).toContain("metadata.json");
    expect(current.explanation).toMatchObject({
      phase: "paused",
      currentRef: "T-001#B-001",
      currentExecutor: "fake-codex",
      latestRecordId: "T-001#B-001::RUN-001",
      latestOutputSummary: expect.stringContaining("desktop auto run"),
      error: "Step limit reached.",
      nextAction: {
        kind: "resume",
        message: "Resume Auto Run or inspect the latest record before continuing."
      }
    });
    expect(current.statePath).toContain("auto-runs");
    expect(current.eventLogPath).toContain("events.ndjson");
    await expect(readFile(current.statePath, "utf8")).resolves.toContain('"phase": "paused"');
    await expect(readFile(current.eventLogPath, "utf8")).resolves.toContain(
      '"type":"step_limit_reached"'
    );
    await expect(getLatestAutoRunSummary(root, null)).resolves.toMatchObject({
      runId: started.runId
    });
    await expect(getRunSession(root, current.runSessionId!)).resolves.toMatchObject({
      session: {
        autoRun: {
          effectiveExecutor: "fake-codex",
          agentId: "codex",
          runnerKind: "cli"
        }
      }
    });
    await expectAutoRunSessionConsistency(root, current, {
      phase: "paused",
      latestAutoRunEvent: "step_limit_reached",
      sessionPhase: "running",
      stepCount: 1,
      stopReason: "step_limit",
      finalSessionEvent: null
    });
    const pausedSession = await getRunSession(root, current.runSessionId!);
    expect(pausedSession.session).toMatchObject({
      kind: "run",
      trigger: "desktop",
      scope: { kind: "project" },
      phase: "running",
      autoRun: {
        desktopRunId: started.runId,
        stepCount: 1,
        stopReason: "step_limit"
      },
      latestRecordId: "T-001#B-001::RUN-001"
    });
    expect(pausedSession.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "session_started",
        "run_started",
        "step_start",
        "step_finish",
        "step_limit_reached"
      ])
    );

    await expect(resumeAutoRun(started.runId)).resolves.toMatchObject({ phase: "running" });
    expect(["pausing", "paused"]).toContain((await pauseAutoRun(started.runId)).phase);
    await expect(stopAutoRun(started.runId)).resolves.toMatchObject({ phase: "stopped" });
    await expect(getRunSession(root, current.runSessionId!)).resolves.toMatchObject({
      session: {
        phase: "stopped",
        autoRun: {
          desktopRunId: started.runId
        }
      },
      events: expect.arrayContaining([expect.objectContaining({ type: "session_stopped" })])
    });
    await expectAutoRunSessionConsistency(
      root,
      await getLatestAutoRunSummary(root, null).then((state) => {
        if (!state) {
          throw new Error("Expected stopped Auto Run summary.");
        }
        return state;
      }),
      {
        phase: "stopped",
        latestAutoRunEvent: "run_stopped",
        sessionPhase: "stopped",
        stepCount: 1,
        stopReason: null,
        finalSessionEvent: "session_stopped"
      }
    );
    const eventLog = await listAutoRunEvents(root, null, started.runId);
    expect(eventLog.diagnostics).toEqual([]);
    expect(eventLog.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["run_started", "step_limit_reached", "run_resumed", "run_stopped"])
    );
    expect(eventLog.events.every((event) => event.runId === started.runId)).toBe(true);
  });

  it("resets runtime state from Desktop and records the reset session", async () => {
    const manifest = manifestTestBuilder().withDefaultExecutor("manual").build();
    const { root, init } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 5, noTmux);
    startedRunIds.add(started.runId);
    const manualState = await waitForRun(started.runId, (state) => state.phase === "manual");
    const manualSession = await getRunSession(root, runSessionIdFor(manualState));
    expect(manualSession.session).toMatchObject({
      phase: "manual",
      finishedAt: null
    });
    expectFinalSessionEvent(manualSession.events, null);

    const result = await resetDesktopRuntimeState(root, null, {
      force: true,
      reason: "  test reset  "
    });

    expect(result).toMatchObject({
      reason: "test reset",
      forced: true,
      previousCurrentRefs: ["T-001#B-001"],
      previousInProgressRefs: ["T-001#B-001"],
      stoppedAutoRunIds: [started.runId],
      session: {
        kind: "reset",
        trigger: "desktop",
        phase: "completed",
        reset: expect.objectContaining({ performed: true, forced: true, reason: "test reset" })
      }
    });
    expect((await readState(init.workspace.stateFile)).blocks["T-001#B-001"]).toMatchObject({
      status: "ready",
      lastRunId: null
    });
    await expect(getLatestAutoRunSummary(root, null)).resolves.toMatchObject({
      runId: started.runId,
      phase: "stopped"
    });
    const stoppedRun = await getLatestAutoRunSummary(root, null);
    if (!stoppedRun) {
      throw new Error("Expected stopped Auto Run summary after force reset.");
    }
    await expectAutoRunSessionConsistency(root, stoppedRun, {
      phase: "stopped",
      latestAutoRunEvent: "run_stopped",
      sessionPhase: "stopped",
      stepCount: 1,
      stopReason: null,
      finalSessionEvent: "session_stopped"
    });

    const detail = await getRunSession(root, result.session.sessionId);
    expect(detail.events.map((event) => event.type)).toEqual([
      "session_started",
      "reset_started",
      "reset_completed",
      "session_completed"
    ]);
    expect(detail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reset_started", reason: "test reset" }),
        expect.objectContaining({
          type: "reset_completed",
          reset: expect.objectContaining({ reason: "test reset" })
        })
      ])
    );
    expect(detail.events.at(-1)).toMatchObject({
      type: "session_completed",
      stoppedAutoRunIds: [started.runId]
    });
  });

  it("refuses Desktop reset while a stopped run loop is still settling", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("slow-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { setTimeout(() => { console.log('slow reset guard ' + input.split('\\n')[0]); }, 500); });"
        ]
      })
      .withDefaultExecutor("slow-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 2, noTmux);
    startedRunIds.add(started.runId);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const log = await readFile(started.eventLogPath, "utf8").catch(() => "");
      if (log.includes('"type":"step_start"')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await expect(stopAutoRun(started.runId)).resolves.toMatchObject({ phase: "stopped" });
    await expect(
      resetDesktopRuntimeState(root, null, { force: true, reason: "test reset" })
    ).rejects.toThrow("Cannot reset runtime state while Auto Run is active");
    const resetSession = await latestResetSession(root);
    expect(resetSession).toMatchObject({
      kind: "reset",
      trigger: "desktop",
      phase: "failed",
      error: expect.stringContaining("Cannot reset runtime state while Auto Run is active")
    });
    const resetDetail = await getRunSession(root, resetSession.sessionId);
    expect(resetDetail.diagnostics).toEqual([]);
    expect(resetDetail.events.at(-1)).toMatchObject({
      type: "session_failed",
      phase: "failed",
      stoppedAutoRunIds: []
    });
    expectFinalSessionEvent(resetDetail.events, "session_failed");
    const autoRunDetail = await getRunSession(root, started.runSessionId!);
    expect(autoRunDetail.session.phase).toBe("stopped");
    expect(autoRunDetail.events.filter((event) => event.type === "session_completed")).toHaveLength(
      0
    );
    expectFinalSessionEvent(autoRunDetail.events, "session_stopped");
    await new Promise((resolve) => setTimeout(resolve, 600));
  });

  it("can disable tmux monitoring while preserving streaming run records", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('streamed without tmux ' + input.split('\\n')[0]); });"
        ]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(started.runId);
    expect(started.options.tmuxEnabled).toBe(false);
    const current = await waitForRun(started.runId, (nextState) => nextState.phase !== "running");

    expect(current).toMatchObject({
      phase: "paused",
      currentExecutor: "fake-codex",
      latestOutputSummary: expect.stringContaining("streamed without tmux"),
      options: { tmuxEnabled: false }
    });
    expect(current.latestRecordPath).toEqual(expect.any(String));
    const metadata = JSON.parse(await readFile(current.latestRecordPath!, "utf8")) as Record<
      string,
      unknown
    >;
    expect(metadata.tmuxSessionId).toBeUndefined();
    await expect(
      readFile(current.latestRecordPath!.replace("metadata.json", "stdout.md"), "utf8")
    ).resolves.toContain("streamed without tmux");
  });

  it("keeps stopped session final when an in-flight non-tmux step settles after stop", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("slow-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { setTimeout(() => { console.log('late stop auto run ' + input.split('\\n')[0]); }, 220); });"
        ]
      })
      .withDefaultExecutor("slow-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 2, noTmux);
    startedRunIds.add(started.runId);
    await waitForAutoRunEvent(started.eventLogPath, (event) => event.type === "step_start");

    await expect(stopAutoRun(started.runId)).resolves.toMatchObject({ phase: "stopped" });
    await expect(stopAutoRun(started.runId)).resolves.toMatchObject({ phase: "stopped" });
    await waitForAutoRunEvent(
      started.eventLogPath,
      (event) => event.type === "stopped_step_ignored"
    );

    const stopped = await getLatestAutoRunSummary(root, null);
    if (!stopped) {
      throw new Error("Expected stopped Auto Run summary.");
    }
    expect(stopped).toMatchObject({
      runId: started.runId,
      phase: "stopped",
      stepCount: 0
    });
    await expectAutoRunSessionConsistency(root, stopped, {
      phase: "stopped",
      latestAutoRunEvent: "stopped_step_ignored",
      sessionPhase: "stopped",
      stepCount: 0,
      stopReason: null,
      finalSessionEvent: "session_stopped"
    });
    const events = await readAutoRunEvents(stopped.eventLogPath);
    expect(events.filter((event) => event.type === "run_stopped")).toHaveLength(1);
  });

  it("finishes the in-flight block before pausing and resumes the same run", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("slow-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { setTimeout(() => { if (input.includes('Review task')) { console.log(JSON.stringify({ reviewBlockRef: 'T-001#R-001', taskId: 'T-001', verdict: 'passed', content: 'slow review passed' })); } else { console.log('slow auto run ' + input.split('\\n')[0]); } }, 120); });"
        ]
      })
      .withDefaultExecutor("slow-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 2, noTmux);
    startedRunIds.add(started.runId);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const log = await readFile(started.eventLogPath, "utf8").catch(() => "");
      if (log.includes('"type":"step_start"')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await expect(pauseAutoRun(started.runId)).resolves.toMatchObject({ phase: "pausing" });

    const paused = await waitForRun(started.runId, (state) => state.phase === "paused");
    expect(paused).toMatchObject({
      phase: "paused",
      stepCount: 1,
      currentRef: "T-001#B-001",
      currentExecutor: "slow-codex"
    });
    await expect(readFile(paused.eventLogPath, "utf8")).resolves.toContain(
      '"pausedAfterStep":true'
    );

    await expect(resumeAutoRun(started.runId)).resolves.toMatchObject({ phase: "running" });
    const resumed = await waitForRun(
      started.runId,
      (state) => state.phase === "paused" && state.stepCount === 2
    );
    expect(resumed).toMatchObject({
      phase: "paused",
      stepCount: 2,
      error: "Step limit reached."
    });
    await expect(stopAutoRun(started.runId)).resolves.toMatchObject({ phase: "stopped" });
    const events = await readAutoRunEvents(resumed.eventLogPath);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "step_start",
      "pause_requested",
      "step_finish",
      "run_resumed",
      "step_start",
      "step_finish",
      "step_limit_reached",
      "run_stopped"
    ]);
    await expectAutoRunSessionConsistency(
      root,
      await getLatestAutoRunSummary(root, null).then((state) => {
        if (!state) {
          throw new Error("Expected stopped Auto Run summary.");
        }
        return state;
      }),
      {
        phase: "stopped",
        latestAutoRunEvent: "run_stopped",
        sessionPhase: "stopped",
        stepCount: 2,
        stopReason: null,
        finalSessionEvent: "session_stopped"
      }
    );
  });

  it("stops an in-flight tmux-backed Auto Run without replacing the stopped phase with failed", async () => {
    if (!(await isTmuxAvailable())) {
      return;
    }
    const manifest = manifestTestBuilder()
      .withExecutor("long-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { setInterval(() => process.stdout.write('still running\\n'), 100); });"
        ]
      })
      .withDefaultExecutor("long-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 2);
    startedRunIds.add(started.runId);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const log = await readFile(started.eventLogPath, "utf8").catch(() => "");
      if (log.includes('"type":"step_start"')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    await expect(stopAutoRun(started.runId)).resolves.toMatchObject({ phase: "stopped" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(getLatestAutoRunSummary(root, null)).resolves.toMatchObject({
      runId: started.runId,
      phase: "stopped"
    });
    await expect(readFile(started.eventLogPath, "utf8")).resolves.toContain('"type":"run_stopped"');
  });

  it("keeps completed runs readable from persisted summaries after releasing terminal state", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('completed auto run ' + input.split('\\n')[0]); });"
        ]
      })
      .withExecutor("pass-review", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log(JSON.stringify({ reviewBlockRef: 'T-001#R-001', taskId: 'T-001', verdict: 'passed', content: 'review passed' })); });"
        ]
      })
      .withDefaultExecutor("fake-codex")
      .withBlock("T-001", "R-001", (block) => ({ ...block, executor: "pass-review" }))
      .build();
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "project" }, 5, noTmux);
    startedRunIds.add(started.runId);

    const completed = await waitForLatestRunSummary(
      root,
      null,
      started.runId,
      (state) => state.phase === "completed"
    );

    expect(completed).toMatchObject({
      runId: started.runId,
      runSessionId: "SESSION-0001",
      phase: "completed",
      currentRef: null,
      latestRecordId: "T-001#R-001::RUN-001",
      latestOutputSummary: "no_claimable_blocks"
    });
    await expect(getRunSession(root, completed.runSessionId!)).resolves.toMatchObject({
      session: {
        kind: "run",
        trigger: "desktop",
        phase: "completed",
        autoRun: {
          desktopRunId: started.runId,
          stepCount: 3,
          effectiveExecutor: "pass-review",
          agentId: "codex",
          runnerKind: "cli"
        },
        latestRecordId: "T-001#R-001::RUN-001"
      },
      events: expect.arrayContaining([expect.objectContaining({ type: "session_completed" })])
    });
    await expect(getAutoRunState(started.runId)).rejects.toThrow(
      `Auto Run '${started.runId}' does not exist.`
    );
    await expect(getLatestAutoRunSummary(root, null)).resolves.toMatchObject({
      runId: started.runId,
      phase: "completed"
    });
  });

  it("runs selected task and selected block Auto Run through the Task Manager claim order", async () => {
    const manifest = manifestTestBuilder({ includeSecondTask: true })
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('scoped auto run ' + input.split('\\n')[0]); });"
        ]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);

    const taskRun = await startAutoRun(root, null, { kind: "task", taskId: "T-002" }, 1, noTmux);
    startedRunIds.add(taskRun.runId);
    const taskState = await waitForRun(taskRun.runId, (state) => state.phase !== "running");
    expect(taskState).toMatchObject({
      scope: { kind: "task", taskId: "T-002" },
      phase: "paused",
      currentRef: "T-002#B-001",
      currentExecutor: "fake-codex",
      stepCount: 1
    });

    const blockRun = await startAutoRun(
      root,
      null,
      { kind: "block", blockRef: "T-001#B-001" },
      1,
      noTmux
    );
    startedRunIds.add(blockRun.runId);
    const blockState = await waitForRun(blockRun.runId, (state) => state.phase !== "running");
    expect(blockState).toMatchObject({
      scope: { kind: "block", blockRef: "T-001#B-001" },
      phase: "paused",
      currentRef: "T-001#B-001",
      currentExecutor: "fake-codex",
      stepCount: 1
    });
  });

  it("uses manifest parallel mode for project-level Auto Run", async () => {
    const manifest = manifestTestBuilder({ includeSecondTask: true })
      .withParallelExecution({ maxConcurrent: 2 })
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('parallel auto run ' + input.split('\\n')[0]); });"
        ]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);

    const run = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(run.runId);
    const state = await waitForRun(run.runId, (nextState) => nextState.phase !== "running");

    expect(state).toMatchObject({
      phase: "paused",
      currentRef: "T-001#B-001",
      currentExecutor: "fake-codex",
      latestOutputSummary: "2 block(s) submitted.",
      stepCount: 1
    });
  });

  it("blocks the desktop run when review warnings remain after no claimable work", async () => {
    const manifest = manifestTestBuilder()
      .withReviewCycles(0)
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('warning test ' + input.split('\\n')[0]); });"
        ]
      })
      .withExecutor("needs-review", {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log(JSON.stringify({ reviewBlockRef: 'T-001#R-001', taskId: 'T-001', verdict: 'needs_changes', content: 'changes required' })); });"
        ]
      })
      .withDefaultExecutor("fake-codex")
      .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "fake-codex" }))
      .withBlock("T-001", "R-001", (block) => ({ ...block, executor: "needs-review" }))
      .build();
    const { root } = await createTestWorkspace(manifest);

    const run = await startAutoRun(root, null, { kind: "project" }, 5, noTmux);
    startedRunIds.add(run.runId);
    const state = await waitForLatestRunSummary(
      root,
      null,
      run.runId,
      (nextState) => nextState.phase !== "running"
    );

    expect(state).toMatchObject({
      phase: "blocked",
      error: expect.stringContaining("reached max feedback cycles")
    });

    const retried = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(retried.runId);
    const retryState = await waitForRun(
      retried.runId,
      (nextState) => nextState.phase !== "running"
    );

    expect(retryState).toMatchObject({
      phase: "paused",
      currentRef: "T-001#R-001",
      currentExecutor: "needs-review",
      stepCount: 1,
      error: "Step limit reached."
    });
    await expect(readFile(retryState.eventLogPath, "utf8")).resolves.toContain(
      '"resetMaxCycleReviewRefs":["T-001#R-001"]'
    );
  });

  it("starts a fresh feedback cycle when retrying a max-cycle review", async () => {
    const manifest = manifestTestBuilder()
      .withReviewCycles(1)
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('retry feedback ' + input.split('\\n')[0]); });"
        ]
      })
      .withExecutor("needs-review", {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          "const fs = require('node:fs'); const counterPath = '.review-counter'; let count = 0; try { count = Number(fs.readFileSync(counterPath, 'utf8')) || 0; } catch {} count += 1; fs.writeFileSync(counterPath, String(count)); let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log(JSON.stringify({ reviewBlockRef: 'T-001#R-001', taskId: 'T-001', verdict: 'needs_changes', content: 'changes required ' + count })); });"
        ]
      })
      .withDefaultExecutor("fake-codex")
      .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "fake-codex" }))
      .withBlock("T-001", "R-001", (block) => ({ ...block, executor: "needs-review" }))
      .build();
    const { root, init } = await createTestWorkspace(manifest);

    const firstRun = await startAutoRun(root, null, { kind: "project" }, 10, noTmux);
    startedRunIds.add(firstRun.runId);
    const firstState = await waitForLatestRunSummary(
      root,
      null,
      firstRun.runId,
      (nextState) => nextState.phase !== "running"
    );

    expect(firstState).toMatchObject({
      phase: "blocked",
      error: expect.stringContaining("reached max feedback cycles")
    });
    await expect(readState(init.workspace.stateFile)).resolves.toMatchObject({
      feedback: {
        "FE-001": {
          sourceReviewBlockRef: "T-001#R-001",
          status: "resolved"
        }
      }
    });

    const retryRun = await startAutoRun(root, null, { kind: "project" }, 1, noTmux);
    startedRunIds.add(retryRun.runId);
    const retryState = await waitForRun(
      retryRun.runId,
      (nextState) => nextState.phase !== "running"
    );

    expect(retryState).toMatchObject({
      phase: "paused",
      currentRef: "T-001#R-001",
      currentExecutor: "needs-review",
      stepCount: 1,
      error: "Step limit reached."
    });
    await expect(readFile(retryState.eventLogPath, "utf8")).resolves.toContain(
      '"resetMaxCycleReviewRefs":["T-001#R-001"]'
    );
    await expect(readState(init.workspace.stateFile)).resolves.toMatchObject({
      feedback: {
        "FE-003": {
          sourceReviewBlockRef: "T-001#R-001",
          status: "open"
        }
      }
    });
  });
});
