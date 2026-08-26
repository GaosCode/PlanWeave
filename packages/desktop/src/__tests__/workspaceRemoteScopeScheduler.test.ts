import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  runWorkspaceRemoteScope,
  runWorkspaceRemoteScopeFromAvailability
} from "../renderer/collaboration/workspaceRemoteScopeScheduler";

const graph: DesktopGraphViewModel = {
  projectId: "project-local",
  projectTitle: "Project",
  graphVersion: "graph-v1",
  packageFingerprint: "package-v1",
  executorOptions: ["codex"],
  autoRunPreflightExecutorHint: "codex",
  tasks: [
    {
      taskId: "T-001",
      title: "Task",
      status: "completed",
      executor: "codex",
      executorLabel: "codex",
      promptMarkdown: "# Task",
      promptMissing: false,
      promptPreview: "Task",
      sharedResources: [],
      blocks: [
        {
          ref: "T-001#B-001",
          blockId: "B-001",
          type: "implementation",
          title: "First",
          status: "completed",
          executor: null,
          requiredCapabilities: ["acp.codex"],
          promptMissing: false,
          exceptionReason: null,
          dispatchable: false,
          remoteExecution: null
        },
        {
          ref: "T-001#B-002",
          blockId: "B-002",
          type: "implementation",
          title: "Second",
          status: "completed",
          executor: null,
          requiredCapabilities: ["acp.codex"],
          promptMissing: false,
          exceptionReason: null,
          dispatchable: false,
          remoteExecution: null
        }
      ],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    }
  ],
  edges: [],
  sharedResourceGroups: [],
  diagnostics: [],
  dirtyPromptRefs: []
};

const binding = {
  workspaceId: "workspace-1",
  projectId: "project-server",
  canvasId: "canvas-main"
};

function remoteScopeStatus(
  rows: Array<{
    ref: string;
    status:
      | "planned"
      | "ready"
      | "in_progress"
      | "completed"
      | "needs_changes"
      | "blocked"
      | "diverged";
    dispatchable: boolean;
  }>,
  options?: { packageFingerprint?: string; projectId?: string }
): CanvasRuntimeStatusProjection {
  return {
    schemaVersion: "canvas-runtime-status/v2",
    scope: {
      ...binding,
      projectId: options?.projectId ?? binding.projectId
    },
    packageFingerprint: options?.packageFingerprint ?? graph.packageFingerprint,
    capturedAt: "2026-08-23T00:00:00.000Z",
    tasks: [{ taskId: "T-001", status: "ready", openFeedbackCount: 0 }],
    blocks: rows.map((row) => ({
      ...row,
      completionReason: row.status === "completed" ? "passed" : null,
      blockedReason: null,
      divergenceReason: null
    }))
  };
}

function availability(input: {
  status: CanvasRuntimeStatusProjection;
  initialized?: boolean;
  sourceRevision?: string;
  graphFingerprint?: string;
}): CanvasRuntimeAvailability {
  const graphFingerprint = input.graphFingerprint ?? input.status.packageFingerprint;
  return {
    schemaVersion: "canvas-runtime-view/v1",
    state: input.initialized
      ? { kind: "initialized", runtimeRevision: 1, status: input.status }
      : { kind: "uninitialized" },
    execution: {
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "available",
      status: input.status,
      sourceRevision: input.sourceRevision ?? "source-revision-1",
      graphFingerprint
    }
  };
}

const serverReady = remoteScopeStatus([
  { ref: "T-001#B-001", status: "ready", dispatchable: true },
  { ref: "T-001#B-002", status: "planned", dispatchable: false }
]);
const serverCompleted = remoteScopeStatus([
  { ref: "T-001#B-001", status: "completed", dispatchable: false },
  { ref: "T-001#B-002", status: "completed", dispatchable: false }
]);

