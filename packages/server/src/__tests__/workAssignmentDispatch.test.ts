import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { startPlanweaveServer } from "../lifecycle.js";
import {
  createAssignmentDispatchGate,
  resolveDispatchAssignment
} from "../work/dispatchIntegration.js";
import {
  deferred,
  registerWorkAssignmentTestDirectory,
  registerWorkAssignmentTestServer,
  remoteManifest,
  setup
} from "./workAssignmentDispatchFixture.js";
describe("assignment × dispatch integration (HC-002#B-003)", () => {
  it("revalidates exact Host authorization, revocation, readiness, and capabilities at dispatch", async () => {
    const fixture = await setup({ strictGate: true });
    const hostId = fixture.hosts[0]!.id;
    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });

    let facts = {
      workspaceId: fixture.workspaceId,
      projectId: fixture.locator.projectId,
      hostId,
      exists: true,
      revoked: false,
      authorizedForProject: false,
      online: true,
      ready: true,
      capabilities: ["acp.codex"]
    };
    const gate = createAssignmentDispatchGate({
      repository: fixture.workAssignments,
      hostPort: {
        getHostFacts: () => facts,
        listHostFacts: () => [],
        listEligibleHostProjections: () => []
      },
      defaultAllowHumanOverride: false
    });
    const resolve = () =>
      gate.resolve({
        workspaceId: fixture.workspaceId,
        projectId: fixture.locator.projectId,
        canvasId: "default",
        blockRef: "T-001#B-001",
        requiredCapabilities: ["acp.codex"],
        agentId: "codex",
        agentProfileId: "codex-acp"
      });
    const expectDenied = (code: string) => {
      try {
        resolve();
        expect.fail(`expected ${code}`);
      } catch (error) {
        expect(error).toMatchObject({ code });
      }
    };

    expectDenied("work_host_not_authorized");
    facts = { ...facts, authorizedForProject: true, revoked: true };
    expectDenied("work_host_revoked");
    facts = { ...facts, revoked: false, ready: false };
    expectDenied("work_host_not_ready");
    facts = { ...facts, ready: true, capabilities: [] };
    expectDenied("work_host_capability_mismatch");
  });

  it("uses automatic selection against package capabilities with the deterministic selector", async () => {
    const fixture = await setup({
      withHosts: [
        { name: "Busy First", capabilities: ["acp.codex"], capacity: 1 },
        { name: "Free Second", capabilities: ["acp.codex"], capacity: 1 }
      ]
    });
    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "automatic_host" },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });

    const pure = resolveDispatchAssignment(fixture.workAssignments, {
      workspaceId: fixture.workspaceId,
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      packageFacts: {
        canvasId: "default",
        kind: "block",
        exists: true,
        blockRef: "T-001#B-001",
        requiredCapabilities: ["acp.codex"]
      }
    });
    expect(pure).toMatchObject({
      ok: true,
      snapshot: { selection: "automatic", preferredHostId: undefined }
    });
  });

  it("projects batch Task/Block assignment views with availability and active dispatch", async () => {
    const fixture = await setup();
    const hostId = fixture.hosts[0]!.id;

    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: { kind: "task", canvasId: "default", taskId: "T-001" },
      target: { kind: "human", humanPrincipalId: fixture.ownerContext.humanPrincipalId },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });
    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });

    const operation = await fixture.seedLegacyOperation("project-batch", {
      workspaceId: fixture.workspaceId,
      assignmentRevision: 1,
      target: { kind: "exact_host", hostId },
      selection: "exact",
      preferredHostId: hostId,
      requiredCapabilities: ["acp.codex"]
    });
    const dispatched = await fixture.coordination.coordinator.reenter(operation.id);
    expect(dispatched.status).toBe("activated");

    const batch = await fixture.assignmentService.listAssignments(
      fixture.ownerContext,
      fixture.locator.projectId,
      {
        workItems: [{ kind: "task", canvasId: "default", taskId: "T-001" }, fixture.blockItem]
      }
    );
    expect(batch.items).toHaveLength(2);
    const taskProjection = batch.items.find((item) => item.workItem.kind === "task");
    const blockProjection = batch.items.find((item) => item.workItem.kind === "block");
    expect(taskProjection).toMatchObject({
      target: { kind: "human", humanPrincipalId: fixture.ownerContext.humanPrincipalId },
      human: { membershipActive: true },
      availability: { status: "ready" },
      activeDispatch: { present: false }
    });
    expect(blockProjection).toMatchObject({
      target: { kind: "exact_host", hostId },
      host: { hostId, online: true, capabilitiesSatisfied: true },
      availability: { status: "ready" },
      activeDispatch: {
        present: true,
        hostId,
        dispatchId: dispatched.operation.dispatchId
      }
    });
  });

  it("keeps assignment and reservation transactions separate under concurrent CAS", async () => {
    const fixture = await setup({
      withHosts: [
        { name: "Host A", capabilities: ["acp.codex"], capacity: 1 },
        { name: "Host B", capabilities: ["acp.codex"], capacity: 1 }
      ]
    });
    const hostA = fixture.hosts[0]!;
    const hostB = fixture.hosts[1]!;

    const first = await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostA.id },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });

    // Concurrent CAS loser does not touch dispatch.
    await expect(
      fixture.assignmentService.updateAssignment({
        projectId: fixture.locator.projectId,
        workItem: fixture.blockItem,
        target: { kind: "exact_host", hostId: hostB.id },
        expectedRevision: 0,
        actor: fixture.ownerContext
      })
    ).rejects.toThrowError(/revision|conflict/i);

    const stillA = fixture.workAssignments.get(
      fixture.workspaceId,
      fixture.locator.projectId,
      fixture.blockItem
    );
    expect(stillA?.target).toEqual({ kind: "exact_host", hostId: hostA.id });
    expect(stillA?.revision).toBe(first.record.revision);
  });

  it("retry_new_attempt revalidates current assignment and resnapshots host selection", async () => {
    const fixture = await setup({
      projectActivity: true,
      withHosts: [
        { name: "Host A", capabilities: ["acp.codex"], capacity: 1 },
        { name: "Host B", capabilities: ["acp.codex"], capacity: 1 }
      ]
    });
    const hostA = fixture.hosts[0]!;
    const hostB = fixture.hosts[1]!;

    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostA.id },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });

    const operation = await fixture.seedLegacyOperation("retry-revalidate", {
      workspaceId: fixture.workspaceId,
      assignmentRevision: 1,
      target: { kind: "exact_host", hostId: hostA.id },
      selection: "exact",
      preferredHostId: hostA.id,
      requiredCapabilities: ["acp.codex"]
    });
    const dispatched = await fixture.coordination.coordinator.reenter(operation.id);
    expect(dispatched.operation.attempt.hostId).toBe(hostA.id);
    expect(dispatched.operation.hostSelection).toMatchObject({
      selection: "exact",
      preferredHostId: hostA.id,
      assignmentRevision: 1
    });

    const dispatch = fixture.coordination.dispatches.getRequired(dispatched.operation.dispatchId);
    fixture.coordination.dispatches.accept(
      hostA.id,
      "retry-revalidate-accepted",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    fixture.coordination.dispatches.interrupt(hostA.id, "retry-revalidate-interrupted", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "retry-revalidate-interrupted",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "acp_session_lost",
      resumable: false
    });
    const lease = fixture.coordination.reservations.getRequired(dispatch.leaseId);
    fixture.coordination.reservations.release({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      reason: "expired"
    });
    await fixture.coordination.coordinator.reenter(dispatched.operation.id);

    // Reassignment before explicit retry: new attempt must follow current assignment, not A.
    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostB.id },
      expectedRevision: 1,
      actor: fixture.ownerContext
    });

    const interrupted = fixture.coordination.operations.getRequired(dispatched.operation.id);
    const maximalRetryDispatchId = "d".repeat(128);
    await fixture.coordination.coordinator.executeAction({
      actionId: "retry-revalidate-action",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "retry_new_attempt",
      priorLeaseId: dispatch.leaseId,
      newDispatchId: maximalRetryDispatchId,
      newExecutionAttemptId: "attempt-retry-revalidate-2",
      reason: "retry after reassignment to Host B"
    });

    const retried = fixture.coordination.operations.getRequired(dispatched.operation.id);
    expect(retried).toMatchObject({
      state: "activated",
      dispatchId: maximalRetryDispatchId,
      executionAttemptId: "attempt-retry-revalidate-2",
      hostSelection: {
        selection: "exact",
        preferredHostId: hostB.id,
        assignmentRevision: 2
      },
      attempt: { hostId: hostB.id }
    });
    expect(retried.hostSelection?.preferredHostId).not.toBe(hostA.id);
    expect(
      fixture.coordination.coordinator.getAuthorizedHostSelection(dispatched.operation.id)
    ).toMatchObject({
      preferredHostId: hostB.id,
      assignmentRevision: 2
    });

    const retryDispatch = fixture.coordination.dispatches.getRequired(maximalRetryDispatchId);
    expect(
      fixture.coordination.dispatches.accept(
        hostB.id,
        "retry-revalidate-max-id-accepted",
        retryDispatch.id,
        retryDispatch.leaseId,
        retryDispatch.executionAttemptId
      ).status
    ).toBe("running");
    if (!fixture.activity) throw new Error("activity_projection_not_configured");
    const retryActivity = fixture.activity
      .list({ projectId: fixture.locator.projectId, limit: 20 })
      .filter((record) => record.summary.dispatchId === maximalRetryDispatchId);
    expect(retryActivity).toHaveLength(1);
    expect(retryActivity[0]).toMatchObject({ type: "remote_run_started" });
    expect(retryActivity[0]?.source.sourceId).toMatch(/^remote_run:v1:[0-9a-f]{64}$/);
    expect(retryActivity[0]?.source.sourceId.length).toBeLessThanOrEqual(128);
    expect(
      fixture.server.database
        .prepare("SELECT 1 FROM host_event_receipts WHERE message_id=?")
        .get("retry-revalidate-max-id-accepted")
    ).toBeDefined();
  });

  it("keeps one retry decision authoritative while assignment changes concurrently", async () => {
    const retryEntered = deferred();
    const resumeRetry = deferred();
    const fixture = await setup({
      withHosts: [{ name: "Host A", capabilities: ["acp.codex"], capacity: 1 }],
      decorateRuntime: (runtime) => ({
        ...runtime,
        retryAttempt: async (input) => {
          retryEntered.resolve();
          await resumeRetry.promise;
          return runtime.retryAttempt(input);
        }
      })
    });
    const hostA = fixture.hosts[0]!;
    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostA.id },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });
    const operation = await fixture.seedLegacyOperation("retry-concurrent-assignment", {
      workspaceId: fixture.workspaceId,
      assignmentRevision: 1,
      target: { kind: "exact_host", hostId: hostA.id },
      selection: "exact",
      preferredHostId: hostA.id,
      requiredCapabilities: ["acp.codex"]
    });
    const dispatched = await fixture.coordination.coordinator.reenter(operation.id);
    const dispatch = fixture.coordination.dispatches.getRequired(dispatched.operation.dispatchId);
    fixture.coordination.dispatches.accept(
      hostA.id,
      "retry-concurrent-accepted",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    fixture.coordination.dispatches.interrupt(hostA.id, "retry-concurrent-interrupted", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "retry-concurrent-interrupted",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "acp_session_lost",
      resumable: false
    });
    const lease = fixture.coordination.reservations.getRequired(dispatch.leaseId);
    fixture.coordination.reservations.release({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      reason: "expired"
    });
    await fixture.coordination.coordinator.reenter(dispatched.operation.id);
    const interrupted = fixture.coordination.operations.getRequired(dispatched.operation.id);
    const action = {
      actionId: "retry-concurrent-assignment-action",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "retry_new_attempt" as const,
      priorLeaseId: dispatch.leaseId,
      newDispatchId: "dispatch-retry-concurrent-2",
      newExecutionAttemptId: "attempt-retry-concurrent-2",
      reason: "retry while assignment changes"
    };

    const winner = fixture.coordination.coordinator.executeAction(action);
    await retryEntered.promise;
    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "human", humanPrincipalId: fixture.ownerContext.humanPrincipalId },
      expectedRevision: 1,
      actor: fixture.ownerContext
    });
    const competingCoordinator = fixture.rebuildCoordination();
    await expect(competingCoordinator.coordinator.executeAction(action)).rejects.toThrow(
      "remote_action_in_progress"
    );
    expect(fixture.coordination.actions.getRequired(action.actionId)).toMatchObject({
      state: "recorded",
      rejectionCode: undefined
    });

    resumeRetry.resolve();
    await expect(winner).resolves.toMatchObject({ state: "settled" });
    expect(fixture.coordination.actions.getRequired(action.actionId)).toMatchObject({
      state: "settled",
      rejectionCode: undefined
    });
    expect(
      fixture.server.database
        .prepare(
          "SELECT COUNT(*) AS count FROM remote_execution_attempts WHERE execution_attempt_id=?"
        )
        .get(action.newExecutionAttemptId)?.count
    ).toBe(1);
  });

  it("reuses the exact Host plan after Runtime retry succeeds before the DB step fails", async () => {
    const fixture = await setup({
      withHosts: [{ name: "Host A", capabilities: ["acp.codex"], capacity: 1 }]
    });
    const hostA = fixture.hosts[0]!;
    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostA.id },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });
    const legacyOperation = await fixture.seedLegacyOperation("retry-runtime-only-failure", {
      workspaceId: fixture.workspaceId,
      assignmentRevision: 1,
      target: { kind: "exact_host", hostId: hostA.id },
      selection: "exact",
      preferredHostId: hostA.id,
      requiredCapabilities: ["acp.codex"]
    });
    const dispatched = await fixture.coordination.coordinator.reenter(legacyOperation.id);
    const dispatch = fixture.coordination.dispatches.getRequired(dispatched.operation.dispatchId);
    fixture.coordination.dispatches.accept(
      hostA.id,
      "retry-runtime-only-accepted",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    fixture.coordination.dispatches.interrupt(hostA.id, "retry-runtime-only-interrupted", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "retry-runtime-only-interrupted",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "acp_session_lost",
      resumable: false
    });
    const lease = fixture.coordination.reservations.getRequired(dispatch.leaseId);
    fixture.coordination.reservations.release({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      reason: "expired"
    });
    await fixture.coordination.coordinator.reenter(dispatched.operation.id);
    const interrupted = fixture.coordination.operations.getRequired(dispatched.operation.id);
    const action = {
      actionId: "retry-runtime-only-action",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "retry_new_attempt" as const,
      priorLeaseId: dispatch.leaseId,
      newDispatchId: "dispatch-retry-runtime-only-2",
      newExecutionAttemptId: "attempt-retry-runtime-only-2",
      reason: "retry after Runtime-only partial effect"
    };
    const operations = fixture.coordination.operations;
    const persistRetry = operations.retryAttempt.bind(operations);
    let failDatabaseStep = true;
    operations.retryAttempt = (input) => {
      if (failDatabaseStep) {
        failDatabaseStep = false;
        throw new Error("injected_retry_database_failure");
      }
      return persistRetry(input);
    };

    await expect(fixture.coordination.coordinator.executeAction(action)).rejects.toThrow(
      "injected_retry_database_failure"
    );
    expect(
      await fixture.runtime.query({ ref: interrupted.blockRef, operationId: interrupted.id })
    ).toMatchObject({
      ownership: {
        dispatchId: action.newDispatchId,
        executionAttemptId: action.newExecutionAttemptId
      }
    });
    expect(fixture.coordination.operations.getRequired(interrupted.id)).toMatchObject({
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId
    });
    const pendingAction = fixture.server.database
      .prepare(
        `SELECT application_owner_token,application_claimed_at,application_decision_json
         FROM remote_execution_actions WHERE action_id=?`
      )
      .get(action.actionId);
    expect(pendingAction).toMatchObject({
      application_owner_token: null,
      application_claimed_at: null
    });
    expect(JSON.parse(String(pendingAction?.application_decision_json))).toMatchObject({
      context: { preferredHostId: hostA.id, assignmentRevision: 1 }
    });

    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "human", humanPrincipalId: fixture.ownerContext.humanPrincipalId },
      expectedRevision: 1,
      actor: fixture.ownerContext
    });
    const recovered = fixture.rebuildCoordination();
    await expect(recovered.coordinator.executeAction(action)).resolves.toMatchObject({
      state: "settled"
    });

    const operation = recovered.operations.getRequired(interrupted.id);
    expect(operation).toMatchObject({
      dispatchId: action.newDispatchId,
      executionAttemptId: action.newExecutionAttemptId,
      hostSelection: {
        preferredHostId: hostA.id,
        assignmentRevision: 1
      },
      attempt: { hostId: hostA.id }
    });
    expect(operation.hostSelection?.target).toEqual({ kind: "exact_host", hostId: hostA.id });
    expect(recovered.actions.getRequired(action.actionId).state).toBe("settled");
    if (!operation.attempt.leaseId) throw new Error("recovered_attempt_not_reserved");
    const reservation = recovered.reservations.getRequired(operation.attempt.leaseId);
    expect(reservation).toMatchObject({ hostId: hostA.id, status: "active" });
  });

  it.each([
    "human",
    "unassigned"
  ] as const)("retry_new_attempt fails closed for %s assignment with the production default gate", async (targetKind) => {
    const fixture = await setup({
      withHosts: [{ name: "Host A", capabilities: ["acp.codex"], capacity: 1 }]
    });
    const hostA = fixture.hosts[0]!;

    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostA.id },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });

    const operation = await fixture.seedLegacyOperation(`retry-deny-${targetKind}`, {
      workspaceId: fixture.workspaceId,
      assignmentRevision: 1,
      target: { kind: "exact_host", hostId: hostA.id },
      selection: "exact",
      preferredHostId: hostA.id,
      requiredCapabilities: ["acp.codex"]
    });
    const dispatched = await fixture.coordination.coordinator.reenter(operation.id);
    const dispatch = fixture.coordination.dispatches.getRequired(dispatched.operation.dispatchId);
    fixture.coordination.dispatches.accept(
      hostA.id,
      "retry-deny-accepted",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    fixture.coordination.dispatches.interrupt(hostA.id, "retry-deny-interrupted", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "retry-deny-interrupted",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "acp_session_lost",
      resumable: false
    });
    const lease = fixture.coordination.reservations.getRequired(dispatch.leaseId);
    fixture.coordination.reservations.release({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      reason: "expired"
    });
    await fixture.coordination.coordinator.reenter(dispatched.operation.id);

    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target:
        targetKind === "human"
          ? { kind: "human", humanPrincipalId: fixture.ownerContext.humanPrincipalId }
          : { kind: "unassigned" },
      expectedRevision: 1,
      actor: fixture.ownerContext
    });

    const interrupted = fixture.coordination.operations.getRequired(dispatched.operation.id);
    const priorSelection = interrupted.hostSelection;
    const reservationCount = fixture.server.database
      .prepare("SELECT COUNT(*) AS count FROM host_capacity_reservations")
      .get()?.count;
    const actionId = `retry-deny-${targetKind}-action`;
    await expect(
      fixture.coordination.coordinator.executeAction({
        actionId,
        operationId: interrupted.id,
        dispatchId: interrupted.dispatchId,
        executionAttemptId: interrupted.executionAttemptId,
        expectedAttemptVersion: interrupted.attempt.stateVersion,
        kind: "retry_new_attempt",
        priorLeaseId: dispatch.leaseId,
        newDispatchId: `dispatch-retry-deny-${targetKind}-2`,
        newExecutionAttemptId: `attempt-retry-deny-${targetKind}-2`,
        reason: `retry should fail closed after ${targetKind} assignment`
      })
    ).rejects.toMatchObject({ code: "work_not_agent_assigned" });

    expect(fixture.coordination.actions.getRequired(actionId)).toMatchObject({
      state: "rejected",
      rejectionCode: "work_not_agent_assigned"
    });
    expect(fixture.coordination.actions.getRequired(actionId).rejectedAt).toBeDefined();
    expect(fixture.coordination.actions.listUnsettled()).not.toContainEqual(
      expect.objectContaining({ request: expect.objectContaining({ actionId }) })
    );

    const unchanged = fixture.coordination.operations.getRequired(dispatched.operation.id);
    expect(unchanged.dispatchId).toBe(interrupted.dispatchId);
    expect(unchanged.executionAttemptId).toBe(interrupted.executionAttemptId);
    expect(unchanged.hostSelection).toEqual(priorSelection);
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM host_capacity_reservations")
        .get()?.count
    ).toBe(reservationCount);

    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostA.id },
      expectedRevision: 2,
      actor: fixture.ownerContext
    });
    const restarted = fixture.rebuildCoordination();
    await expect(restarted.coordinator.reconcileActions()).resolves.toEqual([]);
    await expect(
      restarted.coordinator.executeAction({
        actionId,
        operationId: interrupted.id,
        dispatchId: interrupted.dispatchId,
        executionAttemptId: interrupted.executionAttemptId,
        expectedAttemptVersion: interrupted.attempt.stateVersion,
        kind: "retry_new_attempt",
        priorLeaseId: dispatch.leaseId,
        newDispatchId: `dispatch-retry-deny-${targetKind}-2`,
        newExecutionAttemptId: `attempt-retry-deny-${targetKind}-2`,
        reason: `retry should fail closed after ${targetKind} assignment`
      })
    ).rejects.toMatchObject({ code: "work_not_agent_assigned" });
    expect(
      fixture.server.database
        .prepare(
          "SELECT COUNT(*) AS count FROM remote_execution_attempts WHERE execution_attempt_id=?"
        )
        .get(`attempt-retry-deny-${targetKind}-2`)?.count
    ).toBe(0);
  });

  it("recovers historical null host_selection on reenter and persists a fresh snapshot", async () => {
    const fixture = await setup({
      withHosts: [
        { name: "Host A", capabilities: ["acp.codex"], capacity: 1 },
        { name: "Host B", capabilities: ["acp.codex"], capacity: 1 }
      ]
    });
    const hostA = fixture.hosts[0]!;
    const hostB = fixture.hosts[1]!;

    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostA.id },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });

    const partial = await fixture.seedLegacyOperation("legacy-null-selection");
    expect(partial.hostSelection).toBeUndefined();
    expect(partial.attempt.hostId).toBeUndefined();

    // Concurrent reassignment after upgrade: legacy null recovery revalidates current assignment.
    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostB.id },
      expectedRevision: 1,
      actor: fixture.ownerContext
    });

    const restarted = fixture.rebuildCoordination();
    const recovered = await restarted.coordinator.reenter(partial.id);
    expect(recovered.status).toBe("activated");
    expect(recovered.operation.attempt.hostId).toBe(hostB.id);
    expect(recovered.operation.hostSelection).toMatchObject({
      selection: "exact",
      preferredHostId: hostB.id,
      assignmentRevision: 2
    });
    // Durable row must be filled so a second restart does not re-resolve again.
    const durable = fixture.server.database
      .prepare("SELECT host_selection_json FROM remote_operations WHERE id=?")
      .get(partial.id) as { host_selection_json: string };
    expect(durable.host_selection_json).toContain(hostB.id);

    // Same-attempt reenter after another reassignment must keep the recovered snapshot (Host B).
    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "unassigned" },
      expectedRevision: 2,
      actor: fixture.ownerContext
    });
    const again = fixture.rebuildCoordination();
    const reentered = await again.coordinator.reenter(partial.id);
    expect(reentered.operation.attempt.hostId).toBe(hostB.id);
    expect(reentered.operation.hostSelection?.preferredHostId).toBe(hostB.id);
  });

  it("null host_selection recovery records assignment denial without aborting reenter", async () => {
    const fixture = await setup({
      strictGate: true,
      withHosts: [{ name: "Host A", capabilities: ["acp.codex"], capacity: 1 }]
    });
    const hostA = fixture.hosts[0]!;

    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostA.id },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });

    const partial = await fixture.seedLegacyOperation("legacy-null-deny");

    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "human", humanPrincipalId: fixture.ownerContext.humanPrincipalId },
      expectedRevision: 1,
      actor: fixture.ownerContext
    });

    const restarted = fixture.rebuildCoordination();
    await expect(restarted.coordinator.reenter(partial.id)).resolves.toMatchObject({
      status: "awaiting_host"
    });
    const row = fixture.server.database
      .prepare("SELECT diagnostic_code,state FROM remote_operations WHERE id=?")
      .get(partial.id) as { diagnostic_code: string; state: string };
    expect(row.diagnostic_code).toBe("work_not_agent_assigned");
    expect(row.state).toBe("claimed");
  });

  it("keeps durable exact Host selection after restart + reassignment before reserve", async () => {
    const fixture = await setup({
      withHosts: [
        { name: "Host A", capabilities: ["acp.codex"], capacity: 1 },
        { name: "Host B", capabilities: ["acp.codex"], capacity: 1 }
      ]
    });
    const hostA = fixture.hosts[0]!;
    const hostB = fixture.hosts[1]!;

    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostA.id },
      expectedRevision: 0,
      actor: fixture.ownerContext
    });

    const partial = await fixture.seedLegacyOperation("durable-selection-restart", {
      workspaceId: fixture.workspaceId,
      assignmentRevision: 1,
      target: { kind: "exact_host", hostId: hostA.id },
      selection: "exact",
      preferredHostId: hostA.id,
      requiredCapabilities: ["acp.codex"]
    });
    expect(partial.hostSelection).toMatchObject({
      selection: "exact",
      preferredHostId: hostA.id,
      assignmentRevision: 1
    });
    expect(partial.attempt.hostId).toBeUndefined();

    // Concurrent reassignment after commit, before reservation.
    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "unassigned" },
      expectedRevision: 1,
      actor: fixture.ownerContext
    });
    // Also exercise reassignment to another exact Host path on a fresh revision.
    await fixture.assignmentService.updateAssignment({
      projectId: fixture.locator.projectId,
      workItem: fixture.blockItem,
      target: { kind: "exact_host", hostId: hostB.id },
      expectedRevision: 2,
      actor: fixture.ownerContext
    });

    // Process restart: new coordinator loses in-memory map; must load durable fingerprint.
    const restarted = fixture.rebuildCoordination();
    expect(restarted.coordinator.getAuthorizedHostSelection(partial.id)).toMatchObject({
      preferredHostId: hostA.id,
      selection: "exact"
    });

    const recovered = await restarted.coordinator.reenter(partial.id);
    expect(recovered.status).toBe("activated");
    expect(recovered.operation.attempt.hostId).toBe(hostA.id);
    expect(recovered.operation.attempt.hostId).not.toBe(hostB.id);
    expect(restarted.coordinator.getAuthorizedHostSelection(partial.id)).toMatchObject({
      preferredHostId: hostA.id,
      selection: "exact",
      assignmentRevision: 1
    });

    fixture.server.database
      .prepare("UPDATE remote_operations SET host_selection_json=NULL WHERE id=?")
      .run(partial.id);
    expect(restarted.coordinator.getAuthorizedHostSelection(partial.id)).toBeUndefined();
  });
});

