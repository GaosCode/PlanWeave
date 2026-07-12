import { describe, expect, it, vi } from "vitest";
import {
  RUNNER_EVENT_MAX_LINE_BYTES,
  RUNNER_EVENT_MAX_MESSAGE_BYTES,
  RUNNER_EVENT_RETENTION_MAX_BYTES,
  encodeNormalizedRunnerEvent,
  normalizedDiagnosticBody,
  normalizedOutputBody,
  normalizedRunnerEventSchema
} from "../autoRun/normalizedEventContract.js";
import { replayNormalizedRunnerEvents } from "../autoRun/runnerEventReplay.js";
import {
  negotiatedCapabilitiesSchema,
  persistedPendingInteractionSchema,
  runnerRunIdentitySchema,
  terminalOutcomeSchema
} from "../autoRun/runnerContractSchemas.js";
import {
  RunnerCleanupError,
  assertLiveOwnership,
  cleanupRunnerLiveControl,
  createLiveOwnership,
  persistedInteractionHistory,
  respondToPendingRunnerRequest,
  type RunnerLiveControl
} from "../autoRun/liveControl.js";
import {
  executeRunnerLifecycleTransition,
  transitionRunnerLifecycle
} from "../autoRun/runnerLifecycle.js";
import { adaptLegacyDesktopRunnerEvents } from "../desktop/legacyRunnerEventAdapter.js";
import { redactRunnerEventPayload } from "../autoRun/runnerEventRedaction.js";

describe("structured runner event redaction", () => {
  it("redacts sensitive keys and values while preserving protocol identities", () => {
    const payload = redactRunnerEventPayload({
      password: "opaque-password",
      nested: [{ ACCESS_TOKEN: "opaque-access", note: "api_key=ordinary-secret" }],
      optionId: "token=opaque-action-id",
      request_id: "token=opaque-request-id",
      sessionId: "token=opaque-session-id",
      toolCallId: "token=opaque-tool-id",
      messageId: "token=opaque-message-id",
      id: "token=opaque-jsonrpc-id"
    });
    expect(payload).toEqual({
      password: "[REDACTED:CREDENTIAL]",
      nested: [{
        ACCESS_TOKEN: "[REDACTED:CREDENTIAL]",
        note: "[REDACTED:CREDENTIAL]"
      }],
      optionId: "token=opaque-action-id",
      request_id: "token=opaque-request-id",
      sessionId: "token=opaque-session-id",
      toolCallId: "token=opaque-tool-id",
      messageId: "token=opaque-message-id",
      id: "token=opaque-jsonrpc-id"
    });
  });

  it("handles cycles and non-plain prototypes without traversing them", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(redactRunnerEventPayload({ cyclic, date: new Date(0) })).toEqual({
      cyclic: { self: "[REDACTED:SENSITIVE_CONTENT]" },
      date: "[REDACTED:SENSITIVE_CONTENT]"
    });
  });
});

function event(
  sequence: number,
  body = normalizedOutputBody("stdout", `line ${sequence}`),
  identityPatch: Record<string, string> = {}
) {
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence,
    timestamp: "2026-07-11T00:00:00.000Z",
    identity: {
      projectId: "project-1",
      canvasId: "default",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      runId: "RUN-001",
      runOwner: "executor",
      runSessionId: "SESSION-0001",
      desktopRunId: "DESKTOP-RUN-0001",
      executorRunId: "RUN-001",
      ...identityPatch
    },
    runner: { version: "planweave.runner/v1", runnerKind: "cli", agentId: "codex" },
    body
  });
}

function encoded(...events: ReturnType<typeof event>[]): string {
  return events.map(encodeNormalizedRunnerEvent).join("");
}

function terminalEvent(sequence: number) {
  return event(sequence, {
    kind: "terminal" as const,
    outcome: {
      version: "planweave.runner/v1" as const,
      state: "succeeded" as const,
      exitCode: 0,
      finishedAt: "2026-07-11T00:00:01.000Z",
      diagnostic: null,
      artifactValidated: true
    }
  });
}