describe("Workspace remote scope scheduling", () => {
  it.each([
    { label: "Task", scope: { kind: "task", taskId: "T-001" } as const },
    { label: "Project", scope: { kind: "project" } as const }
  ])("bootstraps the first $label dispatch from Server availability", async ({ scope }) => {
    let dispatched = false;
    const execute = vi.fn(async () => {
      dispatched = true;
    });
    const readAvailability = vi.fn(async () =>
      availability({
        status: dispatched ? serverCompleted : serverReady,
        initialized: dispatched
      })
    );

    await runWorkspaceRemoteScopeFromAvailability({
      graph,
      scope,
      binding,
      readAvailability,
      execute
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith("T-001#B-001", undefined);
    expect(readAvailability).toHaveBeenCalledTimes(3);
  });

  it("lets Server readiness override a conflicting completed local graph", async () => {
    let dispatched = false;
    const execute = vi.fn(async () => {
      dispatched = true;
    });

    await runWorkspaceRemoteScopeFromAvailability({
      graph,
      scope: { kind: "task", taskId: "T-001" },
      binding,
      readAvailability: async () =>
        availability({
          status: dispatched ? serverCompleted : serverReady,
          initialized: dispatched
        }),
      execute
    });

    expect(execute).toHaveBeenCalledWith("T-001#B-001", undefined);
  });

  it("does not dispatch when Server has no dispatchable Block", async () => {
    const execute = vi.fn();
    const serverIdle = remoteScopeStatus([
      { ref: "T-001#B-001", status: "completed", dispatchable: false },
      { ref: "T-001#B-002", status: "planned", dispatchable: false }
    ]);

    await expect(
      runWorkspaceRemoteScopeFromAvailability({
        graph,
        scope: { kind: "task", taskId: "T-001" },
        binding,
        readAvailability: async () => availability({ status: serverIdle }),
        execute
      })
    ).rejects.toThrow("workspace_remote_scope_idle:no_dispatchable_blocks");

    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects source revision drift before dispatch", async () => {
    const execute = vi.fn();
    const readAvailability = vi
      .fn()
      .mockResolvedValueOnce(availability({ status: serverReady, sourceRevision: "source-1" }))
      .mockResolvedValueOnce(availability({ status: serverReady, sourceRevision: "source-2" }));

    await expect(
      runWorkspaceRemoteScopeFromAvailability({
        graph,
        scope: { kind: "task", taskId: "T-001" },
        binding,
        readAvailability,
        execute
      })
    ).rejects.toThrow("workspace_remote_scope_source_mismatch");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects graph fingerprint drift before dispatch", async () => {
    const execute = vi.fn();
    const changed = remoteScopeStatus(
      [{ ref: "T-001#B-001", status: "ready", dispatchable: true }],
      { packageFingerprint: "package-v2" }
    );
    const readAvailability = vi
      .fn()
      .mockResolvedValueOnce(availability({ status: serverReady }))
      .mockResolvedValueOnce(
        availability({ status: changed, sourceRevision: "source-revision-1" })
      );

    await expect(
      runWorkspaceRemoteScopeFromAvailability({
        graph,
        scope: { kind: "task", taskId: "T-001" },
        binding,
        readAvailability,
        execute
      })
    ).rejects.toThrow("workspace_remote_scope_content_mismatch");
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a mismatched Server scope before dispatch", async () => {
    const execute = vi.fn();
    const wrongScope = remoteScopeStatus(
      [{ ref: "T-001#B-001", status: "ready", dispatchable: true }],
      { projectId: "project-other" }
    );

    await expect(
      runWorkspaceRemoteScopeFromAvailability({
        graph,
        scope: { kind: "task", taskId: "T-001" },
        binding,
        readAvailability: async () => availability({ status: wrongScope }),
        execute
      })
    ).rejects.toThrow("collaboration_runtime_scope_mismatch");
    expect(execute).not.toHaveBeenCalled();
  });

  it("advances a Task run from authoritative dispatchable state", async () => {
    let phase = 0;
    const execute = vi.fn(async () => {
      phase += 1;
    });
    const readStatus = vi.fn(async () =>
      phase === 0
        ? serverReady
        : phase === 1
          ? remoteScopeStatus([
              { ref: "T-001#B-001", status: "completed", dispatchable: false },
              { ref: "T-001#B-002", status: "ready", dispatchable: true }
            ])
          : serverCompleted
    );

    await runWorkspaceRemoteScope({
      graph,
      scope: { kind: "task", taskId: "T-001" },
      readStatus,
      execute
    });

    expect(execute.mock.calls.map(([ref]) => ref)).toEqual(["T-001#B-001", "T-001#B-002"]);
  });

  it("does not redispatch a Block while the Server projection is lagging", async () => {
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(serverReady)
      .mockResolvedValueOnce(serverReady)
      .mockResolvedValueOnce(serverCompleted);
    const execute = vi.fn(async () => undefined);
    const waitForStatusChange = vi.fn(async () => undefined);

    await runWorkspaceRemoteScope({
      graph,
      scope: { kind: "task", taskId: "T-001" },
      readStatus,
      execute,
      waitForStatusChange
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(waitForStatusChange).toHaveBeenCalledTimes(1);
  });

  it("waits for an existing remote operation after reconnect", async () => {
    const readStatus = vi
      .fn()
      .mockResolvedValueOnce(
        remoteScopeStatus([
          { ref: "T-001#B-001", status: "in_progress", dispatchable: false },
          { ref: "T-001#B-002", status: "planned", dispatchable: false }
        ])
      )
      .mockResolvedValueOnce(serverCompleted);
    const execute = vi.fn();
    const waitForStatusChange = vi.fn(async () => undefined);

    await runWorkspaceRemoteScope({
      graph,
      scope: { kind: "task", taskId: "T-001" },
      readStatus,
      execute,
      waitForStatusChange
    });

    expect(execute).not.toHaveBeenCalled();
    expect(waitForStatusChange).toHaveBeenCalledOnce();
  });

  it("does not report completion when cancelled during a status read", async () => {
    let resolveStatus: ((status: CanvasRuntimeStatusProjection) => void) | undefined;
    const pendingStatus = new Promise<CanvasRuntimeStatusProjection>((resolve) => {
      resolveStatus = resolve;
    });
    const controller = new AbortController();
    const run = runWorkspaceRemoteScope({
      graph,
      scope: { kind: "task", taskId: "T-001" },
      readStatus: () => pendingStatus,
      execute: vi.fn(),
      signal: controller.signal
    });

    controller.abort();
    resolveStatus?.(serverCompleted);

    await expect(run).rejects.toThrow("workspace_remote_scope_cancelled");
  });
});
