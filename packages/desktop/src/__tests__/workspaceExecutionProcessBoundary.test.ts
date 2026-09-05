/* @vitest-environment jsdom */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { WorkspaceExecutionSessionVersionConflictError } from "@planweave-ai/runtime";
import { projectWorkspaceExecutionTimeline } from "@planweave-ai/runtime/browser";
import {
  desktopWorkspaceExecutionStartInputSchema,
  desktopWorkspaceExecutionResponseSchema
} from "../shared/workspaceExecution";
import { DesktopWorkspaceExecutionSessionRepository } from "../main/workspaceExecutionDesktopSessionRepository";
import {
  cancelActiveWorkspaceExecution,
  cancelWorkspaceExecutionSession
} from "../main/workspaceExecutionDesktopService";
import { workspaceExecutionHandlerResult } from "../main/workspaceExecutionIpcResult";
import { CollaborationClientError } from "../main/collaboration/collaborationErrors";
import { createWorkspaceExecutionPreloadApi } from "../preload/workspaceExecutionPreloadBridge";
import { useWorkspaceExecutionTaskWorkspaceConversation } from "../renderer/task-workspace/useWorkspaceExecutionTaskWorkspaceConversation";
import {
  workspaceExecutionPollingKey,
  workspaceExecutionSuccessPollDelay
} from "../renderer/task-workspace/workspaceExecutionPollingCadence";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const namespace = `wxs:sha256:${"b".repeat(64)}` as const;
const storage = { kind: "namespace" as const, namespace };

function sessionRecord() {
  return {
    stateVersion: 1,
    sessionId: "SESSION-0001",
    kind: "run" as const,
    trigger: "desktop" as const,
    canvasId: "canvas-1",
    scope: { kind: "block" as const, blockRef: "T-001#B-001" },
    phase: "running" as const,
    startedAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    finishedAt: null,
    reset: null,
    autoRun: null,
    latestRecordId: null,
    latestRecordPath: null,
    workspaceExecution: {
      version: "planweave.workspace-execution-session/v1" as const,
      binding: {
        version: "planweave.workspace-authority-binding/v1" as const,
        bindingId: `wxb:sha256:${"a".repeat(64)}`,
        kind: "local" as const,
        packageWorkspace: "/private/package",
        canvasId: "canvas-1",
        scope: { kind: "block" as const, blockRef: "T-001#B-001" },
        contentRevision: "revision-1",
        graphFingerprint: `pkg-${"c".repeat(64)}`
      },
      dispatchIntent: null,
      handle: null,
      interactions: [],
      evidence: { status: "pending" as const, diagnostics: [] }
    },
    error: null
  };
}

async function repositoryFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "planweave-workspace-execution-"));
  const directory = resolve(root, namespace.slice("wxs:sha256:".length));
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "SESSION-0001.json"),
    `${JSON.stringify(sessionRecord())}\n`,
    "utf8"
  );
  return { directory, repository: new DesktopWorkspaceExecutionSessionRepository(root), root };
}

function coordinatorView(
  operationId: string,
  blockRef: string,
  events: unknown[] = [],
  progress: { eventCursor?: number; operationRevision?: number } = {}
) {
  return desktopWorkspaceExecutionResponseSchema.parse({
    version: "planweave.workspace-execution-view/v1",
    handle: {
      version: "planweave.workspace-execution-handle/v1",
      target: "remote",
      phase: "attempt",
      runSessionId: "SESSION-0001",
      authorityBindingId: `wxb:sha256:${"a".repeat(64)}`,
      scope: { kind: "block", blockRef },
      capabilities: { interactionResponse: true },
      operationId,
      operationRevision: progress.operationRevision ?? 1,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      attemptStateVersion: 1,
      leaseId: "lease-1",
      agentEndpointId: "endpoint-1",
      cursor: {
        target: "remote",
        executionAttemptId: "attempt-1",
        eventCursor: progress.eventCursor ?? 0
      }
    },
    session: {
      sessionId: "SESSION-0001",
      stateVersion: 1,
      phase: "running",
      scope: { kind: "block", blockRef },
      startedAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      finishedAt: null,
      error: null,
      interactionStatus: [],
      evidence: { status: "pending", diagnostics: [] }
    },
    events
  });
}

