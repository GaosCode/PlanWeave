import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { remoteAgentEndpointListSchema } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import {
  remoteInteractionPageSchema,
  remoteInteractionViewSchema,
  remoteOperationObservationSchema,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { workAuthorityProjectionSchema } from "@planweave-ai/collaboration-protocol/work/authority";
import { createWorkspaceAuthorityBindingResolver } from "../workspaceExecution/authorityBinding.js";
import { createLocalPackageAuthoritySource } from "../workspaceExecution/authorityBinding.js";
import { WorkspaceExecutionCoordinator } from "../workspaceExecution/coordinator.js";
import { createLocalWorkspaceExecutionAdapter } from "../workspaceExecution/localExecutionAdapter.js";
import { createRemoteWorkspaceExecutionAdapter } from "../workspaceExecution/remoteExecutionAdapter.js";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { loadPlanGraphPackage } from "../plangraph/packageRepository.js";
import { getAutoRunStatus } from "../taskManager/autoRun.js";
import {
  appendRunSessionEvent,
  createRunSession,
  getRunSession,
  listRunSessions,
  updateRunSession,
  withRunSessionScopeLock
} from "../runSessions/repository.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const fingerprint = `pkg-${"a".repeat(64)}`;
const revisions = {
  responsibilityRevision: 1,
  reviewerRevision: 2,
  executionTargetRevision: 3
};
const endpoint = {
  schemaVersion: "agent-endpoint/v1" as const,
  endpointId: "endpoint-codex",
  profileId: "codex-acp",
  agentId: "codex",
  displayName: "Codex",
  hostDisplayName: "Build Host",
  capabilities: ["acp.codex"],
  status: "available" as const
};

function request(packageWorkspace: string) {
  return {
    authority: {
      kind: "workspace_canvas" as const,
      packageWorkspace,
      connectionProfileId: "profile-1",
      serverOrigin: "https://planweave.example",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "default",
      expected: { contentRevision: "snapshot:revision-1", graphFingerprint: fingerprint }
    },
    scope: { kind: "block" as const, blockRef: "T-001#B-001" },
    trigger: "cli" as const,
    target: { policy: "remote" as const },
    effectiveExecutor: { name: "codex-acp", agentId: "codex" },
    eventFormat: "execution-v1" as const
  };
}

function authorityResolver(packageWorkspace: string, overrides: Record<string, unknown> = {}) {
  return createWorkspaceAuthorityBindingResolver({
    local: { inspect: vi.fn() },
    remote: {
      inspect: vi.fn(async () => remoteSnapshotForWorkspace(packageWorkspace, overrides))
    }
  });
}

function remoteSnapshotForWorkspace(
  packageWorkspace: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    packageWorkspace,
    connectionProfileId: "profile-1",
    serverOrigin: "https://planweave.example",
    workspaceId: "workspace-1",
    projectId: "project-1",
    canvasId: "default",
    blockRef: "T-001#B-001",
    contentRevision: "snapshot:revision-1",
    graphFingerprint: fingerprint,
    authorityRevisions: revisions,
    ...overrides
  };
}

function workAuthority() {
  const scope = {
    kind: "block" as const,
    workspaceId: "workspace-1",
    projectId: "project-1",
    canvasId: "default",
    blockRef: "T-001#B-001"
  };
  return workAuthorityProjectionSchema.parse({
    schemaVersion: "work-authority/v1",
    scope,
    responsibility: {
      schemaVersion: "responsibility/v1",
      scope,
      principal: null,
      revision: 1,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: "unassigned"
    },
    reviewer: {
      schemaVersion: "review-assignment/v1",
      scope,
      principal: null,
      revision: 2,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: "unassigned"
    },
    executionTarget: {
      schemaVersion: "execution-target/v1",
      scope,
      target: { kind: "exact_host", hostId: "host-1" },
      revision: 3,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: { status: "ready", reason: "ready" }
    },
    revisions,
    selectedHost: null,
    evaluatedAt: "2030-01-01T00:00:00.000Z"
  });
}