describe("runner identity and capability contracts", () => {
  it("requires the canonical run id to match its declared owner mapping", () => {
    const raw = {
      projectId: "project-1",
      canvasId: "default",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      runId: "RUN-001",
      runOwner: "desktop",
      runSessionId: null,
      desktopRunId: "DESKTOP-RUN-0001",
      executorRunId: "RUN-001"
    };
    expect(runnerRunIdentitySchema.safeParse(raw).success).toBe(false);
    expect(runnerRunIdentitySchema.parse({ ...raw, runId: "DESKTOP-RUN-0001" })).toMatchObject({
      runOwner: "desktop",
      desktopRunId: "DESKTOP-RUN-0001"
    });
  });

  it("fails closed for incomplete negotiation and success without an artifact", () => {
    expect(
      negotiatedCapabilitiesSchema.safeParse({
        version: "planweave.runner/v1",
        required: ["session"],
        available: ["prompt"],
        negotiated: ["prompt"]
      }).success
    ).toBe(false);
    expect(
      terminalOutcomeSchema.safeParse({
        version: "planweave.runner/v1",
        state: "succeeded",
        exitCode: 0,
        finishedAt: "2026-07-11T00:00:00.000Z",
        diagnostic: null,
        artifactValidated: false
      }).success
    ).toBe(false);
    expect(
      terminalOutcomeSchema.safeParse({
        version: "planweave.runner/v1",
        state: "succeeded",
        reason: "completed",
        cleanup: { status: "failed" },
        exitCode: 0,
        finishedAt: "2026-07-11T00:00:00.000Z",
        diagnostic: null,
        artifactValidated: true
      }).success
    ).toBe(false);
    expect(
      terminalOutcomeSchema.safeParse({
        version: "planweave.runner/v1",
        state: "failed",
        reason: "completed",
        cleanup: { status: "succeeded" },
        exitCode: 1,
        finishedAt: "2026-07-11T00:00:00.000Z",
        diagnostic: "failed",
        artifactValidated: false
      }).success
    ).toBe(false);
  });
});

describe("runner event redaction and UTF-8 limits", () => {
  it.each([
    ["Authorization: Basic dXNlcjpwYXNz", ["dXNlcjpwYXNz"]],
    ["Authorization: Bearer abc.def.ghi", ["abc.def.ghi"]],
    ["api_key=alpha beta", ["alpha", "beta"]],
    ['password: "hunter two"', ["hunter", "two"]],
    ["client_secret='hello world'", ["hello", "world"]],
    ["token=my token with spaces", ["my", "token", "spaces"]],
    ["Cookie: session=top-secret; user=one", ["top-secret"]],
    ["-----BEGIN PRIVATE KEY-----\nsecret bytes\n-----END PRIVATE KEY-----", ["secret", "bytes"]]
  ])("removes complete secret bytes from output, encode, replay, diagnostic, and legacy views: %s", (secret, secretFragments) => {
    const body = normalizedOutputBody("stdout", secret);
    const diagnostic = normalizedDiagnosticBody("corrupt_line", secret);
    const line = encodeNormalizedRunnerEvent(event(1, body));
    const replay = replayNormalizedRunnerEvents({ content: line, runId: "RUN-001" });

    const legacy = adaptLegacyDesktopRunnerEvents(
      [
        {
          line: 1,
          timestamp: "2026-07-11T00:00:00.000Z",
          runId: "DESKTOP-RUN-0001",
          type: "step",
          phase: "running",
          data: { outputSummary: secret }
        }
      ],
      {
        projectId: "project-1",
        canvasId: "default",
        taskId: "T-001",
        blockId: "B-001",
        claimRef: "T-001#B-001",
        runSessionId: null,
        executorRunId: "RUN-001",
        runnerKind: "cli",
        agentId: "codex"
      }
    );
    for (const fragment of secretFragments) {
      expect(body.content).not.toContain(fragment);
      expect(diagnostic.message).not.toContain(fragment);
      expect(line).not.toContain(fragment);
      expect(JSON.stringify(replay)).not.toContain(fragment);
      expect(JSON.stringify(legacy)).not.toContain(fragment);
    }
  });

  it("rejects unredacted and incompletely redacted direct schema inputs without echoing secrets", () => {
    const direct = {
      ...event(1),
      body: {
        kind: "diagnostic",
        code: "corrupt_line",
        message: "Authorization: Bearer raw-secret"
      }
    };
    const parsed = normalizedRunnerEventSchema.safeParse(direct);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.message).not.toContain("raw-secret");
    }
    expect(() =>
      normalizedRunnerEventSchema.parse({
        ...event(1),
        body: {
          kind: "output",
          stream: "stdout",
          content: "[REDACTED:CREDENTIAL] alpha beta",
          redaction: { classes: ["credential"], replaced: 1 }
        }
      })
    ).toThrow("unredacted credential");
  });

  it("enforces message limits in UTF-8 bytes at and beyond the exact boundary", () => {
    expect(
      normalizedOutputBody("stdout", "x".repeat(RUNNER_EVENT_MAX_MESSAGE_BYTES)).content
    ).toHaveLength(RUNNER_EVENT_MAX_MESSAGE_BYTES);
    expect(() =>
      normalizedOutputBody(
        "stdout",
        "界".repeat(Math.floor(RUNNER_EVENT_MAX_MESSAGE_BYTES / 3) + 1)
      )
    ).toThrow("UTF-8 limit");
  });
});