function runnerEvent(input: {
  attemptId: string;
  blockRef?: string;
  cursor: number;
  eventId: string;
  operationId?: string;
  text: string;
}) {
  const blockRef = input.blockRef ?? "T-001#B-001";
  const operationId = input.operationId ?? "operation-1";
  return {
    version: "planweave.execution-event/v1" as const,
    eventId: input.eventId,
    type: "runner_event" as const,
    observedAt: `2026-08-30T00:00:0${input.cursor}.000Z`,
    runSessionId: "SESSION-0001",
    scope: { kind: "block" as const, blockRef },
    source: {
      target: "remote" as const,
      operationId,
      executionAttemptId: input.attemptId,
      cursor: input.cursor
    },
    data: {
      eventProtocolVersion: 1 as const,
      event: { cursor: input.cursor, kind: "agent_message" as const, text: input.text }
    }
  };
}

function workspaceConversationApi(followWorkspaceExecution: ReturnType<typeof vi.fn>) {
  return {
    startWorkspaceExecution: vi.fn(),
    followWorkspaceExecution,
    respondWorkspaceExecution: vi.fn(),
    cancelWorkspaceExecution: vi.fn()
  };
}

const workspaceLocator = {
  kind: "workspace" as const,
  connectionProfileId: "profile-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1"
};

function successPollDelay(
  noProgressCount: number,
  scopeKey = "scope-1",
  operationId = "operation-1"
): number {
  return workspaceExecutionSuccessPollDelay(
    noProgressCount,
    workspaceExecutionPollingKey(scopeKey, operationId)
  );
}

