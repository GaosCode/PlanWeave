import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExpectedAuthority,
  commitAutoRunTransition,
  generateTransitionId,
  pendingTransitionPath,
  readPendingTransitionIntentResult,
  recoverPendingTransition,
  writePendingTransitionIntent,
  type TransitionPersistenceAdapters
} from "../desktop/autoRunTransition.js";
import {
  getAutoRunState,
  getLatestAutoRunSummaryWithDiagnostics,
  listAutoRunEvents,
  pauseAutoRun,
  resumeAutoRun,
  startAutoRun,
  stopAutoRun
} from "../desktop/index.js";
import {
  readRawPersistedAutoRunState,
  writePersistedAutoRunState
} from "../desktop/runStateRepository.js";
import { appendAutoRunEvent } from "../desktop/runStateStore.js";
import type { DesktopAutoRunState } from "../desktop/types.js";
import { appendRunSessionEvent, getRunSession, updateRunSession } from "../runSessions/index.js";
import { runDoctor } from "../taskManager/index.js";
import type { ProjectWorkspace } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

const startedRunIds = new Set<string>();
const noTmux = { tmuxEnabled: false } as const;

afterEach(async () => {
  await Promise.all([...startedRunIds].map((runId) => stopAutoRun(runId).catch(() => undefined)));
  startedRunIds.clear();
  delete process.env.PLANWEAVE_HOME;
});

async function startRun(root: string) {
  const run = await startAutoRun(root, null, { kind: "project" }, 2, noTmux);
  startedRunIds.add(run.runId);
  return run;
}

function makeIntent(
  run: DesktopAutoRunState,
  nextPhase: DesktopAutoRunState["phase"],
  eventType: string,
  options: {
    transitionId?: string;
    expectedAuthority?: ReturnType<typeof buildExpectedAuthority>;
    extra?: Partial<DesktopAutoRunState>;
  } = {}
) {
  const next = {
    ...run,
    phase: nextPhase,
    updatedAt: options.expectedAuthority?.updatedAt ?? new Date().toISOString(),
    ...options.extra
  };
  const expectedAuthority =
    options.expectedAuthority ?? buildExpectedAuthority({ ...run, ...next, phase: nextPhase });
  return {
    version: 2 as const,
    transitionId: options.transitionId ?? generateTransitionId(),
    runId: run.runId,
    previousPhase: "running" as const,
    nextPhase,
    eventType,
    previousAuthority: buildExpectedAuthority(run),
    expectedAuthority,
    data: { previousPhase: "running", nextPhase },
    createdAt: new Date().toISOString()
  };
}

async function writeCommittedState(
  workspace: ProjectWorkspace,
  run: DesktopAutoRunState,
  phase: DesktopAutoRunState["phase"],
  extra: Partial<DesktopAutoRunState> = {}
) {
  const next = {
    ...run,
    phase,
    updatedAt: new Date().toISOString(),
    ...extra
  };
  await mkdir(dirname(run.statePath), { recursive: true });
  await writePersistedAutoRunState(next);
  return next;
}

function sessionSummaryBuilder(parallel = false) {
  return async (_ws: ProjectWorkspace, state: DesktopAutoRunState) => ({
    desktopRunId: state.runId,
    stepCount: state.stepCount,
    parallel,
    executorOverride: null,
    effectiveExecutor: state.currentExecutor,
    agentId: null,
    runnerKind: null,
    stopReason: null
  });
}

/**
 * Inject failure once on the named boundary; all other calls delegate to real repositories.
 */
function onceFaultAdapters(
  boundary: "writeState" | "appendAutoRunEvent" | "updateSession" | "appendSessionEvent"
): TransitionPersistenceAdapters {
  let failed = false;
  return {
    writeState: async (state) => {
      if (boundary === "writeState" && !failed) {
        failed = true;
        throw new Error("injected writeState failure");
      }
      await writePersistedAutoRunState(state);
    },
    appendAutoRunEvent: async (state, type, data) => {
      if (boundary === "appendAutoRunEvent" && !failed) {
        failed = true;
        throw new Error("injected appendAutoRunEvent failure");
      }
      await appendAutoRunEvent(state, type, data);
    },
    updateSession: async (workspace, sessionId, patch) => {
      if (boundary === "updateSession" && !failed) {
        failed = true;
        throw new Error("injected updateSession failure");
      }
      return updateRunSession(workspace, sessionId, patch);
    },
    appendSessionEvent: async (workspace, sessionId, eventType, data) => {
      if (boundary === "appendSessionEvent" && !failed) {
        failed = true;
        throw new Error("injected appendSessionEvent failure");
      }
      await appendRunSessionEvent(workspace, sessionId, eventType, data);
    }
  };
}

