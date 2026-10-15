import { expect, it } from "vitest";
import { setupOperatorCas } from "./workspaceExecutionOperatorCasTestFixture.js";

it.each([
  false,
  true
])("refreshes an owner cancellation rejected by real Operator HTTP CAS, restart=%s", async (restart) => {
  const h = await setupOperatorCas();
  const first = h.create();
  const started = await first.start(h.input);
  if (started.handle.target !== "remote") throw new Error("remote_handle_required");
  const handle = started.handle;
  const operation = h.f.operations.getRequired(handle.operationId);
  const dispatch = h.f.dispatches.getRequired(operation.dispatchId);
  h.f.dispatches.accept(
    h.f.host.id,
    "host-started",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  const reservation = h.f.reservations.getRequired(dispatch.leaseId);
  h.f.reservations.transition({
    leaseId: dispatch.leaseId,
    fencingToken: reservation.fencingToken,
    expectedAttemptVersion: operation.attempt.stateVersion,
    status: "running"
  });
  const current = h.f.operations.getRequired(operation.id);
  expect(current.attempt.stateVersion).toBeGreaterThan(handle.attemptStateVersion!);
  const cancel = {
    ...h.input,
    sessionId: handle.runSessionId,
    actionId: "stop-stale",
    reason: "Desktop stop",
    expectedRemoteHandle: handle
  };
  await expect(first.cancel(cancel)).rejects.toThrow();
  expect(h.cancelCommands()).toHaveLength(0);
  const next = restart ? h.create() : first;
  const recovered = await next.recoverCancellations({ locator: h.input.locator });
  expect(recovered.sessions).toHaveLength(1);
  const intent = recovered.sessions[0]!.intent;
  const result = await next.cancel(cancel);
  expect(h.actions[0]).toMatchObject({
    status: 409,
    response: { error: "remote_action_attempt_version_conflict" }
  });
  expect(intent.actionId).not.toBe(cancel.actionId);
  expect(intent.expectedRemoteHandle).toMatchObject({
    operationId: handle.operationId,
    dispatchId: handle.dispatchId,
    executionAttemptId: handle.executionAttemptId,
    leaseId: handle.leaseId,
    runSessionId: handle.runSessionId,
    authorityBindingId: handle.authorityBindingId,
    scope: handle.scope,
    attemptStateVersion: current.attempt.stateVersion
  });
  expect(result.session.phase).not.toBe("stopped");
  expect(h.cancelCommands()).toHaveLength(1);
  expect(h.actions[1]).toMatchObject({
    status: 202,
    request: { actionId: intent.actionId, expectedAttemptVersion: current.attempt.stateVersion }
  });
  expect(h.f.operations.getRequired(operation.id)).toMatchObject({
    dispatchId: operation.dispatchId,
    executionAttemptId: operation.executionAttemptId,
    attempt: { leaseId: dispatch.leaseId }
  });
  await h.f.dispatches.fail(
    h.f.host.id,
    "host-stopped",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId,
    { code: "execution_cancelled", message: "Cancelled by Host", retryable: false }
  );
  expect((await next.cancel(cancel)).session.phase).toBe("stopped");
  expect(
    (await h.create().recoverCancellations({ locator: h.input.locator })).sessions
  ).toHaveLength(0);
});

it("replays the accepted cancellation with its original action and payload after response loss and Main restart", async () => {
  const h = await setupOperatorCas();
  const first = h.create();
  const started = await first.start(h.input);
  if (started.handle.target !== "remote") throw new Error("remote_handle_required");
  const cancel = {
    ...h.input,
    sessionId: started.handle.runSessionId,
    actionId: "stop-response-lost",
    reason: "Desktop stop",
    expectedRemoteHandle: started.handle
  };
  h.loseNextActionResponse();
  await expect(first.cancel(cancel)).rejects.toMatchObject({ code: "operator_request_failed" });
  expect(h.actions[0]).toMatchObject({ status: 202 });
  expect(h.cancelCommands()).toHaveLength(1);
  const restarted = h.create();
  const recovered = await restarted.recoverCancellations({ locator: h.input.locator });
  expect(recovered.sessions[0]!.intent).toMatchObject({
    actionId: cancel.actionId,
    reason: cancel.reason,
    expectedRemoteHandle: cancel.expectedRemoteHandle
  });
  await restarted.cancel(cancel);
  expect(h.actions[1]!.request).toEqual(h.actions[0]!.request);
  expect(h.cancelCommands()).toHaveLength(1);
});

it.each([
  "attempt",
  "lease"
] as const)("refuses to refresh a rejected cancellation when the %s is replaced before authoritative observation", async (replacement) => {
  const h = await setupOperatorCas();
  const first = h.create();
  const started = await first.start(h.input);
  if (started.handle.target !== "remote") throw new Error("remote_handle_required");
  const handle = started.handle;
  const original = h.f.operations.getRequired(handle.operationId);
  const dispatch = h.f.dispatches.getRequired(original.dispatchId);
  h.f.dispatches.accept(
    h.f.host.id,
    "host-started",
    dispatch.id,
    dispatch.leaseId,
    dispatch.executionAttemptId
  );
  const reservation = h.f.reservations.getRequired(dispatch.leaseId);
  h.f.reservations.transition({
    leaseId: dispatch.leaseId,
    fencingToken: reservation.fencingToken,
    expectedAttemptVersion: original.attempt.stateVersion,
    status: "running"
  });
  h.afterConflict(async () => {
    h.f.dispatches.interrupt(h.f.host.id, "host-interrupted", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "host-interrupted",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "acp_session_lost",
      resumable: replacement === "lease",
      ...(replacement === "lease"
        ? { recovery: { acpSessionId: "session-replacement", recoveryId: "recovery-replacement" } }
        : {})
    });
    await h.f.coordinator.reenter(original.id);
    h.f.reservations.release({
      leaseId: dispatch.leaseId,
      fencingToken: reservation.fencingToken,
      expectedVersion: reservation.version,
      reason: "expired"
    });
    const interrupted = h.f.operations.getRequired(original.id);
    const identity = {
      actionId: "replace-execution",
      operationId: original.id,
      dispatchId: dispatch.id,
      executionAttemptId: dispatch.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      priorLeaseId: dispatch.leaseId,
      reason: "Explicit operator recovery"
    };
    await h.f.coordinator.executeAction(
      replacement === "attempt"
        ? {
            ...identity,
            kind: "retry_new_attempt",
            newDispatchId: "dispatch-replacement",
            newExecutionAttemptId: "attempt-replacement"
          }
        : {
            ...identity,
            kind: "resume_same_session",
            leaseId: "lease-replacement",
            leaseExpiresAt: new Date(Date.now() + 55_000).toISOString(),
            recovery: { acpSessionId: "session-replacement", recoveryId: "recovery-replacement" }
          }
    );
    if (replacement === "attempt") await h.f.coordinator.reenter(original.id);
  });
  const cancel = {
    ...h.input,
    sessionId: handle.runSessionId,
    actionId: "stop-replaced",
    reason: "Desktop stop",
    expectedRemoteHandle: handle
  };
  await expect(first.cancel(cancel)).rejects.toThrow();
  expect(h.actions[0]).toMatchObject({
    status: 409,
    response: { error: "remote_action_attempt_version_conflict" }
  });
  const current = h.f.operations.getRequired(original.id);
  if (replacement === "attempt")
    expect(current.executionAttemptId).not.toBe(original.executionAttemptId);
  else {
    expect(current.executionAttemptId).toBe(original.executionAttemptId);
    expect(current.attempt.leaseId).not.toBe(original.attempt.leaseId);
  }
  const restarted = h.create();
  const recovered = await restarted.recoverCancellations({ locator: h.input.locator });
  expect(recovered.sessions[0]!.intent).toMatchObject({
    actionId: cancel.actionId,
    expectedRemoteHandle: handle
  });
  await expect(restarted.cancel(cancel)).rejects.toThrow(
    /workspace_execution_(cancel_identity|resume)_mismatch/
  );
  expect(h.actions).toHaveLength(1);
  expect(h.cancelCommands()).toHaveLength(0);
  expect(h.f.operations.getRequired(original.id)).toMatchObject({
    executionAttemptId: current.executionAttemptId,
    dispatchId: current.dispatchId,
    attempt: { leaseId: current.attempt.leaseId }
  });
});