describe("Workspace execution process boundary", () => {
  it.each([
    "completed",
    "failed",
    "stopped"
  ] as const)("does not send a cancel action after follow observes a %s session", async (phase) => {
    const observeRemoteOperation = vi.fn();
    const executeRemoteOperationAction = vi.fn();
    const current = desktopWorkspaceExecutionResponseSchema.parse({
      ...coordinatorView("operation-1", "T-001#B-001"),
      session: {
        ...coordinatorView("operation-1", "T-001#B-001").session,
        phase,
        finishedAt: "2026-08-30T00:00:01.000Z"
      }
    });

    await expect(
      cancelActiveWorkspaceExecution({
        current,
        actionId: "cancel-1",
        reason: "stop requested",
        remoteOperations: { observeRemoteOperation, executeRemoteOperationAction }
      })
    ).resolves.toBe("already_terminal");
    expect(observeRemoteOperation).not.toHaveBeenCalled();
    expect(executeRemoteOperationAction).not.toHaveBeenCalled();
  });

  it.each([
    ["completed", 1],
    ["failed", 2],
    ["cancelled", 2]
  ] as const)("re-follows a remotely %s session without comparing stale attempt identity or sending an action", async (state, attemptStateVersion) => {
    const running = coordinatorView("operation-1", "T-001#B-001");
    const terminalPhase = state === "cancelled" ? "stopped" : state;
    const terminal = desktopWorkspaceExecutionResponseSchema.parse({
      ...running,
      session: {
        ...running.session,
        phase: terminalPhase,
        finishedAt: "2026-08-30T00:00:02.000Z"
      }
    });
    const follow = vi.fn().mockResolvedValueOnce(running).mockResolvedValueOnce(terminal);
    const observeRemoteOperation = vi.fn(async () => ({
      operationId: "operation-1",
      dispatchId: attemptStateVersion === 1 ? "dispatch-1" : "dispatch-2",
      executionAttemptId: attemptStateVersion === 1 ? "attempt-1" : "attempt-2",
      state,
      attempt: {
        stateVersion: attemptStateVersion,
        leaseId: attemptStateVersion === 1 ? "lease-1" : "lease-2"
      }
    }));
    const executeRemoteOperationAction = vi.fn();

    await expect(
      cancelWorkspaceExecutionSession({
        follow,
        actionId: "cancel-1",
        reason: "stop requested",
        remoteOperations: { observeRemoteOperation, executeRemoteOperationAction }
      })
    ).resolves.toEqual(terminal);
    expect(follow).toHaveBeenCalledTimes(2);
    expect(executeRemoteOperationAction).not.toHaveBeenCalled();
  });

  it("rejects renderer attempts to send credential or storage authority", () => {
    expect(() =>
      desktopWorkspaceExecutionStartInputSchema.parse({
        locator: {
          kind: "workspace",
          connectionProfileId: "profile-1",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "canvas-1"
        },
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-1",
        effectiveExecutor: { name: "codex", agentId: "codex" },
        credential: "secret"
      })
    ).toThrow();
  });

  it.each([
    [401, "auth", "human_auth_unauthenticated"],
    [403, "forbidden", "human_cross_project_forbidden"],
    [404, "not_found", "human_remote_resource_not_found"]
  ] as const)("preserves the safe %s IPC code across main and preload without exposing raw details", async (httpStatus, kind, code) => {
    const rawSecret = "token=pw_secret /private/workspace response-body";
    const result = await workspaceExecutionHandlerResult(async () => {
      throw new CollaborationClientError({
        kind,
        code,
        httpStatus,
        message: rawSecret,
        retryable: false
      });
    });
    const api = createWorkspaceExecutionPreloadApi(async () => result);

    await expect(
      api.followWorkspaceExecution({
        locator: workspaceLocator,
        blockRef: "T-001#B-001",
        operationId: "operation-1"
      })
    ).rejects.toThrow(code);
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(JSON.stringify(result)).not.toContain("/private/workspace");
  });

  it("rejects Node repository and project paths in the browser view", () => {
    expect(() =>
      desktopWorkspaceExecutionResponseSchema.parse({
        version: "planweave.workspace-execution-view/v1",
        handle: {
          version: "planweave.workspace-execution-handle/v1",
          target: "remote",
          phase: "attempt",
          runSessionId: "SESSION-0001",
          authorityBindingId: `wxb:sha256:${"a".repeat(64)}`,
          scope: { kind: "block", blockRef: "T-001#B-001" },
          capabilities: { interactionResponse: true },
          operationId: "operation-1",
          operationRevision: 1,
          dispatchId: "dispatch-1",
          executionAttemptId: "attempt-1",
          attemptStateVersion: 1,
          leaseId: "lease-1",
          agentEndpointId: "endpoint-1",
          cursor: { target: "remote", executionAttemptId: "attempt-1", eventCursor: 0 }
        },
        session: {
          sessionId: "SESSION-0001",
          stateVersion: 1,
          phase: "running",
          scope: { kind: "block", blockRef: "T-001#B-001" },
          startedAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
          finishedAt: null,
          error: null,
          interactionStatus: [],
          evidence: { status: "pending", diagnostics: [] },
          projectRoot: "/private/workspace"
        },
        events: []
      })
    ).toThrow();
  });

  it("keeps Coordinator and repository imports out of preload and renderer", async () => {
    const sources = await Promise.all(
      [
        "packages/desktop/src/preload/preload.ts",
        "packages/desktop/src/renderer/bridge.ts",
        "packages/desktop/src/renderer/hooks/useWorkspaceAgentEndpointRun.ts"
      ].map((path) => readFile(resolve(repositoryRoot, path), "utf8"))
    );
    const exposedSource = sources.join("\n");
    expect(exposedSource).not.toMatch(/WorkspaceExecutionCoordinator/);
    expect(exposedSource).not.toMatch(/workspaceExecutionDesktopSessionRepository/);
    expect(exposedSource).not.toMatch(/node:/);
    expect(exposedSource).not.toMatch(/credentialProvider|safeStorage/);
  });

  it("serializes same-session CAS and reports the losing update", async () => {
    const fixture = await repositoryFixture();
    try {
      const results = await Promise.allSettled([
        fixture.repository.update(
          storage,
          "SESSION-0001",
          { phase: "completed" },
          { expectedStateVersion: 1 }
        ),
        fixture.repository.update(
          storage,
          "SESSION-0001",
          { phase: "failed" },
          { expectedStateVersion: 1 }
        )
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.any(WorkspaceExecutionSessionVersionConflictError)
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps the main-only namespace and session record private", async () => {
    const fixture = await repositoryFixture();
    try {
      await fixture.repository.update(
        storage,
        "SESSION-0001",
        { phase: "completed" },
        { expectedStateVersion: 1 }
      );
      expect((await stat(fixture.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(resolve(fixture.directory, "SESSION-0001.json"))).mode & 0o777).toBe(
        0o600
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("surfaces corrupt session JSON instead of treating it as an empty namespace", async () => {
    const fixture = await repositoryFixture();
    try {
      await writeFile(resolve(fixture.directory, "SESSION-0001.json"), "{broken", "utf8");
      await expect(fixture.repository.list(storage)).rejects.toThrow();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("serializes the same scope while allowing different scopes to overlap", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "planweave-workspace-locks-"));
    const repository = new DesktopWorkspaceExecutionSessionRepository(root);
    let active = 0;
    let maxActive = 0;
    const operation = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    };
    try {
      await Promise.all([
        repository.withScopeLock(storage, { kind: "block", blockRef: "T-001#B-001" }, operation),
        repository.withScopeLock(storage, { kind: "block", blockRef: "T-001#B-001" }, operation)
      ]);
      expect(maxActive).toBe(1);
      maxActive = 0;
      await Promise.all([
        repository.withScopeLock(storage, { kind: "block", blockRef: "T-001#B-001" }, operation),
        repository.withScopeLock(storage, { kind: "block", blockRef: "T-001#B-002" }, operation)
      ]);
      expect(maxActive).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a slow attach response overwrite a newer Workspace scope", async () => {
    let resolveOld!: (value: ReturnType<typeof coordinatorView>) => void;
    const oldResponse = new Promise<ReturnType<typeof coordinatorView>>((resolve) => {
      resolveOld = resolve;
    });
    const followWorkspaceExecution = vi.fn((input: { operationId?: string }) =>
      input.operationId === "operation-old"
        ? oldResponse
        : Promise.resolve(coordinatorView("operation-new", "T-002#B-001"))
    );
    const api = {
      startWorkspaceExecution: vi.fn(),
      followWorkspaceExecution,
      respondWorkspaceExecution: vi.fn(),
      cancelWorkspaceExecution: vi.fn()
    };
    const locator = {
      kind: "workspace" as const,
      connectionProfileId: "profile-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    };
    const { result, rerender, unmount } = renderHook(
      (props: { blockRef: string; operationId: string; scopeKey: string }) =>
        useWorkspaceExecutionTaskWorkspaceConversation({
          api,
          locator,
          blockRef: props.blockRef,
          operationId: props.operationId,
          scopeKey: props.scopeKey,
          onTerminal: vi.fn()
        }),
      {
        initialProps: {
          blockRef: "T-001#B-001",
          operationId: "operation-old",
          scopeKey: "scope-old"
        }
      }
    );
    rerender({
      blockRef: "T-002#B-001",
      operationId: "operation-new",
      scopeKey: "scope-new"
    });
    await vi.waitFor(() => expect(result.current?.operationId).toBe("operation-new"));
    await act(async () => resolveOld(coordinatorView("operation-old", "T-001#B-001")));
    expect(result.current?.operationId).toBe("operation-new");
    unmount();
  });

  it("surfaces a canonical pending interaction as action required", async () => {
    const blockRef = "T-001#B-001";
    const operationId = "operation-1";
    const view = coordinatorView(operationId, blockRef, [
      {
        version: "planweave.execution-event/v1",
        eventId: "interaction-1",
        type: "interaction_required",
        observedAt: "2026-08-30T00:00:01.000Z",
        runSessionId: "SESSION-0001",
        scope: { kind: "block", blockRef },
        source: { target: "remote", operationId, executionAttemptId: "attempt-1", cursor: 1 },
        data: {
          type: "interaction.authentication_required",
          dispatchId: "dispatch-1",
          leaseId: "lease-1",
          executionAttemptId: "attempt-1",
          acpSessionId: "acp-1",
          actionId: "action-1",
          expiresAt: "2030-01-01T00:05:00.000Z",
          agentProfileId: "codex-acp",
          hostInstruction: "Login required"
        }
      }
    ]);
    const api = {
      startWorkspaceExecution: vi.fn(),
      followWorkspaceExecution: vi.fn(async () => view),
      respondWorkspaceExecution: vi.fn(),
      cancelWorkspaceExecution: vi.fn()
    };
    const { result, unmount } = renderHook(() =>
      useWorkspaceExecutionTaskWorkspaceConversation({
        api,
        locator: {
          kind: "workspace",
          connectionProfileId: "profile-1",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "canvas-1"
        },
        blockRef,
        operationId,
        scopeKey: "scope-1",
        onTerminal: vi.fn()
      })
    );

    await vi.waitFor(() => expect(result.current?.state).toBe("action_required"));
    expect(api.followWorkspaceExecution).toHaveBeenCalledOnce();
    unmount();
  });

  it("retains canonical events across empty incremental follow pages", async () => {
    vi.useFakeTimers();
    try {
      const event = runnerEvent({
        attemptId: "attempt-1",
        cursor: 1,
        eventId: "runner-1",
        text: "First page"
      });
      const follow = vi
        .fn()
        .mockResolvedValueOnce(
          coordinatorView("operation-1", "T-001#B-001", [event], { eventCursor: 1 })
        )
        .mockResolvedValue(coordinatorView("operation-1", "T-001#B-001", [], { eventCursor: 1 }));
      const api = workspaceConversationApi(follow);
      const { result, unmount } = renderHook(() =>
        useWorkspaceExecutionTaskWorkspaceConversation({
          api,
          locator: workspaceLocator,
          blockRef: "T-001#B-001",
          operationId: "operation-1",
          scopeKey: "scope-1",
          onTerminal: vi.fn()
        })
      );

      await act(async () => Promise.resolve());
      expect(result.current).toMatchObject({
        cursor: 1,
        executionAttemptId: "attempt-1",
        timeline: [{ kind: "message", content: "First page" }]
      });
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(0) + successPollDelay(1)));
      expect(follow).toHaveBeenCalledTimes(3);
      expect(follow).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ evidenceCursor: undefined })
      );
      expect(follow).toHaveBeenLastCalledWith(
        expect.objectContaining({
          evidenceCursor: { target: "remote", executionAttemptId: "attempt-1", eventCursor: 1 }
        })
      );
      expect(result.current).toMatchObject({
        cursor: 1,
        executionAttemptId: "attempt-1",
        timeline: [{ kind: "message", content: "First page" }]
      });
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off consecutive unchanged successful follows with deterministic jitter", async () => {
    vi.useFakeTimers();
    try {
      const follow = vi.fn().mockResolvedValue(coordinatorView("operation-1", "T-001#B-001"));
      const api = workspaceConversationApi(follow);
      const { unmount } = renderHook(() =>
        useWorkspaceExecutionTaskWorkspaceConversation({
          api,
          locator: workspaceLocator,
          blockRef: "T-001#B-001",
          operationId: "operation-1",
          scopeKey: "scope-1",
          onTerminal: vi.fn()
        })
      );

      await act(async () => Promise.resolve());
      expect(follow).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(0)));
      expect(follow).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(1) - 1));
      expect(follow).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(follow).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(2) - 1));
      expect(follow).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(follow).toHaveBeenCalledTimes(4);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives stable staggered successful polling cadence from scope and operation identity", () => {
    const first = [0, 1, 2, 8].map((count) => successPollDelay(count, "scope-a", "operation-a"));
    const repeated = [0, 1, 2, 8].map((count) => successPollDelay(count, "scope-a", "operation-a"));
    const second = [0, 1, 2, 8].map((count) => successPollDelay(count, "scope-b", "operation-b"));

    expect(repeated).toEqual(first);
    expect(second).not.toEqual(first);
    expect([...first, ...second].every((delay) => delay <= 30_000)).toBe(true);
  });

  it("resets successful polling backoff when the operation revision advances", async () => {
    vi.useFakeTimers();
    try {
      const unchanged = coordinatorView("operation-1", "T-001#B-001");
      const advanced = coordinatorView("operation-1", "T-001#B-001", [], {
        operationRevision: 2
      });
      const follow = vi
        .fn()
        .mockResolvedValueOnce(unchanged)
        .mockResolvedValueOnce(unchanged)
        .mockResolvedValue(advanced);
      const api = workspaceConversationApi(follow);
      const { unmount } = renderHook(() =>
        useWorkspaceExecutionTaskWorkspaceConversation({
          api,
          locator: workspaceLocator,
          blockRef: "T-001#B-001",
          operationId: "operation-1",
          scopeKey: "scope-1",
          onTerminal: vi.fn()
        })
      );

      await act(async () => Promise.resolve());
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(0)));
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(1)));
      expect(follow).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(0) - 1));
      expect(follow).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(follow).toHaveBeenCalledTimes(4);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches the runtime fixture projection across attempt change, cursor, and terminal state", async () => {
    vi.useFakeTimers();
    try {
      const first = runnerEvent({
        attemptId: "attempt-1",
        cursor: 18,
        eventId: "runner-18",
        text: "Attempt one"
      });
      first.observedAt = "2026-08-30T00:00:18.000Z";
      const changed = {
        ...runnerEvent({
          attemptId: "attempt-2",
          cursor: 0,
          eventId: "attempt-2",
          text: "unused"
        }),
        observedAt: "2026-08-30T00:00:19.000Z",
        type: "attempt_changed" as const,
        data: { previousExecutionAttemptId: "attempt-1", executionAttemptId: "attempt-2" }
      };
      const second = runnerEvent({
        attemptId: "attempt-2",
        cursor: 1,
        eventId: "runner-2",
        text: "Attempt two"
      });
      second.observedAt = "2026-08-30T00:00:20.000Z";
      const operation = {
        ...second,
        eventId: "operation-revision-42",
        observedAt: "2026-08-30T00:00:21.000Z",
        type: "operation_observed" as const,
        data: { state: "running", attemptStatus: "running", operationRevision: 42 }
      };
      const terminal = {
        ...runnerEvent({
          attemptId: "attempt-2",
          cursor: 1,
          eventId: "terminal-1",
          text: "unused"
        }),
        observedAt: "2026-08-30T00:00:22.000Z",
        type: "run_terminal" as const,
        data: { outcome: "completed" as const }
      };
      const fixture = [first, changed, second, operation, terminal];
      const expected = projectWorkspaceExecutionTimeline(fixture);
      const follow = vi
        .fn()
        .mockResolvedValueOnce(coordinatorView("operation-1", "T-001#B-001", [first]))
        .mockResolvedValueOnce(
          coordinatorView("operation-1", "T-001#B-001", [changed, second, operation, terminal])
        );
      const api = workspaceConversationApi(follow);
      const onTerminal = vi.fn();
      const { result, unmount } = renderHook(() =>
        useWorkspaceExecutionTaskWorkspaceConversation({
          api,
          locator: workspaceLocator,
          blockRef: "T-001#B-001",
          operationId: "operation-1",
          scopeKey: "scope-1",
          onTerminal
        })
      );

      await act(async () => Promise.resolve());
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(0)));
      expect(result.current).toMatchObject({
        cursor: 1,
        executionAttemptId: expected.executionAttemptIds.at(-1),
        terminalOutcome: expected.terminalOutcome,
        timeline: expected.runnerTimeline
      });
      expect(onTerminal).toHaveBeenCalledOnce();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses while hidden and resumes once visible", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "hidden";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    try {
      const follow = vi.fn().mockResolvedValue(coordinatorView("operation-1", "T-001#B-001"));
      const api = workspaceConversationApi(follow);
      const { unmount } = renderHook(() =>
        useWorkspaceExecutionTaskWorkspaceConversation({
          api,
          locator: workspaceLocator,
          blockRef: "T-001#B-001",
          operationId: "operation-1",
          scopeKey: "scope-1",
          onTerminal: vi.fn()
        })
      );
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(follow).not.toHaveBeenCalled();
      visibility = "visible";
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(follow).toHaveBeenCalledOnce();
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(0)));
      expect(follow).toHaveBeenCalledTimes(2);
      visibility = "hidden";
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(follow).toHaveBeenCalledTimes(2);
      visibility = "visible";
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(follow).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(0) - 1));
      expect(follow).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(follow).toHaveBeenCalledTimes(4);
      unmount();
    } finally {
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("backs off consecutive transient follow failures exponentially", async () => {
    vi.useFakeTimers();
    try {
      const follow = vi.fn().mockRejectedValue(new Error("network unavailable"));
      const api = workspaceConversationApi(follow);
      const { unmount } = renderHook(() =>
        useWorkspaceExecutionTaskWorkspaceConversation({
          api,
          locator: workspaceLocator,
          blockRef: "T-001#B-001",
          operationId: "operation-1",
          scopeKey: "scope-1",
          onTerminal: vi.fn()
        })
      );

      await act(async () => Promise.resolve());
      expect(follow).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(999));
      expect(follow).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(follow).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(1_999));
      expect(follow).toHaveBeenCalledTimes(2);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(follow).toHaveBeenCalledTimes(3);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling permanent 403 errors while retaining the last projection", async () => {
    vi.useFakeTimers();
    try {
      const event = runnerEvent({
        attemptId: "attempt-1",
        cursor: 1,
        eventId: "runner-1",
        text: "Retained"
      });
      const forbidden = new Error("workspace_execution_authority_mismatch");
      const follow = vi
        .fn()
        .mockResolvedValueOnce(coordinatorView("operation-1", "T-001#B-001", [event]))
        .mockRejectedValue(forbidden);
      const api = workspaceConversationApi(follow);
      const { result, unmount } = renderHook(() =>
        useWorkspaceExecutionTaskWorkspaceConversation({
          api,
          locator: workspaceLocator,
          blockRef: "T-001#B-001",
          operationId: "operation-1",
          scopeKey: "scope-1",
          onTerminal: vi.fn()
        })
      );
      await act(async () => Promise.resolve());
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(0)));
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(follow).toHaveBeenCalledTimes(2);
      expect(result.current).toMatchObject({
        cursor: 1,
        error: "workspace_execution_authority_mismatch",
        timeline: [{ kind: "message", content: "Retained" }]
      });
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after a real cross-project 403 passes through main and preload", async () => {
    vi.useFakeTimers();
    try {
      const event = runnerEvent({
        attemptId: "attempt-1",
        cursor: 1,
        eventId: "runner-1",
        text: "Retained"
      });
      const view = coordinatorView("operation-1", "T-001#B-001", [event]);
      const rawSecret = "scope=project-2 token=pw_secret /private/workspace raw-response";
      const success = await workspaceExecutionHandlerResult(async () => view);
      const forbidden = await workspaceExecutionHandlerResult(async () => {
        throw new CollaborationClientError({
          kind: "forbidden",
          code: "human_cross_project_forbidden",
          httpStatus: 403,
          message: rawSecret,
          retryable: false
        });
      });
      const invoke = vi.fn().mockResolvedValueOnce(success).mockResolvedValue(forbidden);
      const api = createWorkspaceExecutionPreloadApi(invoke);
      const { result, unmount } = renderHook(() =>
        useWorkspaceExecutionTaskWorkspaceConversation({
          api,
          locator: workspaceLocator,
          blockRef: "T-001#B-001",
          operationId: "operation-1",
          scopeKey: "scope-1",
          onTerminal: vi.fn()
        })
      );

      await act(async () => Promise.resolve());
      await act(async () => vi.advanceTimersByTimeAsync(successPollDelay(0)));
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(result.current).toMatchObject({
        cursor: 1,
        error: "human_cross_project_forbidden",
        timeline: [{ kind: "message", content: "Retained" }]
      });
      expect(JSON.stringify(forbidden)).not.toContain(rawSecret);
      expect(JSON.stringify(forbidden)).not.toContain("project-2");
      expect(JSON.stringify(forbidden)).not.toContain("/private/workspace");
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
