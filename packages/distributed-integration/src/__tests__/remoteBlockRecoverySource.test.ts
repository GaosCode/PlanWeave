import {
  CANVAS_RUNTIME_CAPABILITY,
  CANVAS_RUNTIME_EXECUTION_CAPABILITY,
  agentHostProtocolVersion,
  canvasRuntimeResponseEventSchema,
  executionAttemptIdSchema,
  hostEventSchema,
  mailboxDeliverySchema,
  type CanvasRuntimeOperation,
  type CanvasRuntimeResponsePayload
} from "@planweave-ai/agent-host-protocol";
import { createRemoteBlockRuntimePort, markBlockDiverged } from "@planweave-ai/runtime";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CanvasRuntimeService } from "../../../agent-host/src/runtime/canvasRuntimeService.js";
import {
  artifactTransfer,
  directories,
  resolverWith,
  response,
  setup
} from "../../../agent-host/src/__tests__/support/canvasRuntimeServiceFixture.js";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../../../server/src/artifacts.js";
import {
  readStableCanvasRuntimeContentTarget,
  readStableCanvasRuntimeEvidence
} from "../../../server/src/canvas/contentFingerprint.js";
import { RemoteHostCanvasRuntimeAdapter } from "../../../server/src/canvas/remoteHostRuntimeAdapter.js";
import { RuntimeArtifactGrantRepository } from "../../../server/src/canvas/runtimeArtifactGrantRepository.js";
import { CanvasRuntimeHostLocator } from "../../../server/src/canvas/runtimeHostLocator.js";
import {
  CanvasRuntimeRpcBroker,
  CanvasRuntimeRpcError
} from "../../../server/src/canvas/runtimeRpcBroker.js";
import { createRemoteBlockCoordination } from "../../../server/src/distributedCoordination.js";
import { remoteBlockIdentity } from "../../../server/src/remoteBlockIdentity.js";
import { acquireServerInstanceOwnership } from "../../../server/src/serverInstanceOwnership.js";
import { remoteAcpFixtureManifest } from "../../../server/src/vpsE2e/fixtureWorkspace.js";
import {
  actor,
  canvasCommandServiceFixture,
  submitBody
} from "../../../server/src/__tests__/support/canvasCommandServiceFixture.js";
import { ownHostRemoteAgents } from "../../../server/src/__tests__/support/remoteAgentOwnerFixture.js";

const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
const ref = "T-001#B-001";
const recovery = { acpSessionId: "original-session", recoveryId: "original-recovery" };
const updatedPrompt = "Current task prompt from the Workspace editor.\n";