it("keeps a generic real HTTP 409 idempotency conflict pinned without refreshing its action", async () => {
  const h = await setupOperatorCas();
  const first = h.create();
  const started = await first.start(h.input);
  if (started.handle.target !== "remote" || !started.handle.leaseId)
    throw new Error("remote_handle_required");
  const handle = started.handle;
  await h.client.executeRemoteOperationAction(
    handle.operationId,
    {
      kind: "cancel",
      actionId: "already-used-action",
      operationId: handle.operationId,
      dispatchId: handle.dispatchId,
      executionAttemptId: handle.executionAttemptId,
      expectedAttemptVersion: handle.attemptStateVersion!,
      leaseId: handle.leaseId!,
      reason: "Original accepted reason"
    },
    h.input.locator.humanPrincipalId
  );
  const cancel = {
    ...h.input,
    sessionId: handle.runSessionId,
    actionId: "already-used-action",
    reason: "Different Desktop intent",
    expectedRemoteHandle: handle
  };
  await expect(first.cancel(cancel)).rejects.toMatchObject({ code: "operator_operation_conflict" });
  const restarted = h.create();
  const recovered = await restarted.recoverCancellations({ locator: h.input.locator });
  expect(recovered.sessions[0]!.intent).toMatchObject({
    actionId: cancel.actionId,
    expectedRemoteHandle: handle
  });
  await expect(restarted.cancel(cancel)).rejects.toMatchObject({
    code: "operator_operation_conflict"
  });
  expect(h.actions.slice(1)).toEqual([
    expect.objectContaining({
      status: 409,
      response: expect.objectContaining({ error: "operator_operation_conflict" })
    }),
    expect.objectContaining({ status: 409, request: h.actions[1]!.request })
  ]);
  expect(h.cancelCommands()).toHaveLength(1);
});
