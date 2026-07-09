import { describe, expect, it } from "vitest";
import {
  type AutoRunStatus,
  type AutoRunStepResult,
  type RunSessionState
} from "@planweave-ai/runtime";
import {
  formatResetResult,
  formatRunResult,
  formatRunSessionDetail,
  formatRunSessions,
  formatRunStatusHuman
} from "../commands/formatters/runFormatters.js";

describe("planweave CLI run command output", () => {
  it("prints run session diagnostics even when no valid sessions exist", () => {
    expect(
      formatRunSessions({
        sessions: [],
        diagnostics: [
          {
            code: "run_session_read_failed",
            sessionId: "SESSION-0001",
            path: "/tmp/project/results/run-sessions/SESSION-0001/session.json",
            message: "Unexpected token"
          }
        ]
      })
    ).toContain("diagnostics:\n- SESSION-0001 run_session_read_failed: Unexpected token");
  });

  it("prints run session stop reasons in text summaries", () => {
    expect(
      formatRunSessions({
        sessions: [
          {
            sessionId: "SESSION-0001",
            kind: "run",
            trigger: "manual",
            projectRoot: "/tmp/project",
            canvasId: "default",
            scope: { kind: "project" },
            phase: "completed",
            startedAt: "2026-06-25T00:00:00.000Z",
            updatedAt: "2026-06-25T00:00:01.000Z",
            finishedAt: "2026-06-25T00:00:01.000Z",
            reset: null,
            autoRun: {
              desktopRunId: null,
              stepCount: 1,
              parallel: false,
              executorOverride: null,
              stopReason: "step_limit"
            },
            latestRecordId: "T-001#B-001::RUN-001",
            latestRecordPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
            error: null
          }
        ],
        diagnostics: []
      })
    ).toContain("SESSION-0001 run completed steps=1 stop=step_limit");
  });

  it("prints run session details in human output", () => {
    const session: RunSessionState = {
      sessionId: "SESSION-0001",
      kind: "run",
      trigger: "manual",
      projectRoot: "/tmp/project",
      canvasId: "default",
      scope: { kind: "project" },
      phase: "completed",
      startedAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:01.000Z",
      finishedAt: "2026-06-25T00:00:01.000Z",
      reset: null,
      autoRun: {
        desktopRunId: null,
        stepCount: 1,
        parallel: false,
        executorOverride: null,
        stopReason: "once"
      },
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
      error: null
    };

    expect(
      formatRunSessionDetail({
        session,
        events: [
          {
            timestamp: "2026-06-25T00:00:00.000Z",
            sessionId: "SESSION-0001",
            type: "session_created",
            phase: "running"
          }
        ],
        diagnostics: []
      })
    ).toContain("events:\n- 2026-06-25T00:00:00.000Z session_created running");
  });

  it("prints reset summaries in human output", () => {
    const session: RunSessionState = {
      sessionId: "SESSION-0001",
      kind: "reset",
      trigger: "manual",
      projectRoot: "/tmp/project",
      canvasId: "default",
      scope: { kind: "project" },
      phase: "completed",
      startedAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:01.000Z",
      finishedAt: "2026-06-25T00:00:01.000Z",
      reset: null,
      autoRun: null,
      latestRecordId: null,
      latestRecordPath: null,
      error: null
    };

    expect(
      formatResetResult({
        session,
        sessionId: "SESSION-0001",
        statePath: "/tmp/project/canvases/default/state.json",
        reason: "restart",
        forced: true,
        previousCurrentRefs: ["T-001#B-001"],
        previousCurrentFeedbackId: null,
        previousCurrentReviewBlockRef: null,
        previousInProgressRefs: []
      })
    ).toContain("forced: yes\nprevious current refs: T-001#B-001");
  });

  it("prints step-limit terminal reason in run text output", () => {
    expect(
      formatRunResult({
        session: {
          sessionId: "SESSION-0001",
          kind: "run",
          trigger: "manual",
          projectRoot: "/tmp/project",
          canvasId: "default",
          scope: { kind: "project" },
          phase: "completed",
          startedAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:01.000Z",
          finishedAt: "2026-06-25T00:00:01.000Z",
          reset: null,
          autoRun: {
            desktopRunId: null,
            stepCount: 1,
            parallel: false,
            executorOverride: null,
            stopReason: "step_limit"
          },
          latestRecordId: "T-001#B-001::RUN-001",
          latestRecordPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
          error: null
        },
        steps: [],
        terminalReason: "step_limit_reached"
      })
    ).toContain("terminal: completed by step limit");
  });

  it("prints manual prompt summaries for manual parallel batches", () => {
    const batchStep = {
      kind: "batch_submitted",
      claim: {
        kind: "batch",
        refs: ["T-001#B-001", "T-002#B-001"],
        effectiveExecutors: {
          "T-001#B-001": "manual",
          "T-002#B-001": "manual"
        }
      },
      steps: [
        {
          kind: "manual",
          claim: {
            kind: "block",
            ref: "T-001#B-001",
            taskId: "T-001",
            blockId: "B-001",
            blockType: "implementation",
            effectiveExecutor: "manual"
          },
          adapterResult: {
            kind: "manual",
            executor: "manual",
            adapter: "manual",
            promptPath: "/tmp/project/package/nodes/T-001/blocks/B-001.prompt.md",
            runDir: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001",
            runId: "RUN-001",
            nextCommand: "planweave submit-result T-001#B-001 --report <report.md>"
          }
        },
        {
          kind: "manual",
          claim: {
            kind: "block",
            ref: "T-002#B-001",
            taskId: "T-002",
            blockId: "B-001",
            blockType: "implementation",
            effectiveExecutor: "manual"
          },
          adapterResult: {
            kind: "manual",
            executor: "manual",
            adapter: "manual",
            promptPath: "/tmp/project/package/nodes/T-002/blocks/B-001.prompt.md",
            runDir: "/tmp/project/results/T-002/blocks/B-001/runs/RUN-001",
            runId: "RUN-001",
            nextCommand: "planweave submit-result T-002#B-001 --report <report.md>"
          }
        }
      ]
    } satisfies AutoRunStepResult;

    expect(
      formatRunResult({
        session: {
          sessionId: "SESSION-0001",
          kind: "run",
          trigger: "manual",
          projectRoot: "/tmp/project",
          canvasId: "default",
          scope: { kind: "project" },
          phase: "manual",
          startedAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:01.000Z",
          finishedAt: "2026-06-25T00:00:01.000Z",
          reset: null,
          autoRun: {
            desktopRunId: null,
            stepCount: 1,
            parallel: true,
            executorOverride: "manual",
            stopReason: null
          },
          latestRecordId: "T-002#B-001::RUN-001",
          latestRecordPath: "/tmp/project/results/T-002/blocks/B-001/runs/RUN-001/metadata.json",
          error: null
        },
        steps: [batchStep],
        terminalReason: "manual"
      })
    ).toContain("manual prompts generated for 2 blocks");
  });

  it("prints run status using the command-layer default start command", () => {
    const status: AutoRunStatus = {
      current: {
        refs: [],
        feedbackId: null,
        reviewBlockRef: null
      },
      latestRuns: [
        {
          kind: "block",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          status: "completed",
          runId: "RUN-001",
          executor: "manual",
          adapter: "manual",
          startedAt: "2026-06-25T00:00:00.000Z",
          finishedAt: "2026-06-25T00:00:01.000Z",
          stdoutSummary: "ok",
          stderrSummary: "",
          failureReason: null,
          promptPath: "/tmp/project/package/nodes/T-001/blocks/B-001.prompt.md",
          reportPath: "/tmp/project/results/T-001/blocks/B-001/report.md",
          metadataPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
          stdoutUpdatedAt: "2026-06-25T00:00:01.000Z",
          stderrUpdatedAt: null,
          metadataUpdatedAt: "2026-06-25T00:00:01.000Z",
          heartbeatPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/heartbeat.json",
          heartbeatUpdatedAt: "2026-06-25T00:00:01.000Z",
          heartbeatStatus: "running",
          heartbeatPid: 1234,
          lastHeartbeatAt: "2026-06-25T00:00:01.000Z",
          lastActivityAt: "2026-06-25T00:00:01.000Z",
          lastOutputAt: "2026-06-25T00:00:01.000Z",
          tmuxSessionName: null,
          tmuxAttachCommand: null,
          tmuxReadOnlyAttachCommand: null
        }
      ],
      explanation: {
        phase: "idle",
        currentRef: null,
        currentExecutor: null,
        latestRecordId: "T-001#B-001::RUN-001",
        latestRecordPath: "/tmp/project/results/T-001/blocks/B-001/runs/RUN-001/metadata.json",
        latestOutputSummary: "ok",
        error: null,
        nextAction: {
          kind: "start",
          message: "Start auto-run.",
          command: null,
          targetPath: null,
          ref: null
        }
      },
      warnings: []
    };

    const text = formatRunStatusHuman(status, {
      defaultStartCommand: "planweave run --canvas default"
    });
    expect(text).toContain("next command: planweave run --canvas default");
    expect(text).toContain("liveness: status=running");
    expect(text).toContain("pid=1234");
    expect(text).toContain("lastActivity=2026-06-25T00:00:01.000Z");
  });
});