async function interruptedWorkspaceAttempt(resumable: boolean) {
  const manifest = remoteAcpFixtureManifest();
  const authority = await canvasCommandServiceFixture({ manifest });
  const { database, access, contentVersions } = authority;
  const evidence = () => {
    const current = readStableCanvasRuntimeEvidence(contentVersions, scope);
    if (!current) throw new Error("test_canvas_content_evidence_missing");
    return current;
  };
  const targets = {
    read: () => readStableCanvasRuntimeContentTarget(contentVersions, scope)
  };
  const original = evidence();
  const { ownerToken } = acquireServerInstanceOwnership(database);
  const { state } = await setup();
  const hostWorkspace = await createTestWorkspace(manifest);
  directories.push(hostWorkspace.home, hostWorkspace.root);
  const canvas = hostWorkspace.init.workspace;
  const runtime = createRemoteBlockRuntimePort({ projectRoot: canvas });
  const service = new CanvasRuntimeService({
    capabilities: [CANVAS_RUNTIME_CAPABILITY],
    resolver: resolverWith(async () => ({ scope, project: canvas, canvas })),
    receipts: state.canvasRuntime,
    artifactTransfer,
    contentTransfer: {
      updateCredentialToken: () => {},
      fetch: async (_scope, target) => contentVersions.readVersion(scope, target.content)
    }
  });

  const artifacts = new ArtifactStore(database, authority.workspace.root, 1024 * 1024);
  let adapter: RemoteHostCanvasRuntimeAdapter;
  const coordination = createRemoteBlockCoordination(
    database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeContentTargets: targets,
      runtimeLeases: {
        acquire: (target) => adapter.acquire(target),
        acquireForHost: (target, hostId) => adapter.acquireForHost(target, hostId)
      },
      inputArtifacts: { materialize: async () => undefined },
      artifactContent: { readReport: async (artifactRef) => artifacts.read(artifactRef) }
    },
    { serverInstanceOwnerToken: ownerToken }
  );
  const host = coordination.hosts.register("Workspace Recovery Host").host;
  const agentOwner = ownHostRemoteAgents({
    database,
    hostId: host.id,
    grantWorkspaceId: scope.workspaceId
  });
  coordination.hosts.bindToWorkspace(host.id, scope.workspaceId);
  const profileCapabilities = ["acp.codex", "acp.session.load"];
  coordination.hosts.reportOnline(
    host.id,
    [CANVAS_RUNTIME_CAPABILITY, CANVAS_RUNTIME_EXECUTION_CAPABILITY, ...profileCapabilities],
    1,
    {
      workspaceMappings: [{ workspaceId: scope.workspaceId, status: "ready" }],
      runtimeProjects: [
        { workspaceId: scope.workspaceId, projectId: scope.projectId, status: "ready" }
      ],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Controlled ACP",
          status: "ready",
          capabilities: profileCapabilities
        }
      ]
    }
  );
  const broker = new CanvasRuntimeRpcBroker(database, coordination.hosts, coordination.mailbox, {
    requestTimeoutMs: 3_000
  });
  broker.attachSessionLookup({ isActive: (hostId) => hostId === host.id });
  const locator = new CanvasRuntimeHostLocator(
    coordination.hosts.runtimeBindings,
    coordination.hosts,
    broker,
    access
  );
  adapter = new RemoteHostCanvasRuntimeAdapter(locator, broker, targets, {
    artifacts,
    grants: new RuntimeArtifactGrantRepository(database, {
      maxArtifactBytes: 1024 * 1024,
      leaseActive: (lease) => broker.isActive(lease.hostId)
    })
  });

  const hostResponses: Array<{
    request: CanvasRuntimeOperation;
    reply: CanvasRuntimeResponsePayload["response"];
  }> = [];
  const deliveryErrors: unknown[] = [];
  let inFlight = Promise.resolve();
  coordination.mailbox.subscribe(host.id, (message) => {
    inFlight = inFlight
      .then(async () => {
        const delivery = mailboxDeliverySchema.parse({
          type: "mailbox.message",
          protocolVersion: agentHostProtocolVersion,
          sequence: message.sequence,
          previousSequence: message.previousSequence,
          messageId: message.messageId,
          command: message.command
        });
        state.receive(delivery);
        const request = delivery.command;
        if (request.type !== "canvas_runtime.request") return;
        await service.handle(request);
        const reply = canvasRuntimeResponseEventSchema.parse(response(state, request.requestId));
        hostResponses.push({ request: request.operation, reply: reply.response });
        broker.handleResponse(host.id, reply);
        state.acknowledgeEvent(reply.messageId);
      })
      .catch((error: unknown) => {
        deliveryErrors.push(error);
      });
  });

  const endpoint = coordination.agentEndpoints.listVisible(scope.workspaceId).items[0];
  if (!endpoint) throw new Error("test_workspace_endpoint_missing");
  const outcome = await coordination.coordinator.dispatch({
    ...scope,
    contentRevision: original.sourceRevision,
    graphFingerprint: original.target.graphFingerprint,
    blockRef: ref,
    idempotencyKey: "workspace-source-dispatch",
    agentEndpointId: endpoint.endpointId,
    callerHumanPrincipalId: agentOwner,
    targetKind: "workspace_canvas",
    expectedResponsibilityRevision: 0,
    expectedReviewerRevision: 0,
    executionTargetRevision: 0
  });
  const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
  coordination.dispatches.accept(
    host.id,
    "initial-accept",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  const interruption = hostEventSchema.parse({
    type: "dispatch.interrupted",
    protocolVersion: agentHostProtocolVersion,
    messageId: "initial-interrupt",
    dispatchId: dispatch.id,
    leaseId: dispatch.leaseId,
    executionAttemptId: dispatch.executionAttemptId,
    reason: resumable ? "transport_lost" : "acp_session_lost",
    resumable,
    ...(resumable ? { recovery } : {})
  });
  if (interruption.type !== "dispatch.interrupted") throw new Error("test_interruption_missing");
  coordination.dispatches.interrupt(host.id, interruption.messageId, interruption);
  await coordination.coordinator.reenter(outcome.operation.id);
  const priorLease = coordination.reservations.getRequired(dispatch.leaseId);
  coordination.reservations.release({
    leaseId: priorLease.leaseId,
    fencingToken: priorLease.fencingToken,
    expectedVersion: priorLease.version,
    reason: "expired"
  });
  const interrupted = coordination.operations.getRequired(outcome.operation.id);
  const identity = remoteBlockIdentity(interrupted);
  expect(deliveryErrors).toEqual([]);
  return {
    authority,
    coordination,
    evidence,
    original,
    database,
    broker,
    hostResponses,
    runtime,
    adapter,
    host,
    canvas,
    interrupted,
    priorLeaseId: priorLease.leaseId,
    identity
  };
}

