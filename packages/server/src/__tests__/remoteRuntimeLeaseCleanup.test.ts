import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CANVAS_RUNTIME_CAPABILITY,
  WORKSPACE_CANVAS_EXECUTION_CAPABILITY,
  agentHostProtocolVersion,
  canvasRuntimeResponseEventSchema
} from "@planweave-ai/agent-host-protocol";
import {
  RemoteOwnershipConflictError,
  remoteBlockInspectInputSchema,
  remoteBlockClaimInputSchema,
  remoteBlockOperationQuerySchema,
  remoteBlockRefIdentitySchema
} from "@planweave-ai/runtime";
import { RemoteBlockWritebackCoordinator } from "../remoteBlockWritebackCoordinator.js";
import {
  SqliteRemoteDispatchPersistence,
  SqliteRemoteOperationCandidateRepository
} from "../remoteCoordinatorPersistence.js";
import {
  decideRemoteExecutionAction,
  type RemoteExecutionActionRequest
} from "../remoteExecutionLifecycle.js";
import { classifyReenterFailure } from "../remoteReenterRecovery.js";
import { CanvasRuntimeRpcError } from "../canvas/runtimeRpcBroker.js";
import { CanvasRuntimeRpcBroker } from "../canvas/runtimeRpcBroker.js";
import { RemoteHostCanvasRuntimeAdapter } from "../canvas/remoteHostRuntimeAdapter.js";
import { CanvasRuntimeHostLocator } from "../canvas/runtimeHostLocator.js";
import { RuntimeArtifactGrantRepository } from "../canvas/runtimeArtifactGrantRepository.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { readStableCanvasRuntimeContentTarget } from "../canvas/contentFingerprint.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { endpointIdFor } from "../agentEndpointCatalog.js";
import { snapshotDispatchEndpoint } from "../remoteBlockCoordinatorEndpoint.js";
import { runtimeAuthoritySnapshotForTarget } from "../endpointSelection.js";
import { ownHostRemoteAgents } from "./support/remoteAgentOwnerFixture.js";
import { seedLegacyRemoteOperation } from "./support/legacyRemoteOperationSeed.js";
import {
  setup,
  remoteManifest,
  setupFleetUnboundHost,
  completeDispatchToTerminal
} from "./support/remoteBlockCoordinatorFixture.js";

