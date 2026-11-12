import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  agentHostProtocolVersion,
  WORKSPACE_CANVAS_EXECUTION_CAPABILITY
} from "@planweave-ai/agent-host-protocol";
import { RemoteOwnershipConflictError } from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import { AgentEndpointCatalogError, endpointIdFor } from "../agentEndpointCatalog.js";
import { CanvasRuntimeUnavailableError } from "../canvas/executionRuntimePort.js";
import { CanvasRuntimeRpcError } from "../canvas/runtimeRpcBroker.js";
import { HumanIdentityCredentialStore } from "../identity/humanIdentityCredentialStore.js";
import { workspaceMembershipIdFor } from "../identity/workspaceMembershipProjection.js";
import { RemoteCoordinatorCheckpointCrash } from "../remoteBlockCoordinatorPorts.js";
import { RemoteExecutionActionRepository } from "../remoteExecutionActions.js";
import type { RemoteExecutionActionRequest } from "../remoteExecutionLifecycle.js";
import { RemoteAgentAuthorizationError } from "../remoteAgent/errors.js";
import { RemoteAgentRepository } from "../remoteAgent/repository.js";
import type { RemoteOperation } from "../remoteOperations.js";
import type { SqliteDatabase } from "../sqlite.js";
import { endpointDispatchRequest } from "./support/endpointCoordinatorFixture.js";
import {
  ensureTestHumanPrincipal,
  ownHostRemoteAgents,
  TEST_REMOTE_AGENT_OWNER_ID
} from "./support/remoteAgentOwnerFixture.js";
import { remoteManifest, setup } from "./support/remoteBlockCoordinatorFixture.js";

const MEMBER_ID = "test-remote-agent-member";

function addWorkspaceMember(
  database: SqliteDatabase,
  workspaceId: string,
  humanPrincipalId: string,
  role: "owner" | "member"
) {
  const issuedAt = new Date().toISOString();
  database
    .prepare(
      "INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES(?,?,?,?,NULL)"
    )
    .run(workspaceId, humanPrincipalId, humanPrincipalId, issuedAt);
  database
    .prepare(
      `INSERT INTO workspace_memberships(
        workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at
      ) VALUES(?,?,?,?,1,?,?,NULL)`
    )
    .run(
      workspaceId,
      workspaceMembershipIdFor(workspaceId, humanPrincipalId),
      humanPrincipalId,
      role,
      issuedAt,
      issuedAt
    );
}