type RecoveryFault = "before_commit" | "after_commit" | "after_rejection";

function failRecoveryRpc(
  broker: CanvasRuntimeRpcBroker,
  operation: "resume_attempt" | "retry_attempt",
  ...faults: RecoveryFault[]
) {
  const request = broker.request.bind(broker);
  vi.spyOn(broker, "request").mockImplementation(async (...args) => {
    const fault = args[2].operation === operation ? faults.shift() : undefined;
    if (!fault) return request(...args);
    if (fault === "after_commit") {
      expect(await request(...args)).toMatchObject({ outcome: "success" });
    } else if (fault === "after_rejection") {
      expect(await request(...args)).toMatchObject({
        outcome: "error",
        error: { code: "remote_block_source_changed" }
      });
    }
    throw new CanvasRuntimeRpcError("canvas_runtime_reconcile_required", true, true);
  });
}

async function interruptedWorkspaceResume(firstResume: "before_commit" | "after_commit") {
  const fixture = await interruptedWorkspaceAttempt(true);
  const { broker, coordination, interrupted, identity, runtime } = fixture;
  failRecoveryRpc(broker, "resume_attempt", firstResume);
  const { capability } = coordination.coordinator.readResume(interrupted);
  if (!capability.available) throw new Error(capability.reason);
  const command = {
    ...capability.target,
    actionId: "workspace-source-resume",
    kind: "resume_same_session",
    reason: "Resume the original ACP session."
  } as const;

  await expect(coordination.coordinator.executeHumanAction(command)).rejects.toMatchObject({
    code: "canvas_runtime_reconcile_required"
  });
  const recorded = coordination.actions.getRequired(command.actionId);
  expect(recorded.state).toBe("recorded");
  if (recorded.request.kind !== "resume_same_session")
    throw new Error("test_resume_request_missing");
  const binding = await runtime.query({ ref, operationId: identity.operationId });
  expect(binding.status).toBe(firstResume === "after_commit" ? "in_progress" : "diverged");
  return { ...fixture, command, leaseId: recorded.request.leaseId };
}

async function updateTaskPrompt(fixture: Awaited<ReturnType<typeof interruptedWorkspaceAttempt>>) {
  const edited = await fixture.authority.service.submit(
    actor("editor"),
    submitBody("edit-before-replay", 0, {
      kind: "update_task_prompt",
      taskId: "T-001",
      promptMarkdown: updatedPrompt
    })
  );
  expect(edited.type).toBe("canvas.command.accepted");
  const current = fixture.evidence();
  expect(current.target.revision).toBe(fixture.original.target.revision + 1);
  expect(current.target.graphFingerprint).not.toBe(fixture.original.target.graphFingerprint);
  return current;
}