describe("Remote runtime lease cleanup at the broker boundary", () => {
  it.each([
    "completed",
    "failed",
    "cancelled"
  ] as const)("records explicit cleanup diagnostics for %s without weakening ordinary terminal guards", async (state) => {
    const fixture = await setup(false);
    const operation = seedLegacyRemoteOperation({
      database: fixture.server.database,
      operations: fixture.operations,
      locator: fixture.locator,
      candidate: await fixture.registry.resolve(fixture.locator).inspect({ ref: "T-001#B-001" }),
      idempotencyKey: `terminal-cleanup-${state}`
    });
    fixture.server.database
      .prepare("UPDATE remote_operations SET state=?,terminal_at=? WHERE id=?")
      .run(state, new Date().toISOString(), operation.id);
    const terminal = fixture.operations.getRequired(operation.id);
    expect(() =>
      fixture.operations.recordDiagnostic(
        operation.id,
        "canvas_runtime_rpc_deadline_exceeded",
        "Ordinary write."
      )
    ).toThrow("remote_operation_not_actionable");
    fixture.operations.recordDiagnostic(
      operation.id,
      "canvas_runtime_rpc_deadline_exceeded",
      "Runtime lease release failed.",
      { includeTerminal: true }
    );
    expect(fixture.operations.getRequired(operation.id)).toMatchObject({
      state,
      terminalAt: terminal.terminalAt,
      executionAttemptId: terminal.executionAttemptId,
      dispatchId: terminal.dispatchId,
      attempt: terminal.attempt
    });
    expect(fixture.operations.latestDiagnostic(operation.id)?.error).toEqual({
      code: "canvas_runtime_rpc_deadline_exceeded",
      retryable: true
    });
    expect(
      fixture.server.database
        .prepare("SELECT diagnostic_message FROM remote_operations WHERE id=?")
        .get(operation.id)
    ).toEqual({ diagnostic_message: "Runtime lease release failed." });
  });
  it.each([
    "disconnected",
    "superseded",
    "inspect_deadline",
    "host_mismatch",
    "operation_mismatch",
    "protocol_error",
    "revoked",
    "cleanup_protocol_error",
    "main_host_mismatch",
    "main_protocol_error"
  ] as const)("preserves recovery policy and diagnostics after %s with failed release", async (scenario) => {
    const fixture = await setup(false, remoteManifest(true));
    const database = fixture.server.database;
    const hostA = fixture.hosts.register("Recovery Host A").host;
    ownHostRemoteAgents({
      database,
      hostId: hostA.id,
      grantWorkspaceId: fixture.locator.workspaceId
    });
    const hostB = fixture.hosts.register("Recovery Host B").host;
    ownHostRemoteAgents({
      database,
      hostId: hostB.id,
      grantWorkspaceId: fixture.locator.workspaceId
    });
    const active = new Set([hostA.id, hostB.id]);
    for (const hostId of active) {
      fixture.hosts.reportOnline(hostId, ["acp.codex", CANVAS_RUNTIME_CAPABILITY], 1, {
        workspaceMappings: [{ workspaceId: fixture.locator.workspaceId, status: "ready" }],
        acpProfiles: [
          {
            profileId: "codex-acp",
            agentId: "codex",
            displayName: "Recovery Agent",
            status: "ready",
            capabilities: ["acp.codex"]
          }
        ]
      });
    }
    const broker = new CanvasRuntimeRpcBroker(database, fixture.hosts, fixture.mailbox, {
      requestTimeoutMs: 100
    });
    broker.attachSessionLookup({ isActive: (hostId) => active.has(hostId) });
    const contentVersions = new ContentVersionRepository(database);
    const target = readStableCanvasRuntimeContentTarget(contentVersions, fixture.locator);
    const adapter = new RemoteHostCanvasRuntimeAdapter(
      new CanvasRuntimeHostLocator(
        fixture.hosts.runtimeBindings,
        fixture.hosts,
        broker,
        new ProjectAccessRepository(database)
      ),
      broker,
      { read: () => target },
      {
        grants: new RuntimeArtifactGrantRepository(database, {
          maxArtifactBytes: 1024 * 1024,
          leaseActive: () => true
        }),
        artifacts: fixture.artifacts
      }
    );
    let coordinationTime = Date.now();
    const coordination = createRemoteBlockCoordination(
      database,
      {
        clock: () => new Date(coordinationTime++),
        leaseDurationMs: 60_000,
        hostOfflineAfterMs: 60_000,
        runtimeLeases: adapter,
        inputArtifacts: { materialize: fixture.materialize },
        artifactContent: {
          readReport: async (ref) => fixture.artifacts.read(ref),
          readReportMediaType: async (ref) => fixture.artifacts.getRequired(ref).mediaType
        },
        ownerEndpointScopeAuthorized: () => true
      },
      { serverInstanceOwnerToken: fixture.server.serverInstanceOwnerToken }
    );
    const runtime = fixture.registry.resolve(fixture.locator);
    const candidates = await Promise.all(
      ["T-001#B-001", "T-002#B-001"].map((ref) => runtime.inspect({ ref }))
    );
    const operations = candidates.map((candidate, index) => {
      const hostId = index === 0 ? hostA.id : hostB.id;
      return seedLegacyRemoteOperation({
        database,
        operations: coordination.operations,
        locator: fixture.locator,
        candidate,
        idempotencyKey: `cleanup-${scenario}-${index}`,
        endpointSelection: snapshotDispatchEndpoint(
          coordination.agentEndpoints.resolveForRun(
            endpointIdFor({ hostId, profileId: "codex-acp", agentId: "codex" }),
            fixture.locator.workspaceId,
            candidate.requiredCapabilities,
            { kind: "owner_fleet" }
          ),
          candidate,
          runtimeAuthoritySnapshotForTarget(
            { kind: "owner_canvas" },
            { responsibilityRevision: 0, reviewerRevision: 0, executionTargetRevision: 0 }
          )
        )
      });
    });
    const first = operations[0]!;
    const second = operations[1]!;

    const calls: { hostId: string; operation: string }[] = [];
    const hostErrors: unknown[] = [];
    let acquireCountA = 0;
    const subscriptions = [...active].map((hostId) =>
      fixture.mailbox.subscribe(hostId, (message) => {
        if (message.command.type !== "canvas_runtime.request") return;
        const command = message.command;
        const operation = command.operation;
        if (hostId === hostA.id && operation.operation === "acquire") acquireCountA++;
        calls.push({ hostId, operation: operation.operation });
        const respond = (response: unknown, responseHost = hostId) =>
          broker.handleResponse(
            responseHost,
            canvasRuntimeResponseEventSchema.parse({
              type: "canvas_runtime.response",
              protocolVersion: agentHostProtocolVersion,
              messageId: randomUUID(),
              requestId: command.requestId,
              response
            })
          );
        void (async () => {
          if (
            hostId === hostA.id &&
            ((operation.operation === "inspect" && !scenario.startsWith("main_")) ||
              (operation.operation === "claim" && scenario.startsWith("main_")))
          ) {
            if (
              scenario === "disconnected" ||
              scenario === "superseded" ||
              scenario === "revoked"
            ) {
              broker.detachHost(hostId, scenario);
            } else if (scenario === "host_mismatch" || scenario === "main_host_mismatch") {
              respond(
                { outcome: "success", operation: operation.operation, result: candidates[0] },
                hostB.id
              );
            } else if (scenario === "operation_mismatch") {
              respond({ outcome: "success", operation: "release", result: { released: true } });
            } else if (scenario === "protocol_error" || scenario === "main_protocol_error") {
              respond({
                outcome: "error",
                operation: operation.operation,
                error: {
                  code: "protocol_error",
                  message: "Invalid peer protocol.",
                  retryable: false
                }
              });
            }
            return;
          }
          if (
            hostId === hostA.id &&
            operation.operation === "release" &&
            (!scenario.startsWith("main_") || acquireCountA > 1)
          ) {
            if (scenario === "cleanup_protocol_error")
              respond({
                outcome: "error",
                operation: "release",
                error: {
                  code: "protocol_error",
                  message: "Invalid release protocol.",
                  retryable: false
                }
              });
            return;
          }
          let result: unknown;
          switch (operation.operation) {
            case "acquire":
              result = {
                runtimeLeaseId: randomUUID(),
                acquiredAt: new Date().toISOString(),
                sourceRevision: candidates[0]!.sourceRevision,
                graphFingerprint: candidates[0]!.graphFingerprint,
                expiresAt: new Date(Date.now() + 60_000).toISOString()
              };
              break;
            case "release":
              result = { released: true };
              break;
            case "inspect":
              result = await runtime.inspect(remoteBlockInspectInputSchema.parse(operation.input));
              break;
            case "claim":
              result = await runtime.claim(remoteBlockClaimInputSchema.parse(operation.input));
              break;
            case "reconcile":
              result = await runtime.reconcile(
                remoteBlockOperationQuerySchema.parse(operation.input)
              );
              break;
            case "activate":
              result = await runtime.activate(remoteBlockRefIdentitySchema.parse(operation.input));
              break;
            default:
              throw new Error(`cleanup_unexpected_rpc:${operation.operation}`);
          }
          respond({ outcome: "success", operation: operation.operation, result });
        })().catch((error) => hostErrors.push(error));
      })
    );
    try {
      const fatal = [
        "host_mismatch",
        "operation_mismatch",
        "protocol_error",
        "revoked",
        "cleanup_protocol_error",
        "main_host_mismatch",
        "main_protocol_error"
      ].includes(scenario);
      if (fatal) {
        const code =
          scenario === "main_host_mismatch"
            ? "canvas_runtime_reconcile_required"
            : scenario === "host_mismatch"
              ? "canvas_runtime_response_host_mismatch"
              : scenario === "operation_mismatch"
                ? "canvas_runtime_response_operation_mismatch"
                : scenario === "revoked"
                  ? "canvas_runtime_host_revoked"
                  : "protocol_error";
        await expect(coordination.coordinator.reenterPending()).rejects.toMatchObject({
          code,
          retryable: false
        });
        expect(coordination.operations.getRequired(second.id).state).toBe("preparing");
        expect(calls.filter((call) => call.hostId === hostB.id)).toEqual([]);
        expect(coordination.operations.latestDiagnostic(first.id)?.error).toEqual({
          code: "protocol_error",
          retryable: false
        });
      } else {
        const outcomes = await coordination.coordinator.reenterPending();
        expect(outcomes.map((outcome) => [outcome.operation.id, outcome.status])).toEqual([
          [first.id, "awaiting_host"],
          [second.id, "activated"]
        ]);
        expect(coordination.operations.getRequired(first.id)).toMatchObject({
          executionAttemptId: first.executionAttemptId,
          dispatchId: first.dispatchId,
          state: "preparing"
        });
        expect(
          calls.filter((call) => call.hostId === hostA.id && call.operation === "activate")
        ).toEqual([]);
        const primary =
          scenario === "inspect_deadline"
            ? "canvas_runtime_rpc_deadline_exceeded"
            : `canvas_runtime_host_${scenario}`;
        expect(coordination.operations.latestDiagnostic(first.id)?.error).toEqual({
          code: primary,
          retryable: true
        });
      }
      const diagnosticRows = database
        .prepare(
          "SELECT error_code FROM remote_operation_diagnostics WHERE operation_id=? AND error_code IS NOT NULL ORDER BY sequence"
        )
        .all(first.id);
      const cleanupCode = ["disconnected", "superseded", "revoked"].includes(scenario)
        ? "canvas_runtime_host_offline"
        : scenario === "cleanup_protocol_error"
          ? "protocol_error"
          : "canvas_runtime_rpc_deadline_exceeded";
      expect(diagnosticRows).toContainEqual({ error_code: cleanupCode });
      if (fatal)
        expect(
          database
            .prepare("SELECT diagnostic_message FROM remote_operations WHERE id=?")
            .get(first.id)
        ).toMatchObject({
          diagnostic_message: expect.stringContaining("Runtime lease release failed")
        });
      expect(hostErrors).toEqual([]);
    } finally {
      for (const unsubscribe of subscriptions) unsubscribe();
      broker.close();
    }
  });
});