function observation(
  input: {
    state?: RemoteOperationObservation["state"];
    attemptId?: string;
    revision?: number;
    attemptStateVersion?: number;
    attemptStatus?: RemoteOperationObservation["attempt"]["status"];
  } = {}
) {
  const attemptId = input.attemptId ?? "attempt-1";
  const state = input.state ?? "running";
  return remoteOperationObservationSchema.parse({
    operationId: "operation-1",
    projectId: "project-1",
    canvasId: "default",
    blockRef: "T-001#B-001",
    state,
    dispatchId: `dispatch-${attemptId}`,
    executionAttemptId: attemptId,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: `2030-01-01T00:00:0${input.revision ?? 1}.000Z`,
    ...(state === "completed" ? { terminalAt: "2030-01-01T00:00:09.000Z" } : {}),
    agentEndpoint: { ...endpoint, resolvedAt: "2030-01-01T00:00:00.000Z" },
    attempt: {
      executionAttemptId: attemptId,
      dispatchId: `dispatch-${attemptId}`,
      status: input.attemptStatus ?? (state === "completed" ? "completed" : state),
      stateVersion: input.attemptStateVersion ?? input.revision ?? 1
    },
    diagnostics: {
      stage:
        state === "completed"
          ? "terminal"
          : state === "awaiting_writeback"
            ? "writing_back"
            : "running",
      revision: input.revision ?? 1,
      attemptId,
      locator: { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" },
      endpointId: "endpoint-codex",
      authorityRevisions: { responsibility: 1, reviewer: 2, executionTarget: 3 },
      content: { revision: "snapshot:revision-1", fingerprint },
      startedAt: "2030-01-01T00:00:00.000Z",
      updatedAt: `2030-01-01T00:00:0${input.revision ?? 1}.000Z`,
      ...(state === "completed" ? { terminalAt: "2030-01-01T00:00:09.000Z" } : {})
    },
    runtime: {
      ref: "T-001#B-001",
      status: state === "completed" ? "completed" : "in_progress"
    }
  });
}

function fixture(input: {
  packageWorkspace: string;
  authority?: ReturnType<typeof authorityResolver>;
  workAuthority?: () => Promise<ReturnType<typeof workAuthority>>;
  dispatch?: () => Promise<RemoteOperationObservation>;
  recover?: () => Promise<RemoteOperationObservation | null>;
  observe?: () => Promise<RemoteOperationObservation>;
  replay?: (afterCursor: number) => Promise<ReturnType<typeof emptyReplay>>;
  interactions?: (cursor: number) => Promise<ReturnType<typeof emptyInteractions>>;
  sessions?: ConstructorParameters<typeof WorkspaceExecutionCoordinator>[0]["sessions"];
}) {
  const catalog = {
    list: vi.fn(async () =>
      remoteAgentEndpointListSchema.parse({
        schemaVersion: "agent-endpoint-list/v1",
        items: [endpoint]
      })
    )
  };
  const dispatch = vi.fn(input.dispatch ?? (async () => observation()));
  const recover = vi.fn(input.recover ?? (async () => null));
  const observe = vi.fn(
    input.observe ?? (async () => observation({ state: "completed", revision: 2 }))
  );
  const replay = vi.fn(
    async ({ afterCursor }: { afterCursor: number }) =>
      input.replay?.(afterCursor) ?? emptyReplay(afterCursor)
  );
  const interactions = vi.fn(
    async ({ cursor }: { cursor: number }) => input.interactions?.(cursor) ?? emptyInteractions()
  );
  const respond = vi.fn(async ({ response }: { response: unknown }) =>
    remoteInteractionViewSchema.parse({
      request: pendingInteraction().items[0]?.request,
      operationId: "operation-1",
      hostId: "host-1",
      status: "settled",
      createdAt: "2030-01-01T00:00:00.000Z",
      settlement: response,
      settledBy: "human-1",
      settledAt: "2030-01-01T00:01:00.000Z"
    })
  );
  const workAuthorityPort = {
    ensure: vi.fn(input.workAuthority ?? (async () => workAuthority()))
  };
  const remote = createRemoteWorkspaceExecutionAdapter({
    workAuthority: workAuthorityPort,
    command: { dispatch },
    query: { recover, observe, replay, interactions },
    interaction: { respond }
  });
  const coordinator = new WorkspaceExecutionCoordinator({
    authority: input.authority ?? authorityResolver(input.packageWorkspace),
    catalog,
    workAuthority: workAuthorityPort,
    local: { launch: vi.fn() },
    remote,
    sessions: input.sessions,
    clock: () => new Date("2030-01-01T00:10:00.000Z")
  });
  return {
    coordinator,
    catalog: catalog.list,
    workAuthority: workAuthorityPort.ensure,
    dispatch,
    recover,
    observe,
    replay,
    interactions,
    respond
  };
}

function emptyReplay(afterCursor = 0) {
  return {
    eventProtocolVersion: 2 as const,
    executionAttemptId: "attempt-1",
    afterCursor,
    cursor: afterCursor,
    highWatermark: afterCursor,
    hasMore: false,
    events: []
  };
}

function emptyInteractions() {
  return remoteInteractionPageSchema.parse({ items: [], nextCursor: null });
}

function pendingInteraction(attemptId = "attempt-2") {
  return remoteInteractionPageSchema.parse({
    items: [
      {
        request: {
          type: "interaction.permission_requested",
          dispatchId: `dispatch-${attemptId}`,
          leaseId: "lease-1",
          executionAttemptId: attemptId,
          actionId: "action-1",
          acpSessionId: "acp-session-1",
          expiresAt: "2030-01-01T01:00:00.000Z",
          title: "Permission",
          description: "Approve tool use"
        },
        operationId: "operation-1",
        hostId: "host-1",
        status: "pending",
        createdAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    nextCursor: null
  });
}

function sessionPorts(
  overrides: Partial<
    NonNullable<ConstructorParameters<typeof WorkspaceExecutionCoordinator>[0]["sessions"]>
  > = {}
) {
  return {
    create: createRunSession,
    get: getRunSession,
    list: listRunSessions,
    update: updateRunSession,
    appendEvent: appendRunSessionEvent,
    withScopeLock: withRunSessionScopeLock,
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("WorkspaceExecutionCoordinator", () => {
  it("delegates explicit local execution to runWithSession without consulting Catalog", async () => {
    const { root } = await createTestWorkspace();
    const snapshot = await capturePackageSnapshot({ projectRoot: root });
    const graph = await loadPlanGraphPackage(root);
    const catalog = { list: vi.fn() };
    const coordinator = new WorkspaceExecutionCoordinator({
      authority: createWorkspaceAuthorityBindingResolver({
        local: createLocalPackageAuthoritySource(),
        remote: { inspect: vi.fn() }
      }),
      catalog,
      workAuthority: { ensure: vi.fn() },
      local: createLocalWorkspaceExecutionAdapter(),
      remote: { launch: vi.fn(), follow: vi.fn(), respond: vi.fn() }
    });
    const localRequest = {
      authority: {
        kind: "local_package" as const,
        packageWorkspace: root,
        expected: {
          contentRevision: snapshot.snapshot.sourceRevision,
          graphFingerprint: graph.graph.packageFingerprint
        }
      },
      scope: { kind: "block" as const, blockRef: "T-001#B-001" },
      trigger: "cli" as const,
      target: { policy: "local" as const },
      executorOverride: "manual",
      eventFormat: "execution-v1" as const
    };

    const result = await coordinator.execute(localRequest);

    expect(catalog.list).not.toHaveBeenCalled();
    expect(result.handle).toMatchObject({ target: "local", localRunId: result.session.sessionId });
    expect(result.session.phase).toBe("manual");
    expect(result.session.autoRun).toMatchObject({
      stepCount: 1,
      executorOverride: "manual",
      stopReason: null
    });
    expect(result.events.map((event) => event.type)).toEqual([
      "execution_selected",
      "action_required"
    ]);
  });

  it("fails authority mismatches before Catalog and Dispatch", async () => {
    const { root } = await createTestWorkspace();
    const f = fixture({
      packageWorkspace: root,
      authority: authorityResolver(root, { projectId: "wrong-project" })
    });

    await expect(f.coordinator.execute(request(root))).rejects.toMatchObject({
      code: "workspace_execution_authority_mismatch"
    });
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("fails changed work authority before Catalog and Dispatch", async () => {
    const { root } = await createTestWorkspace();
    const f = fixture({
      packageWorkspace: root,
      workAuthority: async () =>
        workAuthorityProjectionSchema.parse({
          ...workAuthority(),
          revisions: {
            ...revisions,
            executionTargetRevision: revisions.executionTargetRevision + 1
          }
        })
    });

    await expect(f.coordinator.execute(request(root))).rejects.toMatchObject({
      code: "workspace_execution_authority_mismatch"
    });
    expect(f.workAuthority).toHaveBeenCalledTimes(1);
    expect(f.catalog).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("revalidates the binding after Catalog and rejects drift before Dispatch", async () => {
    const { root } = await createTestWorkspace();
    const executionRequest = request(root);
    const initial = await authorityResolver(root).resolve(
      executionRequest.authority,
      executionRequest.scope
    );
    const changedRequest = {
      ...executionRequest,
      authority: {
        ...executionRequest.authority,
        expected: {
          ...executionRequest.authority.expected,
          contentRevision: "snapshot:revision-2"
        }
      }
    };
    const changed = await authorityResolver(root, {
      contentRevision: "snapshot:revision-2"
    }).resolve(changedRequest.authority, changedRequest.scope);
    const resolve = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(changed);
    const f = fixture({ packageWorkspace: root, authority: { resolve } });

    await expect(f.coordinator.execute(executionRequest)).rejects.toMatchObject({
      code: "workspace_execution_authority_mismatch"
    });

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(f.workAuthority).toHaveBeenCalledTimes(1);
    expect(f.catalog).toHaveBeenCalledTimes(1);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["completed", true, "completed"],
    ["failed", false, "failed"]
  ] as const)("keeps local and remote %s terminal envelopes substitutable", async (outcome, ok, terminalReason) => {
    const localWorkspace = await createTestWorkspace();
    const snapshot = await capturePackageSnapshot({ projectRoot: localWorkspace.root });
    const graph = await loadPlanGraphPackage(localWorkspace.root);
    const local = createLocalWorkspaceExecutionAdapter({
      run: async (options) => {
        const finishedAt = "2030-01-01T00:00:00.000Z";
        const session = await createRunSession({
          projectRoot: options.projectRoot,
          kind: "run",
          scope: options.scope ?? { kind: "project" }
        });
        return {
          session: {
            ...session,
            phase: outcome,
            updatedAt: finishedAt,
            finishedAt,
            error: outcome === "failed" ? "local_failure" : null
          },
          steps: [],
          status: await getAutoRunStatus({ projectRoot: localWorkspace.root }),
          ok,
          terminalReason
        };
      }
    });
    const localCoordinator = new WorkspaceExecutionCoordinator({
      authority: createWorkspaceAuthorityBindingResolver({
        local: createLocalPackageAuthoritySource(),
        remote: { inspect: vi.fn() }
      }),
      catalog: { list: vi.fn() },
      workAuthority: { ensure: vi.fn() },
      local,
      remote: { launch: vi.fn(), follow: vi.fn(), respond: vi.fn() }
    });
    const localResult = await localCoordinator.execute({
      authority: {
        kind: "local_package",
        packageWorkspace: localWorkspace.root,
        expected: {
          contentRevision: snapshot.snapshot.sourceRevision,
          graphFingerprint: graph.graph.packageFingerprint
        }
      },
      scope: { kind: "block", blockRef: "T-001#B-001" },
      trigger: "cli",
      target: { policy: "local" },
      eventFormat: "execution-v1"
    });

    const remoteWorkspace = await createTestWorkspace();
    const remote = fixture({
      packageWorkspace: remoteWorkspace.root,
      observe: async () => observation({ state: outcome, attemptStatus: outcome, revision: 2 })
    });
    const started = await remote.coordinator.execute(request(remoteWorkspace.root));
    const remoteResult = await remote.coordinator.follow(
      request(remoteWorkspace.root),
      started.handle.runSessionId
    );

    const localTerminal = localResult.events.find((event) => event.type === "run_terminal");
    const remoteTerminal = remoteResult.events.find((event) => event.type === "run_terminal");
    expect(localTerminal).toMatchObject({ type: "run_terminal", data: { outcome } });
    expect(remoteTerminal).toMatchObject({ type: "run_terminal", data: { outcome } });
    expect(localResult.session.phase).toBe(outcome);
    expect(remoteResult.session.phase).toBe(outcome);
  });

  it("resumes a non-terminal operation without redispatch and waits for writeback terminal", async () => {
    const { root, init } = await createTestWorkspace();
    let observeCount = 0;
    const f = fixture({
      packageWorkspace: root,
      observe: async () => {
        observeCount += 1;
        return observeCount === 1
          ? observation({
              state: "awaiting_writeback",
              attemptStatus: "awaiting_writeback",
              revision: 2
            })
          : observation({ state: "completed", attemptStatus: "completed", revision: 3 });
      },
      replay: async (afterCursor) => ({
        eventProtocolVersion: 2,
        executionAttemptId: "attempt-1",
        afterCursor,
        cursor: afterCursor === 0 ? 1 : afterCursor,
        highWatermark: 1,
        hasMore: false,
        events:
          afterCursor === 0
            ? [
                {
                  eventVersion: 2,
                  cursor: 1,
                  sourceSequence: 10,
                  timestamp: "2030-01-01T00:00:01.000Z",
                  fragment: {
                    kind: "engine_terminal" as const,
                    terminal: { state: "succeeded" as const, stopReason: "end_turn" }
                  }
                }
              ]
            : []
      })
    });

    const started = await f.coordinator.execute(request(root));
    expect(started.session.phase).toBe("running");
    expect(f.dispatch).toHaveBeenCalledTimes(1);

    const awaitingWriteback = await f.coordinator.execute(request(root));
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(awaitingWriteback.session.phase).toBe("running");
    expect([...started.events, ...awaitingWriteback.events].map((event) => event.type)).toContain(
      "runner_event"
    );
    expect(awaitingWriteback.events.map((event) => event.type)).not.toContain("run_terminal");

    const completed = await f.coordinator.follow(request(root), started.handle.runSessionId);
    expect(completed.session.phase).toBe("completed");
    expect(completed.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["writeback_observed", "run_terminal"])
    );
    expect(f.dispatch).toHaveBeenCalledTimes(1);

    const restarted = await f.coordinator.execute(request(root));
    expect(restarted.handle.runSessionId).not.toBe(started.handle.runSessionId);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.dispatch.mock.calls[0]?.[0].intent.idempotencyKey).not.toBe(
      f.dispatch.mock.calls[1]?.[0].intent.idempotencyKey
    );

    const stored = await readFile(
      join(init.workspace.resultsDir, "run-sessions", started.handle.runSessionId, "session.json"),
      "utf8"
    );
    expect(stored).toContain('"workspaceExecution"');
    expect(stored).toContain('"operationId": "operation-1"');
    expect(stored).not.toMatch(/token|authorization|bearer|header/i);
  });

  it.each([
    ["content revision", { contentRevision: "snapshot:revision-corrupt" }],
    ["graph fingerprint", { graphFingerprint: `pkg-${"c".repeat(64)}` }],
    [
      "both content fields",
      {
        contentRevision: "snapshot:revision-corrupt",
        graphFingerprint: `pkg-${"c".repeat(64)}`
      }
    ]
  ] as const)("rejects a persisted intent with mismatched %s before restart transport", async (_name, mismatch) => {
    const { root, init } = await createTestWorkspace();
    const initial = fixture({ packageWorkspace: root });
    const started = await initial.coordinator.execute(request(root));
    const path = join(
      init.workspace.resultsDir,
      "run-sessions",
      started.handle.runSessionId,
      "session.json"
    );
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      workspaceExecution: { dispatchIntent: Record<string, unknown> };
    };
    Object.assign(stored.workspaceExecution.dispatchIntent, mismatch);
    await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const listed = await listRunSessions(root);
    expect(listed.sessions).toEqual([]);
    expect(listed.diagnostics).toEqual([
      expect.objectContaining({
        code: "run_session_invalid",
        message: expect.stringContaining("workspace_execution_dispatch_intent_mismatch")
      })
    ]);

    const restarted = fixture({ packageWorkspace: root });
    await expect(
      restarted.coordinator.follow(request(root), started.handle.runSessionId)
    ).rejects.toThrow("could not be read");
    expect(restarted.dispatch).not.toHaveBeenCalled();
    expect(restarted.recover).not.toHaveBeenCalled();
    expect(restarted.observe).not.toHaveBeenCalled();
    expect(restarted.replay).not.toHaveBeenCalled();
    expect(restarted.interactions).not.toHaveBeenCalled();
  });

  it("resets attempt cursors, exposes retention and interaction identity, and routes settlement exactly", async () => {
    const { root } = await createTestWorkspace();
    const f = fixture({
      packageWorkspace: root,
      observe: async () =>
        observation({
          state: "action_required",
          attemptStatus: "action_required",
          attemptId: "attempt-2",
          revision: 2
        }),
      replay: async (afterCursor) => ({
        eventProtocolVersion: 2,
        executionAttemptId: "attempt-2",
        afterCursor,
        cursor: 4,
        highWatermark: 4,
        hasMore: false,
        events: [],
        diagnostics: [{ code: "remote_acp_event_retention_gap" as const, droppedThroughCursor: 4 }]
      }),
      interactions: async () => pendingInteraction("attempt-2")
    });
    const started = await f.coordinator.execute(request(root));
    const followed = await f.coordinator.follow(request(root), started.handle.runSessionId);

    expect(f.replay).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "operation-1", afterCursor: 0 }),
      undefined
    );
    expect(followed.handle).toMatchObject({
      target: "remote",
      executionAttemptId: "attempt-2",
      cursor: { executionAttemptId: "attempt-2", eventCursor: 4 }
    });
    expect(followed.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "attempt_changed",
        "action_required",
        "retention_gap",
        "interaction_required"
      ])
    );
    expect(followed.session.phase).toBe("running");

    const response = {
      type: "interaction.permission_response" as const,
      dispatchId: "dispatch-attempt-2",
      leaseId: "lease-1",
      executionAttemptId: "attempt-2",
      actionId: "action-1",
      acpSessionId: "acp-session-1",
      decision: "allow_once" as const
    };
    const resolved = await f.coordinator.respond({
      request: request(root),
      sessionId: started.handle.runSessionId,
      response
    });
    expect(resolved).toMatchObject({ type: "interaction_resolved", data: response });
    expect(f.respond).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "operation-1", response }),
      undefined
    );

    for (const mismatch of [
      { dispatchId: "dispatch-wrong" },
      { leaseId: "lease-wrong" },
      { executionAttemptId: "attempt-wrong" },
      { acpSessionId: "acp-session-wrong" },
      { actionId: "action-wrong" }
    ]) {
      await expect(
        f.coordinator.respond({
          request: request(root),
          sessionId: started.handle.runSessionId,
          response: { ...response, ...mismatch }
        })
      ).rejects.toMatchObject({ code: "workspace_execution_resume_mismatch" });
    }
    expect(f.respond).toHaveBeenCalledTimes(1);
  });

  it("refuses recovery when the durable authority binding has changed", async () => {
    const { root } = await createTestWorkspace();
    let currentRevisions = revisions;
    const authority = createWorkspaceAuthorityBindingResolver({
      local: { inspect: vi.fn() },
      remote: {
        inspect: vi.fn(async () =>
          remoteSnapshotForWorkspace(root, { authorityRevisions: currentRevisions })
        )
      }
    });
    const f = fixture({ packageWorkspace: root, authority });
    const started = await f.coordinator.execute(request(root));
    currentRevisions = { ...revisions, reviewerRevision: revisions.reviewerRevision + 1 };

    await expect(f.coordinator.execute(request(root))).rejects.toMatchObject({
      code: "workspace_execution_resume_mismatch"
    });
    await expect(
      f.coordinator.follow(request(root), started.handle.runSessionId)
    ).rejects.toMatchObject({ code: "workspace_execution_resume_mismatch" });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.observe).not.toHaveBeenCalled();
  });

  it("keeps the durable handle recoverable when observation has a retryable network failure", async () => {
    const { root } = await createTestWorkspace();
    const f = fixture({
      packageWorkspace: root,
      observe: async () => {
        throw new Error("network unavailable");
      }
    });
    const started = await f.coordinator.execute(request(root));

    await expect(
      f.coordinator.follow(request(root), started.handle.runSessionId)
    ).rejects.toMatchObject({ code: "remote_observation_unavailable", retryable: true });
    expect(f.dispatch).toHaveBeenCalledTimes(1);

    const replayWorkspace = await createTestWorkspace();
    const replayFailure = fixture({
      packageWorkspace: replayWorkspace.root,
      replay: async () => {
        throw new Error("replay network unavailable");
      }
    });
    const replayStarted = await replayFailure.coordinator.execute(request(replayWorkspace.root));
    const replayResult = await replayFailure.coordinator.follow(
      request(replayWorkspace.root),
      replayStarted.handle.runSessionId
    );
    expect(replayResult.session).toMatchObject({
      phase: "completed",
      workspaceExecution: { evidence: { status: "incomplete" } }
    });
    expect(replayFailure.dispatch).toHaveBeenCalledTimes(1);

    const gapWorkspace = await createTestWorkspace();
    const cursorGap = fixture({
      packageWorkspace: gapWorkspace.root,
      replay: async (afterCursor) => ({
        eventProtocolVersion: 2,
        executionAttemptId: "attempt-1",
        afterCursor,
        cursor: 2,
        highWatermark: 2,
        hasMore: false,
        events: [
          {
            eventVersion: 2,
            cursor: 2,
            sourceSequence: 2,
            timestamp: "2030-01-01T00:00:02.000Z",
            fragment: {
              kind: "engine_terminal",
              terminal: { state: "succeeded", stopReason: "end_turn" }
            }
          }
        ]
      })
    });
    const gapStarted = await cursorGap.coordinator.execute(request(gapWorkspace.root));
    const gapResult = await cursorGap.coordinator.follow(
      request(gapWorkspace.root),
      gapStarted.handle.runSessionId
    );
    expect(gapResult.session.workspaceExecution?.evidence).toMatchObject({
      status: "incomplete"
    });
  });

  it("serializes concurrent executes by durable scope and dispatches once", async () => {
    const { root } = await createTestWorkspace();
    const f = fixture({ packageWorkspace: root });

    const [first, second] = await Promise.all([
      f.coordinator.execute(request(root)),
      f.coordinator.execute(request(root))
    ]);

    expect(first.handle.runSessionId).toBe(second.handle.runSessionId);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect((await listRunSessions(root)).sessions).toHaveLength(1);
  });

  it.each([
    "update",
    "append"
  ] as const)("recovers accepted dispatch after %s checkpoint failure without redispatch", async (failurePoint) => {
    const { root } = await createTestWorkspace();
    let failed = false;
    const ports = sessionPorts({
      update: async (...args) => {
        if (failurePoint === "update" && !failed) {
          failed = true;
          throw new Error("injected update failure");
        }
        return updateRunSession(...args);
      },
      appendEvent: async (...args) => {
        if (failurePoint === "append" && args[2] === "workspace_execution_checkpoint" && !failed) {
          failed = true;
          throw new Error("injected append failure");
        }
        return appendRunSessionEvent(...args);
      }
    });
    const f = fixture({
      packageWorkspace: root,
      recover: async () => observation(),
      sessions: ports
    });

    await expect(f.coordinator.execute(request(root))).rejects.toThrow("injected");
    const restarted = fixture({
      packageWorkspace: root,
      recover: async () => observation(),
      sessions: ports
    });
    const recovered = await restarted.coordinator.execute(request(root));

    expect(recovered.handle.operationId).toBe("operation-1");
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(restarted.dispatch).not.toHaveBeenCalled();
    expect(restarted.recover).toHaveBeenCalledTimes(failurePoint === "update" ? 1 : 0);
    expect((await listRunSessions(root)).sessions).toHaveLength(1);
  });

  it("does not let a slow older follow overwrite a newer terminal checkpoint", async () => {
    const { root } = await createTestWorkspace();
    const older = deferred<RemoteOperationObservation>();
    const newer = deferred<RemoteOperationObservation>();
    const olderStarted = deferred<void>();
    let calls = 0;
    const f = fixture({
      packageWorkspace: root,
      observe: async () => {
        calls += 1;
        if (calls === 1) {
          olderStarted.resolve();
          return older.promise;
        }
        return newer.promise;
      }
    });
    const started = await f.coordinator.execute(request(root));
    const slow = f.coordinator.follow(request(root), started.handle.runSessionId);
    await olderStarted.promise;
    const fast = f.coordinator.follow(request(root), started.handle.runSessionId);
    newer.resolve(observation({ state: "completed", attemptStatus: "completed", revision: 3 }));
    await fast;
    older.resolve(
      observation({ state: "awaiting_writeback", attemptStatus: "awaiting_writeback", revision: 2 })
    );
    await slow;

    const durable = (await getRunSession(root, started.handle.runSessionId)).session;
    expect(durable).toMatchObject({
      phase: "completed",
      workspaceExecution: { handle: { operationRevision: 3 } }
    });
  });

  it("rejects every mismatched launch identity before persisting a handle", async () => {
    const cases: Array<
      [string, (value: RemoteOperationObservation) => RemoteOperationObservation]
    > = [
      ["project", (value) => ({ ...value, projectId: "wrong-project" })],
      ["canvas", (value) => ({ ...value, canvasId: "wrong-canvas" })],
      ["block", (value) => ({ ...value, blockRef: "T-001#B-999" })],
      [
        "endpoint",
        (value) => ({
          ...value,
          agentEndpoint: { ...value.agentEndpoint!, endpointId: "wrong-endpoint" }
        })
      ],
      [
        "diagnostic endpoint",
        (value) => ({
          ...value,
          diagnostics: { ...value.diagnostics!, endpointId: "wrong-endpoint" }
        })
      ],
      [
        "workspace",
        (value) => ({
          ...value,
          diagnostics: {
            ...value.diagnostics!,
            locator: { ...value.diagnostics!.locator, workspaceId: "wrong-workspace" }
          }
        })
      ],
      ["dispatch", (value) => ({ ...value, dispatchId: "wrong-dispatch" })],
      ["attempt", (value) => ({ ...value, executionAttemptId: "wrong-attempt" })],
      [
        "authority",
        (value) => ({
          ...value,
          diagnostics: {
            ...value.diagnostics!,
            authorityRevisions: {
              ...value.diagnostics!.authorityRevisions!,
              executionTarget: revisions.executionTargetRevision + 1
            }
          }
        })
      ],
      [
        "content",
        (value) => ({
          ...value,
          diagnostics: {
            ...value.diagnostics!,
            content: { ...value.diagnostics!.content, revision: "source-revision-wrong" }
          }
        })
      ]
    ];
    for (const [, mutate] of cases) {
      const { root } = await createTestWorkspace();
      const f = fixture({ packageWorkspace: root, dispatch: async () => mutate(observation()) });
      await expect(f.coordinator.execute(request(root))).rejects.toMatchObject({
        code: "remote_dispatch_acceptance_mismatch"
      });
      const stored = (await listRunSessions(root)).sessions[0];
      expect(stored?.workspaceExecution?.handle).toBeNull();
    }
  });

  it("rereads pending interactions from zero and retains the surviving durable identity", async () => {
    const { root } = await createTestWorkspace();
    let reads = 0;
    const pendingA = pendingInteraction("attempt-1");
    const pendingB = remoteInteractionPageSchema.parse({
      ...pendingInteraction("attempt-1"),
      items: [
        {
          ...pendingInteraction("attempt-1").items[0],
          request: {
            ...pendingInteraction("attempt-1").items[0]!.request,
            actionId: "action-2"
          }
        }
      ]
    });
    const f = fixture({
      packageWorkspace: root,
      interactions: async (cursor) => {
        expect(cursor).toBe(0);
        reads += 1;
        if (reads <= 2) return emptyInteractions();
        return reads === 3 ? pendingA : pendingB;
      }
    });
    const started = await f.coordinator.execute(request(root));
    const unstable = await f.coordinator.follow(request(root), started.handle.runSessionId);
    expect(unstable.session.workspaceExecution?.evidence.status).toBe("incomplete");
    const stable = await f.coordinator.follow(request(root), started.handle.runSessionId);
    expect(stable.session.workspaceExecution?.interactions).toHaveLength(1);
    expect(stable.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "interaction_required" })])
    );
  });

  it.each([
    "replay",
    "interaction"
  ] as const)("keeps terminal durable when %s evidence is unavailable", async (failurePoint) => {
    const { root } = await createTestWorkspace();
    const f = fixture({
      packageWorkspace: root,
      observe: async () =>
        observation({ state: "completed", attemptStatus: "completed", revision: 2 }),
      replay: async (afterCursor) => {
        if (failurePoint === "replay") throw new Error("replay service unavailable");
        return emptyReplay(afterCursor);
      },
      interactions: async () => {
        if (failurePoint === "interaction") throw new Error("interaction service unavailable");
        return emptyInteractions();
      }
    });
    const started = await f.coordinator.execute(request(root));
    const completed = await f.coordinator.follow(request(root), started.handle.runSessionId);
    expect(completed.session).toMatchObject({
      phase: "completed",
      workspaceExecution: { evidence: { status: "incomplete" } }
    });
  });

  it("rejects stale attempt versions and never moves an attempt cursor backwards", async () => {
    const versionWorkspace = await createTestWorkspace();
    let observationCount = 0;
    const versionFixture = fixture({
      packageWorkspace: versionWorkspace.root,
      observe: async () => {
        observationCount += 1;
        return observationCount === 1
          ? observation({ revision: 2, attemptStateVersion: 2 })
          : observation({ revision: 3, attemptStateVersion: 1 });
      }
    });
    const versionStarted = await versionFixture.coordinator.execute(request(versionWorkspace.root));
    await versionFixture.coordinator.follow(
      request(versionWorkspace.root),
      versionStarted.handle.runSessionId
    );
    await expect(
      versionFixture.coordinator.follow(
        request(versionWorkspace.root),
        versionStarted.handle.runSessionId
      )
    ).rejects.toMatchObject({ code: "remote_attempt_revision_stale" });

    const cursorWorkspace = await createTestWorkspace();
    let replayCount = 0;
    const cursorFixture = fixture({
      packageWorkspace: cursorWorkspace.root,
      replay: async (afterCursor) => {
        replayCount += 1;
        if (replayCount <= 1) {
          return {
            ...emptyReplay(afterCursor),
            cursor: 4,
            highWatermark: 4,
            diagnostics: [
              { code: "remote_acp_event_retention_gap" as const, droppedThroughCursor: 4 }
            ]
          };
        }
        return { ...emptyReplay(afterCursor), cursor: 3, highWatermark: 3 };
      }
    });
    const cursorStarted = await cursorFixture.coordinator.execute(request(cursorWorkspace.root));
    const followed = await cursorFixture.coordinator.follow(
      request(cursorWorkspace.root),
      cursorStarted.handle.runSessionId
    );
    expect(followed.handle.cursor.eventCursor).toBe(4);
  });
});
