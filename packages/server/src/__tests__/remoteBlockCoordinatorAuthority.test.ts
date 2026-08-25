import { describe, expect, it } from "vitest";
import { workspaceMembershipIdFor } from "../identity/workspaceMembershipProjection.js";
import { RemoteAgentAuthorizationError } from "../remoteAgent/errors.js";
import { RemoteAgentRepository } from "../remoteAgent/repository.js";
import type { SqliteDatabase } from "../sqlite.js";
import { endpointDispatchRequest } from "./support/endpointCoordinatorFixture.js";
import {
  ensureTestHumanPrincipal,
  TEST_REMOTE_AGENT_OWNER_ID
} from "./support/remoteAgentOwnerFixture.js";
import { setup } from "./support/remoteBlockCoordinatorFixture.js";

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
    protocolVersion: 1,
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
      locator: fixture.locator,
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
      reviewerRevision: 0
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
      locator: fixture.locator,
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

  it("reenters a running operation from persisted snapshots after grant revoke", async () => {
    const fixture = await setup(true);
    ensureTestHumanPrincipal(fixture.server.database, MEMBER_ID, "Workspace Member");
    addWorkspaceMember(fixture.server.database, fixture.locator.workspaceId, MEMBER_ID, "member");
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.locator,
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

  it("re-authorizes retry_new_attempt against current grants after revoke", async () => {
    const fixture = await setup(true);
    ensureTestHumanPrincipal(fixture.server.database, MEMBER_ID, "Workspace Member");
    addWorkspaceMember(fixture.server.database, fixture.locator.workspaceId, MEMBER_ID, "member");
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.locator,
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
    ).rejects.toThrow(RemoteAgentAuthorizationError);
    expect(fixture.operations.getRequired(interrupted.id)).toMatchObject({
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      attempt: { stateVersion: interrupted.attempt.stateVersion }
    });
  });

  it("rejects a different principal reusing the same idempotency key", async () => {
    const fixture = await setup(true);
    ensureTestHumanPrincipal(fixture.server.database, MEMBER_ID, "Workspace Member");
    addWorkspaceMember(fixture.server.database, fixture.locator.workspaceId, MEMBER_ID, "member");
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "shared-idempotency-key"
    });
    await fixture.coordinator.dispatch(request);
    const intruder = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "shared-idempotency-key",
      callerHumanPrincipalId: MEMBER_ID
    });
    await expect(fixture.coordinator.dispatch(intruder)).rejects.toThrow(
      "remote_operation_idempotency_conflict"
    );
  });

  it("fails closed when retry_new_attempt has no agent access snapshot", async () => {
    const fixture = await setup(true);
    const request = endpointDispatchRequest({
      agentEndpoints: fixture.agentEndpoints,
      locator: fixture.locator,
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