describe("normalized runner event replay", () => {
  it("binds a run to full run+runner identity and rejects drift", () => {
    const runnerDrift = {
      ...event(3),
      runner: { ...event(3).runner, agentId: "claude-code" }
    };
    const content = encoded(
      event(1),
      event(2, undefined, { taskId: "T-002", claimRef: "T-002#B-001" }),
      runnerDrift
    );
    const replay = replayNormalizedRunnerEvents({ content, runId: "RUN-001" });
    expect(replay.events.map((item) => item.sequence)).toEqual([1]);
    expect(replay.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "identity_mismatch" })])
    );
  });

  it("keeps terminal and canonical identity stable after the cursor passes terminal", () => {
    const content = encoded(event(1), terminalEvent(2));
    const first = replayNormalizedRunnerEvents({ content, runId: "RUN-001" });
    expect(first.terminal).toBe(true);
    const next = replayNormalizedRunnerEvents({
      content,
      runId: "RUN-001",
      cursor: first.nextCursor
    });
    expect(next.events).toEqual([]);
    expect(next.terminal).toBe(true);
    expect(next.nextCursor.canonicalIdentity).toEqual(first.nextCursor.canonicalIdentity);
  });

  it("distinguishes an unknown initial gap from an explicit retention boundary", () => {
    const content = encoded(event(7), event(8));
    expect(
      replayNormalizedRunnerEvents({ content, runId: "RUN-001" }).diagnostics.map(
        (item) => item.code
      )
    ).toContain("initial_sequence_gap");
    expect(
      replayNormalizedRunnerEvents({
        content,
        runId: "RUN-001",
        retainedFromSequence: 7
      }).diagnostics.map((item) => item.code)
    ).toContain("retention_boundary");
  });

  it("reports duplicate, out-of-order, gaps, corrupt lines, and bounded partial recovery", () => {
    const content = [
      encodeNormalizedRunnerEvent(event(1)).trimEnd(),
      encodeNormalizedRunnerEvent(event(3)).trimEnd(),
      encodeNormalizedRunnerEvent(event(3)).trimEnd(),
      encodeNormalizedRunnerEvent(event(2)).trimEnd(),
      "{bad-json}",
      encodeNormalizedRunnerEvent(event(4)).trimEnd().slice(0, 60)
    ].join("\n");
    const replay = replayNormalizedRunnerEvents({ content, runId: "RUN-001" });
    expect(replay.events.map((item) => item.sequence)).toEqual([1, 3]);
    expect(replay.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "sequence_gap",
        "duplicate_sequence",
        "out_of_order_sequence",
        "corrupt_line",
        "partial_line"
      ])
    );

    const oversized = replayNormalizedRunnerEvents({
      content: "x".repeat(RUNNER_EVENT_MAX_LINE_BYTES + 1),
      runId: "RUN-001"
    });
    expect(oversized.partialLine).toBeNull();
    expect(oversized.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "line_limit_exceeded" })])
    );

    const exact = replayNormalizedRunnerEvents({
      content: "x".repeat(RUNNER_EVENT_MAX_LINE_BYTES),
      runId: "RUN-001"
    });
    expect(exact.partialLine).toHaveLength(RUNNER_EVENT_MAX_LINE_BYTES);

    const secretPartial = replayNormalizedRunnerEvents({
      content: "Authorization: Bearer raw-partial-secret",
      runId: "RUN-001"
    });
    expect(secretPartial.partialLine).toBeNull();
    expect(JSON.stringify(secretPartial)).not.toContain("raw-partial-secret");
  });

  it("stops at the exact UTF-8 retention boundary without returning raw retained content", () => {
    const line = "x".repeat(RUNNER_EVENT_MAX_LINE_BYTES);
    const lineCount = Math.ceil(RUNNER_EVENT_RETENTION_MAX_BYTES / (line.length + 1));
    const replay = replayNormalizedRunnerEvents({
      content: `${Array.from({ length: lineCount }, () => line).join("\n")}\n`,
      runId: "RUN-001"
    });
    expect(replay.events).toEqual([]);
    expect(replay.partialLine).toBeNull();
    expect(replay.diagnostics.at(-1)).toMatchObject({ code: "retention_limit_reached" });
  });

  it.each([
    "\n",
    "\r\n"
  ])("accounts exact %j delimiters plus a multibyte partial at the retention boundary", (delimiter) => {
    const completeLine = "x".repeat(RUNNER_EVENT_MAX_LINE_BYTES);
    const recordBytes = RUNNER_EVENT_MAX_LINE_BYTES + Buffer.byteLength(delimiter);
    const completeCount = Math.floor(RUNNER_EVENT_RETENTION_MAX_BYTES / recordBytes);
    const remaining = RUNNER_EVENT_RETENTION_MAX_BYTES - completeCount * recordBytes;
    const multibyteCount = Math.floor(remaining / 3);
    const finalAsciiBytes = remaining - multibyteCount * 3;
    const partial = `${"界".repeat(multibyteCount)}${"x".repeat(finalAsciiBytes)}`;
    const exact = `${`${completeLine}${delimiter}`.repeat(completeCount)}${partial}`;
    expect(Buffer.byteLength(exact)).toBe(RUNNER_EVENT_RETENTION_MAX_BYTES);
    expect(
      replayNormalizedRunnerEvents({ content: exact, runId: "RUN-001" }).diagnostics.map(
        (diagnostic) => diagnostic.code
      )
    ).not.toContain("retention_limit_reached");
    const exceeded = replayNormalizedRunnerEvents({
      content: `${exact}x`,
      runId: "RUN-001"
    });
    expect(exceeded.partialLine).toBeNull();
    expect(exceeded.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "retention_limit_reached"
    );
  });

  it("keeps ACP correlation ids out of CLI events", () => {
    expect(
      normalizedRunnerEventSchema.safeParse({
        ...event(1),
        correlation: { sessionId: "acp-session-1", requestId: "request-1" }
      }).success
    ).toBe(false);
  });
});

