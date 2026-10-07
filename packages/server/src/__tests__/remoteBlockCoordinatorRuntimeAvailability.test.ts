import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CANVAS_RUNTIME_CAPABILITY,
  agentHostProtocolVersion,
  canvasRuntimeResponseEventSchema
} from "@planweave-ai/agent-host-protocol";
import {
  remoteBlockInspectInputSchema,
  remoteBlockClaimInputSchema,
  remoteBlockOperationQuerySchema,
  remoteBlockInterruptionInputSchema,
  remoteBlockFailureInputSchema,
  remoteBlockRefIdentitySchema
} from "@planweave-ai/runtime";
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
import { remoteOperationDiagnosticRetryabilitySql } from "../remoteOperationDiagnosticRetryability.js";
import { ownHostRemoteAgents } from "./support/remoteAgentOwnerFixture.js";
import { CanvasRuntimeUnavailableError } from "../canvas/executionRuntimePort.js";
import {
  workspaceEndpointSelection,
  workspaceExecutionCandidate
} from "./support/endpointCoordinatorFixture.js";
import { seedLegacyRemoteOperation } from "./support/legacyRemoteOperationSeed.js";
import { setup, remoteManifest } from "./support/remoteBlockCoordinatorFixture.js";

describe("RemoteBlockCoordinator Runtime availability reentry", () => {
  it.each([
    "host_offline",
    "runtime_not_attached"
  ] as const)("keeps an operation awaiting_host when Runtime acquisition reports %s", async (reason) => {
    const fixture = await setup(true);
    const candidate = workspaceExecutionCandidate(
      await fixture.registry.resolve(fixture.locator).inspect({ ref: "T-001#B-001" })
    );
    if (!fixture.host) throw new Error("runtime_availability_host_missing");
    const operation = seedLegacyRemoteOperation({
      database: fixture.server.database,
      operations: fixture.operations,
      locator: fixture.locator,
      candidate,
      idempotencyKey: `runtime-unavailable-${reason}`,
      hostSelection: {
        workspaceId: fixture.locator.workspaceId,
        assignmentRevision: 0,
        target: { kind: "automatic_host" },
        selection: "automatic",
        requiredCapabilities: candidate.requiredCapabilities
      },
      endpointSelection: workspaceEndpointSelection({
        agentEndpoints: fixture.agentEndpoints,
        candidate,
        hostId: fixture.host.id,
        workspaceId: fixture.locator.workspaceId,
        database: fixture.server.database
      })
    });
    fixture.registry.setScopedResolver(async () => {
      throw new CanvasRuntimeUnavailableError(reason);
    });

    const [outcome] = await fixture.coordinator.reenterPending();

    expect(outcome?.status).toBe("awaiting_host");
    expect(fixture.operations.latestDiagnostic(operation.id)).toEqual({
      stage: "preparing_runtime",
      error: { code: reason, retryable: true }
    });
  });

  it.each([
    "acquire",
    "activate",
    "protocol_error"
  ] as const)("isolates Host A's lost %s response and recovers its exact attempt without duplicate activation", async (lostOperation) => {
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
        idempotencyKey: `lost-${lostOperation}-${index}`,
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
    const calls: { hostId: string; operation: string; input?: unknown }[] = [];
    const hostErrors: unknown[] = [];
    let drop = true;
    let dropActionAcquire = false;
    const subscriptions = [...active].map((hostId) =>
      fixture.mailbox.subscribe(hostId, (message) => {
        if (message.command.type !== "canvas_runtime.request") return;
        const command = message.command;
        calls.push({
          hostId,
          operation: command.operation.operation,
          ...("input" in command.operation ? { input: command.operation.input } : {})
        });
        void (async () => {
          const operation = command.operation;
          if (
            hostId === hostA.id &&
            operation.operation === "acquire" &&
            lostOperation === "protocol_error"
          ) {
            broker.handleResponse(
              hostId,
              canvasRuntimeResponseEventSchema.parse({
                type: "canvas_runtime.response",
                protocolVersion: agentHostProtocolVersion,
                messageId: randomUUID(),
                requestId: command.requestId,
                response: {
                  outcome: "error",
                  operation: "acquire",
                  error: {
                    code: "protocol_error",
                    message: "Invalid peer protocol.",
                    retryable: true,
                    reconcileRequired: true
                  }
                }
              })
            );
            return;
          }
          if (hostId === hostA.id && operation.operation === "acquire" && dropActionAcquire) {
            dropActionAcquire = false;
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
            case "mark_interrupted":
              result = await runtime.markInterrupted(
                remoteBlockInterruptionInputSchema.parse(operation.input)
              );
              break;
            case "fail":
              result = await runtime.fail(remoteBlockFailureInputSchema.parse(operation.input));
              break;
            case "activate":
              result = await runtime.activate(remoteBlockRefIdentitySchema.parse(operation.input));
              break;
            default:
              throw new Error(`rpc_recovery_unexpected_operation:${operation.operation}`);
          }
          if (hostId === hostA.id && operation.operation === lostOperation && drop) {
            drop = false;
            return;
          }
          broker.handleResponse(
            hostId,
            canvasRuntimeResponseEventSchema.parse({
              type: "canvas_runtime.response",
              protocolVersion: agentHostProtocolVersion,
              messageId: randomUUID(),
              requestId: command.requestId,
              response: { outcome: "success", operation: operation.operation, result }
            })
          );
        })().catch((error) => hostErrors.push(error));
      })
    );
    try {
      if (lostOperation === "protocol_error") {
        await expect(coordination.coordinator.reenterPending()).rejects.toMatchObject({
          code: "protocol_error"
        });
        expect(coordination.operations.getRequired(second.id).state).toBe("preparing");
        return;
      }
      const outcomes = await coordination.coordinator.reenterPending();
      expect(hostErrors).toEqual([]);
      expect(outcomes.map((outcome) => [outcome.operation.id, outcome.status])).toEqual([
        [first.id, "awaiting_host"],
        [second.id, "activated"]
      ]);
      expect(coordination.operations.getRequired(first.id).state).not.toBe("failed");
      const code =
        lostOperation === "acquire"
          ? "canvas_runtime_rpc_deadline_exceeded"
          : "canvas_runtime_reconcile_required";
      expect(coordination.operations.latestDiagnostic(first.id)?.error).toEqual({
        code,
        retryable: true
      });
      expect(
        database
          .prepare(
            `SELECT ${remoteOperationDiagnosticRetryabilitySql("diagnostic_code")} AS retryable FROM remote_operations WHERE id=?`
          )
          .get(first.id)
      ).toEqual({ retryable: 1 });
      broker.detachHost(hostA.id, "superseded");
      const recovered = await coordination.coordinator.reenterPending();
      expect(recovered.find((outcome) => outcome.operation.id === first.id)?.status).toBe(
        "activated"
      );
      const after = coordination.operations.getRequired(first.id);
      expect(after.executionAttemptId).toBe(first.executionAttemptId);
      expect(after.dispatchId).toBe(first.dispatchId);
      expect(after.state).toBe("activated");
      const binding = await runtime.query({ ref: first.blockRef, operationId: first.id });
      expect(binding.ownership).toMatchObject({
        phase: "active",
        operationId: first.id,
        dispatchId: first.dispatchId,
        executionAttemptId: first.executionAttemptId
      });
      expect(
        calls.filter((call) => call.hostId === hostA.id && call.operation === "activate")
      ).toHaveLength(1);
      await coordination.coordinator.reenterPending();
      expect(
        calls.filter((call) => call.hostId === hostA.id && call.operation === "activate")
      ).toHaveLength(1);
      expect(
        fixture.mailbox
          .listAfter(hostA.id, 0)
          .filter((message) => message.command.type === "execute_block")
      ).toHaveLength(1);
      expect(coordination.operations.latestDiagnostic(first.id)?.error).toBeUndefined();
      if (lostOperation === "activate") {
        for (const [index, initial] of operations.entries()) {
          const hostId = index === 0 ? hostA.id : hostB.id;
          const dispatch = coordination.dispatches.getRequired(initial.dispatchId);
          coordination.dispatches.accept(
            hostId,
            `accept-action-${index}`,
            dispatch.id,
            dispatch.leaseId,
            dispatch.executionAttemptId
          );
          coordination.dispatches.interrupt(hostId, `interrupt-action-${index}`, {
            type: "dispatch.interrupted",
            protocolVersion: agentHostProtocolVersion,
            messageId: `interrupt-action-${index}`,
            dispatchId: dispatch.id,
            leaseId: dispatch.leaseId,
            executionAttemptId: dispatch.executionAttemptId,
            reason: "acp_session_lost",
            resumable: false
          });
          await coordination.coordinator.reenter(initial.id);
          const reservation = coordination.reservations.getRequired(dispatch.leaseId);
          coordination.reservations.release({
            leaseId: reservation.leaseId,
            fencingToken: reservation.fencingToken,
            expectedVersion: reservation.version,
            reason: "expired"
          });
          const interrupted = coordination.operations.getRequired(initial.id);
          coordination.actions.record({
            actionId: `fail-action-${index}`,
            operationId: interrupted.id,
            dispatchId: interrupted.dispatchId,
            executionAttemptId: interrupted.executionAttemptId,
            expectedAttemptVersion: interrupted.attempt.stateVersion,
            kind: "fail",
            reason: "Stop interrupted attempt.",
            leaseId: dispatch.leaseId,
            failure: {
              code: "operator_stopped",
              message: "Stop interrupted attempt.",
              retryable: false
            }
          });
        }
        dropActionAcquire = true;
        const actionOutcomes = await coordination.coordinator.reconcileActions();
        expect(actionOutcomes.map((action) => action.request.actionId)).toEqual(["fail-action-1"]);
        expect(coordination.actions.getRequired("fail-action-0").state).toBe("recorded");
        expect(coordination.operations.getRequired(first.id).state).toBe("interrupted");
        expect(coordination.operations.latestDiagnostic(first.id)?.error).toEqual({
          code: "canvas_runtime_rpc_deadline_exceeded",
          retryable: true
        });
        expect(coordination.operations.getRequired(second.id).state).toBe("failed");
        const reconciledActions = await coordination.coordinator.reconcileActions();
        expect(
          reconciledActions.find((action) => action.request.actionId === "fail-action-0")?.state
        ).toBe("settled");
        expect(coordination.operations.getRequired(first.id).state).toBe("failed");
        expect(coordination.operations.getRequired(first.id).executionAttemptId).toBe(
          first.executionAttemptId
        );
        await coordination.coordinator.reconcileActions();
        expect(
          calls.filter((call) => call.hostId === hostA.id && call.operation === "fail")
        ).toHaveLength(1);
      }
      expect(hostErrors).toEqual([]);
    } finally {
      for (const unsubscribe of subscriptions) unsubscribe();
      broker.close();
    }
  });
});
