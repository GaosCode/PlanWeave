/* @vitest-environment jsdom */

import { act } from "@testing-library/react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import { agentEndpointPreferenceKey } from "../renderer/collaboration/agentEndpointPreferences";
import { statusProjection } from "./helpers/collaborationRuntimeAvailabilityFixture";
import * as workspaceExecutionPollingCadence from "../renderer/task-workspace/workspaceExecutionPollingCadence";
import {
  blockClaim,
  feedbackClaim,
  graph,
  operation,
  project,
  remoteEndpoint,
  renderRun
} from "./workspaceAgentEndpointRunTestFixture";

describe("workspace Agent Endpoint routing", () => {
  it("dispatches a Workspace run without a prior initialize call", async () => {
    const { result, lifecycle, setError, dispatch } = renderRun({
      runtimeAvailability: { kind: "state_uninitialized" }
    });

    await act(() => result.current({ kind: "project" }));

    expect(dispatch).toHaveBeenCalledOnce();
    expect(lifecycle.onCompleted).toHaveBeenCalledOnce();
    expect(setError).not.toHaveBeenCalledWith("collaboration_runtime_state_uninitialized");
  });

  it("does not POST initialize before every Workspace run", async () => {
    const { result, dispatch } = renderRun({
      runtimeAvailability: { kind: "available" }
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("starts the selected local Agent when Server state is known without an attached Runtime", async () => {
    const localEndpoint: AvailableAgentEndpoint = {
      id: "local:codex",
      source: "local",
      executorName: "codex",
      displayName: "Codex",
      locationName: "",
      available: true,
      unavailableReason: null,
      capabilities: ["acp.codex"],
      localExecutorName: "codex"
    };
    const { result, dispatch, setError, startLocal } = renderRun({
      endpoint: localEndpoint,
      localCanvas: true,
      runtimeAvailability: {
        kind: "unavailable",
        reason: "runtime_not_attached",
        statusKnown: true
      }
    });

    await act(() => result.current({ kind: "project" }));

    expect(startLocal).toHaveBeenCalledWith({ kind: "project" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("does not silently replace remote Task endpoints with local Project Auto Run", async () => {
    const { result, dispatch, setError, startLocal, waitForTerminal } = renderRun();

    await act(() => result.current({ kind: "project" }));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-windows"
      })
    );
    expect(waitForTerminal).toHaveBeenCalledTimes(1);
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("delegates interrupted-attempt recovery to the main-process Coordinator", async () => {
    const liveInterruptedBinding = {
      identity: { operationId: "operation-interrupted" },
      phase: "active" as const,
      status: "interrupted" as const,
      actionRequired: true,
      source: { revision: "source-1", graphFingerprint: "fingerprint-1" },
      dispatchAttempt: {
        dispatchId: "dispatch-interrupted",
        executionAttemptId: "attempt-interrupted"
      }
    };
    const interrupted = {
      ...operation("interrupted"),
      operationId: "operation-interrupted",
      dispatchId: "dispatch-interrupted",
      executionAttemptId: "attempt-interrupted",
      attempt: {
        executionAttemptId: "attempt-interrupted",
        dispatchId: "dispatch-interrupted",
        status: "interrupted" as const,
        leaseId: "lease-interrupted",
        stateVersion: 3
      },
      runtime: {
        ref: "T-001#B-001",
        status: "interrupted" as const,
        interruption: { resumable: false as const }
      }
    };
    const recovered = {
      ...operation("running"),
      operationId: "operation-interrupted",
      dispatchId: "dispatch-retry-operation-1",
      executionAttemptId: "attempt-retry-operation-1"
    };
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [{ ref: "T-001#B-001", status: "in_progress", dispatchable: false }]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
        })
      );
    const { result, dispatch, observe, executeAction, waitForTerminal, setError } = renderRun({
      graph,
      readRuntimeAvailability,
      resolveLiveRemoteBinding: vi.fn(async () => liveInterruptedBinding)
    });
    observe.mockResolvedValueOnce(interrupted).mockResolvedValue(recovered);

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatch).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
    expect(waitForTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: expect.objectContaining({ operationId: "operation-1" })
      })
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("does not run resumable-attempt recovery in the renderer", async () => {
    const liveResumeBinding = {
      identity: { operationId: "operation-resume" },
      phase: "active" as const,
      status: "interrupted" as const,
      actionRequired: true,
      source: { revision: "source-1", graphFingerprint: "fingerprint-1" },
      dispatchAttempt: {
        dispatchId: "dispatch-resume",
        executionAttemptId: "attempt-resume"
      }
    };
    const interrupted = {
      ...operation("interrupted"),
      operationId: "operation-resume",
      dispatchId: "dispatch-resume",
      executionAttemptId: "attempt-resume",
      attempt: {
        executionAttemptId: "attempt-resume",
        dispatchId: "dispatch-resume",
        status: "interrupted" as const,
        leaseId: "lease-resume",
        stateVersion: 2
      },
      runtime: {
        ref: "T-001#B-001",
        status: "interrupted" as const,
        interruption: {
          resumable: true as const,
          recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
        }
      }
    };
    const resumed = {
      ...operation("running"),
      operationId: "operation-resume",
      dispatchId: "dispatch-resume",
      executionAttemptId: "attempt-resume"
    };
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [{ ref: "T-001#B-001", status: "in_progress", dispatchable: false }]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
        })
      );
    const { result, dispatch, observe, executeAction, waitForTerminal, setError } = renderRun({
      graph,
      readRuntimeAvailability,
      resolveLiveRemoteBinding: vi.fn(async () => liveResumeBinding)
    });
    observe.mockResolvedValueOnce(interrupted).mockResolvedValue(resumed);

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatch).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();
    expect(waitForTerminal).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("does not observe existing remote operations before main-process start", async () => {
    const existingOperationId = "operation-existing";
    const liveExistingBinding = {
      identity: { operationId: existingOperationId },
      phase: "preparing" as const,
      status: "owned" as const,
      actionRequired: false,
      source: { revision: "source-1", graphFingerprint: "fingerprint-1" },
      dispatchAttempt: null
    };
    const { result, dispatch, observe, ensureWorkAuthority, waitForTerminal, setError } = renderRun(
      {
        graph,
        resolveLiveRemoteBinding: vi.fn(async () => liveExistingBinding)
      }
    );

    await act(() => result.current({ kind: "project" }));

    expect(dispatch).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    expect(ensureWorkAuthority).not.toHaveBeenCalled();
    expect(waitForTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: expect.objectContaining({ operationId: "operation-1" })
      })
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("inherits the Task endpoint for a compatible Block with an explicit logical executor", async () => {
    const explicitExecutorGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) => ({
        ...task,
        blocks: task.blocks.map((block) => ({ ...block, executor: "codex" }))
      }))
    };
    const { result, dispatch, setError, startLocal } = renderRun({ graph: explicitExecutorGraph });

    await act(() => result.current({ kind: "project" }));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-windows"
      })
    );
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("fails Project preflight before partial execution when a selected endpoint is unavailable", async () => {
    const previewClaimNext = vi.fn();
    const {
      result,
      dispatch,
      readRuntimeAvailability,
      setError,
      startLocal,
      previewClaimNext: preview
    } = renderRun({
      endpoint: {
        ...remoteEndpoint,
        available: false,
        unavailableReason: "agent_endpoint_host_offline"
      },
      previewClaimNext
    });

    await act(() => result.current({ kind: "project" }));

    expect(setError).toHaveBeenCalledWith(
      "agent_endpoint_unavailable:T-001#B-001:Codex:agent_endpoint_host_offline"
    );
    expect(readRuntimeAvailability).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(startLocal).not.toHaveBeenCalled();
  });

  it("preserves the existing Runtime Auto Run path for an all-local Project", async () => {
    const localEndpoint: AvailableAgentEndpoint = {
      id: "local:codex",
      source: "local",
      executorName: "codex",
      displayName: "Codex",
      locationName: null,
      available: true,
      unavailableReason: null,
      capabilities: ["acp.codex"],
      remoteEndpointId: null
    };
    const previewClaimNext = vi.fn();
    const {
      result,
      dispatch,
      setError,
      startLocal,
      previewClaimNext: preview
    } = renderRun({
      endpoint: localEndpoint,
      previewClaimNext
    });

    await act(() => result.current({ kind: "project" }));

    expect(startLocal).toHaveBeenCalledWith({ kind: "project" });
    expect(preview).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("continues claim-bus multi-unit work: remote impl then local review", async () => {
    const mixedGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: [
        {
          ...graph.tasks[0]!,
          blocks: [
            graph.tasks[0]!.blocks[0]!,
            {
              ...graph.tasks[0]!.blocks[0]!,
              ref: "T-001#R-001",
              blockId: "R-001",
              type: "review",
              title: "Review",
              status: "planned",
              executor: "local-review",
              requiredCapabilities: []
            }
          ]
        }
      ]
    };
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "ready",
          blocks: [
            { ref: "T-001#B-001", status: "ready" },
            { ref: "T-001#R-001", status: "planned", dispatchable: false }
          ]
        })
      )
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "ready",
          blocks: [
            { ref: "T-001#B-001", status: "ready" },
            { ref: "T-001#R-001", status: "planned", dispatchable: false }
          ]
        })
      )
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [
            { ref: "T-001#B-001", status: "completed", dispatchable: false },
            { ref: "T-001#R-001", status: "ready" }
          ]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [
            { ref: "T-001#B-001", status: "completed", dispatchable: false },
            { ref: "T-001#R-001", status: "completed", dispatchable: false }
          ]
        })
      );
    const previewClaimNext = vi
      .fn()
      .mockResolvedValueOnce(blockClaim("T-001#B-001"))
      .mockResolvedValueOnce({
        ...blockClaim("T-001#R-001"),
        blockType: "review" as const
      })
      .mockResolvedValue({ kind: "none", reason: "no_claimable_blocks" });
    const localReview: AvailableAgentEndpoint = {
      id: "local:local-review",
      source: "local",
      executorName: "local-review",
      displayName: "Local Review",
      locationName: null,
      available: true,
      unavailableReason: null,
      capabilities: [],
      remoteEndpointId: null
    };
    const {
      result,
      dispatch,
      setError,
      startLocal,
      previewClaimNext: preview
    } = renderRun({
      endpoints: [remoteEndpoint, localReview],
      graph: mixedGraph,
      preferences: {
        [agentEndpointPreferenceKey({
          projectRoot: project.rootPath,
          canvasId: "canvas-main",
          scope: { kind: "block", blockRef: "T-001#B-001" }
        })]: {
          kind: "remote",
          remoteEndpointId: "endpoint-windows"
        }
      },
      readRuntimeAvailability,
      previewClaimNext
    });

    await act(() => result.current({ kind: "project" }));

    expect(preview).toHaveBeenCalledTimes(3);
    expect(preview).toHaveBeenNthCalledWith(
      1,
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { kind: "project" }
    );
    expect(preview).toHaveBeenNthCalledWith(
      2,
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { kind: "project" }
    );
    expect(preview).toHaveBeenNthCalledWith(
      3,
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { kind: "project" }
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ blockRef: "T-001#B-001" }));
    expect(startLocal).toHaveBeenCalledTimes(1);
    expect(startLocal).toHaveBeenCalledWith(
      { kind: "block", blockRef: "T-001#R-001" },
      { stepLimit: 1 }
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("accepts step-limit paused as local unit success and stops to free the workspace", async () => {
    // selectedAgentEndpointId for no preference is `local:${executorName}` → local:codex
    const localOnly: AvailableAgentEndpoint = {
      id: "local:codex",
      source: "local",
      executorName: "codex",
      displayName: "Local Codex",
      locationName: null,
      available: true,
      unavailableReason: null,
      capabilities: ["acp.codex"],
      remoteEndpointId: null
    };
    // all-local short-circuits to startLocal without claim bus — force coordinated via remote preference on a second block path
    // Use mixed: one local block via claim bus (project with remote endpoint preference but execute only local by endpoint map)
    const localGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: [
        {
          ...graph.tasks[0]!,
          blocks: [
            {
              ...graph.tasks[0]!.blocks[0]!,
              ref: "T-001#B-001",
              status: "ready",
              dispatchable: true
            },
            {
              ...graph.tasks[0]!.blocks[0]!,
              ref: "T-001#B-002",
              blockId: "B-002",
              status: "ready",
              dispatchable: true
            }
          ]
        }
      ]
    };
    // Prefer local for both so plan is local_scope — that won't hit claim bus.
    // To force claim bus with local units, need at least one remote endpoint selected for another block.
    const remotePrefGraph = localGraph;
    const previewClaimNext = vi
      .fn()
      .mockResolvedValueOnce(blockClaim("T-001#B-001"))
      .mockResolvedValueOnce(blockClaim("T-001#B-002"))
      .mockResolvedValue({ kind: "none", reason: "no_claimable_blocks" });
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "ready",
          blocks: [
            { ref: "T-001#B-001", status: "ready" },
            { ref: "T-001#B-002", status: "ready" }
          ]
        })
      )
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [
            { ref: "T-001#B-001", status: "completed", dispatchable: false },
            { ref: "T-001#B-002", status: "ready" }
          ]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [
            { ref: "T-001#B-001", status: "completed", dispatchable: false },
            { ref: "T-001#B-002", status: "completed", dispatchable: false }
          ]
        })
      );
    const { result, startLocal, stopLocal, waitForLocalUnit, lifecycle, setError } = renderRun({
      endpoints: [remoteEndpoint, localOnly],
      graph: remotePrefGraph,
      // No preference for B-001 → local; remote preference only on B-002 → coordinated claim bus.
      preferences: {
        [agentEndpointPreferenceKey({
          projectRoot: project.rootPath,
          canvasId: "canvas-main",
          scope: { kind: "block", blockRef: "T-001#B-002" }
        })]: {
          kind: "remote",
          remoteEndpointId: "endpoint-windows"
        }
      },
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(waitForLocalUnit).toHaveBeenCalled();
    await expect(waitForLocalUnit.mock.results[0]!.value).resolves.toMatchObject({
      phase: "paused",
      error: "Step limit reached."
    });
    expect(startLocal).toHaveBeenCalledWith(
      { kind: "block", blockRef: "T-001#B-001" },
      { stepLimit: 1 }
    );
    expect(stopLocal).toHaveBeenCalledWith("DESKTOP-RUN-LOCAL");
    expect(lifecycle.onCompleted).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("executes a feedback claim unit with stepLimit 1 then continues", async () => {
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [{ ref: "T-001#B-001", status: "ready" }]
        })
      )
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [{ ref: "T-001#B-001", status: "ready" }]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
        })
      );
    const previewClaimNext = vi
      .fn()
      .mockResolvedValueOnce(feedbackClaim("FE-001"))
      .mockResolvedValueOnce(blockClaim("T-001#B-001"))
      .mockResolvedValue({ kind: "none", reason: "no_claimable_blocks" });
    const { result, dispatch, setError, startLocal, stopLocal, waitForLocalUnit, lifecycle } =
      renderRun({
        readRuntimeAvailability,
        previewClaimNext
      });

    await act(() => result.current({ kind: "project" }));

    expect(startLocal).toHaveBeenCalledWith({ kind: "task", taskId: "T-001" }, { stepLimit: 1 });
    expect(waitForLocalUnit).toHaveBeenCalled();
    expect(stopLocal).toHaveBeenCalledWith("DESKTOP-RUN-LOCAL");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ blockRef: "T-001#B-001" }));
    expect(lifecycle.onCompleted).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("surfaces claim_bus_blocked through lifecycle.onFailed", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "blocked" as const,
      reason: "dependency_incomplete",
      ref: "T-001#B-002"
    }));
    const readRuntimeAvailability = vi.fn().mockResolvedValue(
      statusProjection({
        taskStatus: "ready",
        blocks: [{ ref: "T-001#B-001", status: "ready" }]
      })
    );
    const { result, dispatch, setError, lifecycle } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(setError).toHaveBeenCalledWith("claim_bus_blocked:dependency_incomplete");
    expect(lifecycle.onFailed).toHaveBeenCalledWith("claim_bus_blocked:dependency_incomplete");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("surfaces claim_bus_idle when preview returns none while scope is incomplete", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "none" as const,
      reason: "no_claimable_blocks"
    }));
    const readRuntimeAvailability = vi.fn().mockResolvedValue(
      statusProjection({
        taskStatus: "in_progress",
        blocks: [{ ref: "T-001#B-001", status: "ready" }]
      })
    );
    const { result, setError, lifecycle } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(setError).toHaveBeenCalledWith("claim_bus_idle:no_claimable_blocks");
    expect(lifecycle.onFailed).toHaveBeenCalledWith("claim_bus_idle:no_claimable_blocks");
    // loop check (1) + refresh path (2 dedicated reads)
    expect(readRuntimeAvailability).toHaveBeenCalledTimes(3);
  });

  it("refreshes completion projection after claim none before judging idle", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "none" as const,
      reason: "no_claimable_blocks"
    }));
    const incomplete = statusProjection({
      taskStatus: "in_progress",
      blocks: [{ ref: "T-001#B-001", status: "ready" }]
    });
    const complete = statusProjection({
      taskStatus: "implemented",
      blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
    });
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(incomplete) // loop-start check
      .mockResolvedValueOnce(incomplete) // refresh first read (still lagging)
      .mockResolvedValue(complete); // refresh second read catches up
    const { result, setError, lifecycle, dispatch } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(lifecycle.onCompleted).toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(readRuntimeAvailability).toHaveBeenCalledTimes(3);
  });

  it("fails closed after a mid-run disconnect instead of accepting a cached completed status", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "none" as const,
      reason: "no_claimable_blocks"
    }));
    const cachedCompleted = statusProjection({
      taskStatus: "implemented",
      blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
    });
    let online = true;
    const readRuntimeAvailability = vi.fn(async () => {
      if (!online) return null;
      online = false;
      return statusProjection({
        taskStatus: "in_progress",
        blocks: [{ ref: "T-001#B-001", status: "ready" }]
      });
    });
    expect(cachedCompleted.tasks[0]?.status).toBe("implemented");
    const { result, setError, lifecycle } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(setError).toHaveBeenCalledWith("collaboration_runtime_availability_unavailable");
    expect(lifecycle.onFailed).toHaveBeenCalledWith(
      "collaboration_runtime_availability_unavailable"
    );
  });

  it("fails completion refresh on explicit unavailable without using cached status", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "none" as const,
      reason: "no_claimable_blocks"
    }));
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "in_progress",
          blocks: [{ ref: "T-001#B-001", status: "ready" }]
        })
      )
      .mockResolvedValue({
        schemaVersion: "canvas-runtime-view/v1",
        state: { kind: "uninitialized" },
        execution: {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "unavailable",
          reason: "content_out_of_sync"
        }
      });
    const { result, setError, lifecycle } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(setError).toHaveBeenCalledWith("collaboration_runtime_content_out_of_sync");
    expect(lifecycle.onFailed).toHaveBeenCalledWith("collaboration_runtime_content_out_of_sync");
  });

  it("waits through an empty Server runtime projection instead of failing as uninitialized", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "none" as const,
      reason: "no_claimable_blocks"
    }));
    const complete = statusProjection({
      taskStatus: "implemented",
      blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
    });
    const pending = {
      schemaVersion: "canvas-runtime-view/v1" as const,
      state: { kind: "uninitialized" as const },
      execution: {
        schemaVersion: "canvas-runtime-availability/v1" as const,
        kind: "available" as const,
        status: complete,
        sourceRevision: "source-revision-1",
        graphFingerprint: complete.packageFingerprint
      }
    };
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(complete);
    const { result, setError, lifecycle } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "project" }));

    expect(lifecycle.onCompleted).toHaveBeenCalledOnce();
    expect(setError).not.toHaveBeenCalledWith("collaboration_runtime_state_uninitialized");
  });

  it("surfaces collaboration_runtime_block_status_unavailable when block row missing after refresh", async () => {
    const previewClaimNext = vi.fn(async () => ({
      kind: "none" as const,
      reason: "no_claimable_blocks"
    }));
    const withBlock = statusProjection({
      taskStatus: "in_progress",
      blocks: [{ ref: "T-001#B-001", status: "ready" }]
    });
    const missingBlock = statusProjection({
      taskStatus: "in_progress",
      blocks: []
    });
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(withBlock) // loop-start: block present, not completed
      .mockResolvedValue(missingBlock); // refresh: target block row still absent
    const { result, setError, lifecycle } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(setError).toHaveBeenCalledWith(
      "collaboration_runtime_block_status_unavailable:T-001#B-001"
    );
    expect(lifecycle.onFailed).toHaveBeenCalledWith(
      "collaboration_runtime_block_status_unavailable:T-001#B-001"
    );
    expect(setError).not.toHaveBeenCalledWith("claim_bus_idle:no_claimable_blocks");
  });

  it("runs coordinated_block through claim bus rather than execute-once", async () => {
    const previewClaimNext = vi
      .fn()
      .mockResolvedValueOnce(blockClaim("T-001#B-001"))
      .mockResolvedValue({ kind: "none", reason: "done" });
    const readRuntimeAvailability = vi
      .fn()
      .mockResolvedValueOnce(
        statusProjection({
          taskStatus: "ready",
          blocks: [{ ref: "T-001#B-001", status: "ready" }]
        })
      )
      .mockResolvedValue(
        statusProjection({
          taskStatus: "implemented",
          blocks: [{ ref: "T-001#B-001", status: "completed", dispatchable: false }]
        })
      );
    const {
      result,
      dispatch,
      previewClaimNext: preview,
      setError
    } = renderRun({
      previewClaimNext,
      readRuntimeAvailability
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(preview).toHaveBeenCalledWith(
      { projectRoot: project.rootPath, canvasId: "canvas-main" },
      { kind: "block", blockRef: "T-001#B-001" }
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("dispatches an inherited Block to the exact remote endpoint selected on its Task", async () => {
    const graphWithFollowingBlock: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) => ({
        ...task,
        blocks: [
          ...task.blocks,
          {
            ...task.blocks[0]!,
            ref: "T-001#B-002",
            blockId: "B-002",
            title: "Following Block"
          }
        ]
      }))
    };
    const { result, dispatch, ensureWorkAuthority, setError, startLocal, startWorkspaceExecution } =
      renderRun({
        graph: graphWithFollowingBlock
      });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(ensureWorkAuthority).not.toHaveBeenCalled();
    expect(startWorkspaceExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-windows"
      })
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("keeps logical executor capability requirements as a dispatch gate", async () => {
    const { result, dispatch, ensureWorkAuthority, setError } = renderRun({
      endpoint: { ...remoteEndpoint, capabilities: [] }
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(ensureWorkAuthority).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(
      "agent_endpoint_unavailable:T-001#B-001:Codex:agent_endpoint_incompatible"
    );
  });

  it("runs a remote Task through its next authoritative Block and waits for completion", async () => {
    const {
      result,
      ensureWorkAuthority,
      previewClaimNext,
      setError,
      startLocal,
      waitForTerminal,
      startWorkspaceExecution
    } = renderRun();

    await act(() => result.current({ kind: "task", taskId: "T-001" }));

    expect(previewClaimNext).toHaveBeenCalled();
    expect(ensureWorkAuthority).not.toHaveBeenCalled();
    expect(startWorkspaceExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-windows"
      })
    );
    expect(waitForTerminal).toHaveBeenCalledTimes(1);
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("surfaces the normalized Host failure instead of a generic remote state", async () => {
    const { result, setError } = renderRun({
      remoteTerminal: operation("failed", {
        code: "acp_authentication_required",
        message: "ACP authentication is required.",
        retryable: false
      })
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(setError).toHaveBeenCalledWith(
      "ACP authentication is required. (acp_authentication_required)"
    );
  });

  it("resets Auto Run follow backoff after a follow returns events", async () => {
    const delay = vi
      .spyOn(workspaceExecutionPollingCadence, "workspaceExecutionSuccessPollDelay")
      .mockReturnValue(0);
    const runningView = {
      version: "planweave.workspace-execution-view/v1" as const,
      handle: {
        version: "planweave.workspace-execution-handle/v1" as const,
        target: "remote" as const,
        phase: "attempt" as const,
        runSessionId: "SESSION-0001",
        authorityBindingId: `wxb:sha256:${"a".repeat(64)}`,
        scope: { kind: "block" as const, blockRef: "T-001#B-001" },
        capabilities: { interactionResponse: true },
        operationId: "operation-1",
        operationRevision: 1,
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        attemptStateVersion: 1,
        leaseId: "lease-1",
        agentEndpointId: "endpoint-windows",
        cursor: { target: "remote" as const, executionAttemptId: "attempt-1", eventCursor: 1 }
      },
      session: {
        sessionId: "SESSION-0001",
        stateVersion: 1,
        phase: "running" as const,
        scope: { kind: "block" as const, blockRef: "T-001#B-001" },
        startedAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:01.000Z",
        finishedAt: null,
        error: null,
        interactionStatus: [],
        evidence: { status: "complete" as const, diagnostics: [] }
      },
      events: [] as Array<{
        version: "planweave.execution-event/v1";
        eventId: string;
        observedAt: string;
        runSessionId: string;
        scope: { kind: "block"; blockRef: string };
        source: {
          target: "remote";
          operationId: string;
          executionAttemptId: string;
          cursor: number;
        };
        type: "operation_observed" | "run_terminal";
        data: Record<string, unknown>;
      }>
    };
    const progressView = {
      ...runningView,
      events: [
        {
          version: "planweave.execution-event/v1" as const,
          eventId: "operation-1:operation:2",
          observedAt: "2026-08-05T00:00:02.000Z",
          runSessionId: "SESSION-0001",
          scope: { kind: "block" as const, blockRef: "T-001#B-001" },
          source: {
            target: "remote" as const,
            operationId: "operation-1",
            executionAttemptId: "attempt-1",
            cursor: 2
          },
          type: "operation_observed" as const,
          data: { state: "running", attemptStatus: "running", operationRevision: 2 }
        }
      ]
    };
    const completedView = {
      ...runningView,
      session: {
        ...runningView.session,
        phase: "completed" as const,
        finishedAt: "2026-08-05T00:00:03.000Z"
      },
      events: [
        {
          version: "planweave.execution-event/v1" as const,
          eventId: "terminal-completed",
          observedAt: "2026-08-05T00:00:03.000Z",
          runSessionId: "SESSION-0001",
          scope: { kind: "block" as const, blockRef: "T-001#B-001" },
          source: {
            target: "remote" as const,
            operationId: "operation-1",
            executionAttemptId: "attempt-1",
            cursor: 3
          },
          type: "run_terminal" as const,
          data: { outcome: "completed" }
        }
      ]
    };
    const followWorkspaceExecution = vi
      .fn()
      .mockResolvedValueOnce(runningView)
      .mockResolvedValueOnce(progressView)
      .mockResolvedValueOnce(completedView);
    const { result, setError, lifecycle } = renderRun({ followWorkspaceExecution });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(followWorkspaceExecution).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls.map((call) => call[0])).toEqual([0, 1, 0]);
    expect(lifecycle.onCompleted).toHaveBeenCalledOnce();
    expect(setError).not.toHaveBeenCalled();
    delay.mockRestore();
  });
});
