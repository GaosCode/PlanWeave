import { describe, expect, it } from "vitest";
import { normalizedRunnerEventSchema } from "../autoRun/normalizedEventContract.js";
import { runnerRecordReadModelSchema } from "../autoRun/runnerRecordReadModel.js";
import { runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import {
  projectTaskWorkspaceRun,
  taskWorkspaceRunDurationSchema,
  taskWorkspaceRunSchema
} from "../desktop/index.js";
import type { DesktopRunRecord } from "../desktop/types.js";

const runIdentity = runnerRunIdentitySchema.parse({
  projectId: "project-1",
  canvasId: "default",
  taskId: "T-001",
  blockId: "B-001",
  claimRef: "T-001#B-001",
  runId: "RUN-001",
  runOwner: "executor",
  runSessionId: "SESSION-001",
  desktopRunId: "DESKTOP-001",
  executorRunId: "RUN-001"
});

const runner = {
  version: "planweave.runner/v1" as const,
  runnerKind: "acp" as const,
  agentId: "codex" as const
};

const promptIdentity = {
  ref: { projectRoot: "/project", canvasId: "default" },
  recordId: "T-001#B-001::RUN-001",
  executorRunId: "RUN-001",
  claimRef: "T-001#B-001",
  sessionId: "session-1"
};

const cancelIdentity = {
  scope: "/project/results/RUN-001",
  executorRunId: "RUN-001",
  desktopRunId: "DESKTOP-001",
  runSessionId: "SESSION-001",
  claimRef: "T-001#B-001",
  sessionId: "session-1"
};

function usageEvent(sequence: number, usedTokens: number, timestamp: string) {
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence,
    timestamp,
    identity: runIdentity,
    runner,
    correlation: { sessionId: "session-1" },
    body: {
      kind: "usage_update",
      usedTokens,
      contextWindowTokens: 100,
      cost: { amount: sequence, currency: "USD" }
    }
  });
}

function readModel(
  events = [
    usageEvent(1, 20, "2026-07-13T00:00:01.000Z"),
    usageEvent(2, 35, "2026-07-13T00:00:02.000Z")
  ],
  canonicalIdentity: typeof runIdentity | null = runIdentity,
  cancelSessionId = "session-1"
) {
  return runnerRecordReadModelSchema.parse({
    events,
    conversation: [],
    timeline: [],
    diagnostics: [],
    cursor: {
      version: "planweave.runner-event-cursor/v1",
      runId: "RUN-001",
      afterSequence: events.at(-1)?.sequence ?? 0,
      canonicalIdentity:
        canonicalIdentity === null ? null : { identity: canonicalIdentity, runner },
      terminal: false
    },
    terminal: false,
    intervention: {
      prompt: {
        available: true,
        reason: null,
        identity: promptIdentity,
        inFlight: false
      },
      cancel: {
        available: true,
        reason: null,
        identity: { ...cancelIdentity, sessionId: cancelSessionId }
      }
    },
    interaction: {
      persisted: false,
      active: false,
      stale: false,
      activeRequests: []
    }
  });
}

function blockRecord(overrides: Partial<DesktopRunRecord> = {}): DesktopRunRecord {
  return {
    recordId: "T-001#B-001::RUN-001",
    kind: "block",
    ref: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    runId: "RUN-001",
    executor: "codex",
    adapter: "agent",
    executionCwd: "/project",
    projectRoot: "/project",
    agentSessionId: "session-1",
    codexSessionId: null,
    tmuxSessionId: "tmux-1",
    exitCode: null,
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: null,
    promptPath: null,
    reportPath: null,
    metadataPath: "/project/results/RUN-001/metadata.json",
    stdoutSummary: "",
    stderrSummary: "",
    promptMarkdown: "",
    reportMarkdown: "",
    displayMarkdown: "",
    displayMarkdownSource: "none",
    metadata: { runnerKind: "acp", agentId: "codex" },
    runnerReadModel: readModel(),
    ...overrides
  };
}

