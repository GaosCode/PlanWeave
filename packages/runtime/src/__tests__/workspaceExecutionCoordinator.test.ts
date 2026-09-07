import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import { workAuthorityProjectionSchema } from "@planweave-ai/collaboration-protocol/work/authority";
import { createWorkspaceAuthorityBindingResolver } from "../workspaceExecution/authorityBinding.js";
import { createLocalPackageAuthoritySource } from "../workspaceExecution/authorityBinding.js";
import { WorkspaceExecutionCoordinator } from "../workspaceExecution/coordinator.js";
import { createLocalWorkspaceExecutionAdapter } from "../workspaceExecution/localExecutionAdapter.js";
import { createPackageWorkspaceExecutionSessionRepository } from "../workspaceExecution/sessionRepository.js";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { loadPlanGraphPackage } from "../plangraph/packageRepository.js";
import { createRunSession, getRunSession, listRunSessions } from "../runSessions/repository.js";
import { getAutoRunStatus } from "../taskManager/autoRun.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import {
  authorityResolver,
  deferred,
  emptyInteractions,
  emptyReplay,
  fixture,
  observation,
  pendingInteraction,
  remoteSnapshotForWorkspace,
  request,
  revisions,
  sessionPorts,
  workAuthority
} from "./workspaceExecutionCoordinatorTestFixture.js";