describe("Auto Run transition coordinator recovery", () => {
  it("concurrent recoverPendingTransition yields exactly one Auto Run and session event", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const committed = await writeCommittedState(init.workspace, run, "stopped");
    const intent = makeIntent(run, "stopped", "run_stopped", {
      expectedAuthority: buildExpectedAuthority(committed)
    });
    await writePendingTransitionIntent(init.workspace, intent);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        recoverPendingTransition(init.workspace, run.runId, () => null)
      )
    );

    expect(results.filter((r) => r.recovered).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.unreadable === false)).toBe(true);

    const events = await listAutoRunEvents(root, null, run.runId);
    const matching = events.events.filter(
      (e) => (e.data as { transitionId?: string } | undefined)?.transitionId === intent.transitionId
    );
    expect(matching.length).toBe(1);

    const session = await getRunSession(init.workspace, run.runSessionId!);
    const sessionPhaseEvents = session.events.filter(
      (e) =>
        e.type === "run_stopped" &&
        (e as { transitionId?: string }).transitionId === intent.transitionId
    );
    expect(sessionPhaseEvents.length).toBe(1);
    const terminalSession = session.events.filter((e) => e.type === "session_stopped");
    expect(terminalSession.length).toBe(1);

    const pending = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(pending.status).toBe("absent");
  });

  it("reopen with empty memory heals projections using raw disk running authority (no intent loss)", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    await stopAutoRun(run.runId).catch(() => undefined);
    startedRunIds.delete(run.runId);

    const runningState = await writeCommittedState(init.workspace, run, "running", {
      stepCount: 1,
      error: null
    });
    const intent = makeIntent(run, "running", "phase_change", {
      expectedAuthority: buildExpectedAuthority(runningState),
      extra: { stepCount: 1 }
    });
    await writePendingTransitionIntent(init.workspace, intent);

    const rec = await recoverPendingTransition(init.workspace, run.runId, () => null, {
      buildSessionSummary: sessionSummaryBuilder()
    });
    expect(rec.recovered).toBe(true);
    expect(rec.applied).toContain("autoRunEvent");
    expect(rec.applied).toContain("session");
    expect(rec.applied).toContain("cleared-intent");

    const raw = await readRawPersistedAutoRunState(init.workspace, run.runId);
    expect(raw?.phase).toBe("running");
    expect(raw?.stepCount).toBe(runningState.stepCount);

    const events = await listAutoRunEvents(root, null, run.runId);
    const matching = events.events.filter(
      (e) => (e.data as { transitionId?: string } | undefined)?.transitionId === intent.transitionId
    );
    expect(matching.length).toBe(1);

    const pending = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(pending.status).toBe("absent");
  });

  it("same-phase step_finish state write failure does not pseudo-recover with old authority", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    expect(run.phase).toBe("running");
    expect(run.stepCount).toBe(0);

    const previous = { ...run, phase: "running" as const };
    const next = {
      ...run,
      phase: "running" as const,
      stepCount: 1,
      currentRef: "T-1#B-001",
      updatedAt: new Date().toISOString()
    };

    await expect(
      commitAutoRunTransition({
        workspace: init.workspace,
        previous,
        next,
        eventType: "step_finish",
        data: { stepKind: "implementation" },
        buildSessionSummary: sessionSummaryBuilder(),
        adapters: onceFaultAdapters("writeState")
      })
    ).rejects.toThrow(/injected writeState/);

    const pending = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(pending.status).toBe("ok");
    if (pending.status === "ok") {
      expect(pending.intent.expectedAuthority.stepCount).toBe(1);
      expect(pending.intent.expectedAuthority.updatedAt).toBe(next.updatedAt);
    }

    const diskBefore = await readRawPersistedAutoRunState(init.workspace, run.runId);
    expect(diskBefore?.phase).toBe("running");
    expect(diskBefore?.stepCount).toBe(0);

    const eventsBefore = await listAutoRunEvents(root, null, run.runId);
    const stepFinishBefore = eventsBefore.events.filter((e) => e.type === "step_finish");
    expect(stepFinishBefore.length).toBe(0);

    const rec = await recoverPendingTransition(init.workspace, run.runId, () => null, {
      buildSessionSummary: sessionSummaryBuilder()
    });
    expect(rec.recovered).toBe(false);
    expect(rec.unreadable).toBe(false);
    expect(rec.diagnostics.some((d) => d.code === "auto_run_transition_aborted_before_state")).toBe(
      true
    );
    expect(rec.applied).not.toContain("autoRunEvent");
    expect(rec.applied).not.toContain("session");

    const eventsAfter = await listAutoRunEvents(root, null, run.runId);
    expect(eventsAfter.events.filter((e) => e.type === "step_finish").length).toBe(0);

    const diskAfter = await readRawPersistedAutoRunState(init.workspace, run.runId);
    expect(diskAfter?.stepCount).toBe(0);

    // Intent cleared only because authority identity did not match (aborted before state).
    const after = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(after.status).toBe("absent");
  });

  it("corrupt authority state with valid intent is unreadable: keep intent, no projection, block start", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    await stopAutoRun(run.runId).catch(() => undefined);
    startedRunIds.delete(run.runId);

    const expectedNext = {
      ...run,
      phase: "paused" as const,
      updatedAt: new Date().toISOString()
    };
    const intent = makeIntent(run, "paused", "pause_completed", {
      expectedAuthority: buildExpectedAuthority(expectedNext)
    });
    await writePendingTransitionIntent(init.workspace, intent);
    await writeFile(run.statePath, "{not-valid-json", "utf8");

    const rec = await recoverPendingTransition(init.workspace, run.runId, () => null, {
      buildSessionSummary: sessionSummaryBuilder()
    });
    expect(rec.recovered).toBe(false);
    expect(rec.unreadable).toBe(true);
    expect(rec.diagnostics.some((d) => d.code === "auto_run_authority_state_unreadable")).toBe(
      true
    );
    const authorityDiag = rec.diagnostics.find(
      (d) => d.code === "auto_run_authority_state_unreadable"
    );
    expect(authorityDiag?.path).toBe(run.statePath);
    expect(authorityDiag?.transitionId).toBe(intent.transitionId);

    const pending = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(pending.status).toBe("ok");

    const events = await listAutoRunEvents(root, null, run.runId);
    expect(
      events.events.filter(
        (e) =>
          (e.data as { transitionId?: string } | undefined)?.transitionId === intent.transitionId
      ).length
    ).toBe(0);

    const doctor = await runDoctor({ projectRoot: root });
    expect(doctor.ok).toBe(false);
    expect(doctor.issues.some((i) => i.code === "auto_run_pending_transition_incomplete")).toBe(
      true
    );

    const latest = await getLatestAutoRunSummaryWithDiagnostics(root, null);
    expect(latest.diagnostics.some((d) => d.code === "auto_run_authority_state_unreadable")).toBe(
      true
    );

    await expect(startAutoRun(root, null, { kind: "project" }, 1, noTmux)).rejects.toThrow(
      /unreadable|unrecovered|pending transition/i
    );

    // Intent still present after latest/start gate attempts.
    const still = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(still.status).toBe("ok");
  });

  it("matching memory cannot bypass corrupt raw authority", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const stopped = await stopAutoRun(run.runId);
    startedRunIds.delete(run.runId);
    const intent = makeIntent(run, "stopped", "run_stopped", {
      expectedAuthority: buildExpectedAuthority(stopped)
    });
    await writePendingTransitionIntent(init.workspace, intent);
    await writeFile(run.statePath, "{not-valid-json", "utf8");

    const recovery = await recoverPendingTransition(init.workspace, run.runId, () => stopped, {
      buildSessionSummary: sessionSummaryBuilder()
    });
    expect(recovery).toMatchObject({ recovered: false, unreadable: true, applied: [] });
    const authorityDiagnostic = recovery.diagnostics.find(
      (diagnostic) => diagnostic.code === "auto_run_authority_state_unreadable"
    );
    expect(authorityDiagnostic?.path).toBe(run.statePath);
    expect(authorityDiagnostic?.transitionId).toBe(intent.transitionId);

    const projected = await listAutoRunEvents(root, null, run.runId);
    expect(
      projected.events.filter(
        (event) =>
          (event.data as { transitionId?: string } | undefined)?.transitionId ===
          intent.transitionId
      )
    ).toHaveLength(0);
    expect((await readPendingTransitionIntentResult(init.workspace, run.runId)).status).toBe("ok");

    const latest = await getLatestAutoRunSummaryWithDiagnostics(root, null);
    expect(
      latest.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "auto_run_authority_state_unreadable" &&
          diagnostic.path === run.statePath &&
          diagnostic.transitionId === intent.transitionId
      )
    ).toBe(true);
    const startError = await startAutoRun(root, null, { kind: "project" }, 1, noTmux).catch(
      (error: unknown) => error
    );
    expect(startError).toBeInstanceOf(Error);
    if (!(startError instanceof Error)) {
      throw new Error("Expected Auto Run start gate to reject.");
    }
    expect(startError.message).toContain(run.statePath);
    expect(startError.message).toContain(intent.transitionId);

    const doctor = await runDoctor({ projectRoot: root });
    expect(doctor.ok).toBe(false);
    expect(
      doctor.issues.some(
        (issue) =>
          issue.code === "auto_run_pending_transition_incomplete" &&
          issue.path === pendingTransitionPath(init.workspace, run.runId) &&
          issue.transitionId === intent.transitionId
      )
    ).toBe(true);
    expect((await readPendingTransitionIntentResult(init.workspace, run.runId)).status).toBe("ok");

    const after = await listAutoRunEvents(root, null, run.runId);
    expect(
      after.events.filter(
        (event) =>
          (event.data as { transitionId?: string } | undefined)?.transitionId ===
          intent.transitionId
      )
    ).toHaveLength(0);
  });

  it("malformed pending intent is unreadable (not absent) and surfaces in latest diagnostics", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    await stopAutoRun(run.runId).catch(() => undefined);
    startedRunIds.delete(run.runId);

    const path = pendingTransitionPath(init.workspace, run.runId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not-json", "utf8");

    const read = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(read.status).toBe("unreadable");
    if (read.status === "unreadable") {
      expect(read.diagnostic.code).toBe("auto_run_pending_transition_unreadable");
      expect(read.diagnostic.path).toBe(path);
    }

    const latest = await getLatestAutoRunSummaryWithDiagnostics(root, null);
    expect(
      latest.diagnostics.some((d) => d.code === "auto_run_pending_transition_unreadable")
    ).toBe(true);

    await expect(startAutoRun(root, null, { kind: "project" }, 1, noTmux)).rejects.toThrow(
      /pending transition|unreadable/i
    );
  });

  it("doctor reports incomplete and unreadable pending transitions (fail-closed)", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    await stopAutoRun(run.runId).catch(() => undefined);
    startedRunIds.delete(run.runId);

    const committed = await writeCommittedState(init.workspace, run, "stopped");
    const intent = makeIntent(run, "stopped", "run_stopped", {
      expectedAuthority: buildExpectedAuthority(committed)
    });
    await writePendingTransitionIntent(init.workspace, intent);

    const report = await runDoctor({ projectRoot: root });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "auto_run_pending_transition_incomplete")).toBe(
      true
    );

    const healed = await getLatestAutoRunSummaryWithDiagnostics(root, null);
    expect(
      healed.diagnostics.some((d) => d.code === "auto_run_pending_transition_incomplete")
    ).toBe(false);
    const afterHeal = await runDoctor({ projectRoot: root });
    expect(afterHeal.issues.some((i) => i.code === "auto_run_pending_transition_incomplete")).toBe(
      false
    );

    const events = await listAutoRunEvents(root, null, run.runId);
    const matching = events.events.filter(
      (e) => (e.data as { transitionId?: string } | undefined)?.transitionId === intent.transitionId
    );
    expect(matching.length).toBe(1);

    const path = pendingTransitionPath(init.workspace, run.runId);
    await writeFile(path, '{"version":1}', "utf8");
    const unreadableReport = await runDoctor({ projectRoot: root });
    expect(unreadableReport.ok).toBe(false);
    expect(
      unreadableReport.issues.some((i) => i.code === "auto_run_pending_transition_unreadable")
    ).toBe(true);
  });

  it.each([
    { boundary: "writeState" as const, nextPhase: "paused" as const, eventType: "pause_completed" },
    {
      boundary: "appendAutoRunEvent" as const,
      nextPhase: "paused" as const,
      eventType: "pause_completed"
    },
    {
      boundary: "updateSession" as const,
      nextPhase: "paused" as const,
      eventType: "pause_completed"
    },
    {
      boundary: "appendSessionEvent" as const,
      nextPhase: "paused" as const,
      eventType: "pause_completed"
    }
  ])("fault at $boundary during phase change leaves recoverable intent or fails closed", async ({
    boundary,
    nextPhase,
    eventType
  }) => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const previous = { ...run, phase: "running" as const };
    const next = {
      ...run,
      phase: nextPhase,
      updatedAt: new Date().toISOString()
    };

    await expect(
      commitAutoRunTransition({
        workspace: init.workspace,
        previous,
        next,
        eventType,
        data: {},
        buildSessionSummary: sessionSummaryBuilder(true),
        adapters: onceFaultAdapters(boundary)
      })
    ).rejects.toThrow(/injected/);

    const pending = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(pending.status).toBe("ok");
    const tid = pending.status === "ok" ? pending.intent.transitionId : "";

    if (boundary === "writeState") {
      const disk = await readRawPersistedAutoRunState(init.workspace, run.runId);
      expect(disk?.phase).toBe("running");
      const rec = await recoverPendingTransition(init.workspace, run.runId, () => null, {
        buildSessionSummary: sessionSummaryBuilder(true)
      });
      expect(rec.recovered).toBe(false);
      expect(rec.diagnostics.some((d) => d.code.includes("aborted_before_state"))).toBe(true);
      expect(rec.applied).not.toContain("autoRunEvent");
      const events = await listAutoRunEvents(root, null, run.runId);
      expect(
        events.events.filter(
          (e) => (e.data as { transitionId?: string } | undefined)?.transitionId === tid
        ).length
      ).toBe(0);
      const after = await readPendingTransitionIntentResult(init.workspace, run.runId);
      expect(after.status).toBe("absent");
      return;
    }

    const raw = await readRawPersistedAutoRunState(init.workspace, run.runId);
    expect(raw?.phase).toBe(nextPhase);
    expect(raw?.updatedAt).toBe(next.updatedAt);

    const rec = await recoverPendingTransition(init.workspace, run.runId, () => null, {
      buildSessionSummary: sessionSummaryBuilder(true)
    });
    expect(rec.recovered).toBe(true);

    const events = await listAutoRunEvents(root, null, run.runId);
    const matching = events.events.filter(
      (e) => (e.data as { transitionId?: string } | undefined)?.transitionId === tid
    );
    expect(matching.length).toBe(1);
    expect(matching[0]?.type).toBe(eventType);

    if (run.runSessionId) {
      const session = await getRunSession(init.workspace, run.runSessionId);
      expect(session.session.phase).toBe("running");
      expect(session.session.autoRun?.stepCount).toBe(next.stepCount);
      const phaseEvents = session.events.filter(
        (e) => e.type === eventType && (e as { transitionId?: string }).transitionId === tid
      );
      expect(phaseEvents.length).toBe(1);
    }

    const after = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(after.status).toBe("absent");
  });

  it.each([
    { boundary: "writeState" as const },
    { boundary: "appendAutoRunEvent" as const },
    { boundary: "updateSession" as const },
    { boundary: "appendSessionEvent" as const }
  ])("fault at $boundary during terminal transition: precise authority and session cardinality", async ({
    boundary
  }) => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const previous = { ...run, phase: "running" as const };
    const finishedAt = new Date().toISOString();
    const next = {
      ...run,
      phase: "stopped" as const,
      stepCount: run.stepCount,
      updatedAt: finishedAt
    };

    await expect(
      commitAutoRunTransition({
        workspace: init.workspace,
        previous,
        next,
        eventType: "run_stopped",
        data: {},
        buildSessionSummary: sessionSummaryBuilder(),
        adapters: onceFaultAdapters(boundary)
      })
    ).rejects.toThrow(/injected/);

    const pending = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(pending.status).toBe("ok");
    const tid = pending.status === "ok" ? pending.intent.transitionId : "";

    if (boundary === "writeState") {
      const disk = await readRawPersistedAutoRunState(init.workspace, run.runId);
      expect(disk?.phase).toBe("running");
      const rec = await recoverPendingTransition(init.workspace, run.runId, () => null, {
        buildSessionSummary: sessionSummaryBuilder()
      });
      expect(rec.recovered).toBe(false);
      expect(rec.diagnostics.some((d) => d.code.includes("aborted_before_state"))).toBe(true);
      const events = await listAutoRunEvents(root, null, run.runId);
      expect(
        events.events.filter(
          (e) => (e.data as { transitionId?: string } | undefined)?.transitionId === tid
        ).length
      ).toBe(0);
      const after = await readPendingTransitionIntentResult(init.workspace, run.runId);
      expect(after.status).toBe("absent");
      return;
    }

    const raw = await readRawPersistedAutoRunState(init.workspace, run.runId);
    expect(raw?.phase).toBe("stopped");
    expect(raw?.updatedAt).toBe(finishedAt);

    const rec = await recoverPendingTransition(init.workspace, run.runId, () => null, {
      buildSessionSummary: sessionSummaryBuilder()
    });
    expect(rec.recovered).toBe(true);

    const events = await listAutoRunEvents(root, null, run.runId);
    const matching = events.events.filter(
      (e) => (e.data as { transitionId?: string } | undefined)?.transitionId === tid
    );
    expect(matching.length).toBe(1);
    expect(matching[0]?.type).toBe("run_stopped");

    if (run.runSessionId) {
      const session = await getRunSession(init.workspace, run.runSessionId);
      expect(session.session.phase).toBe("stopped");
      expect(session.session.finishedAt).toBe(finishedAt);
      expect(session.session.autoRun?.desktopRunId).toBe(run.runId);
      expect(session.session.autoRun?.stepCount).toBe(next.stepCount);
      const phaseEvents = session.events.filter(
        (e) => e.type === "run_stopped" && (e as { transitionId?: string }).transitionId === tid
      );
      expect(phaseEvents.length).toBe(1);
      const terminalEvents = session.events.filter((e) => e.type === "session_stopped");
      expect(terminalEvents.length).toBe(1);
      expect((terminalEvents[0] as { transitionId?: string }).transitionId).toBe(tid);
    }

    const after = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(after.status).toBe("absent");
  });

  it("commit refuses to overwrite unrecovered pending intent from a prior transition", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const path = pendingTransitionPath(init.workspace, run.runId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{broken", "utf8");

    await expect(
      commitAutoRunTransition({
        workspace: init.workspace,
        previous: run,
        next: { ...run, phase: "stopped", updatedAt: new Date().toISOString() },
        eventType: "run_stopped",
        buildSessionSummary: sessionSummaryBuilder()
      })
    ).rejects.toThrow(/unreadable|schema|Failed to read pending/i);

    const { rm } = await import("node:fs/promises");
    await rm(path, { force: true });

    const paused = await writeCommittedState(init.workspace, run, "paused");
    const healable = makeIntent(run, "paused", "pause_completed", {
      expectedAuthority: buildExpectedAuthority(paused)
    });
    await writePendingTransitionIntent(init.workspace, healable);

    const committed = await commitAutoRunTransition({
      workspace: init.workspace,
      previous: paused,
      next: { ...run, phase: "stopped", updatedAt: new Date().toISOString() },
      eventType: "run_stopped",
      buildSessionSummary: sessionSummaryBuilder()
    });
    expect(committed.eventType).toBe("run_stopped");
    const events = await listAutoRunEvents(root, null, run.runId);
    const healed = events.events.filter(
      (e) =>
        (e.data as { transitionId?: string } | undefined)?.transitionId === healable.transitionId
    );
    expect(healed.length).toBe(1);
    const newOnes = events.events.filter(
      (e) =>
        (e.data as { transitionId?: string } | undefined)?.transitionId === committed.transitionId
    );
    expect(newOnes.length).toBe(1);
  });

  it("memory latest path still recovers missing projections before returning", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    // Memory matches disk authority (same run identity including updatedAt/stepCount).
    const intent = makeIntent(run, "running", "phase_change", {
      expectedAuthority: buildExpectedAuthority(run)
    });
    await writePendingTransitionIntent(init.workspace, intent);

    const before = await listAutoRunEvents(root, null, run.runId);
    const beforeCount = before.events.filter(
      (e) => (e.data as { transitionId?: string } | undefined)?.transitionId === intent.transitionId
    ).length;
    expect(beforeCount).toBe(0);

    const latest = await getLatestAutoRunSummaryWithDiagnostics(root, null);
    expect(latest.state?.runId).toBe(run.runId);
    expect(latest.state?.phase).toBe("running");

    const after = await listAutoRunEvents(root, null, run.runId);
    const matching = after.events.filter(
      (e) => (e.data as { transitionId?: string } | undefined)?.transitionId === intent.transitionId
    );
    expect(matching.length).toBe(1);
    const pending = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(pending.status).toBe("absent");
  });

  it("publishes verified authority to memory after a projection failure is recovered", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const authority = await writeCommittedState(init.workspace, run, "paused");
    const intent = makeIntent(run, "paused", "pause_completed", {
      expectedAuthority: buildExpectedAuthority(authority)
    });
    await writePendingTransitionIntent(init.workspace, intent);

    const failed = await recoverPendingTransition(init.workspace, run.runId, () => run, {
      buildSessionSummary: sessionSummaryBuilder(),
      adapters: onceFaultAdapters("appendAutoRunEvent")
    });
    expect(failed.recovered).toBe(false);
    expect(failed.authorityState?.phase).toBe("paused");
    expect(
      failed.diagnostics.some(
        (diagnostic) => diagnostic.code === "auto_run_transition_event_heal_failed"
      )
    ).toBe(true);
    expect((await getAutoRunState(run.runId)).phase).toBe("running");
    expect((await readPendingTransitionIntentResult(init.workspace, run.runId)).status).toBe("ok");

    const latest = await getLatestAutoRunSummaryWithDiagnostics(root, null);
    expect(latest.state?.phase).toBe("paused");
    expect((await getAutoRunState(run.runId)).phase).toBe("paused");
    expect((await readPendingTransitionIntentResult(init.workspace, run.runId)).status).toBe(
      "absent"
    );

    const events = await listAutoRunEvents(root, null, run.runId);
    expect(
      events.events.filter(
        (event) =>
          event.type === "pause_completed" &&
          (event.data as { transitionId?: string } | undefined)?.transitionId ===
            intent.transitionId
      )
    ).toHaveLength(1);
  });

  it("pause derives its guard from recovered durable authority instead of stale memory", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const paused = await writeCommittedState(init.workspace, run, "paused");
    const intent = makeIntent(run, "paused", "pause_completed", {
      expectedAuthority: buildExpectedAuthority(paused)
    });
    await writePendingTransitionIntent(init.workspace, intent);

    await expect(pauseAutoRun(run.runId)).resolves.toMatchObject({ phase: "paused" });
    expect((await getAutoRunState(run.runId)).phase).toBe("paused");
    expect((await readRawPersistedAutoRunState(init.workspace, run.runId))?.phase).toBe("paused");
    expect((await readPendingTransitionIntentResult(init.workspace, run.runId)).status).toBe(
      "absent"
    );
  });

  it("resume recovers durable paused authority before deciding to resume", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const paused = await writeCommittedState(init.workspace, run, "paused");
    const intent = makeIntent(run, "paused", "pause_completed", {
      expectedAuthority: buildExpectedAuthority(paused)
    });
    await writePendingTransitionIntent(init.workspace, intent);

    await expect(resumeAutoRun(run.runId)).resolves.toMatchObject({ phase: "running" });
    expect((await getAutoRunState(run.runId)).phase).toBe("running");
    expect((await readRawPersistedAutoRunState(init.workspace, run.runId))?.phase).toBe("running");
    expect((await readPendingTransitionIntentResult(init.workspace, run.runId)).status).toBe(
      "absent"
    );
  });

  it("does not replay projections from a committed transition superseded by newer authority", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const paused = { ...run, phase: "paused" as const, updatedAt: new Date().toISOString() };

    await expect(
      commitAutoRunTransition({
        workspace: init.workspace,
        previous: run,
        next: paused,
        eventType: "pause_completed",
        buildSessionSummary: sessionSummaryBuilder(),
        adapters: onceFaultAdapters("appendAutoRunEvent")
      })
    ).rejects.toThrow("injected appendAutoRunEvent failure");
    const pending = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(pending.status).toBe("ok");
    if (pending.status !== "ok") throw new Error("Expected pending transition.");

    const stopped = await writeCommittedState(init.workspace, paused, "stopped");
    const recovered = await recoverPendingTransition(init.workspace, run.runId, () => run, {
      buildSessionSummary: sessionSummaryBuilder()
    });
    expect(recovered.recovered).toBe(true);
    expect(recovered.authorityState).toMatchObject({
      phase: "stopped",
      updatedAt: stopped.updatedAt
    });
    expect((await readRawPersistedAutoRunState(init.workspace, run.runId))?.phase).toBe("stopped");
    expect((await readPendingTransitionIntentResult(init.workspace, run.runId)).status).toBe(
      "absent"
    );
    expect(
      recovered.diagnostics.some(
        (diagnostic) => diagnostic.code === "auto_run_transition_superseded_after_commit"
      )
    ).toBe(true);
    const events = await listAutoRunEvents(root, null, run.runId);
    expect(
      events.events.filter(
        (event) =>
          event.type === "pause_completed" &&
          (event.data as { transitionId?: string } | undefined)?.transitionId ===
            pending.intent.transitionId
      )
    ).toHaveLength(0);
  });

  it("reconstructs a missing authority state from a committed marker before projecting", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const paused = { ...run, phase: "paused" as const, updatedAt: new Date().toISOString() };

    await expect(
      commitAutoRunTransition({
        workspace: init.workspace,
        previous: run,
        next: paused,
        eventType: "pause_completed",
        buildSessionSummary: sessionSummaryBuilder(),
        adapters: onceFaultAdapters("appendAutoRunEvent")
      })
    ).rejects.toThrow("injected appendAutoRunEvent failure");
    const pending = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(pending.status).toBe("ok");
    if (pending.status !== "ok") throw new Error("Expected pending transition.");
    const { rm } = await import("node:fs/promises");
    await rm(run.statePath, { force: true });

    const recovered = await recoverPendingTransition(init.workspace, run.runId, () => null, {
      buildSessionSummary: sessionSummaryBuilder()
    });
    expect(recovered.recovered).toBe(true);
    expect(recovered.applied).toContain("authority-state");
    expect(await readRawPersistedAutoRunState(init.workspace, run.runId)).toMatchObject({
      phase: "paused",
      updatedAt: paused.updatedAt
    });
    const events = await listAutoRunEvents(root, null, run.runId);
    expect(
      events.events.filter(
        (event) =>
          event.type === "pause_completed" &&
          (event.data as { transitionId?: string } | undefined)?.transitionId ===
            pending.intent.transitionId
      )
    ).toHaveLength(1);
    expect((await readPendingTransitionIntentResult(init.workspace, run.runId)).status).toBe(
      "absent"
    );
  });

  it("keeps recovery evidence when the session event log is corrupt after projection", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const paused = { ...run, phase: "paused" as const, updatedAt: new Date().toISOString() };

    await expect(
      commitAutoRunTransition({
        workspace: init.workspace,
        previous: run,
        next: paused,
        eventType: "pause_completed",
        buildSessionSummary: sessionSummaryBuilder(),
        adapters: {
          clearCommitMarker: async () => {
            throw new Error("injected clearCommitMarker failure");
          }
        }
      })
    ).rejects.toThrow("injected clearCommitMarker failure");
    expect((await readPendingTransitionIntentResult(init.workspace, run.runId)).status).toBe("ok");
    if (!run.runSessionId) throw new Error("Expected the desktop run to have a run session.");

    const sessionEventsPath = join(
      init.workspace.resultsDir,
      "run-sessions",
      run.runSessionId,
      "events.ndjson"
    );
    await appendFile(sessionEventsPath, "{invalid-json\n", "utf8");

    const recovered = await recoverPendingTransition(init.workspace, run.runId, () => run, {
      buildSessionSummary: sessionSummaryBuilder()
    });
    expect(recovered.recovered).toBe(false);
    expect(
      recovered.diagnostics.some(
        (diagnostic) => diagnostic.code === "auto_run_transition_session_heal_failed"
      )
    ).toBe(true);
    expect((await readPendingTransitionIntentResult(init.workspace, run.runId)).status).toBe("ok");
  });

  it("crash after intent before state cleans without phantom advance", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    const intent = makeIntent(run, "paused", "pause_completed", {
      expectedAuthority: buildExpectedAuthority({
        ...run,
        phase: "paused",
        updatedAt: new Date().toISOString()
      })
    });
    await writePendingTransitionIntent(init.workspace, intent);

    const rec = await recoverPendingTransition(init.workspace, run.runId, () => null);
    expect(rec.recovered).toBe(false);
    expect(rec.diagnostics.some((d) => d.code.includes("aborted_before_state"))).toBe(true);
    const latest = await getLatestAutoRunSummaryWithDiagnostics(root, null);
    expect(latest.state?.phase).toBe("running");
  });

  it("same-phase authority mismatch (stale stepCount) is not treated as committed", async () => {
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const run = await startRun(root);
    // Disk still stepCount=0; intent expects stepCount=1 after step_finish.
    const intent = makeIntent(run, "running", "step_finish", {
      expectedAuthority: buildExpectedAuthority({
        ...run,
        phase: "running",
        stepCount: 1,
        currentRef: "T-1#B-001",
        updatedAt: new Date().toISOString()
      }),
      extra: { stepCount: 1, currentRef: "T-1#B-001" }
    });
    await writePendingTransitionIntent(init.workspace, intent);

    const rec = await recoverPendingTransition(init.workspace, run.runId, () => null, {
      buildSessionSummary: sessionSummaryBuilder()
    });
    expect(rec.recovered).toBe(false);
    expect(rec.diagnostics.some((d) => d.code === "auto_run_transition_aborted_before_state")).toBe(
      true
    );
    const events = await listAutoRunEvents(root, null, run.runId);
    expect(events.events.filter((e) => e.type === "step_finish").length).toBe(0);
    const pending = await readPendingTransitionIntentResult(init.workspace, run.runId);
    expect(pending.status).toBe("absent");
    const disk = await readRawPersistedAutoRunState(init.workspace, run.runId);
    expect(disk?.stepCount).toBe(0);
  });
});
