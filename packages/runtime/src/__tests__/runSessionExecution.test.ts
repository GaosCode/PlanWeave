import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getRunSession, runWithSession } from "../runSessions/index.js";
import { getAutoRunStatus, runAutoRunStep } from "../taskManager/autoRun.js";
import { readJsonFile } from "../json.js";
import type { RuntimeState } from "../types.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

function automaticManifest(reviewVerdict: "passed" | "needs_changes" = "passed") {
  return manifestTestBuilder()
    .withExecutor("fake-implementation", {
      adapter: "codex-exec",
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdin.resume();",
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
          "process.stdin.resume();",
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

function slowImplementationManifest() {
  return manifestTestBuilder()
    .withExecutor("slow-implementation", {
      adapter: "codex-exec",
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdin.resume();",
          "process.stdin.on('end', () => {",
          "  setTimeout(() => { console.log('slow implementation complete'); }, 700);",
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

async function waitForSessionRecord(projectRoot: string, sessionId: string, recordId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const detail = await getRunSession(projectRoot, sessionId);
      if (detail.session.latestRecordId === recordId && detail.events.some((event) => event.type === "step_start" && event.recordId === recordId)) {
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

describe("runWithSession", () => {
  it("creates a run session, resets state, and records the first block run", async () => {
    const { root, init } = await createTestWorkspace(automaticManifest());

    const result = await runWithSession({ projectRoot: root, reset: true, stepLimit: 10 });
    const detail = await getRunSession(root, result.session.sessionId);

    expect(result.session).toMatchObject({
      sessionId: "SESSION-0001",
      kind: "run",
      phase: "completed",
      reset: expect.objectContaining({ performed: true, forced: false, reason: null }),
      autoRun: expect.objectContaining({ stepCount: 3, parallel: false, executorOverride: null, stopReason: null }),
      latestRecordId: "T-001#R-001::RUN-001",
      error: null
    });
    expect(detail.events.map((event) => event.type).filter((eventType) => eventType !== "step_start")).toEqual([
      "session_started",
      "reset_started",
      "reset_completed",
      "step_finish",
      "step_finish",
      "step_finish",
      "session_completed"
    ]);
    const stepEvents = detail.events.filter((event) => event.type === "step_finish");
    expect(stepEvents.find((event) => JSON.stringify(event.claimRefs) === JSON.stringify(["T-001#B-001"]))).toMatchObject({
      stepKind: "submitted",
      recordId: "T-001#B-001::RUN-001",
      recordLinks: [expect.objectContaining({ recordId: "T-001#B-001::RUN-001" })]
    });
    expect(stepEvents.find((event) => JSON.stringify(event.claimRefs) === JSON.stringify(["T-001#R-001"]))).toMatchObject({
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
    await expect(access(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json"))).resolves.toBeUndefined();
  });

  it("keeps block run history across repeated forced reset runs", async () => {
    const { root, init } = await createTestWorkspace(automaticManifest());

    await runWithSession({ projectRoot: root, reset: true, stepLimit: 10 });
    const second = await runWithSession({ projectRoot: root, reset: true, force: true, reason: "  rerun acceptance  ", stepLimit: 10 });

    expect(second.session).toMatchObject({
      sessionId: "SESSION-0002",
      phase: "completed",
      reset: expect.objectContaining({ performed: true, forced: true, reason: "rerun acceptance" }),
      latestRecordId: "T-001#R-001::RUN-002"
    });
    await expect(access(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json"))).resolves.toBeUndefined();
    await expect(access(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-002", "metadata.json"))).resolves.toBeUndefined();

    const detail = await getRunSession(root, "SESSION-0002");
    expect(detail.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reset_started", reason: "rerun acceptance", force: true }),
        expect.objectContaining({ type: "reset_completed", reset: expect.objectContaining({ reason: "rerun acceptance" }) }),
        expect.objectContaining({ type: "step_finish", stepKind: "submitted", claimRefs: ["T-001#B-001"], recordId: "T-001#B-001::RUN-002" })
      ])
    );
  }, 20_000);

  it("maps a manual step to a manual final session phase", async () => {
    const { root } = await createTestWorkspace();

    const result = await runWithSession({ projectRoot: root, once: true, executorName: "manual" });
    const detail = await getRunSession(root, result.session.sessionId);

    expect(result.session).toMatchObject({
      sessionId: "SESSION-0001",
      phase: "manual",
      autoRun: expect.objectContaining({ stepCount: 1, executorOverride: "manual", stopReason: null }),
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
    const { root } = await createTestWorkspace(basicManifest({ includeSecondTask: true, parallel: true, maxConcurrent: 2 }));

    const result = await runWithSession({ projectRoot: root, parallel: true, executorName: "manual" });
    const detail = await getRunSession(root, result.session.sessionId);

    expect(result.session).toMatchObject({
      sessionId: "SESSION-0001",
      phase: "manual",
      autoRun: expect.objectContaining({ stepCount: 1, parallel: true, executorOverride: "manual", stopReason: null }),
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

    const result = await runWithSession({ projectRoot: root, once: true });
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
    expect(state.blocks["T-001#B-001"]).toMatchObject({ status: "completed", lastRunId: "RUN-001" });
    expect(status.explanation.latestRecordId).toBe("T-001#R-001::RUN-001");
    await expect(readFile(join(init.workspace.resultsDir, "run-sessions", "SESSION-0001", "events.ndjson"), "utf8")).resolves.not.toContain(
      "reset_completed"
    );
  });

  it("links the active run record before a slow step finishes", async () => {
    const { root } = await createTestWorkspace(slowImplementationManifest());

    const running = runWithSession({ projectRoot: root, once: true });
    await waitForSessionRecord(root, "SESSION-0001", "T-001#B-001::RUN-001");
    const pendingDetail = await getRunSession(root, "SESSION-0001");

    expect(pendingDetail.session).toMatchObject({
      phase: "running",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: expect.stringContaining(join("T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json"))
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

  it("marks step-limit exhaustion as completed with a stop reason instead of stopped", async () => {
    const { root } = await createTestWorkspace(automaticManifest());

    const result = await runWithSession({ projectRoot: root, stepLimit: 1 });
    const detail = await getRunSession(root, result.session.sessionId);

    expect(result.session).toMatchObject({
      phase: "completed",
      autoRun: expect.objectContaining({ stepCount: 1, stopReason: "step_limit" })
    });
    expect(result).toMatchObject({ ok: true, terminalReason: "step_limit_reached" });
    expect(result.steps).toHaveLength(1);
    expect(result.status.explanation.nextAction.kind).toBe("start");
    expect(detail.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "session_completed", phase: "completed", stopReason: "step_limit" })])
    );
  });

  it("supports zero-step sessions without using stopped phase", async () => {
    const { root } = await createTestWorkspace(automaticManifest());

    const result = await runWithSession({ projectRoot: root, stepLimit: 0 });

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

    const result = await runWithSession({ projectRoot: root, reset: true });
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

    const result = await runWithSession({ projectRoot: root, stepLimit: 3 });
    const detail = await getRunSession(root, result.session.sessionId);
    const feedbackStep = detail.events.find((event) => event.type === "step_finish" && event.recordId === "FE-001::RUN-001");

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
