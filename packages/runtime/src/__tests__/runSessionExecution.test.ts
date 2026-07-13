import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getRunSession, runWithSession } from "../runSessions/index.js";
import { getAutoRunStatus, runAutoRunStep } from "../taskManager/autoRun.js";
import { readJsonFile } from "../json.js";
import { listBlockRunRecords } from "../desktop/index.js";
import { isTmuxAvailable, killActiveTmuxSessions } from "../autoRun/tmuxExecutor.js";
import type { RuntimeState } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

const noTmux = { tmuxEnabled: false } as const;

function automaticManifest(reviewVerdict: "passed" | "needs_changes" = "passed") {
  return manifestTestBuilder()
    .withExecutor("fake-implementation", {
      adapter: "codex-exec",
      command: process.execPath,
      args: [
        "-e",
        [
          "let input = '';",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          "  console.log('implementation complete');",
          "});"
        ].join("")
      ]
    })
    .withExecutor("fake-review", {
      adapter: "codex-exec",
      command: process.execPath,
      args: [
        "-e",
        [
          "let input = '';",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          `  console.log(JSON.stringify({ reviewBlockRef: 'T-001#R-001', taskId: 'T-001', verdict: '${reviewVerdict}', content: 'ok' }));`,
          "});"
        ].join("")
      ]
    })
    .withDefaultExecutor("fake-implementation")
    .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "fake-implementation" }))
    .withBlock("T-001", "R-001", (block) => ({ ...block, executor: "fake-review" }))
    .build();
}

function slowImplementationManifest(delayMs = 2_000) {
  return manifestTestBuilder()
    .withExecutor("slow-implementation", {
      adapter: "codex-exec",
      command: process.execPath,
      args: [
        "-e",
        [
          "let input = '';",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          `  setTimeout(() => { console.log('slow implementation complete'); }, ${delayMs});`,
          "});"
        ].join("")
      ]
    })
    .withDefaultExecutor("slow-implementation")
    .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "slow-implementation" }))
    .build();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSessionRecord(
  projectRoot: string,
  sessionId: string,
  recordId: string
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const detail = await getRunSession(projectRoot, sessionId);
      if (
        detail.session.latestRecordId === recordId &&
        detail.events.some((event) => event.type === "step_start" && event.recordId === recordId)
      ) {
        return;
      }
    } catch {
      // The run session may not be created yet.
    }
    await sleep(50);
  }
  const detail = await getRunSession(projectRoot, sessionId);
  expect(detail.session.latestRecordId).toBe(recordId);
}

async function waitForAutoRunStatus(
  projectRoot: string,
  predicate: (status: Awaited<ReturnType<typeof getAutoRunStatus>>) => boolean
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await getAutoRunStatus({ projectRoot });
    if (predicate(status)) {
      return status;
    }
    await sleep(20);
  }
  return getAutoRunStatus({ projectRoot });
}