describe("shared Workspace Resume source", () => {
  it.each([
    "before_commit",
    "after_commit"
  ] as const)("rejects old evidence after a normal editor update and Host acquire (%s)", async (firstResume) => {
    const fixture = await interruptedWorkspaceResume(firstResume);
    const {
      coordination,
      database,
      hostResponses,
      runtime,
      adapter,
      host,
      canvas,
      command,
      identity,
      leaseId
    } = fixture;
    const current = await updateTaskPrompt(fixture);

    const lease = await adapter.acquireForHost(scope, host.id);
    try {
      const stateBefore = await readFile(canvas.stateFile, "utf8");
      await expect(
        lease.runtime.resumeAttempt({
          ...identity,
          executionAttemptId: executionAttemptIdSchema.parse("stale-attempt")
        })
      ).rejects.toMatchObject({ code: "remote_ownership_activation_conflict" });
      await expect(
        lease.runtime.resumeAttempt({ ...identity, operationId: "foreign-operation" })
      ).rejects.toMatchObject({ code: "remote_ownership_operation_conflict" });
      expect(await readFile(canvas.stateFile, "utf8")).toBe(stateBefore);
    } finally {
      await lease.release();
    }
    await expect(coordination.coordinator.executeHumanAction(command)).rejects.toMatchObject({
      code: "remote_resume_attempt_conflict"
    });
    expect(
      hostResponses.filter(({ request }) => request.operation === "acquire").at(-1)
    ).toMatchObject({
      reply: {
        outcome: "success",
        result: {
          sourceRevision: current.sourceRevision,
          graphFingerprint: current.target.graphFingerprint
        }
      }
    });
    expect(
      hostResponses.filter(({ request }) => request.operation === "resume_attempt").at(-1)
    ).toMatchObject({
      request: {
        evidence: {
          sourceRevision: identity.sourceRevision,
          graphFingerprint: identity.graphFingerprint
        }
      },
      reply: { outcome: "error", error: { code: "remote_block_source_changed", retryable: false } }
    });
    expect(await readFile(join(canvas.packageDir, "nodes/T-001/prompt.md"), "utf8")).toBe(
      updatedPrompt
    );
    const binding = await runtime.query({ ref, operationId: identity.operationId });
    const { ref: _ref, ...ownership } = identity;
    expect(binding).toEqual({
      ref,
      status: "diverged",
      ownership: { phase: "active", ...ownership },
      divergenceReason: expect.stringContaining("Remote source changed before resume")
    });

    expect(coordination.actions.getRequired(command.actionId)).toMatchObject({
      state: "rejected",
      rejectionCode: "remote_resume_attempt_conflict"
    });
    expect(
      database
        .prepare("SELECT application_owner_token FROM remote_execution_actions WHERE action_id=?")
        .get(command.actionId)
    ).toEqual({ application_owner_token: null });
    expect(coordination.reservations.getRequired(leaseId).status).toBe("expired");
    expect(coordination.operations.getRequired(identity.operationId).attempt).toMatchObject({
      executionAttemptId: identity.executionAttemptId,
      status: "interrupted",
      leaseId: command.priorLeaseId
    });
    expect(coordination.dispatches.getRequired(identity.dispatchId)).toMatchObject({
      status: "interrupted",
      leaseId: command.priorLeaseId,
      interruption: { recovery }
    });
    expect(
      database.prepare("SELECT 1 FROM mailbox_messages WHERE message_id=?").get(command.actionId)
    ).toBeUndefined();
    await expect(coordination.coordinator.executeHumanAction(command)).rejects.toMatchObject({
      code: "remote_resume_attempt_conflict"
    });
  });

  it("replays an unchanged committed Resume once with the original ACP session and attempt", async () => {
    const { coordination, database, runtime, canvas, command, identity, hostResponses } =
      await interruptedWorkspaceResume("after_commit");
    const before = await readFile(canvas.stateFile, "utf8");
    const fileBefore = await stat(canvas.stateFile);
    const resumed = await coordination.coordinator.executeHumanAction(command);
    expect(resumed).toMatchObject({ state: "delivered" });
    await expect(coordination.coordinator.executeHumanAction(command)).resolves.toEqual(resumed);
    expect(await readFile(canvas.stateFile, "utf8")).toBe(before);
    expect(await stat(canvas.stateFile)).toMatchObject({
      ino: fileBefore.ino,
      mtimeMs: fileBefore.mtimeMs
    });
    expect(
      hostResponses.filter(({ request }) => request.operation === "resume_attempt")
    ).toHaveLength(2);
    const { ref: _ref, ...ownership } = identity;
    expect(await runtime.query({ ref, operationId: identity.operationId })).toMatchObject({
      status: "in_progress",
      ownership: { phase: "active", ...ownership }
    });
    const delivered = database
      .prepare("SELECT command_json FROM mailbox_messages WHERE message_id=?")
      .all(command.actionId);
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(String(delivered[0].command_json))).toMatchObject({
      type: "resume_execution",
      dispatchId: identity.dispatchId,
      executionAttemptId: identity.executionAttemptId,
      priorRecovery: recovery
    });
  });
});