function liveControl(options: {
  ownership: ReturnType<typeof createLiveOwnership>;
  respond?: () => Promise<void>;
  reject?: () => Promise<void>;
  close?: () => Promise<void>;
  terminate?: () => Promise<void>;
}): RunnerLiveControl {
  return {
    ownership: options.ownership,
    sessionId: "acp-session-1",
    process: { pid: 123, terminate: options.terminate ?? vi.fn(async () => undefined) },
    connection: {
      send: vi.fn(async () => undefined),
      close: options.close ?? vi.fn(async () => undefined),
      cancelSession: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
      supportsSessionClose: false
    },
    interventionCapabilities: { cancel: true, permission: true, elicitationPreview: true },
    pendingRequests: new Map([
      [
        "request-1",
        {
          requestId: "request-1",
          interactionId: "interaction-1",
          kind: "permission",
          requestedAt: "2026-07-11T00:00:00.000Z",
          summary: "password=secret value",
          permissionOptions: [{ optionId: "allow", label: "Allow", decision: "approve" }],
          respond: options.respond ?? vi.fn(async () => undefined),
          reject: options.reject ?? vi.fn(async () => undefined)
        }
      ]
    ])
  };
}

describe("live ownership and cleanup", () => {
  it("gates response and cleanup on the exact ownership reference and generation", async () => {
    const ownership = createLiveOwnership("RUN-001", 1);
    const stale = createLiveOwnership("RUN-001", 2);
    const control = liveControl({ ownership });
    expect(() => assertLiveOwnership(ownership, stale)).toThrow("ownership was lost");
    await expect(
      respondToPendingRunnerRequest({
        control,
        ownership: stale,
        requestId: "request-1",
        value: true
      })
    ).rejects.toThrow("ownership was lost");
    await expect(cleanupRunnerLiveControl(control, stale, "terminal")).rejects.toThrow(
      "ownership was lost"
    );
  });

  it("attaches complete non-actionable history while aggregating every cleanup failure", async () => {
    const ownership = createLiveOwnership("RUN-001", 1);
    const control = liveControl({
      ownership,
      reject: vi.fn(async () => Promise.reject(new Error("reject failed"))),
      close: vi.fn(async () => Promise.reject(new Error("close failed"))),
      terminate: vi.fn(async () => Promise.reject(new Error("terminate failed")))
    });
    try {
      await cleanupRunnerLiveControl(control, ownership, "terminal");
      throw new Error("Expected cleanup to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(RunnerCleanupError);
      const cleanupError = error as RunnerCleanupError;
      expect(cleanupError.errors).toHaveLength(3);
      expect(cleanupError.result.history).toEqual([
        expect.objectContaining({ actionable: false, nonActionableReason: "terminal_cleanup" })
      ]);
      expect(JSON.stringify(cleanupError.result.history)).not.toContain("secret value");
    }
  });

  it("performs terminal cleanup once and returns idempotent history", async () => {
    const ownership = createLiveOwnership("RUN-001", 1);
    const reject = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const terminate = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const control = liveControl({ ownership, respond, reject, close, terminate });
    const first = await cleanupRunnerLiveControl(control, ownership, "terminal");
    const second = await cleanupRunnerLiveControl(control, ownership, "terminal");
    expect(first.alreadyCleaned).toBe(false);
    expect(second).toMatchObject({ alreadyCleaned: true, history: first.history });
    expect(reject).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("permanently rejects responses after successful terminal cleanup", async () => {
    const ownership = createLiveOwnership("RUN-001", 1);
    const respond = vi.fn(async () => undefined);
    const control = liveControl({ ownership, respond });
    await cleanupRunnerLiveControl(control, ownership, "terminal");
    await expect(
      respondToPendingRunnerRequest({
        control,
        ownership,
        requestId: "request-1",
        value: true
      })
    ).rejects.toThrow("no longer actionable");
    expect(respond).not.toHaveBeenCalled();
  });

  it("does not repeat cleanup side effects after an aggregated cleanup failure", async () => {
    const ownership = createLiveOwnership("RUN-001", 1);
    const secret = "raw-cleanup-secret";
    const reject = vi.fn(async () => Promise.reject(new Error(`Authorization: Bearer ${secret}`)));
    const close = vi.fn(async () => undefined);
    const terminate = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const control = liveControl({ ownership, respond, reject, close, terminate });
    let initial: RunnerCleanupError | null = null;
    try {
      await cleanupRunnerLiveControl(control, ownership, "terminal");
    } catch (error) {
      initial = error as RunnerCleanupError;
    }
    expect(initial?.result.alreadyCleaned).toBe(false);
    expect(initial?.errors.map((error) => error.message).join(" ")).not.toContain(secret);
    let repeated: RunnerCleanupError | null = null;
    try {
      await cleanupRunnerLiveControl(control, ownership, "terminal");
    } catch (error) {
      repeated = error as RunnerCleanupError;
    }
    expect(repeated).toBeInstanceOf(RunnerCleanupError);
    expect(repeated?.result.alreadyCleaned).toBe(true);
    expect(repeated?.message).not.toContain(secret);
    expect(repeated?.errors.map((error) => error.message).join(" ")).not.toContain(secret);
    await expect(
      respondToPendingRunnerRequest({ control, ownership, requestId: "request-1", value: true })
    ).rejects.toThrow("no longer actionable");
    expect(respond).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("keeps persisted interaction history structurally non-actionable", () => {
    const request = [
      ...liveControl({ ownership: createLiveOwnership("RUN-001", 1) }).pendingRequests.values()
    ][0];
    expect(persistedInteractionHistory(request, "persisted_history").actionable).toBe(false);
    expect(
      persistedPendingInteractionSchema.parse({
        ...persistedInteractionHistory(request, "ownership_lost"),
        actionable: false
      }).nonActionableReason
    ).toBe("ownership_lost");
  });
});

describe("runner lifecycle transitions", () => {
  const success = {
    version: "planweave.runner/v1" as const,
    state: "succeeded" as const,
    exitCode: 0,
    finishedAt: "2026-07-11T00:00:00.000Z",
    diagnostic: null,
    artifactValidated: true
  };

  it("executes CLI-compatible success, failure, cancellation, restart, and terminal idempotence", () => {
    const first = createLiveOwnership("RUN-001", 1);
    const second = createLiveOwnership("RUN-001", 2);
    expect(
      transitionRunnerLifecycle({
        from: "created",
        to: "initializing",
        cause: "normal",
        ownership: first
      }).state
    ).toBe("initializing");
    expect(
      transitionRunnerLifecycle({
        from: "initializing",
        to: "ready",
        cause: "normal",
        ownership: first
      }).state
    ).toBe("ready");
    expect(
      transitionRunnerLifecycle({ from: "ready", to: "running", cause: "normal", ownership: first })
        .state
    ).toBe("running");
    expect(
      transitionRunnerLifecycle({
        from: "running",
        to: "succeeded",
        cause: "normal",
        ownership: first,
        outcome: success
      }).terminal
    ).toBe(true);
    expect(
      transitionRunnerLifecycle({
        from: "succeeded",
        to: "succeeded",
        cause: "normal",
        ownership: first,
        outcome: success
      }).idempotent
    ).toBe(true);
    expect(
      transitionRunnerLifecycle({
        from: "running",
        to: "initializing",
        cause: "restart",
        ownership: first,
        nextOwnership: second
      }).ownership
    ).toBe(second);
    expect(
      transitionRunnerLifecycle({
        from: "running",
        to: "cancelling",
        cause: "normal",
        ownership: first
      }).state
    ).toBe("cancelling");
    expect(
      transitionRunnerLifecycle({
        from: "cancelling",
        to: "cancelled",
        cause: "normal",
        ownership: first,
        outcome: {
          version: "planweave.runner/v1",
          state: "cancelled",
          exitCode: null,
          finishedAt: "2026-07-11T00:00:00.000Z",
          diagnostic: null,
          artifactValidated: false
        }
      }).terminal
    ).toBe(true);
    const failedOutcome = {
      version: "planweave.runner/v1" as const,
      state: "failed" as const,
      exitCode: 1,
      finishedAt: "2026-07-11T00:00:00.000Z",
      diagnostic: "ownership lost",
      artifactValidated: false
    };
    expect(
      transitionRunnerLifecycle({
        from: "running",
        to: "failed",
        cause: "normal",
        ownership: first,
        outcome: failedOutcome
      }).terminal
    ).toBe(true);
    expect(
      transitionRunnerLifecycle({
        from: "waiting_interaction",
        to: "failed",
        cause: "ownership_loss",
        ownership: first,
        outcome: failedOutcome
      }).state
    ).toBe("failed");
  });

  it("rejects illegal and post-terminal transitions and requires failed ownership loss", () => {
    const ownership = createLiveOwnership("RUN-001", 1);
    expect(() =>
      transitionRunnerLifecycle({
        from: "created",
        to: "succeeded",
        cause: "normal",
        ownership,
        outcome: {
          version: "planweave.runner/v1",
          state: "succeeded",
          exitCode: 0,
          finishedAt: "2026-07-11T00:00:00.000Z",
          diagnostic: null,
          artifactValidated: true
        }
      })
    ).toThrow("Illegal");
    expect(() =>
      transitionRunnerLifecycle({
        from: "succeeded",
        to: "failed",
        cause: "normal",
        ownership,
        outcome: {
          version: "planweave.runner/v1",
          state: "failed",
          exitCode: 1,
          finishedAt: "2026-07-11T00:00:00.000Z",
          diagnostic: "failed",
          artifactValidated: false
        }
      })
    ).toThrow("terminal state");
    expect(() =>
      transitionRunnerLifecycle({
        from: "running",
        to: "cancelled",
        cause: "ownership_loss",
        ownership,
        outcome: {
          version: "planweave.runner/v1",
          state: "cancelled",
          exitCode: null,
          finishedAt: "2026-07-11T00:00:00.000Z",
          diagnostic: null,
          artifactValidated: false
        }
      })
    ).toThrow("ownership loss");
  });

  it("executes terminal live cleanup through the lifecycle seam", async () => {
    const ownership = createLiveOwnership("RUN-001", 1);
    const reject = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const terminate = vi.fn(async () => undefined);
    const control = liveControl({ ownership, reject, close, terminate });
    const result = await executeRunnerLifecycleTransition({
      transition: {
        from: "cancelling",
        to: "cancelled",
        cause: "normal",
        ownership,
        outcome: {
          version: "planweave.runner/v1",
          state: "cancelled",
          exitCode: null,
          finishedAt: "2026-07-11T00:00:00.000Z",
          diagnostic: null,
          artifactValidated: false
        }
      },
      live: { kind: "present", control, cleanupReason: "cancelled" }
    });
    expect(result.cleanup?.history).toEqual([
      expect.objectContaining({ actionable: false, nonActionableReason: "terminal_cleanup" })
    ]);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