describe("HostReservationRepository preferred Host selection", () => {
  it("does not select an alternate Host when preferredHostId is set", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    registerWorkAssignmentTestDirectory(workspace.home);
    registerWorkAssignmentTestDirectory(workspace.root);
    const dataDirectory = join(workspace.root, "server-data");
    const server = await startPlanweaveServer({
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5_000
    });
    registerWorkAssignmentTestServer(server);

    const workspaceIdentity = new WorkspaceIdentityRepository(server.database);
    const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject("project-a");
    const hosts = new AgentHostRepository(server.database);
    const preferred = hosts.register("Preferred").host;
    const alternate = hosts.register("Alternate").host;
    hosts.bindToWorkspace(preferred.id, workspaceId);
    hosts.bindToWorkspace(alternate.id, workspaceId);
    hosts.reportOnline(preferred.id, ["linux"], 1, {
      workspaceMappings: [{ workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          status: "ready",
          capabilities: ["linux"]
        }
      ]
    });
    hosts.reportOnline(alternate.id, ["linux"], 1, {
      workspaceMappings: [{ workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          status: "ready",
          capabilities: ["linux"]
        }
      ]
    });
    // Make preferred offline.
    server.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", preferred.id);

    const { RemoteOperationRepository } = await import("../remoteOperations.js");
    const { HostReservationRepository } = await import("../hostReservations.js");
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });
    const operation = operations.markClaimed(
      operations.create({
        workspaceId,
        projectId: "project-a",
        canvasId: "default",
        blockRef: "T-001#B-001",
        ownershipGeneration: "gen-1",
        idempotencyKey: "pref-1",
        sourceFingerprint: "fp-1",
        requiredCapabilities: ["linux"]
      }).id
    );

    expect(() =>
      reservations.reserve(operation.id, {
        agentId: "codex",
        agentProfileId: "codex-acp",
        preferredHostId: preferred.id
      })
    ).toThrowError("no_compatible_agent_host");

    // Without preferred, automatic would pick alternate.
    const operation2 = operations.markClaimed(
      operations.create({
        workspaceId,
        projectId: "project-a",
        canvasId: "default",
        blockRef: "T-001#B-002",
        ownershipGeneration: "gen-1",
        idempotencyKey: "pref-2",
        sourceFingerprint: "fp-2",
        requiredCapabilities: ["linux"]
      }).id
    );
    const reserved = reservations.reserve(operation2.id, {
      agentId: "codex",
      agentProfileId: "codex-acp"
    });
    expect(reserved.hostId).toBe(alternate.id);
  });
});