async function startedWorkspaceRetry(
  loseRejection = false,
  firstFault: "after_commit" | "before_commit" = "after_commit"
) {
  const fixture = await interruptedWorkspaceAttempt(false);
  const { broker, coordination, interrupted, runtime, identity, priorLeaseId } = fixture;
  const faults: RecoveryFault[] = loseRejection ? [firstFault, "after_rejection"] : [firstFault];
  failRecoveryRpc(broker, "retry_attempt", ...faults);
  const action = {
    operationId: identity.operationId,
    dispatchId: identity.dispatchId,
    executionAttemptId: identity.executionAttemptId,
    expectedAttemptVersion: interrupted.attempt.stateVersion,
    priorLeaseId,
    actionId: "workspace-source-retry",
    kind: "retry_new_attempt",
    newDispatchId: "retry-dispatch",
    newExecutionAttemptId: "retry-attempt",
    reason: "Retry after a non-resumable interruption."
  } as const;
  await expect(coordination.coordinator.executeAction(action)).rejects.toMatchObject({
    code: "canvas_runtime_reconcile_required"
  });
  expect(coordination.actions.getRequired(action.actionId).state).toBe("recorded");
  const binding = await runtime.query({ ref, operationId: identity.operationId });
  if (firstFault === "after_commit") {
    expect(binding).toMatchObject({
      status: "in_progress",
      ownership: {
        dispatchId: action.newDispatchId,
        executionAttemptId: action.newExecutionAttemptId
      }
    });
  } else {
    expect(binding).toMatchObject({ status: "diverged", interruption: { resumable: false } });
  }
  return { ...fixture, action, binding };
}