describe("Remote runtime lease owners after terminal or fatal mutation", () => {
  it.each([
    true,
    false
  ])("continues batch activation after a terminal reset with release failure=%s", async (failRelease) => {
    const fixture = await setupFleetUnboundHost(remoteManifest(true));
    if (!fixture.host) throw new Error("cleanup_host_missing");
    const hostId = fixture.host.id;
    const runtime = fixture.registry.resolve(fixture.locator);
    const release = vi.fn();
    const activation = vi.fn(runtime.activate.bind(runtime));
    const acquire = async () => {
      const lease = await fixture.registry.acquire(fixture.locator);
      let terminalReset = false;
      return {
        ...lease,
        runtime: {
          ...lease.runtime,
          activate: activation,
          reconcile: async (input: Parameters<typeof runtime.reconcile>[0]) => {
            if (input.ref === "T-001#B-001") {
              terminalReset = true;
              throw new RemoteOwnershipConflictError(
                "remote_ownership_not_active",
                "Runtime reset removed ownership."
              );
            }
            return runtime.reconcile(input);
          }
        },
        release: async () => {
          release(terminalReset);
          await lease.release();
          if (terminalReset && failRelease)
            throw new CanvasRuntimeRpcError("canvas_runtime_rpc_deadline_exceeded", true, false);
        }
      };
    };
    const coordination = createRemoteBlockCoordination(
      fixture.server.database,
      {
        leaseDurationMs: 60_000,
        hostOfflineAfterMs: 60_000,
        runtimeLeases: { acquire, acquireForHost: acquire },
        inputArtifacts: { materialize: fixture.materialize },
        artifactContent: { readReport: async (ref) => fixture.artifacts.read(ref) },
        ownerEndpointScopeAuthorized: () => true
      },
      { serverInstanceOwnerToken: fixture.server.serverInstanceOwnerToken }
    );
    const candidateA = await runtime.inspect({ ref: "T-001#B-001" });
    const first = coordination.operations.markClaimed(
      seedLegacyRemoteOperation({
        database: fixture.server.database,
        operations: coordination.operations,
        locator: fixture.locator,
        candidate: candidateA,
        idempotencyKey: "terminal-cleanup-batch-a",
        agentAccess: {
          callerHumanPrincipalId: fixture.callerHumanPrincipalId,
          authorized: {
            remoteAgent: {
              endpointId: "test-reset-endpoint",
              hostId,
              profileId: "codex-acp",
              agentId: "codex"
            },
            runtimeAuthority: { kind: "owner_canvas" },
            agentAccessAuthority: {
              kind: "agent_owner",
              ownerHumanPrincipalId: fixture.callerHumanPrincipalId,
              policyRevision: 1
            },
            resolvedAt: new Date().toISOString()
          }
        }
      }).id
    );
    const candidateB = await runtime.inspect({ ref: "T-002#B-001" });
    const second = seedLegacyRemoteOperation({
      database: fixture.server.database,
      operations: coordination.operations,
      locator: fixture.locator,
      candidate: candidateB,
      idempotencyKey: "terminal-cleanup-batch-b",
      endpointSelection: snapshotDispatchEndpoint(
        coordination.agentEndpoints.resolveForRun(
          endpointIdFor({ hostId, profileId: "codex-acp", agentId: "codex" }),
          fixture.locator.workspaceId,
          candidateB.requiredCapabilities,
          { kind: "owner_fleet" }
        ),
        candidateB,
        runtimeAuthoritySnapshotForTarget(
          { kind: "owner_canvas" },
          { responsibilityRevision: 0, reviewerRevision: 0, executionTargetRevision: 0 }
        )
      )
    });
    const outcomes = await coordination.coordinator.reenterPending();
    expect(outcomes.map((outcome) => [outcome.operation.id, outcome.status])).toEqual([
      [first.id, "terminal"],
      [second.id, "activated"]
    ]);
    expect(coordination.operations.getRequired(first.id)).toMatchObject({
      state: "cancelled",
      executionAttemptId: first.executionAttemptId,
      dispatchId: first.dispatchId
    });
    expect(coordination.operations.getRequired(second.id)).toMatchObject({
      state: "activated",
      executionAttemptId: second.executionAttemptId,
      dispatchId: second.dispatchId
    });
    expect(
      (await runtime.query({ ref: second.blockRef, operationId: second.id })).ownership
    ).toMatchObject({
      phase: "active",
      operationId: second.id,
      executionAttemptId: second.executionAttemptId,
      dispatchId: second.dispatchId
    });
    expect(activation).toHaveBeenCalledTimes(1);
    expect(release.mock.calls.filter(([reset]) => reset)).toHaveLength(1);
    expect(
      coordination.mailbox
        .listAfter(hostId, 0)
        .filter((message) => message.command.type === "execute_block")
    ).toHaveLength(1);
    if (failRelease) {
      expect(coordination.operations.latestDiagnostic(first.id)?.error).toEqual({
        code: "canvas_runtime_rpc_deadline_exceeded",
        retryable: true
      });
      expect(
        fixture.server.database
          .prepare("SELECT diagnostic_message FROM remote_operations WHERE id=?")
          .get(first.id)
      ).toMatchObject({
        diagnostic_message: expect.stringContaining("Runtime lease release failed")
      });
    }
    await completeDispatchToTerminal({ ...fixture, ...coordination }, outcomes[1]!);
    expect(coordination.operations.getRequired(second.id)).toMatchObject({
      state: "completed",
      executionAttemptId: second.executionAttemptId,
      dispatchId: second.dispatchId
    });
    expect(coordination.dispatches.getRequired(second.dispatchId).status).toBe("completed");
    await coordination.coordinator.reenterPending();
    expect(activation).toHaveBeenCalledTimes(1);
    expect(release.mock.calls.filter(([reset]) => reset)).toHaveLength(1);
  });

  it.each(
    (["complete", "fail", "sealRejected"] as const).flatMap((kind) =>
      (["cleanup_failure", "cleanup_success", "existing_lease"] as const).map((ownership) => ({
        kind,
        ownership
      }))
    )
  )("preserves fatal primary error and release ownership for $kind / $ownership", async ({
    kind,
    ownership
  }) => {
    const fixture = await setup(true);
    const endpoint = fixture.agentEndpoints.listVisibleFleet().items[0];
    if (!endpoint) throw new Error("cleanup_endpoint_missing");
    const outcome = await fixture.coordinator.dispatch({
      ...fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: `fatal-${kind}-${ownership}`,
      agentEndpointId: endpoint.endpointId,
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      executionTargetRevision: 0,
      targetKind: "owner_canvas",
      callerHumanPrincipalId: fixture.callerHumanPrincipalId
    });
    const operation = outcome.operation;
    const primary = new CanvasRuntimeRpcError("canvas_runtime_protocol_error", false, false);
    const cleanup = new CanvasRuntimeRpcError("canvas_runtime_rpc_deadline_exceeded", true, false);
    const mutation = vi.fn(async () => {
      throw primary;
    });
    const release = vi.fn(async () => {
      if (ownership === "cleanup_failure") throw cleanup;
    });
    const lease = await fixture.registry.acquire(fixture.locator);
    const injected = {
      ...lease,
      runtime: { ...lease.runtime, complete: mutation, fail: mutation },
      release
    };
    const acquire = vi.fn(async () => injected);
    const persistence = new SqliteRemoteDispatchPersistence(fixture.server.database);
    const failure = {
      code: "execution_cancelled",
      message: "Cancel the attempt.",
      retryable: false
    };
    fixture.server.database
      .prepare(
        "UPDATE dispatches SET status='awaiting_writeback',result_json=?,failure_json=? WHERE id=?"
      )
      .run(
        kind === "fail"
          ? null
          : JSON.stringify({
              summary: "Completed.",
              reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
              artifactRefs: []
            }),
        kind === "fail" ? JSON.stringify(failure) : null,
        operation.dispatchId
      );
    const coordinator = new RemoteBlockWritebackCoordinator({
      operations: fixture.operations,
      reservations: fixture.reservations,
      candidates: new SqliteRemoteOperationCandidateRepository(fixture.server.database),
      runtimeLeases: { acquire, acquireForHost: acquire },
      dispatches: persistence,
      artifactContent: { readReport: async () => new Uint8Array([1]) },
      checkpoint: async () => {},
      authorizeActiveWriteback: () => {}
    });
    const existingLease = ownership === "existing_lease" ? injected : undefined;
    const result =
      kind === "sealRejected"
        ? coordinator.sealOperationLocalFailure(
            operation,
            new Error("remote_source_changed"),
            existingLease
          )
        : coordinator[kind](operation.id, existingLease);
    await expect(result).rejects.toBe(primary);
    expect(classifyReenterFailure(primary)).toBe("fatal");
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(existingLease ? 0 : 1);
    expect(release).toHaveBeenCalledTimes(existingLease ? 0 : 1);
    expect(fixture.operations.getRequired(operation.id)).toMatchObject({
      state: "activated",
      executionAttemptId: operation.executionAttemptId,
      dispatchId: operation.dispatchId
    });
    expect(persistence.inspect(operation).dispatch?.status).toBe("awaiting_writeback");
    if (ownership === "cleanup_failure") {
      expect(fixture.operations.latestDiagnostic(operation.id)?.error).toEqual({
        code: "protocol_error",
        retryable: false
      });
      const rows = fixture.server.database
        .prepare(
          "SELECT error_code FROM remote_operation_diagnostics WHERE operation_id=? AND error_code IS NOT NULL ORDER BY sequence"
        )
        .all(operation.id);
      expect(rows).toContainEqual({ error_code: "canvas_runtime_rpc_deadline_exceeded" });
      expect(rows).toContainEqual({ error_code: "protocol_error" });
      expect(
        fixture.server.database
          .prepare("SELECT diagnostic_message FROM remote_operations WHERE id=?")
          .get(operation.id)
      ).toMatchObject({
        diagnostic_message: expect.stringContaining("Runtime lease release failed")
      });
    }
    if (existingLease) {
      await existingLease.release();
      expect(release).toHaveBeenCalledTimes(1);
    }
    await lease.release();
  });
});

