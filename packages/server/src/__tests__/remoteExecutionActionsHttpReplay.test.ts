import {
  agentHostProtocolVersion,
  WORKSPACE_CANVAS_EXECUTION_CAPABILITY,
  type HostEvent
} from "@planweave-ai/agent-host-protocol";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  handleHumanHttpRequest,
  HumanIdentityRepository,
  HumanMembershipService
} from "../identity/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { HumanRemoteControlService } from "../humanRemoteControlService.js";
import { handleHumanRemoteHttpRequest } from "../humanRemoteHttp.js";
import { RemoteExecutionActionRepository } from "../remoteExecutionActions.js";
import { SqliteRemoteDispatchPersistence } from "../remoteCoordinatorPersistence.js";
import { attachAgentHostWebSocketServer } from "../wsServer.js";
import { endpointDispatchRequest } from "./support/endpointCoordinatorFixture.js";
import {
  remoteManifest,
  setup as setupCoordinator
} from "./support/remoteBlockCoordinatorFixture.js";
import { ownHostRemoteAgents } from "./support/remoteAgentOwnerFixture.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function setup() {
  const fixture = await setupCoordinator(false, remoteManifest(true), 2);
  const database = fixture.server.database;
  const registration = fixture.hosts.register("Controlled Replay Host");
  const host = registration.host;
  ownHostRemoteAgents({ database, hostId: host.id, grantWorkspaceId: fixture.locator.workspaceId });
  fixture.hosts.bindToWorkspace(host.id, fixture.locator.workspaceId);
  const identity = new HumanIdentityRepository(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const scopeAuthority = {
    hasProject: (projectId: string) => projectId === fixture.locator.projectId,
    hasScope: (scope: { workspaceId: string; projectId: string }) =>
      scope.workspaceId === fixture.locator.workspaceId &&
      scope.projectId === fixture.locator.projectId
  };
  const membership = new HumanMembershipService({
    repository: identity,
    collaborationScopeAuthority: scopeAuthority,
    workspaceForProject: (projectId) =>
      projectId === fixture.locator.projectId ? fixture.locator.workspaceId : undefined
  });
  const service = new HumanRemoteControlService({
    operations: fixture.operations,
    dispatches: fixture.dispatches,
    coordinator: fixture.coordinator,
    events: fixture.acpEvents,
    interactions: fixture.interactions,
    authorizeCanvas: (_context, scope) => {
      if (!scopeAuthority.hasScope(scope) || scope.canvasId !== fixture.locator.canvasId) {
        throw new Error("authority_scope_forbidden");
      }
    }
  });
  const http = createServer((request, response) => {
    void (async () => {
      if (
        await handleHumanHttpRequest(request, response, {
          service: membership,
          repository: identity,
          collaborationScopeAuthority: scopeAuthority,
          transportAdmission: loopbackHttpTransportAdmission
        })
      )
        return;
      if (
        await handleHumanRemoteHttpRequest(request, response, {
          service,
          repository: identity,
          workspaceIdentity,
          collaborationScopeAuthority: scopeAuthority,
          readiness: () => ({ status: "ready", schemaVersion: 1 }),
          transportAdmission: loopbackHttpTransportAdmission
        })
      )
        return;
      response.writeHead(404).end();
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "unexpected_http_error"
        })
      );
    });
  });
  const actions = new RemoteExecutionActionRepository(database);
  const ws = attachAgentHostWebSocketServer({
    server: http,
    hosts: fixture.hosts,
    mailbox: fixture.mailbox,
    dispatches: fixture.dispatches,
    acpEvents: fixture.acpEvents,
    interactions: fixture.interactions,
    actions,
    heartbeatIntervalMs: 60_000,
    leaseDurationMs: 60_000,
    transportAdmission: loopbackHttpTransportAdmission
  });
  cleanups.push(async () => {
    await ws.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("expected_http_address");
  const origin = `http://127.0.0.1:${address.port}`;
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/agent-hosts/${host.id}/connect`, {
    headers: { Authorization: `Bearer ${registration.token}` }
  });
  cleanups.push(async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  });
  const frames: Array<Record<string, unknown>> = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "host.hello",
      protocolVersion: agentHostProtocolVersion,
      supportedExecutionEnvelopeVersions: [1, 2],
      lastAcknowledgedSequence: 0,
      lastAcknowledgementRecoverySequence: 0,
      capabilities: ["acp.codex", WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
      capacity: 2,
      readiness: {
        workspaceMappings: [{ workspaceId: fixture.locator.workspaceId, status: "ready" }],
        acpProfiles: [
          {
            profileId: "codex-acp",
            agentId: "codex",
            displayName: "Controlled Agent",
            status: "ready",
            capabilities: ["acp.codex"]
          }
        ]
      }
    })
  );
  await vi.waitFor(() =>
    expect(frames).toContainEqual(expect.objectContaining({ type: "host.welcome" }))
  );
  const bootstrap = await fetch(
    `${origin}/api/v1/projects/${fixture.locator.projectId}/human/bootstrap`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "Replay Owner",
        humanPrincipalId: fixture.callerHumanPrincipalId
      })
    }
  );
  expect(bootstrap.status).toBe(201);
  const bootstrapBody = (await bootstrap.json()) as { deviceToken: string };
  const dispatch = async (blockRef: string, idempotencyKey: string) =>
    fixture.coordinator.dispatch(
      endpointDispatchRequest({
        agentEndpoints: fixture.agentEndpoints,
        locator: fixture.dispatchLocator,
        blockRef,
        idempotencyKey
      })
    );
  const first = await dispatch("T-001#B-001", "http-replay-primary");
  const other = await dispatch("T-002#B-001", "http-replay-other");
  const operation = first.operation;
  const persisted = fixture.dispatches.getRequired(operation.dispatchId);
  const action = {
    kind: "cancel" as const,
    actionId: "http-cancel-replay",
    operationId: operation.id,
    dispatchId: persisted.id,
    executionAttemptId: persisted.executionAttemptId,
    expectedAttemptVersion: operation.attempt.stateVersion,
    leaseId: persisted.leaseId,
    reason: "Controlled cancellation"
  };
  const post = async (
    body: unknown,
    token: string | undefined = bootstrapBody.deviceToken,
    projectId = fixture.locator.projectId
  ) => {
    const response = await fetch(
      `${origin}/api/v1/projects/${projectId}/remote-operations/${operation.id}/actions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body)
      }
    );
    const responseBody: unknown = await response.json();
    return { status: response.status, body: responseBody };
  };
  const send = async (event: HostEvent) => {
    socket.send(JSON.stringify(event));
    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.type === "protocol.error")).toEqual([]);
      expect(frames).toContainEqual(
        expect.objectContaining({ type: "host.event_ack", messageId: event.messageId })
      );
    });
  };
  const snapshot = () => ({
    action: actions.getRequired(action.actionId),
    operation: fixture.operations.getRequired(operation.id),
    dispatch: fixture.dispatches.getRequired(persisted.id),
    mailbox: fixture.mailbox.listAfter(host.id, 0)
  });
  return {
    ...fixture,
    host,
    actions,
    operation,
    persisted,
    other: other.operation,
    action,
    post,
    send,
    snapshot
  };
}