async function interruptOperation(
  fixture: Awaited<ReturnType<typeof setup>>,
  operationId: string,
  idempotencyKey: string
) {
  if (!fixture.host) throw new Error("expected_test_host");
  const operation = fixture.operations.getRequired(operationId);
  const dispatch = fixture.dispatches.getRequired(operation.dispatchId);
  fixture.dispatches.accept(
    fixture.host.id,
    `${idempotencyKey}-accepted`,
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  fixture.dispatches.interrupt(fixture.host.id, `${idempotencyKey}-interrupted`, {
    type: "dispatch.interrupted",
    protocolVersion: agentHostProtocolVersion,
    messageId: `${idempotencyKey}-interrupted`,
    dispatchId: dispatch.id,
    leaseId: dispatch.leaseId,
    executionAttemptId: dispatch.executionAttemptId,
    reason: "acp_session_lost",
    resumable: false
  });
  const lease = fixture.reservations.getRequired(dispatch.leaseId);
  fixture.reservations.release({
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    expectedVersion: lease.version,
    reason: "expired"
  });
  await fixture.coordinator.reenter(operation.id);
  return fixture.operations.getRequired(operation.id);
}

describe("RemoteBlockCoordinator authority snapshots", () => {
  it("persists v2 runtime snapshot and executes workspace_canvas with agent_owner access", async () => {
    const fixture = await setup(true);
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "workspace-runtime-owner-access"
    });

    const outcome = await fixture.coordinator.dispatch(request);
    const operation = fixture.operations.getRequired(outcome.operation.id);
    const persisted = fixture.server.database
      .prepare("SELECT endpoint_selection_json,agent_access_json FROM remote_operations WHERE id=?")
      .get(operation.id) as { endpoint_selection_json: string; agent_access_json: string };

    expect(outcome.status).toBe("activated");
    expect(operation.endpointSelection?.authority).toEqual({
      schemaVersion: "endpoint-authority/v2",
      kind: "workspace_canvas",
      workspaceId: fixture.locator.workspaceId,
      responsibilityRevision: 0,
      reviewerRevision: 0,
      executionTargetRevision: 0
    });
    expect(operation.agentAccess).toMatchObject({
      callerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID,
      authorized: {
        runtimeAuthority: {
          kind: "workspace_canvas",
          workspaceId: fixture.locator.workspaceId
        },
        agentAccessAuthority: {
          kind: "agent_owner",
          ownerHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
        }
      }
    });
    expect(persisted.endpoint_selection_json).toContain("endpoint-authority/v2");
    expect(persisted.endpoint_selection_json).not.toContain("controlPlane");
    expect(persisted.agent_access_json).toContain("agent_owner");
    expect(
      fixture.mailbox.listAfter(fixture.host?.id ?? "", 0)[0]?.command.envelope
    ).not.toHaveProperty("ownerPackageLocator");
  });

  it("executes workspace_canvas runtime with workspace_grant access", async () => {
    const fixture = await setup(true);
    ensureTestHumanPrincipal(fixture.server.database, MEMBER_ID, "Workspace Member");
    addWorkspaceMember(fixture.server.database, fixture.locator.workspaceId, MEMBER_ID, "member");
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "workspace-runtime-grant-access",
      callerHumanPrincipalId: MEMBER_ID
    });

    const outcome = await fixture.coordinator.dispatch(request);

    expect(outcome.status).toBe("activated");
    expect(outcome.operation.endpointSelection?.authority).toMatchObject({
      schemaVersion: "endpoint-authority/v2",
      kind: "workspace_canvas",
      workspaceId: fixture.locator.workspaceId
    });
    expect(outcome.operation.agentAccess?.authorized).toMatchObject({
      runtimeAuthority: {
        kind: "workspace_canvas",
        workspaceId: fixture.locator.workspaceId
      },
      agentAccessAuthority: {
        kind: "workspace_grant",
        workspaceId: fixture.locator.workspaceId
      }
    });
  });

  it.each([
    "before reservation",
    "after reservation",
    "during reconciliation"
  ] as const)("denies publication when a workspace grant is revoked %s", async (when) => {
    let revokeGrant: () => void;
    const fixture = await setup(true, undefined, 1, {
      reached(point) {
        if (point !== "after_operation_commit") return;
        if (when === "before reservation") revokeGrant();
        if (when === "during reconciliation") {
          throw new RemoteCoordinatorCheckpointCrash(point);
        }
      }
    });
    if (!fixture.host) throw new Error("expected_test_host");
    const hostId = fixture.host.id;
    const workspaceId = fixture.locator.workspaceId;
    const endpointId = endpointIdFor({ hostId, profileId: "codex-acp", agentId: "codex" });
    ensureTestHumanPrincipal(fixture.server.database, MEMBER_ID, "Workspace Member");
    addWorkspaceMember(fixture.server.database, workspaceId, MEMBER_ID, "member");
    revokeGrant = () => fixture.remoteAgents.revokeGrant({ endpointId, workspaceId });
    const realReserve = fixture.reservations.reserve.bind(fixture.reservations);
    const reserve = vi.spyOn(fixture.reservations, "reserve").mockImplementation((...args) => {
      const reservation = realReserve(...args);
      if (when === "after reservation") revokeGrant();
      return reservation;
    });
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "revoke-before-publication",
      agentEndpointId: endpointId,
      callerHumanPrincipalId: MEMBER_ID
    });

    if (when === "during reconciliation") {
      await expect(fixture.coordinator.dispatch(request)).rejects.toThrowError(
        "injected_crash:after_operation_commit"
      );
      revokeGrant();
      await expect(fixture.reconcile()).resolves.toEqual([]);
    } else {
      await expect(fixture.coordinator.dispatch(request)).rejects.toMatchObject({
        code: "remote_agent_workspace_grant_missing"
      });
    }

    const operation = fixture.operations.findByCallerIdentity(request);
    expect(operation?.agentAccess?.authorized.agentAccessAuthority).toMatchObject({
      kind: "workspace_grant",
      workspaceId
    });
    if (when === "after reservation") {
      const leaseId = operation?.attempt.leaseId;
      if (!leaseId) throw new Error("expected_test_reservation");
      expect(fixture.reservations.getRequired(leaseId).status).toBe("expired");
    } else {
      expect(reserve).not.toHaveBeenCalled();
    }
    if (when === "during reconciliation") {
      if (!operation) throw new Error("expected_test_operation");
      expect(operation.state).toBe("preparing");
      expect(fixture.operations.latestDiagnostic(operation.id)).toMatchObject({
        stage: "authorizing",
        error: { code: "remote_agent_workspace_grant_missing", retryable: false }
      });
    }
    expect(fixture.mailbox.listAfter(hostId, 0)).toEqual([]);
    if (when === "during reconciliation") {
      fixture.remoteAgents.grantWorkspace({
        endpointId,
        workspaceId,
        grantedByHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
      });
      await expect(fixture.reconcile()).resolves.toMatchObject([
        { status: "activated", operation: { id: operation?.id } }
      ]);
      expect(fixture.mailbox.listAfter(hostId, 0)).toMatchObject([
        { command: { type: "execute_block", dispatchId: operation?.dispatchId } }
      ]);
    }
  });

  it("reenters a running operation from persisted snapshots after grant revoke", async () => {
    const fixture = await setup(true);
    ensureTestHumanPrincipal(fixture.server.database, MEMBER_ID, "Workspace Member");
    addWorkspaceMember(fixture.server.database, fixture.locator.workspaceId, MEMBER_ID, "member");
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "reenter-after-grant-revoke",
      callerHumanPrincipalId: MEMBER_ID
    });
    const dispatched = await fixture.coordinator.dispatch(request);
    const endpointId = dispatched.operation.endpointSelection?.endpointId;
    if (!endpointId) throw new Error("expected_endpoint_selection");
    const snapshot = dispatched.operation.agentAccess;
    new RemoteAgentRepository(fixture.server.database).revokeGrant({
      endpointId,
      workspaceId: fixture.locator.workspaceId
    });

    const reentered = await fixture.coordinator.reenter(dispatched.operation.id);

    expect(reentered.status).toBe("activated");
    expect(reentered.operation.state).not.toBe("cancelled");
    expect(reentered.operation.agentAccess).toEqual(snapshot);
    expect(reentered.operation.endpointSelection?.authority).toEqual(
      dispatched.operation.endpointSelection?.authority
    );
    expect(() =>
      fixture.coordinator.reauthorizeAgentAccessForRetry(
        fixture.operations.getRequired(dispatched.operation.id)
      )
    ).toThrow(RemoteAgentAuthorizationError);
  });

  it.each([
    "initial",
    "before initial Runtime binding",
    "recover prepared dispatch",
    "recover interrupted compensation"
  ] as const)("denies a revoked grant before mailbox admission (%s)", async (path) => {
    let revokeGrant: () => void;
    let revokedOperation: RemoteOperation | undefined;
    let crashAfterPrepare = path === "recover prepared dispatch";
    const fixture = await setup(true, undefined, 1, {
      reached(point) {
        if (point === "after_dispatch_persistence" && crashAfterPrepare) {
          crashAfterPrepare = false;
          throw new RemoteCoordinatorCheckpointCrash(point);
        }
        const revokeAt =
          path === "before initial Runtime binding"
            ? "after_dispatch_persistence"
            : "after_runtime_binding";
        if (point === revokeAt && !revokedOperation) revokeGrant();
      }
    });
    if (!fixture.host) throw new Error("expected_test_host");
    const hostId = fixture.host.id;
    const workspaceId = fixture.locator.workspaceId;
    const endpointId = endpointIdFor({ hostId, profileId: "codex-acp", agentId: "codex" });
    ensureTestHumanPrincipal(fixture.server.database, MEMBER_ID, "Workspace Member");
    addWorkspaceMember(fixture.server.database, workspaceId, MEMBER_ID, "member");
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "revoke-after-runtime-binding",
      agentEndpointId: endpointId,
      callerHumanPrincipalId: MEMBER_ID
    });
    revokeGrant = () => {
      const operation = fixture.operations.findByCallerIdentity(request);
      if (!operation?.attempt.leaseId) throw new Error("expected_test_reservation");
      expect(operation.attempt.status).toBe("reserved");
      expect(fixture.reservations.getRequired(operation.attempt.leaseId).status).toBe("active");
      expect(fixture.mailbox.listAfter(hostId, 0)).toEqual([]);
      revokedOperation = operation;
      fixture.remoteAgents.revokeGrant({ endpointId, workspaceId });
    };

    const run = async () => {
      if (path !== "recover prepared dispatch") return fixture.coordinator.dispatch(request);
      await expect(fixture.coordinator.dispatch(request)).rejects.toThrow(
        "injected_crash:after_dispatch_persistence"
      );
      expect(revokedOperation).toBeUndefined();
      const pending = fixture.operations.findByCallerIdentity(request);
      if (!pending) throw new Error("expected_test_operation");
      return fixture.coordinator.reenter(pending.id);
    };
    if (path === "recover interrupted compensation") {
      vi.spyOn(fixture.runtime, "markInterrupted").mockRejectedValueOnce(
        new Error("injected_runtime_interruption_failure")
      );
      await expect(run()).rejects.toThrow("injected_runtime_interruption_failure");
    } else {
      await expect(run()).rejects.toMatchObject({
        code: "remote_agent_workspace_grant_missing"
      });
    }
    if (!revokedOperation?.attempt.leaseId) throw new Error("expected_test_reservation");
    const { id, blockRef, dispatchId, executionAttemptId } = revokedOperation;
    const leaseId = revokedOperation.attempt.leaseId;
    const interrupted = fixture.operations.getRequired(id);
    expect(interrupted).toMatchObject({
      state: "interrupted",
      dispatchId,
      executionAttemptId,
      attempt: { status: "interrupted", leaseId }
    });
    expect(fixture.reservations.getRequired(leaseId).status).toBe("expired");
    expect(fixture.reservations.activeCountsForHosts([hostId]).get(hostId)).toBe(0);
    expect(fixture.dispatches.getRequired(dispatchId)).toMatchObject({
      status: "interrupted",
      interruption: { reason: "lease_lost", resumable: false }
    });
    expect(fixture.mailbox.listAfter(hostId, 0)).toEqual([]);
    expect(fixture.operations.latestDiagnostic(id)?.error?.code).toBe(
      "remote_agent_workspace_grant_missing"
    );
    if (path === "recover interrupted compensation") {
      await expect(
        fixture.runtime.query({ ref: blockRef, operationId: id })
      ).resolves.toMatchObject({
        status: "in_progress",
        ownership: { phase: "active", dispatchId, executionAttemptId }
      });
      await expect(fixture.reconcile()).resolves.toMatchObject([
        { operation: { id, dispatchId, executionAttemptId }, status: "wait_for_action" }
      ]);
    }
    const binding = await fixture.runtime.query({ ref: blockRef, operationId: id });
    expect(binding).toMatchObject({
      status: "diverged",
      ownership: { operationId: id, dispatchId, executionAttemptId },
      interruption: { reason: "lease_lost", resumable: false }
    });
    const runsDir = join(
      fixture.workspace.init.workspace.resultsDir,
      "T-001",
      "blocks",
      "B-001",
      "runs"
    );
    for (let replay = 0; replay < 2; replay++) {
      await expect(fixture.reconcile()).resolves.toMatchObject([
        { operation: { id, dispatchId, executionAttemptId }, status: "wait_for_action" }
      ]);
    }
    expect(fixture.operations.getRequired(id)).toEqual(interrupted);
    expect(await fixture.runtime.query({ ref: blockRef, operationId: id })).toEqual(binding);
    expect((await readdir(runsDir)).filter((entry) => /^RUN-\d+$/.test(entry))).toEqual([
      "RUN-001"
    ]);
    expect(fixture.mailbox.listAfter(hostId, 0)).toEqual([]);

    fixture.remoteAgents.grantWorkspace({
      endpointId,
      workspaceId,
      grantedByHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
    });
    await fixture.coordinator.executeAction({
      actionId: "retry-denied-unpublished-execution",
      operationId: id,
      dispatchId,
      executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "retry_new_attempt",
      priorLeaseId: leaseId,
      newDispatchId: "dispatch-after-grant-restoration",
      newExecutionAttemptId: "attempt-after-grant-restoration",
      reason: "Workspace grant restored"
    });
    expect(fixture.operations.getRequired(id)).toMatchObject({
      state: "activated",
      executionAttemptId: "attempt-after-grant-restoration"
    });
    expect(fixture.mailbox.listAfter(hostId, 0)).toMatchObject([
      {
        command: {
          type: "execute_block",
          dispatchId: "dispatch-after-grant-restoration",
          executionAttemptId: "attempt-after-grant-restoration"
        }
      }
    ]);
  });

  it.each([
    false,
    true
  ])("does not replay an admission-denied retry after a newer attempt (failed compensation: %s)", async (failCompensation) => {
    let revokeGrant: (() => void) | undefined;
    const fixture = await setup(true, undefined, 1, {
      reached(point) {
        if (point === "after_runtime_binding") revokeGrant?.();
      }
    });
    if (!fixture.host) throw new Error("expected_test_host");
    const hostId = fixture.host.id;
    const workspaceId = fixture.locator.workspaceId;
    const endpointId = endpointIdFor({ hostId, profileId: "codex-acp", agentId: "codex" });
    ensureTestHumanPrincipal(fixture.server.database, MEMBER_ID, "Workspace Member");
    addWorkspaceMember(fixture.server.database, workspaceId, MEMBER_ID, "member");
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "retry-denied-at-admission",
      agentEndpointId: endpointId,
      callerHumanPrincipalId: MEMBER_ID
    });
    const first = await fixture.coordinator.dispatch(request);
    const prior = await interruptOperation(fixture, first.operation.id, "before-retry");
    const retry = (operation: RemoteOperation, suffix: string) => ({
      actionId: `retry-action-${suffix}`,
      operationId: operation.id,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      expectedAttemptVersion: operation.attempt.stateVersion,
      kind: "retry_new_attempt",
      priorLeaseId: operation.attempt.leaseId,
      newDispatchId: `retry-dispatch-${suffix}`,
      newExecutionAttemptId: `retry-attempt-${suffix}`,
      reason: "Try a new execution"
    });
    const denied = retry(prior, "denied");
    const expectedError = new RemoteAgentAuthorizationError("remote_agent_workspace_grant_missing");
    revokeGrant = () => {
      fixture.remoteAgents.revokeGrant({ endpointId, workspaceId });
      revokeGrant = undefined;
    };
    if (failCompensation) {
      vi.spyOn(fixture.runtime, "markInterrupted").mockRejectedValueOnce(
        new Error("injected_retry_compensation_failure")
      );
      await expect(fixture.coordinator.executeAction(denied)).rejects.toThrow(
        "injected_retry_compensation_failure"
      );
    } else {
      await expect(fixture.coordinator.executeAction(denied)).rejects.toThrow(expectedError);
    }
    const deniedAttempt = fixture.operations.getRequired(prior.id);
    expect(deniedAttempt).toMatchObject({
      state: "interrupted",
      dispatchId: denied.newDispatchId,
      executionAttemptId: denied.newExecutionAttemptId
    });
    if (!deniedAttempt.attempt.leaseId) throw new Error("expected_test_reservation");
    expect(fixture.reservations.getRequired(deniedAttempt.attempt.leaseId).status).toBe("expired");
    expect(fixture.dispatches.getRequired(denied.newDispatchId)).toMatchObject({
      status: "interrupted",
      interruption: { reason: "lease_lost", resumable: false }
    });
    if (failCompensation) {
      await expect(fixture.reconcile()).resolves.toMatchObject([{ status: "wait_for_action" }]);
      await expect(
        fixture.runtime.query({ ref: request.blockRef, operationId: prior.id })
      ).resolves.toMatchObject({
        status: "diverged",
        ownership: {
          dispatchId: denied.newDispatchId,
          executionAttemptId: denied.newExecutionAttemptId
        }
      });
    }
    fixture.remoteAgents.grantWorkspace({
      endpointId,
      workspaceId,
      grantedByHumanPrincipalId: TEST_REMOTE_AGENT_OWNER_ID
    });
    const next = retry(deniedAttempt, "next");
    await expect(fixture.coordinator.executeAction(next)).resolves.toMatchObject({
      state: "settled"
    });
    await expect(
      fixture.runtime.query({ ref: request.blockRef, operationId: prior.id })
    ).resolves.toMatchObject({
      status: "in_progress",
      ownership: {
        dispatchId: next.newDispatchId,
        executionAttemptId: next.newExecutionAttemptId
      }
    });
    const interrupted = await interruptOperation(fixture, prior.id, "after-next-retry");
    for (let replay = 0; replay < 2; replay++) {
      await expect(fixture.reconcile()).resolves.toMatchObject([
        { operation: { dispatchId: next.newDispatchId }, status: "wait_for_action" }
      ]);
      const replayed = fixture.coordinator.executeAction(denied);
      await expect(replayed).rejects.toBeInstanceOf(RemoteAgentAuthorizationError);
      await expect(replayed).rejects.toThrow(expectedError);
    }
    expect(fixture.operations.getRequired(prior.id)).toEqual(interrupted);
    await expect(
      fixture.runtime.query({ ref: request.blockRef, operationId: prior.id })
    ).resolves.toMatchObject({
      status: "diverged",
      ownership: {
        dispatchId: next.newDispatchId,
        executionAttemptId: next.newExecutionAttemptId
      }
    });
    expect(fixture.mailbox.listAfter(hostId, 0).map(({ command }) => command.dispatchId)).toEqual([
      first.operation.dispatchId,
      next.newDispatchId
    ]);
    await expect(fixture.coordinator.reconcileActions()).resolves.toEqual([]);
  });

  it.each([
    { revokeAt: "runtime_binding", retry: false, failure: "none" },
    { revokeAt: "runtime_binding", retry: false, failure: "persistence" },
    { revokeAt: "runtime_binding", retry: false, failure: "compensation" },
    { revokeAt: "before_recovery", retry: true, failure: "none" },
    { revokeAt: "acquiring_runtime", retry: true, failure: "none" }
  ])("handles a revoked Host during batched admission ($revokeAt, retry=$retry, failure=$failure)", async ({
    revokeAt,
    retry,
    failure
  }) => {
    let preparationCheckpoint: "after_dispatch_persistence" | "after_operation_commit" | undefined;
    let revokeHost: (() => void) | undefined;
    let blockedHostId: string | undefined;
    let revokeOnAcquire = false;
    const fixture = await setup(
      true,
      remoteManifest(true),
      1,
      {
        reached(point) {
          if (point === preparationCheckpoint) {
            throw new RemoteCoordinatorCheckpointCrash(point);
          }
          if (point === "after_runtime_binding" && revokeAt === "runtime_binding") revokeHost?.();
        }
      },
      (targetHostId) => {
        if (targetHostId !== blockedHostId) return;
        if (revokeOnAcquire && revokeHost) {
          revokeHost();
          throw new CanvasRuntimeRpcError("canvas_runtime_host_revoked", false, false);
        }
        throw new CanvasRuntimeUnavailableError("host_offline");
      }
    );
    if (!fixture.host) throw new Error("expected_test_host");
    const hostId = fixture.host.id;
    const workspaceId = fixture.locator.workspaceId;
    const healthyHost = fixture.hosts.register("Healthy Coordinator Host").host;
    ownHostRemoteAgents({ database: fixture.server.database, hostId: healthyHost.id });
    fixture.hosts.bindToWorkspace(healthyHost.id, workspaceId);
    fixture.hosts.reportOnline(
      healthyHost.id,
      ["acp.codex", WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
      1,
      {
        workspaceMappings: [{ workspaceId, status: "ready" }],
        acpProfiles: [
          {
            profileId: "codex-acp",
            agentId: "codex",
            displayName: "Healthy Agent",
            status: "ready",
            capabilities: ["acp.codex"]
          }
        ]
      }
    );
    const requestFor = (blockRef: string, targetHostId: string) =>
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.dispatchLocator,
        blockRef,
        idempotencyKey: `recover-${blockRef}`,
        agentEndpointId: endpointIdFor({
          hostId: targetHostId,
          profileId: "codex-acp",
          agentId: "codex"
        })
      });
    const prepare = async (
      blockRef: string,
      targetHostId: string,
      checkpoint: typeof preparationCheckpoint
    ) => {
      preparationCheckpoint = checkpoint;
      const request = requestFor(blockRef, targetHostId);
      await expect(fixture.coordinator.dispatch(request)).rejects.toThrow(
        `injected_crash:${checkpoint}`
      );
      const operation = fixture.operations.findByCallerIdentity(request);
      if (!operation) throw new Error("expected_test_operation");
      return operation;
    };
    let retryRequest:
      | Extract<RemoteExecutionActionRequest, { kind: "retry_new_attempt" }>
      | undefined;
    let prior: RemoteOperation | undefined;
    let denied: RemoteOperation;
    const actions = new RemoteExecutionActionRepository(fixture.server.database);
    if (retry) {
      const initial = await fixture.coordinator.dispatch(requestFor("T-001#B-001", hostId));
      prior = await interruptOperation(fixture, initial.operation.id, "before-revoked-host-retry");
      if (!prior.attempt.leaseId) throw new Error("expected_test_prior_reservation");
      retryRequest = {
        actionId: "retry-before-host-revocation",
        operationId: prior.id,
        dispatchId: prior.dispatchId,
        executionAttemptId: prior.executionAttemptId,
        expectedAttemptVersion: prior.attempt.stateVersion,
        kind: "retry_new_attempt",
        priorLeaseId: prior.attempt.leaseId,
        newDispatchId: "dispatch-retry-revoked-host",
        newExecutionAttemptId: "attempt-retry-revoked-host",
        reason: "Try a new execution"
      };
      preparationCheckpoint = "after_dispatch_persistence";
      await expect(fixture.coordinator.executeAction(retryRequest)).rejects.toThrow(
        "injected_crash:after_dispatch_persistence"
      );
      denied = fixture.operations.getRequired(prior.id);
      expect(denied).toMatchObject({
        state: "reserved",
        dispatchId: retryRequest.newDispatchId,
        executionAttemptId: retryRequest.newExecutionAttemptId
      });
      expect(actions.getRequired(retryRequest.actionId).state).toBe("recorded");
      await expect(
        fixture.runtime.query({ ref: denied.blockRef, operationId: prior.id })
      ).resolves.toMatchObject({
        status: "in_progress",
        ownership: { dispatchId: denied.dispatchId, executionAttemptId: denied.executionAttemptId }
      });
    } else {
      denied = await prepare("T-001#B-001", hostId, "after_dispatch_persistence");
    }
    const healthy = await prepare("T-002#B-001", healthyHost.id, "after_operation_commit");
    const leaseId = denied.attempt.leaseId;
    if (!leaseId) throw new Error("expected_test_reservation");
    expect(fixture.operations.listNonTerminal().map(({ id }) => id)).toEqual([
      denied.id,
      healthy.id
    ]);
    preparationCheckpoint = undefined;
    revokeHost = () => {
      fixture.hosts.revoke(hostId);
      revokeHost = undefined;
    };
    if (revokeAt === "before_recovery") revokeHost();
    if (revokeAt !== "runtime_binding") blockedHostId = hostId;
    revokeOnAcquire = revokeAt === "acquiring_runtime";
    const priorMailbox = fixture.mailbox.listAfter(hostId, 0);
    const { id, blockRef, dispatchId, executionAttemptId } = denied;
    if (failure === "persistence") {
      fixture.server.database.exec(`
          CREATE TRIGGER reject_interruption BEFORE UPDATE OF status ON dispatches
          WHEN NEW.status='interrupted'
          BEGIN SELECT RAISE(ABORT, 'injected_admission_persistence_failure'); END;
        `);
      await expect(fixture.reconcile()).rejects.toThrow("injected_admission_persistence_failure");
      expect(fixture.operations.getRequired(id).state).toBe("reserved");
      expect(fixture.reservations.getRequired(leaseId).status).toBe("active");
      expect(fixture.mailbox.listAfter(healthyHost.id, 0)).toEqual([]);
    } else {
      if (failure === "compensation") {
        const conflict = new RemoteOwnershipConflictError(
          "remote_ownership_activation_conflict",
          "Runtime ownership changed before interruption."
        );
        vi.spyOn(fixture.runtime, "markInterrupted").mockRejectedValueOnce(conflict);
        await expect(fixture.reconcile()).rejects.toMatchObject({ cause: conflict });
        expect(fixture.operations.getRequired(id).state).toBe("interrupted");
        expect(fixture.reservations.getRequired(leaseId).status).toBe("expired");
        expect(fixture.mailbox.listAfter(healthyHost.id, 0)).toEqual([]);
      }
      const outcomes = await fixture.reconcile().catch((error) => {
        if (retryRequest) {
          actions.releaseApplicationClaimIfOwned(
            retryRequest.actionId,
            fixture.server.serverInstanceOwnerToken
          );
        }
        throw error;
      });
      expect(outcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "activated",
            operation: expect.objectContaining({ id: healthy.id })
          })
        ])
      );
      expect(fixture.operations.getRequired(id)).toMatchObject({
        state: "interrupted",
        dispatchId,
        executionAttemptId
      });
      expect(fixture.reservations.getRequired(leaseId).status).toBe("expired");
      expect(fixture.reservations.activeCountsForHosts([hostId]).get(hostId)).toBe(0);
      expect(fixture.dispatches.getRequired(dispatchId)).toMatchObject({
        status: "interrupted",
        interruption: { reason: "lease_lost", resumable: false }
      });
      expect(fixture.operations.latestDiagnostic(id)?.error?.code).toBe("agent_endpoint_unknown");
      if (retryRequest && prior) {
        expect(actions.getRequired(retryRequest.actionId).state).toBe("settled");
        const replay = fixture.coordinator.executeAction(retryRequest);
        await expect(replay).rejects.toBeInstanceOf(AgentEndpointCatalogError);
        await expect(replay).rejects.toMatchObject({ code: "agent_endpoint_unknown" });
        if (!prior.attempt.leaseId) throw new Error("expected_test_prior_reservation");
        expect(fixture.reservations.getRequired(prior.attempt.leaseId).status).toBe("expired");
        expect(fixture.dispatches.getRequired(prior.dispatchId).interruption?.reason).toBe(
          "acp_session_lost"
        );
        await expect(
          fixture.runtime.query({ ref: blockRef, operationId: id })
        ).resolves.toMatchObject({
          status: "in_progress",
          ownership: { dispatchId, executionAttemptId }
        });
        await fixture.reconcile();
        expect(fixture.operations.latestDiagnostic(id)?.error?.code).toBe("agent_endpoint_unknown");
        blockedHostId = undefined;
        await fixture.reconcile();
      }
      await expect(
        fixture.runtime.query({ ref: blockRef, operationId: id })
      ).resolves.toMatchObject({
        status: "diverged",
        ownership: { dispatchId, executionAttemptId }
      });
      await fixture.reconcile();
      expect(fixture.operations.latestDiagnostic(id)?.error?.code).toBe("agent_endpoint_unknown");
      expect(fixture.mailbox.listAfter(healthyHost.id, 0)).toMatchObject([
        { command: { type: "execute_block", dispatchId: healthy.dispatchId } }
      ]);
    }
    expect(fixture.mailbox.listAfter(hostId, 0)).toEqual(priorMailbox);
  });

  it("re-authorizes retry_new_attempt against current grants after revoke", async () => {
    const fixture = await setup(true);
    ensureTestHumanPrincipal(fixture.server.database, MEMBER_ID, "Workspace Member");
    addWorkspaceMember(fixture.server.database, fixture.locator.workspaceId, MEMBER_ID, "member");
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "retry-after-grant-revoke",
      callerHumanPrincipalId: MEMBER_ID
    });
    const dispatched = await fixture.coordinator.dispatch(request);
    const interrupted = await interruptOperation(
      fixture,
      dispatched.operation.id,
      request.idempotencyKey
    );
    const endpointId = interrupted.endpointSelection?.endpointId;
    if (!endpointId) throw new Error("expected_endpoint_selection");
    new RemoteAgentRepository(fixture.server.database).revokeGrant({
      endpointId,
      workspaceId: fixture.locator.workspaceId
    });

    await expect(
      fixture.coordinator.executeAction({
        actionId: "retry-after-grant-revoke-action",
        operationId: interrupted.id,
        dispatchId: interrupted.dispatchId,
        executionAttemptId: interrupted.executionAttemptId,
        expectedAttemptVersion: interrupted.attempt.stateVersion,
        kind: "retry_new_attempt",
        priorLeaseId: interrupted.attempt.leaseId,
        newDispatchId: "dispatch-retry-after-grant-revoke",
        newExecutionAttemptId: "attempt-retry-after-grant-revoke",
        reason: "retry must re-check current grant"
      })
    ).rejects.toMatchObject({ code: "remote_agent_workspace_grant_missing" });
    const hostId = interrupted.attempt.hostId;
    if (!hostId) throw new Error("expected_test_host");
    const originalMailbox = fixture.mailbox.listAfter(hostId, 0);
    await expect(fixture.reconcile()).resolves.toMatchObject([{ status: "wait_for_action" }]);
    expect(fixture.operations.getRequired(interrupted.id)).toMatchObject({
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      attempt: { stateVersion: interrupted.attempt.stateVersion }
    });
    expect(fixture.operations.latestDiagnostic(interrupted.id)).toMatchObject({
      error: { code: "remote_agent_workspace_grant_missing", retryable: false }
    });
    expect(fixture.mailbox.listAfter(hostId, 0)).toEqual(originalMailbox);
  });

  it("rejects a different principal reusing the same idempotency key", async () => {
    const fixture = await setup(true);
    ensureTestHumanPrincipal(fixture.server.database, MEMBER_ID, "Workspace Member");
    addWorkspaceMember(fixture.server.database, fixture.locator.workspaceId, MEMBER_ID, "member");
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "shared-idempotency-key"
    });
    await fixture.coordinator.dispatch(request);
    const intruder = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "shared-idempotency-key",
      callerHumanPrincipalId: MEMBER_ID
    });
    await expect(fixture.coordinator.dispatch(intruder)).rejects.toThrow(
      "remote_operation_idempotency_conflict"
    );
  });

  it("reenters the same idempotency key after the caller identity is merged", async () => {
    const fixture = await setup(true);
    const canonicalId = "test-remote-agent-owner-canonical";
    ensureTestHumanPrincipal(fixture.server.database, canonicalId, "Canonical Owner");
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "merged-caller-idempotency"
    });
    const first = await fixture.coordinator.dispatch(request);
    const identities = new HumanIdentityCredentialStore(fixture.server.database, () => new Date());
    const tokenOwner = identities.issue(TEST_REMOTE_AGENT_OWNER_ID);
    const tokenCanonical = identities.issue(canonicalId);
    identities.merge(tokenOwner.identityToken, tokenCanonical.identityToken);
    const retried = await fixture.coordinator.dispatch({
      ...request,
      callerHumanPrincipalId: canonicalId
    });
    expect(retried.operation.id).toBe(first.operation.id);
    expect(retried.operation.agentAccess?.callerHumanPrincipalId).toBe(TEST_REMOTE_AGENT_OWNER_ID);
  });

  it("fails closed when retry_new_attempt has no agent access snapshot", async () => {
    const fixture = await setup(true);
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.dispatchLocator,
      blockRef: "T-001#B-001",
      idempotencyKey: "retry-missing-access"
    });
    const dispatched = await fixture.coordinator.dispatch(request);
    const interrupted = await interruptOperation(
      fixture,
      dispatched.operation.id,
      request.idempotencyKey
    );
    fixture.server.database
      .prepare("UPDATE remote_operations SET agent_access_json=NULL WHERE id=?")
      .run(interrupted.id);

    await expect(
      fixture.coordinator.executeAction({
        actionId: "retry-missing-access-action",
        operationId: interrupted.id,
        dispatchId: interrupted.dispatchId,
        executionAttemptId: interrupted.executionAttemptId,
        expectedAttemptVersion: interrupted.attempt.stateVersion,
        kind: "retry_new_attempt",
        priorLeaseId: interrupted.attempt.leaseId,
        newDispatchId: "dispatch-retry-missing-access",
        newExecutionAttemptId: "attempt-retry-missing-access",
        reason: "pre-v59 operations cannot start a new attempt"
      })
    ).rejects.toThrow(new RemoteAgentAuthorizationError("remote_agent_access_snapshot_missing"));
    expect(fixture.operations.getRequired(interrupted.id)).toMatchObject({
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      attempt: { stateVersion: interrupted.attempt.stateVersion }
    });
  });
});