describe("Fail action recovery owns terminal cleanup", () => {
  const releaseFixtureClaims: (() => void)[] = [];
  afterEach(() => {
    for (const release of releaseFixtureClaims.splice(0)) release();
  });
  async function preparedActions(releaseFailure: "deadline" | "fatal" | "success") {
    const fixture = await setupFleetUnboundHost(remoteManifest(true));
    fixture.hosts.reportOnline(
      fixture.host.id,
      ["acp.codex", WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
      2,
      {
        workspaceMappings: [],
        acpProfiles: [
          {
            profileId: "codex-acp",
            agentId: "codex",
            displayName: "Action agent",
            status: "ready",
            capabilities: ["acp.codex"]
          }
        ]
      }
    );
    const runtime = fixture.registry.resolve(fixture.locator);
    const mutation = vi.fn(runtime.fail.bind(runtime));
    const cleanup = new CanvasRuntimeRpcError(
      releaseFailure === "fatal"
        ? "canvas_runtime_protocol_error"
        : "canvas_runtime_rpc_deadline_exceeded",
      releaseFailure !== "fatal",
      false
    );
    const release = vi.fn();
    const acquire = async () => {
      const lease = await fixture.registry.acquire(fixture.locator);
      let failedRef: string | undefined;
      return {
        ...lease,
        runtime: {
          ...lease.runtime,
          fail: async (input: Parameters<typeof runtime.fail>[0]) => {
            failedRef = input.ref;
            return mutation(input);
          }
        },
        release: async () => {
          release(failedRef);
          await lease.release();
          if (failedRef === "T-001#B-001" && releaseFailure !== "success") throw cleanup;
        }
      };
    };
    const coordination = createRemoteBlockCoordination(
      fixture.server.database,
      {
        runtimeLeases: { acquire, acquireForHost: acquire },
        runtimeContentTargets: {
          read: (scope) =>
            readStableCanvasRuntimeContentTarget(
              new ContentVersionRepository(fixture.server.database),
              scope
            )
        },
        leaseDurationMs: 60_000,
        hostOfflineAfterMs: 60_000,
        inputArtifacts: { materialize: fixture.materialize },
        artifactContent: { readReport: async (ref) => fixture.artifacts.read(ref) },
        ownerEndpointScopeAuthorized: () => true
      },
      { serverInstanceOwnerToken: fixture.server.serverInstanceOwnerToken }
    );
    const endpoint = coordination.agentEndpoints.listVisibleFleet().items[0];
    if (!endpoint) throw new Error("action_cleanup_endpoint_missing");
    const persistence = new SqliteRemoteDispatchPersistence(fixture.server.database);
    const requests: Extract<RemoteExecutionActionRequest, { kind: "fail" }>[] = [];
    for (const [index, ref] of ["T-001#B-001", "T-002#B-001"].entries()) {
      const outcome = await coordination.coordinator.dispatch({
        ...fixture.dispatchLocator,
        blockRef: ref,
        idempotencyKey: `action-cleanup-${index}`,
        agentEndpointId: endpoint.endpointId,
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        executionTargetRevision: 0,
        targetKind: "owner_canvas",
        callerHumanPrincipalId: fixture.callerHumanPrincipalId
      });
      const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
      coordination.dispatches.accept(
        fixture.host.id,
        `action-accept-${index}`,
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId
      );
      coordination.dispatches.interrupt(fixture.host.id, `action-interrupt-${index}`, {
        type: "dispatch.interrupted",
        protocolVersion: agentHostProtocolVersion,
        messageId: `action-interrupt-${index}`,
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        reason: "acp_session_lost",
        resumable: false
      });
      await coordination.coordinator.reenter(outcome.operation.id);
      const reservation = coordination.reservations.getRequired(dispatch.leaseId);
      coordination.reservations.release({
        leaseId: reservation.leaseId,
        fencingToken: reservation.fencingToken,
        expectedVersion: reservation.version,
        reason: "expired"
      });
      const operation = coordination.operations.getRequired(outcome.operation.id);
      const action: Extract<RemoteExecutionActionRequest, { kind: "fail" }> = {
        actionId: `cleanup-fail-${index}`,
        operationId: operation.id,
        dispatchId: operation.dispatchId,
        executionAttemptId: operation.executionAttemptId,
        expectedAttemptVersion: operation.attempt.stateVersion,
        leaseId: dispatch.leaseId,
        kind: "fail",
        reason: "Stop interrupted operation.",
        failure: {
          code: "operator_stopped",
          message: "Stop interrupted operation.",
          retryable: false
        }
      };
      expect(decideRemoteExecutionAction(action, persistence.actionSnapshot(operation))).toEqual({
        transition: "fail",
        sendsCommand: false
      });
      coordination.actions.record(action);
      persistence.prepareManualFailure({ operation, failure: action.failure });
      requests.push(action);
    }
    mutation.mockClear();
    release.mockClear();
    releaseFixtureClaims.push(() => {
      for (const request of requests)
        coordination.actions.releaseApplicationClaimIfOwned(
          request.actionId,
          fixture.server.serverInstanceOwnerToken
        );
    });
    return { fixture, coordination, requests, mutation, release, cleanup };
  }

  it.each([
    "deadline",
    "success",
    "fatal"
  ] as const)("recovers the exact fail effects with lease release %s", async (releaseFailure) => {
    const { fixture, coordination, requests, mutation, release, cleanup } =
      await preparedActions(releaseFailure);
    if (releaseFailure === "fatal") {
      await expect(coordination.coordinator.reconcileActions()).rejects.toBe(cleanup);
      expect(coordination.actions.getRequired(requests[0]!.actionId).state).toBe("recorded");
      expect(coordination.operations.getRequired(requests[1]!.operationId).state).toBe(
        "interrupted"
      );
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      return;
    }
    const recovered = await coordination.coordinator.reconcileActions();
    expect(recovered.map((action) => action.state)).toEqual(["settled", "settled"]);
    for (const request of requests) {
      expect(coordination.operations.getRequired(request.operationId)).toMatchObject({
        state: "failed",
        dispatchId: request.dispatchId,
        executionAttemptId: request.executionAttemptId,
        attempt: {
          status: "failed",
          stateVersion: request.expectedAttemptVersion + 1,
          leaseId: request.leaseId
        }
      });
      expect(coordination.dispatches.getRequired(request.dispatchId).status).toBe("failed");
      expect(coordination.actions.getRequired(request.actionId).state).toBe("settled");
      expect(
        fixture.server.database
          .prepare(
            "SELECT application_owner_token,application_decision_json FROM remote_execution_actions WHERE action_id=?"
          )
          .get(request.actionId)
      ).toEqual({ application_owner_token: null, application_decision_json: null });
    }
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    if (releaseFailure === "deadline") {
      expect(coordination.operations.latestDiagnostic(requests[0]!.operationId)?.error).toEqual({
        code: "canvas_runtime_rpc_deadline_exceeded",
        retryable: true
      });
    } else
      expect(
        coordination.operations.latestDiagnostic(requests[0]!.operationId)?.error
      ).toBeUndefined();
    await coordination.coordinator.reconcileActions();
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it.each([
    "wrong_identity",
    "wrong_version",
    "different_failure",
    "terminal_wrong_identity",
    "terminal_wrong_version",
    "terminal_different_failure",
    "terminal_inconsistent_status"
  ] as const)("does not settle or mutate an action with %s", async (fault) => {
    const { fixture, coordination, requests, mutation, release } = await preparedActions("success");
    const first = requests[0]!;
    const terminal = fault.startsWith("terminal_");
    if (terminal) {
      await coordination.coordinator.fail(first.operationId);
      mutation.mockClear();
      release.mockClear();
    }
    if (fault.endsWith("wrong_identity")) {
      const changed = { ...first, executionAttemptId: requests[1]!.executionAttemptId };
      const createdAt = coordination.actions.getRequired(first.actionId).createdAt;
      fixture.server.database
        .prepare("DELETE FROM remote_execution_actions WHERE action_id=?")
        .run(first.actionId);
      coordination.actions.record(changed);
      fixture.server.database
        .prepare("UPDATE remote_execution_actions SET created_at=? WHERE action_id=?")
        .run(createdAt, first.actionId);
    } else if (fault.endsWith("wrong_version")) {
      fixture.server.database
        .prepare(
          "UPDATE remote_execution_attempts SET state_version=state_version+1 WHERE execution_attempt_id=?"
        )
        .run(first.executionAttemptId);
    } else if (fault === "terminal_inconsistent_status") {
      fixture.server.database
        .prepare(
          "UPDATE remote_execution_attempts SET status='cancelled' WHERE execution_attempt_id=?"
        )
        .run(first.executionAttemptId);
    } else {
      fixture.server.database
        .prepare("UPDATE dispatches SET failure_json=? WHERE id=?")
        .run(JSON.stringify({ ...first.failure, code: "another_failure" }), first.dispatchId);
    }
    await expect(coordination.coordinator.reconcileActions()).rejects.toThrow();
    expect(coordination.actions.getRequired(first.actionId).state).toBe("recorded");
    expect(coordination.operations.getRequired(first.operationId).state).toBe(
      terminal ? "failed" : "interrupted"
    );
    expect(mutation).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