describe("remote cancel replay through HTTP and Host protocol", () => {
  it("applies a recorded receipt once and replays delivered, acknowledged and settled without effects", async () => {
    const fixture = await setup();
    const claim = vi.spyOn(RemoteExecutionActionRepository.prototype, "claimApplication");
    const apply = vi.spyOn(SqliteRemoteDispatchPersistence.prototype, "enqueueCancel");
    const publish = vi.spyOn(fixture.mailbox, "publish");
    fixture.actions.record(fixture.action);
    const foreignBefore = fixture.operations.getRequired(fixture.other.id);
    const foreignDispatchBefore = fixture.dispatches.getRequired(fixture.other.dispatchId);
    const conflicts = async () => {
      const before = fixture.snapshot();
      for (const changed of [
        { reason: "Changed intent" },
        { dispatchId: fixture.other.dispatchId },
        { executionAttemptId: fixture.other.executionAttemptId },
        { expectedAttemptVersion: fixture.action.expectedAttemptVersion + 1 },
        { leaseId: "lease-foreign" }
      ]) {
        expect(await fixture.post({ ...fixture.action, ...changed })).toEqual({
          status: 409,
          body: { error: "human_remote_operation_conflict" }
        });
      }
      expect(fixture.snapshot()).toEqual(before);
    };
    const counts = () => ({
      claim: claim.mock.calls.length,
      apply: apply.mock.calls.length,
      publish: publish.mock.calls.length
    });
    for (const state of ["recorded", "delivered", "acknowledged", "settled"] as const) {
      const before = fixture.snapshot();
      expect(before.action.state).toBe(state);
      await conflicts();
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => fixture.post(fixture.action))
      );
      const after = fixture.snapshot();
      const evidence = (snapshot: ReturnType<typeof fixture.snapshot>) => ({
        action: snapshot.action,
        operation: {
          id: snapshot.operation.id,
          state: snapshot.operation.state,
          attempt: snapshot.operation.attempt
        },
        dispatch: { id: snapshot.dispatch.id, status: snapshot.dispatch.status },
        mailbox: snapshot.mailbox.map(({ command, ...message }) => ({
          ...message,
          commandType: command.type
        }))
      });
      console.log(
        JSON.stringify({
          phase: state,
          before: evidence(before),
          responses,
          after: evidence(after),
          counts: counts()
        })
      );
      for (const response of responses) {
        expect(response.status).toBe(202);
        expect(response.body).toMatchObject({
          request: fixture.action,
          state: state === "recorded" ? "delivered" : state,
          createdAt: after.action.createdAt,
          deliveredAt: after.action.deliveredAt,
          ...(after.action.acknowledgedAt ? { acknowledgedAt: after.action.acknowledgedAt } : {}),
          ...(after.action.settledAt ? { settledAt: after.action.settledAt } : {})
        });
        if (state !== "settled") expect(response.body).not.toHaveProperty("settledAt");
      }
      expect(counts()).toEqual({ claim: 1, apply: 1, publish: 1 });
      expect(after.mailbox).toHaveLength(before.mailbox.length + (state === "recorded" ? 1 : 0));
      expect(
        after.mailbox.filter((message) => message.command.type === "cancel_execution")
      ).toHaveLength(1);
      expect(after.action.requestFingerprint).toBe(before.action.requestFingerprint);
      if (state !== "recorded") {
        expect(after).toEqual(before);
        expect(responses.map((response) => response.body)).toEqual(
          Array(4).fill(responses[0]?.body)
        );
      }
      if (state === "delivered") {
        for (const message of after.mailbox) {
          await fixture.send({
            type: "mailbox.ack",
            protocolVersion: agentHostProtocolVersion,
            messageId: `ack-${message.sequence}`,
            sequence: message.sequence
          });
        }
        expect(fixture.actions.getRequired(fixture.action.actionId)).toMatchObject({
          state: "acknowledged",
          acknowledgedAt: expect.any(String),
          settledAt: undefined
        });
        expect(fixture.dispatches.getRequired(fixture.persisted.id).status).toBe("cancelling");
        expect(fixture.operations.getRequired(fixture.operation.id).state).not.toBe("cancelled");
      }
      if (state === "acknowledged") {
        await fixture.send({
          type: "dispatch.failed",
          protocolVersion: agentHostProtocolVersion,
          messageId: "controlled-cancel-terminal",
          dispatchId: fixture.persisted.id,
          leaseId: fixture.persisted.leaseId,
          executionAttemptId: fixture.persisted.executionAttemptId,
          failure: { code: "execution_cancelled", message: fixture.action.reason, retryable: true }
        });
        await vi.waitFor(() =>
          expect(fixture.operations.getRequired(fixture.operation.id).state).toBe("cancelled")
        );
        expect(fixture.actions.getRequired(fixture.action.actionId).state).toBe("settled");
      }
    }
    expect(fixture.actions.getRequired(fixture.action.actionId).settledAt).toEqual(
      expect.any(String)
    );
    expect(fixture.operations.getRequired(fixture.other.id)).toEqual(foreignBefore);
    expect(fixture.dispatches.getRequired(fixture.other.dispatchId)).toEqual(foreignDispatchBefore);
  });

  it("keeps first-request identity, CAS, lease, fencing and HTTP authorization boundaries", async () => {
    const fixture = await setup();
    const apply = vi.spyOn(SqliteRemoteDispatchPersistence.prototype, "enqueueCancel");
    const operationBefore = fixture.operations.getRequired(fixture.operation.id);
    const otherBefore = fixture.operations.getRequired(fixture.other.id);
    const mailboxBefore = fixture.mailbox.listAfter(fixture.host.id, 0);
    for (const [index, changed] of [
      { dispatchId: fixture.other.dispatchId },
      { executionAttemptId: fixture.other.executionAttemptId },
      { expectedAttemptVersion: fixture.action.expectedAttemptVersion - 1 },
      { leaseId: "lease-foreign" }
    ].entries()) {
      const response = await fixture.post({
        ...fixture.action,
        ...changed,
        actionId: `fresh-invalid-${index}`
      });
      expect(response).toEqual({
        status: 409,
        body: {
          error:
            index === 2
              ? "remote_action_attempt_version_conflict"
              : "human_remote_operation_conflict"
        }
      });
      console.log(JSON.stringify({ negative: changed, response }));
    }
    expect(await fixture.post(fixture.action, "")).toEqual({
      status: 401,
      body: { error: "human_auth_unauthenticated" }
    });
    expect(await fixture.post(fixture.action, undefined, "other-project")).toEqual({
      status: 403,
      body: { error: "human_cross_project_forbidden" }
    });
    expect(fixture.operations.getRequired(fixture.operation.id)).toEqual(operationBefore);
    const lease = fixture.reservations.getRequired(fixture.persisted.leaseId);
    fixture.reservations.release({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      reason: "expired"
    });
    const expired = await fixture.post({
      ...fixture.action,
      actionId: "fresh-expired",
      expectedAttemptVersion: fixture.operations.getRequired(fixture.operation.id).attempt
        .stateVersion
    });
    expect(expired.status).toBeGreaterThanOrEqual(400);
    await expect(
      fixture.coordinator.executeAction({
        ...fixture.action,
        actionId: "fresh-expired-owner",
        expectedAttemptVersion: fixture.operations.getRequired(fixture.operation.id).attempt
          .stateVersion
      })
    ).rejects.toThrow("remote_cancel_attempt_not_active");
    console.log(JSON.stringify({ negative: "fenced-reservation", expired }));
    expect(fixture.mailbox.listAfter(fixture.host.id, 0)).toEqual(mailboxBefore);
    expect(fixture.dispatches.getRequired(fixture.persisted.id)).toEqual(fixture.persisted);
    expect(fixture.operations.getRequired(fixture.other.id)).toEqual(otherBefore);
    expect(apply).not.toHaveBeenCalled();
  });
});