describe("shared Workspace Retry source", () => {
  it.each([
    "received_rejection",
    "lost_rejection",
    "restored_source"
  ])("rejects a committed Retry after source drift and continues ordinary maintenance (%s)", async (scenario) => {
    const loseRejection = scenario !== "received_rejection";
    const fixture = await startedWorkspaceRetry(loseRejection);
    const {
      action,
      binding,
      canvas,
      coordination,
      database,
      hostResponses,
      identity,
      priorLeaseId,
      runtime
    } = fixture;
    const promptPath = join(canvas.packageDir, "nodes/T-001/prompt.md");
    const originalPrompt = await readFile(promptPath, "utf8");
    const current = await updateTaskPrompt(fixture);
    const firstReplay = coordination.coordinator.executeAction(action);
    if (loseRejection) {
      await expect(firstReplay).rejects.toMatchObject({
        code: "canvas_runtime_reconcile_required"
      });
      expect(coordination.actions.getRequired(action.actionId).state).toBe("recorded");
    } else {
      await expect(firstReplay).rejects.toMatchObject({
        code: "remote_resume_attempt_conflict",
        cause: { code: "remote_block_source_changed" }
      });
      expect(coordination.actions.getRequired(action.actionId).state).toBe("rejected");
    }
    expect(
      hostResponses.filter(({ request }) => request.operation === "acquire").at(-1)
    ).toMatchObject({
      reply: {
        outcome: "success",
        result: {
          sourceRevision: current.sourceRevision,
          graphFingerprint: current.target.graphFingerprint
        }
      }
    });
    expect(await readFile(promptPath, "utf8")).toBe(updatedPrompt);
    expect(await runtime.query({ ref, operationId: identity.operationId })).toEqual({
      ...binding,
      status: "diverged",
      divergenceReason: expect.stringContaining("Remote source changed before retry")
    });
    expect(coordination.operations.getRequired(identity.operationId).attempt).toMatchObject({
      executionAttemptId: identity.executionAttemptId,
      status: "interrupted",
      leaseId: priorLeaseId
    });
    if (scenario === "restored_source") {
      const restored = await fixture.authority.service.submit(
        actor("editor"),
        submitBody("restore-before-replay", 1, {
          kind: "update_task_prompt",
          taskId: "T-001",
          promptMarkdown: originalPrompt
        })
      );
      expect(restored.type).toBe("canvas.command.accepted");
      expect(identity.sourceRevision).toMatch(/^snapshot:/);
      expect(fixture.evidence().target).toMatchObject({
        revision: current.target.revision + 1,
        graphFingerprint: fixture.original.target.graphFingerprint
      });
    }
    await expect(coordination.reconcile()).resolves.toEqual([
      expect.objectContaining({
        operation: expect.objectContaining({ id: identity.operationId, state: "failed" }),
        status: "terminal"
      })
    ]);
    await expect(coordination.reconcile()).resolves.toEqual([]);
    const retries = hostResponses.filter(({ request }) => request.operation === "retry_attempt");
    expect(retries).toHaveLength(loseRejection ? 3 : 2);
    for (const [index, retry] of retries.slice(1).entries()) {
      const code =
        scenario === "restored_source" && index === 1
          ? "remote_ownership_status_conflict"
          : "remote_block_source_changed";
      expect(retry).toMatchObject({
        request: {
          evidence: {
            operationId: identity.operationId,
            sourceRevision: identity.sourceRevision,
            graphFingerprint: identity.graphFingerprint
          }
        },
        reply: {
          outcome: "error",
          error: { code, retryable: false }
        }
      });
    }
    await expect(coordination.coordinator.executeAction(action)).rejects.toMatchObject({
      code: "remote_resume_attempt_conflict"
    });
    expect(coordination.actions.getRequired(action.actionId)).toMatchObject({
      state: "rejected",
      rejectionCode: "remote_resume_attempt_conflict"
    });
    expect(
      database
        .prepare("SELECT application_owner_token FROM remote_execution_actions WHERE action_id=?")
        .get(action.actionId)
    ).toEqual({ application_owner_token: null });
    expect(coordination.reservations.getRequired(priorLeaseId).status).toBe("expired");
    expect(
      database.prepare("SELECT lease_id, status FROM host_capacity_reservations").all()
    ).toEqual([{ lease_id: priorLeaseId, status: "expired" }]);
    expect(
      database.prepare("SELECT execution_attempt_id FROM remote_execution_attempts").all()
    ).toEqual([{ execution_attempt_id: identity.executionAttemptId }]);
    expect(database.prepare("SELECT id FROM dispatches").all()).toEqual([
      { id: identity.dispatchId }
    ]);
    expect(
      database
        .prepare(
          "SELECT message_id FROM mailbox_messages WHERE json_extract(command_json, '$.dispatchId')=?"
        )
        .all(action.newDispatchId)
    ).toEqual([]);
    expect(
      database
        .prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(identity.operationId)
    ).toEqual({ diagnostic_code: "remote_source_changed" });
    expect(await runtime.query({ ref, operationId: identity.operationId })).toMatchObject({
      status: "diverged",
      ownership: binding.ownership
    });
    if (scenario === "restored_source") {
      expect(await readFile(promptPath, "utf8")).toBe(originalPrompt);
      expect(
        hostResponses.filter(({ request }) => request.operation === "query").at(-1)
      ).toMatchObject({
        reply: {
          outcome: "success",
          result: {
            status: "diverged",
            ownership: binding.ownership,
            divergenceReason: expect.any(String)
          }
        }
      });
    }
  });

  it("preserves the status conflict when the authoritative diverged owner is the old attempt", async () => {
    const { action, canvas, coordination, identity, runtime } = await startedWorkspaceRetry(
      false,
      "before_commit"
    );
    await markBlockDiverged({
      projectRoot: canvas,
      ref,
      reason: "Original attempt requires operator review."
    });
    await expect(coordination.coordinator.executeAction(action)).rejects.toMatchObject({
      code: "remote_ownership_status_conflict"
    });
    expect(coordination.actions.getRequired(action.actionId)).toMatchObject({ state: "recorded" });
    expect(await runtime.query({ ref, operationId: identity.operationId })).toMatchObject({
      status: "diverged",
      ownership: {
        dispatchId: identity.dispatchId,
        executionAttemptId: identity.executionAttemptId
      },
      divergenceReason: "Original attempt requires operator review."
    });
  });

  it("delivers one new attempt when the Runtime Retry committed and the source is unchanged", async () => {
    const { action, coordination, database, runtime, binding, identity } =
      await startedWorkspaceRetry();
    const settled = await coordination.coordinator.executeAction(action);
    expect(settled.state).toBe("settled");
    await expect(coordination.coordinator.executeAction(action)).resolves.toEqual(settled);
    expect(coordination.operations.getRequired(identity.operationId)).toMatchObject({
      dispatchId: action.newDispatchId,
      executionAttemptId: action.newExecutionAttemptId
    });
    expect(await runtime.query({ ref, operationId: identity.operationId })).toEqual(binding);
    expect(
      database
        .prepare(
          "SELECT message_id FROM mailbox_messages WHERE json_extract(command_json, '$.type')='execute_block' AND json_extract(command_json, '$.dispatchId')=?"
        )
        .all(action.newDispatchId)
    ).toHaveLength(1);
  });
});