describe("Task Workspace run projection", () => {
  it("preserves exact record, runner, prompt, and cancel identities", () => {
    const projected = projectTaskWorkspaceRun({
      record: blockRecord(),
      runIdentity,
      now: new Date("2026-07-13T00:00:05.000Z")
    });

    expect(projected.record).toEqual({
      recordId: "T-001#B-001::RUN-001",
      ref: "T-001#B-001",
      taskId: "T-001",
      blockId: "B-001",
      runId: "RUN-001"
    });
    expect(projected.runIdentity).toEqual(runIdentity);
    expect(projected.metadata).toMatchObject({ runnerKind: "acp", agentId: "codex" });
    expect(projected.capabilities.prompt).toEqual({
      available: true,
      reason: null,
      identity: promptIdentity,
      inFlight: false
    });
    expect(projected.capabilities.cancel).toEqual({
      available: true,
      reason: null,
      identity: cancelIdentity
    });
    expect(projected.capabilities.retry).toMatchObject({
      available: false,
      identity: null
    });
    expect(projected.capabilities.resume).toMatchObject({
      available: false,
      identity: null
    });
  });

  it("uses only the latest usage_update as a current-context snapshot", () => {
    const projected = projectTaskWorkspaceRun({
      record: blockRecord({
        runnerReadModel: readModel([
          usageEvent(2, 35, "2026-07-13T00:00:02.000Z"),
          usageEvent(1, 20, "2026-07-13T00:00:01.000Z")
        ])
      }),
      runIdentity,
      now: new Date("2026-07-13T00:00:05.000Z")
    });

    expect(projected.usage.currentContext).toEqual({
      aggregation: "snapshot",
      sequence: 2,
      observedAt: "2026-07-13T00:00:02.000Z",
      usedTokens: 35,
      contextWindowTokens: 100,
      cost: { amount: 2, currency: "USD" }
    });
    expect(projected.usage.currentContext?.usedTokens).not.toBe(55);
    expect(projected.usage.runTokens).toMatchObject({ available: false, totalTokens: null });
    expect(projected.usage.taskTokens).toMatchObject({ available: false, totalTokens: null });
  });

  it("calculates active and finished duration from an injected current time", () => {
    const now = new Date("2026-07-13T00:00:05.000Z");
    const active = projectTaskWorkspaceRun({ record: blockRecord(), runIdentity, now });
    const finished = projectTaskWorkspaceRun({
      record: blockRecord({ finishedAt: "2026-07-13T00:00:03.000Z" }),
      runIdentity,
      now
    });
    const missingStart = projectTaskWorkspaceRun({
      record: blockRecord({ startedAt: null }),
      runIdentity,
      now
    });

    expect(active.duration).toMatchObject({
      calculatedAt: "2026-07-13T00:00:05.000Z",
      wallClockMs: 5_000,
      unavailableReason: null
    });
    expect(finished.duration).toMatchObject({
      calculatedAt: "2026-07-13T00:00:05.000Z",
      wallClockMs: 3_000,
      unavailableReason: null
    });
    expect(missingStart.duration).toMatchObject({
      wallClockMs: null,
      unavailableReason: expect.stringContaining("startedAt is missing")
    });
  });

  it("parses valid and legacy wave metadata and rejects malformed wave ids", () => {
    const now = new Date("2026-07-13T00:00:05.000Z");
    const executionWaveId = "WAVE-123e4567-e89b-42d3-a456-426614174000";

    expect(
      projectTaskWorkspaceRun({
        record: blockRecord({ metadata: { executionWaveId } }),
        runIdentity,
        now
      }).executionWaveId
    ).toBe(executionWaveId);
    expect(
      projectTaskWorkspaceRun({
        record: blockRecord({ metadata: {} }),
        runIdentity,
        now
      }).executionWaveId
    ).toBeNull();
    expect(() =>
      projectTaskWorkspaceRun({
        record: blockRecord({ metadata: { executionWaveId: "WAVE-nearby-time" } }),
        runIdentity,
        now
      })
    ).toThrow(/Execution wave id/);
  });

  it("rejects feedback records, mismatched identity, and unknown public fields", () => {
    const now = new Date("2026-07-13T00:00:05.000Z");
    expect(() =>
      projectTaskWorkspaceRun({
        record: blockRecord({ kind: "feedback" }),
        runIdentity,
        now
      })
    ).toThrow();
    expect(() =>
      projectTaskWorkspaceRun({
        record: blockRecord(),
        runIdentity: runnerRunIdentitySchema.parse({
          ...runIdentity,
          taskId: "T-002",
          claimRef: "T-002#B-001"
        }),
        now
      })
    ).toThrow(/canonical runner record identity/);

    const projected = projectTaskWorkspaceRun({ record: blockRecord(), runIdentity, now });
    expect(taskWorkspaceRunSchema.safeParse({ ...projected, extra: true }).success).toBe(false);
  });

  it.each([
    "T-002#B-001::RUN-001",
    "T-001#B-001::RUN-OTHER"
  ])("rejects record id '%s' when its ref or run id does not match", (recordId) => {
    expect(() =>
      projectTaskWorkspaceRun({
        record: blockRecord({
          recordId,
          runnerReadModel: null
        }),
        runIdentity,
        now: new Date("2026-07-13T00:00:05.000Z")
      })
    ).toThrow(/recordId/);
  });

  it("requires executorRunId to equal the persisted record runId", () => {
    const mismatchedExecutorIdentity = runnerRunIdentitySchema.parse({
      ...runIdentity,
      runOwner: "desktop",
      desktopRunId: "RUN-001",
      executorRunId: "RUN-OTHER"
    });

    expect(() =>
      projectTaskWorkspaceRun({
        record: blockRecord({ runnerReadModel: null }),
        runIdentity: mismatchedExecutorIdentity,
        now: new Date("2026-07-13T00:00:05.000Z")
      })
    ).toThrow(/executorRunId/);
  });

  it("fails closed for missing or mismatched canonical runner identities", () => {
    const foreignProjectIdentity = runnerRunIdentitySchema.parse({
      ...runIdentity,
      projectId: "project-2"
    });
    const now = new Date("2026-07-13T00:00:05.000Z");

    expect(() =>
      projectTaskWorkspaceRun({
        record: blockRecord({ runnerReadModel: readModel(undefined, foreignProjectIdentity) }),
        runIdentity,
        now
      })
    ).toThrow(/canonical runner record identity/);
    expect(() =>
      projectTaskWorkspaceRun({
        record: blockRecord({ runnerReadModel: readModel(undefined, null) }),
        runIdentity,
        now
      })
    ).toThrow(/canonical runner record identity/);
  });

  it("rejects prompt and cancel identities that target different sessions", () => {
    expect(() =>
      projectTaskWorkspaceRun({
        record: blockRecord({
          runnerReadModel: readModel(undefined, runIdentity, "session-2")
        }),
        runIdentity,
        now: new Date("2026-07-13T00:00:05.000Z")
      })
    ).toThrow(/same sessionId/);
  });

  it("rejects duration without a start time when wall-clock data is present or unexplained", () => {
    expect(
      taskWorkspaceRunDurationSchema.safeParse({
        startedAt: null,
        finishedAt: null,
        calculatedAt: "2026-07-13T00:00:05.000Z",
        wallClockMs: 1,
        unavailableReason: null
      }).success
    ).toBe(false);
    expect(
      taskWorkspaceRunDurationSchema.safeParse({
        startedAt: null,
        finishedAt: null,
        calculatedAt: "2026-07-13T00:00:05.000Z",
        wallClockMs: null,
        unavailableReason: null
      }).success
    ).toBe(false);
  });

  it("reports prompt and cancel unavailable without inventing identities", () => {
    const projected = projectTaskWorkspaceRun({
      record: blockRecord({ runnerReadModel: null }),
      runIdentity,
      now: new Date("2026-07-13T00:00:05.000Z")
    });

    expect(projected.capabilities.prompt).toMatchObject({
      available: false,
      identity: null,
      inFlight: false
    });
    expect(projected.capabilities.cancel).toMatchObject({
      available: false,
      identity: null
    });
  });
});