describe("WorkspaceExecutionCoordinator", () => {
  it("exposes interrupted execution as awaiting action instead of polling it as running", async () => {
    const { root } = await createTestWorkspace();
    const f = fixture({
      packageWorkspace: root,
      observe: async () =>
        observation({ state: "interrupted", attemptStatus: "interrupted", revision: 2 })
    });
    const started = await f.coordinator.execute(request(root));
    const followed = await f.coordinator.follow(request(root), started.handle.runSessionId);
    expect(followed.session.phase).toBe("blocked");
    expect(followed.events).toContainEqual(
      expect.objectContaining({
        type: "action_required",
        data: { reason: "blocked" }
      })
    );
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });

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

  it("dispatches an owner Canvas Remote Agent from local package authority without Workspace authority", async () => {
    const { root } = await createTestWorkspace();
    const captured = await capturePackageSnapshot({ projectRoot: root });
    const loaded = await loadPlanGraphPackage(root);
    const zeroRevisions = {
      responsibilityRevision: 0,
      reviewerRevision: 0,
      executionTargetRevision: 0
    };
    const ownerObservation = observation({
      projectId: loaded.workspace.id,
      locatorWorkspaceId: "internal-runtime-workspace",
      authorityRevisions: zeroRevisions,
      contentRevision: captured.snapshot.sourceRevision,
      graphFingerprint: loaded.graph.packageFingerprint
    });
    const ownerAuthority = createWorkspaceAuthorityBindingResolver({
      local: createLocalPackageAuthoritySource(),
      remote: { inspect: vi.fn() }
    });
    const f = fixture({
      packageWorkspace: root,
      authority: ownerAuthority,
      workAuthority: async () => null,
      dispatch: async () => ownerObservation
    });
    const ownerRequest = {
      authority: {
        kind: "owner_canvas" as const,
        packageWorkspace: root,
        expected: {
          contentRevision: captured.snapshot.sourceRevision,
          graphFingerprint: loaded.graph.packageFingerprint
        },
        connectionProfileId: "profile-owner",
        serverOrigin: "https://planweave.example",
        humanPrincipalId: "human-owner",
        projectId: loaded.workspace.id,
        canvasId: "default"
      },
      scope: { kind: "block" as const, blockRef: "T-001#B-001" },
      trigger: "desktop" as const,
      target: { policy: "remote" as const, agentEndpointId: "endpoint-codex" },
      effectiveExecutor: { name: "codex-acp", agentId: "codex" },
      eventFormat: "execution-v1" as const
    };

    const result = await f.coordinator.execute(ownerRequest);

    expect(result.handle.target).toBe("remote");
    expect(f.catalog).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          authorityKind: "owner_canvas",
          humanPrincipalId: "human-owner",
          projectId: loaded.workspace.id,
          canvasId: "default",
          authorityRevisions: zeroRevisions
        }),
        intent: expect.objectContaining({
          projectId: loaded.workspace.id,
          canvasId: "default",
          expectedResponsibilityRevision: 0,
          expectedReviewerRevision: 0,
          executionTargetRevision: 0,
          contentRevision: captured.snapshot.sourceRevision,
          graphFingerprint: loaded.graph.packageFingerprint
        })
      }),
      undefined
    );
    expect(f.workAuthority).toHaveBeenCalledTimes(1);
    await expect(
      Promise.all(f.workAuthority.mock.results.map((call) => call.value))
    ).resolves.toEqual([null]);
  });

  it("does not re-inspect authority after Catalog before remote dispatch", async () => {
    const { root } = await createTestWorkspace();
    const executionRequest = request(root);
    const authority = authorityResolver(root);
    const resolve = vi.fn((locator, scope, signal) => authority.resolve(locator, scope, signal));
    const f = fixture({ packageWorkspace: root, authority: { resolve } });

    await f.coordinator.execute(executionRequest);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(f.workAuthority).toHaveBeenCalledTimes(1);
    expect(f.catalog).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
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
    const f = fixture({
      packageWorkspace: root,
      authority,
      workAuthority: async () =>
        workAuthorityProjectionSchema.parse({
          ...workAuthority(),
          revisions: currentRevisions
        })
    });
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

  it("retries the exact dispatch intent when recovery confirms no operation", async () => {
    const { root } = await createTestWorkspace();
    let dispatchCount = 0;
    const f = fixture({
      packageWorkspace: root,
      dispatch: async () => {
        dispatchCount += 1;
        if (dispatchCount === 1) throw new Error("connection reset before response");
        return observation();
      },
      recover: async () => null
    });

    await expect(f.coordinator.execute(request(root))).rejects.toMatchObject({
      code: "remote_dispatch_unavailable"
    });
    const pending = (await listRunSessions(root)).sessions[0];
    const intent = pending?.workspaceExecution?.dispatchIntent;
    expect(intent).not.toBeNull();

    const retried = await f.coordinator.execute(request(root));

    expect(retried.handle.operationId).toBe("operation-1");
    expect(retried.handle.runSessionId).toBe(pending?.sessionId);
    expect(f.recover).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ intent }), undefined);
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
        return createPackageWorkspaceExecutionSessionRepository().update(...args);
      },
      appendEvent: async (...args) => {
        if (failurePoint === "append" && args[2] === "workspace_execution_checkpoint" && !failed) {
          failed = true;
          throw new Error("injected append failure");
        }
        return createPackageWorkspaceExecutionSessionRepository().appendEvent(...args);
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

  it("terminalizes a session when the attempt advances without an operation revision change", async () => {
    const { root } = await createTestWorkspace();
    let calls = 0;
    const f = fixture({
      packageWorkspace: root,
      observe: async () => {
        calls += 1;
        return calls === 1
          ? observation({ revision: 2, attemptStateVersion: 2 })
          : observation({
              state: "completed",
              attemptStatus: "completed",
              revision: 2,
              attemptStateVersion: 3
            });
      },
      interactions: async () => pendingInteraction("attempt-1")
    });
    const started = await f.coordinator.execute(request(root));
    const running = await f.coordinator.follow(request(root), started.handle.runSessionId);
    expect(running.session).toMatchObject({
      phase: "running",
      workspaceExecution: {
        handle: { operationRevision: 2, attemptStateVersion: 2 },
        interactions: [expect.objectContaining({ status: "pending" })]
      }
    });

    const completed = await f.coordinator.follow(request(root), started.handle.runSessionId);

    expect(completed.session).toMatchObject({
      phase: "completed",
      workspaceExecution: {
        handle: { operationRevision: 2, attemptStateVersion: 3 },
        interactions: [expect.objectContaining({ status: "expired" })]
      }
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

  it("reads pending interactions once per evidence collection", async () => {
    const { root } = await createTestWorkspace();
    let reads = 0;
    const pending = pendingInteraction("attempt-1");
    const f = fixture({
      packageWorkspace: root,
      interactions: async (cursor) => {
        expect(cursor).toBe(0);
        reads += 1;
        return reads === 1 ? emptyInteractions() : pending;
      }
    });
    const started = await f.coordinator.execute(request(root));
    expect(reads).toBe(1);
    const followed = await f.coordinator.follow(request(root), started.handle.runSessionId);
    expect(reads).toBe(2);
    expect(followed.session.workspaceExecution?.interactions).toHaveLength(1);
    expect(followed.events).toEqual(
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
