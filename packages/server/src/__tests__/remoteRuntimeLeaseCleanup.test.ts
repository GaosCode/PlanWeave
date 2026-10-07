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
import { ownHostRemoteAgents } from "./support/remoteAgentOwnerFixture.js";
import { seedLegacyRemoteOperation } from "./support/legacyRemoteOperationSeed.js";
import { setup, remoteManifest } from "./support/remoteBlockCoordinatorFixture.js";

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