describe("runWithSession", () => {
  it("creates a run session, resets state, and records the first block run", async () => {
    const { root, init } = await createTestWorkspace(automaticManifest());

    const result = await runWithSession({
      projectRoot: root,
      reset: true,
      stepLimit: 10,
      ...noTmux
    });
    const detail = await getRunSession(root, result.session.sessionId);

    expect(result.session).toMatchObject({
      sessionId: "SESSION-0001",
      kind: "run",
      phase: "completed",
      reset: expect.objectContaining({ performed: true, forced: false, reason: null }),
      autoRun: expect.objectContaining({
        stepCount: 3,
        parallel: false,
        executorOverride: null,
        stopReason: null
      }),
      latestRecordId: "T-001#R-001::RUN-001",
      error: null
    });
    expect(
      detail.events.map((event) => event.type).filter((eventType) => eventType !== "step_start")
    ).toEqual([
      "session_started",
      "reset_started",
      "reset_completed",
      "step_finish",
      "step_finish",
      "step_finish",
      "session_completed"
    ]);
    const stepEvents = detail.events.filter((event) => event.type === "step_finish");
    expect(
      stepEvents.find(
        (event) => JSON.stringify(event.claimRefs) === JSON.stringify(["T-001#B-001"])
      )
    ).toMatchObject({
      stepKind: "submitted",
      recordId: "T-001#B-001::RUN-001",
      recordLinks: [expect.objectContaining({ recordId: "T-001#B-001::RUN-001" })]
    });
    expect(
      stepEvents.find(
        (event) => JSON.stringify(event.claimRefs) === JSON.stringify(["T-001#R-001"])
      )
    ).toMatchObject({
      stepKind: "submitted",
      reviewAttemptId: expect.any(String),
      reviewVerdict: "passed",
      recordId: "T-001#R-001::RUN-001",
      recordLinks: [expect.objectContaining({ recordId: "T-001#R-001::RUN-001" })]
    });
    expect(stepEvents.find((event) => event.stepKind === "idle")).toMatchObject({
      claimRefs: [],
      recordId: null,
      recordLinks: []
    });
    await expect(
      access(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      )
    ).resolves.toBeUndefined();
  });

  it("keeps block run history across repeated forced reset runs", async () => {
    const { root, init } = await createTestWorkspace(automaticManifest());

    await runWithSession({ projectRoot: root, reset: true, stepLimit: 10, ...noTmux });
    const second = await runWithSession({
      projectRoot: root,
      reset: true,
      force: true,
      reason: "  rerun acceptance  ",
      stepLimit: 10,
      ...noTmux
    });

    expect(second.session).toMatchObject({
      sessionId: "SESSION-0002",
      phase: "completed",
      reset: expect.objectContaining({ performed: true, forced: true, reason: "rerun acceptance" }),
      latestRecordId: "T-001#R-001::RUN-002"
    });
    await expect(
      access(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      )
    ).resolves.toBeUndefined();
    await expect(
      access(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-002",
          "metadata.json"
        )
      )
    ).resolves.toBeUndefined();

    const detail = await getRunSession(root, "SESSION-0002");
    expect(detail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reset_started", reason: "rerun acceptance", force: true }),
        expect.objectContaining({
          type: "reset_completed",
          reset: expect.objectContaining({ reason: "rerun acceptance" })
        }),
        expect.objectContaining({
          type: "step_finish",
          stepKind: "submitted",
          claimRefs: ["T-001#B-001"],
          recordId: "T-001#B-001::RUN-002"
        })
      ])
    );
  }, 20_000);

  it("maps a manual step to a manual final session phase", async () => {
    const { root } = await createTestWorkspace();

    const result = await runWithSession({
      projectRoot: root,
      once: true,
      executorName: "manual",
      ...noTmux
    });
    const detail = await getRunSession(root, result.session.sessionId);

    expect(result.session).toMatchObject({
      sessionId: "SESSION-0001",
      phase: "manual",
      autoRun: expect.objectContaining({
        stepCount: 1,
        executorOverride: "manual",
        stopReason: null
      }),
      latestRecordId: "T-001#B-001::RUN-001"
    });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.kind).toBe("manual");
    expect(result).toMatchObject({ ok: true, terminalReason: "manual" });
    expect(detail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "step_finish",
          phase: "running",
          stepKind: "manual",
          claimRefs: ["T-001#B-001"],
          executorName: "manual",
          outputSummary: expect.stringContaining("planweave submit-result")
        }),
        expect.objectContaining({ type: "session_manual", phase: "manual" })
      ])
    );
  });

  it("maps manual steps inside a parallel batch to a manual final session phase", async () => {
    const { root } = await createTestWorkspace(
      basicManifest({ includeSecondTask: true, parallel: true, maxConcurrent: 2 })
    );

    const result = await runWithSession({
      projectRoot: root,
      parallel: true,
      executorName: "manual",
      ...noTmux
    });
    const detail = await getRunSession(root, result.session.sessionId);

    expect(result.session).toMatchObject({
      sessionId: "SESSION-0001",
      phase: "manual",
      autoRun: expect.objectContaining({
        stepCount: 1,
        parallel: true,
        executorOverride: "manual",
        stopReason: null
      }),
      latestRecordId: "T-002#B-001::RUN-001"
    });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      kind: "batch_submitted",
      steps: [
        { kind: "manual", claim: { kind: "block", ref: "T-001#B-001" } },
        { kind: "manual", claim: { kind: "block", ref: "T-002#B-001" } }
      ]
    });
    expect(result).toMatchObject({ ok: true, terminalReason: "manual" });
    expect(detail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "step_finish",
          stepKind: "batch_submitted",
          claimRefs: ["T-001#B-001", "T-002#B-001"],
          recordId: "T-002#B-001::RUN-001",
          recordLinks: [
            expect.objectContaining({ recordId: "T-001#B-001::RUN-001" }),
            expect.objectContaining({ recordId: "T-002#B-001::RUN-001" })
          ],
          outputSummary: "Manual prompts generated for 2 block(s)."
        }),
        expect.objectContaining({ type: "session_manual", phase: "manual" })
      ])
    );
  });

  it("continues from current state when reset is not requested", async () => {
    const { root, init } = await createTestWorkspace(automaticManifest());
    await runAutoRunStep({ projectRoot: root });
    await waitForAutoRunStatus(
      root,
      (currentStatus) =>
        currentStatus.warnings.length === 0 &&
        currentStatus.explanation.nextAction.kind === "start" &&
        currentStatus.explanation.nextAction.ref === "T-001#R-001"
    );

    const result = await runWithSession({ projectRoot: root, once: true, ...noTmux });
    const state = await readJsonFile<RuntimeState>(init.workspace.stateFile);
    const status = await getAutoRunStatus({ projectRoot: root });
    expect(result.session).toMatchObject({
      sessionId: "SESSION-0001",
      phase: "completed",
      reset: null,
      autoRun: expect.objectContaining({ stepCount: 1, stopReason: "once" }),
      latestRecordId: "T-001#R-001::RUN-001"
    });
    expect(result).toMatchObject({ ok: true, terminalReason: "completed" });
    expect(result.steps[0]).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001" }
    });
    expect(state.blocks["T-001#B-001"]).toMatchObject({
      status: "completed",
      lastRunId: "RUN-001"
    });
    expect(status.explanation.latestRecordId).toBe("T-001#R-001::RUN-001");
    await expect(
      readFile(
        join(init.workspace.resultsDir, "run-sessions", "SESSION-0001", "events.ndjson"),
        "utf8"
      )
    ).resolves.not.toContain("reset_completed");
  });

  it("links the active run record before a slow step finishes", async () => {
    const { root, init } = await createTestWorkspace(slowImplementationManifest());

    const running = runWithSession({ projectRoot: root, once: true, ...noTmux });
    await waitForSessionRecord(root, "SESSION-0001", "T-001#B-001::RUN-001");
    const pendingDetail = await getRunSession(root, "SESSION-0001");

    expect(pendingDetail.session).toMatchObject({
      phase: "running",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: expect.stringContaining(
        join("T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json")
      )
    });
    expect(pendingDetail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "step_start",
          claimRefs: ["T-001#B-001"],
          recordId: "T-001#B-001::RUN-001",
          recordLinks: [expect.objectContaining({ recordId: "T-001#B-001::RUN-001" })],
          executorName: "slow-implementation"
        })
      ])
    );

    await expect(running).resolves.toMatchObject({ ok: true, terminalReason: "completed" });
  });

  it("propagates AbortSignal to the selected CLI runner and releases the claim", async () => {
    const { root, init } = await createTestWorkspace(slowImplementationManifest());
    const abort = new AbortController();

    const running = runWithSession({
      projectRoot: root,
      once: true,
      signal: abort.signal,
      ...noTmux
    });
    await waitForSessionRecord(root, "SESSION-0001", "T-001#B-001::RUN-001");
    abort.abort();
    const result = await running;
    const detail = await getRunSession(root, result.session.sessionId);
    const state = await readJsonFile<RuntimeState>(init.workspace.stateFile);
    const status = await getAutoRunStatus({ projectRoot: root });
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    const metadata = await readJsonFile<Record<string, unknown>>(join(runDir, "metadata.json"));
    const heartbeat = await readJsonFile<{ pid: number | null; status: string }>(
      join(runDir, "heartbeat.json")
    );
    const desktopRecords = await listBlockRunRecords(root, "T-001#B-001");

    expect(result).toMatchObject({ ok: false, terminalReason: "cancelled" });
    expect(result.session).toMatchObject({
      phase: "stopped",
      autoRun: expect.objectContaining({
        stopReason: "cancelled",
        effectiveExecutor: "slow-implementation",
        agentId: "codex",
        runnerKind: "cli"
      }),
      error: null
    });
    expect(detail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session_stopped",
          phase: "stopped",
          stopReason: "cancelled"
        })
      ])
    );
    expect(status.current.refs).toEqual([]);
    expect(status.explanation.phase).not.toBe("running");
    expect(status.latestRuns[0]).toMatchObject({
      finishedAt: expect.any(String),
      failureReason: "Executor cancelled."
    });
    expect(metadata).toMatchObject({
      finishedAt: expect.any(String),
      exitCode: 130,
      outcome: "cancelled",
      cancelled: true,
      stopped: true,
      timedOut: false,
      failureReason: "Executor cancelled."
    });
    expect(heartbeat.status).not.toBe("running");
    if (heartbeat.pid !== null) {
      expect(() => process.kill(heartbeat.pid!, 0)).toThrow();
    }
    expect(desktopRecords[0]).toMatchObject({
      recordId: "T-001#B-001::RUN-001",
      finishedAt: expect.any(String),
      exitCode: 130
    });
    expect(state.blocks["T-001#B-001"]?.status).toBe("ready");
  });

  it("retains ACP executor identity when fail-closed execution blocks before a run record", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("codex-acp", {
        adapter: "agent",
        agent: "codex",
        runner: { transport: "acp" }
      })
      .withDefaultExecutor("codex-acp")
      .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "codex-acp" }))
      .build();
    const { root } = await createTestWorkspace(manifest);

    const result = await runWithSession({ projectRoot: root, once: true, ...noTmux });

    expect(result).toMatchObject({
      ok: false,
      terminalReason: "blocked",
      steps: [
        {
          kind: "blocked",
          runnerEvidence: {
            effectiveExecutor: "codex-acp",
            agentId: "codex",
            runnerKind: "acp"
          }
        }
      ],
      session: {
        phase: "blocked",
        latestRecordId: null,
        autoRun: {
          effectiveExecutor: "codex-acp",
          agentId: "codex",
          runnerKind: "acp"
        }
      }
    });
  });

  it("finalizes cancelled tmux run metadata and releases the tmux session", async () => {
    if (!(await isTmuxAvailable())) {
      return;
    }
    const { root, init } = await createTestWorkspace(slowImplementationManifest(60_000));
    const abort = new AbortController();
    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    const metadataPath = join(runDir, "metadata.json");

    const running = runWithSession({
      projectRoot: root,
      once: true,
      signal: abort.signal,
      tmuxEnabled: true
    });
    await waitForSessionRecord(root, "SESSION-0001", "T-001#B-001::RUN-001");
    let inFlightMetadata: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      inFlightMetadata = await readJsonFile<Record<string, unknown>>(metadataPath);
      if (typeof inFlightMetadata.tmuxSessionName === "string") {
        break;
      }
      await sleep(25);
    }
    expect(inFlightMetadata.tmuxSessionName).toEqual(expect.any(String));

    abort.abort();
    const result = await running;
    const metadata = await readJsonFile<Record<string, unknown>>(metadataPath);

    expect(result).toMatchObject({ ok: false, terminalReason: "cancelled" });
    expect(metadata).toMatchObject({
      finishedAt: expect.any(String),
      exitCode: 130,
      outcome: "cancelled",
      cancelled: true,
      stopped: true,
      failureReason: "Executor cancelled."
    });
    await expect(killActiveTmuxSessions()).resolves.toEqual([]);
  });

  it("marks step-limit exhaustion as completed with a stop reason instead of stopped", async () => {
    const { root } = await createTestWorkspace(automaticManifest());

    const result = await runWithSession({ projectRoot: root, stepLimit: 1, ...noTmux });
    const detail = await getRunSession(root, result.session.sessionId);

    expect(result.session).toMatchObject({
      phase: "completed",
      autoRun: expect.objectContaining({ stepCount: 1, stopReason: "step_limit" })
    });
    expect(result).toMatchObject({ ok: true, terminalReason: "step_limit_reached" });
    expect(result.steps).toHaveLength(1);
    expect(result.status.explanation.nextAction.kind).toBe("start");
    expect(detail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "session_completed",
          phase: "completed",
          stopReason: "step_limit"
        })
      ])
    );
  });

  it("supports zero-step sessions without using stopped phase", async () => {
    const { root } = await createTestWorkspace(automaticManifest());

    const result = await runWithSession({ projectRoot: root, stepLimit: 0, ...noTmux });

    expect(result.session).toMatchObject({
      phase: "completed",
      autoRun: expect.objectContaining({ stepCount: 0, stopReason: "no_steps" }),
      latestRecordId: null
    });
    expect(result.steps).toEqual([]);
  });

  it("persists a failed session when reset is refused for active work", async () => {
    const { root } = await createTestWorkspace(automaticManifest());
    await runAutoRunStep({ projectRoot: root, executorName: "manual" });

    const result = await runWithSession({ projectRoot: root, reset: true, ...noTmux });
    const detail = await getRunSession(root, result.session.sessionId);

    expect(result).toMatchObject({ ok: false, terminalReason: "failed" });
    expect(result.session).toMatchObject({
      phase: "failed",
      error: expect.stringContaining("Cannot reset runtime state while active work exists")
    });
    expect(detail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reset_started" }),
        expect.objectContaining({ type: "session_failed", phase: "failed" })
      ])
    );
  });

  it("records feedback run links and keeps session latest record scoped to this run", async () => {
    const { root } = await createTestWorkspace(automaticManifest("needs_changes"));

    const result = await runWithSession({ projectRoot: root, stepLimit: 3, ...noTmux });
    const detail = await getRunSession(root, result.session.sessionId);
    const feedbackStep = detail.events.find(
      (event) => event.type === "step_finish" && event.recordId === "FE-001::RUN-001"
    );

    expect(result.session).toMatchObject({
      phase: "completed",
      latestRecordId: "FE-001::RUN-001",
      latestRecordPath: expect.stringContaining(join("feedback-runs", "RUN-001", "metadata.json")),
      autoRun: expect.objectContaining({ stepCount: 3, stopReason: "step_limit" })
    });
    expect(result).toMatchObject({ ok: true, terminalReason: "step_limit_reached" });
    expect(feedbackStep).toMatchObject({
      stepKind: "submitted",
      claimRefs: ["T-001#R-001"],
      feedbackId: "FE-001",
      recordId: "FE-001::RUN-001",
      recordPath: expect.stringContaining(join("feedback-runs", "RUN-001", "metadata.json")),
      recordLinks: [expect.objectContaining({ recordId: "FE-001::RUN-001" })]
    });
  });
});
