import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createActivityJournalComposition } from "../composition/activityComments.js";
import { createRemoteCoordinationOptions } from "../composition/remoteExecution.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { ActivityRepository } from "../comments/activityRepository.js";
import { buildRemoteRunActivity } from "../comments/activityProjection.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { attachHumanObserverWebSocketServer } from "../humanObserverWs.js";
import { AuthorizationChangeSignal } from "../authorizationChangeSignal.js";
import { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";
import { setupCommentReadComposition } from "./support/commentReadAccessCompositionFixture.js";
import { auth, createWorkspaceDevice } from "./support/commentAttachmentHttpFixture.js";
import { createRemoteDispatchFixture } from "./support/remoteDispatchFixture.js";
import { executionEnvelopeFor } from "./protocolTestFixtures.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function messages(socket: WebSocket, count: number) {
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const received: Record<string, unknown>[] = [];
    const timer = setTimeout(() => reject(new Error("observer_messages_timeout")), 3000);
    const listener = (data: RawData) => {
      received.push(JSON.parse(data.toString()));
      if (received.length !== count) return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(received);
    };
    socket.on("message", listener);
  });
}

async function setup() {
  const fixture = await setupCommentReadComposition();
  const { database, config, projectId, owner } = fixture;
  const workspaceId = owner.workspaceId;
  const scope = { workspaceId, projectId };
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const identity = new HumanIdentityRepository(database);
  const member = createWorkspaceDevice({
    database,
    workspaceIdentity,
    authorizeScope() {},
    workspaceId,
    projectId,
    suffix: "remote-reader"
  });
  database
    .prepare(
      "UPDATE workspace_memberships SET role='member' WHERE workspace_id=? AND human_principal_id=?"
    )
    .run(workspaceId, member.principalId);
  await fixture.mutateAccess(owner.token, workspaceId, null, {
    operation: "visibility",
    expectedAclRevision: 0,
    visibility: "shared"
  });
  const activity = createActivityJournalComposition({ database, config, clock: () => new Date() });
  const options = createRemoteCoordinationOptions({
    config,
    clock: () => new Date(),
    activity,
    ownerRuntimeLeases: {
      acquire() {
        throw new Error("unexpected_runtime_acquire");
      },
      acquireForHost() {
        throw new Error("unexpected_runtime_acquire");
      }
    },
    ownerRuntimeAvailability: { hasRuntimeProject: () => false, hasRuntimeScope: () => false },
    getAuthorization() {
      throw new Error("unexpected_operator_authorization");
    },
    getHumanIdentity: () => identity,
    getWorkspaceIdentity: () => workspaceIdentity
  });
  const coordination = createRemoteBlockCoordination(database, options, {
    serverInstanceOwnerToken: "activity-scope-test"
  });
  const host = coordination.hosts.register("Private run host").host;
  coordination.hosts.reportOnline(host.id, ["linux"], 2);
  const dispatch = createRemoteDispatchFixture(
    database,
    coordination,
    executionEnvelopeFor("T-001#B-001", ["linux"], projectId)
  );
  const observerHttp = createServer();
  const observer = attachHumanObserverWebSocketServer({
    upgradeRouter: new WebSocketUpgradeRouter(observerHttp),
    journal: activity.humanObserverJournal,
    repository: identity,
    workspaceIdentity,
    projectAccess: fixture.access,
    collaborationScopeAuthority: {
      hasScope: (candidate) =>
        candidate.workspaceId === workspaceId && candidate.projectId === projectId,
      hasProject: (candidate) => candidate === projectId
    },
    authorizationChanges: new AuthorizationChangeSignal(),
    maxPayloadBytes: 16_384,
    shutdownTimeoutMs: 1000,
    transportAdmission: loopbackHttpTransportAdmission
  });
  await new Promise<void>((resolve) => observerHttp.listen(0, "127.0.0.1", resolve));
  const address = observerHttp.address();
  if (!address || typeof address === "string") throw new Error("observer_address_missing");
  const sockets: WebSocket[] = [];
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await observer.close();
    await new Promise<void>((resolve) => observerHttp.close(() => resolve()));
  });
  const connect = async (cursor: number, count = 1) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/projects/${projectId}/human/observe`,
      {
        headers: auth(member.token)
      }
    );
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const ready = messages(socket, count);
    socket.send(
      JSON.stringify({
        type: "human.observer.hello",
        protocolVersion: 1,
        projectId,
        lastCursor: cursor
      })
    );
    return { socket, ready };
  };
  const read = async () => {
    const response = await fetch(`${fixture.base}/activity`, { headers: auth(member.token) });
    expect(response.status).toBe(200);
    return (await response.json()) as {
      items: Array<{ activityId: string; type: string; workItem?: object }>;
    };
  };
  const accept = () =>
    coordination.dispatches.accept(
      host.id,
      "scope-accept",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
  const interrupt = () =>
    coordination.dispatches.interrupt(host.id, "scope-interrupt", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "scope-interrupt",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "acp_session_lost",
      resumable: false
    });
  return {
    ...fixture,
    activity,
    scope,
    member,
    coordination,
    dispatch,
    connect,
    read,
    accept,
    interrupt
  };
}

describe("remote run Activity scope at composition boundaries", () => {
  it("keeps private dispatch lifecycle out of HTTP, live and replay until a Canvas viewer grant", async () => {
    const fixture = await setup();
    const baseline = fixture.activity.humanObserverJournal.appendInCallerTransaction(
      fixture.scope,
      { kind: "project" }
    );
    const initial = await fixture.connect(0);
    await expect(initial.ready).resolves.toMatchObject([{ type: "human.observer.welcome" }]);
    const delivered = messages(initial.socket, 1);
    fixture.accept();
    // A project event is the delivery handshake after the hidden lifecycle events.
    const barrier = fixture.activity.humanObserverJournal.appendInCallerTransaction(fixture.scope, {
      kind: "project"
    });
    await expect(delivered).resolves.toMatchObject([{ kind: "project", cursor: barrier.cursor }]);
    expect(
      (await fixture.read()).items.filter((item) => item.type.startsWith("remote_run"))
    ).toEqual([]);
    const replay = await fixture.connect(baseline.cursor, 2);
    await expect(replay.ready).resolves.toMatchObject([
      { kind: "project", cursor: barrier.cursor },
      { type: "human.observer.welcome" }
    ]);
    replay.socket.terminate();
    initial.socket.terminate();

    await fixture.mutateAccess(fixture.owner.token, fixture.scope.workspaceId, "default", {
      operation: "grant",
      expectedAclRevision: 0,
      humanPrincipalId: fixture.member.principalId,
      role: "viewer"
    });
    expect((await fixture.read()).items).toContainEqual(
      expect.objectContaining({
        type: "remote_run_started",
        workItem: { kind: "block", canvasId: "default", blockRef: "T-001#B-001" }
      })
    );
    await fixture.mutateAccess(fixture.owner.token, fixture.scope.workspaceId, null, {
      operation: "visibility",
      expectedAclRevision: 1,
      visibility: "private"
    });
    expect((await fixture.read()).items).toContainEqual(
      expect.objectContaining({ type: "remote_run_started" })
    );
    const viewer = await fixture.connect(baseline.cursor, 3);
    await expect(viewer.ready).resolves.toMatchObject([
      { kind: "remote_run", remoteRunStatus: "started", workItem: { canvasId: "default" } },
      { kind: "activity", workItem: { canvasId: "default" } },
      { type: "human.observer.welcome" }
    ]);
    const live = messages(viewer.socket, 2);
    fixture.interrupt();
    await expect(live).resolves.toMatchObject([
      { kind: "remote_run", remoteRunStatus: "interrupted", workItem: { canvasId: "default" } },
      { kind: "activity", workItem: { canvasId: "default" } }
    ]);
    await fixture.mutateAccess(fixture.owner.token, fixture.scope.workspaceId, null, {
      operation: "visibility",
      expectedAclRevision: 2,
      visibility: "shared"
    });
    const grant = fixture.access.listActiveCanvasPersonGrants({
      ...fixture.scope,
      canvasId: "default",
      humanPrincipalId: fixture.member.principalId
    })[0]!;
    await fixture.mutateAccess(fixture.owner.token, fixture.scope.workspaceId, "default", {
      operation: "revoke",
      expectedAclRevision: 1,
      grantId: grant.grantId
    });
    expect(
      (await fixture.read()).items.filter((item) => item.type.startsWith("remote_run"))
    ).toEqual([]);
    const revokedLive = messages(viewer.socket, 1);
    const nextDispatch = createRemoteDispatchFixture(
      fixture.database,
      fixture.coordination,
      executionEnvelopeFor("T-001#B-002", ["linux"], fixture.projectId)
    );
    fixture.coordination.dispatches.accept(
      nextDispatch.hostId,
      "scope-accept-after-revoke",
      nextDispatch.id,
      nextDispatch.leaseId,
      nextDispatch.executionAttemptId
    );
    const revokedBarrier = fixture.activity.humanObserverJournal.appendInCallerTransaction(
      fixture.scope,
      { kind: "project" }
    );
    await expect(revokedLive).resolves.toMatchObject([
      { kind: "project", cursor: revokedBarrier.cursor }
    ]);
    const afterRevoke = await fixture.connect(barrier.cursor, 2);
    await expect(afterRevoke.ready).resolves.toMatchObject([
      { kind: "project", cursor: revokedBarrier.cursor },
      { type: "human.observer.welcome" }
    ]);
  });

  it("refuses historical unscoped Activity, recovered outbox and journal while retaining project events", async () => {
    const fixture = await setup();
    const repository = new ActivityRepository(fixture.database, {
      workspaceId: fixture.scope.workspaceId
    });
    const record = buildRemoteRunActivity({
      activityId: repository.allocateActivityId(),
      projectId: fixture.projectId,
      type: "remote_run_started",
      dispatchId: fixture.dispatch.id,
      hostId: fixture.dispatch.hostId,
      occurredAt: new Date().toISOString()
    });
    fixture.database
      .prepare(`INSERT INTO activity_projection_outbox
      (outbox_id,workspace_id,project_id,source_kind,source_id,activity_json,activity_occurred_at,created_at,projected_at)
      VALUES(?,?,?,?,?,?,?,?,NULL)`)
      .run(
        "old-outbox",
        fixture.scope.workspaceId,
        fixture.projectId,
        record.source.kind,
        record.source.sourceId,
        JSON.stringify(record),
        record.occurredAt,
        record.occurredAt
      );
    expect(repository.reconcileOutbox()).toMatchObject({ inserted: 1 });
    expect((await fixture.read()).items.map((item) => item.activityId)).not.toContain(
      record.activityId
    );
    const journal = fixture.activity.humanObserverJournal;
    const start = journal.appendInCallerTransaction(fixture.scope, { kind: "project" });
    journal.appendInCallerTransaction(fixture.scope, {
      kind: "remote_run",
      dispatchId: fixture.dispatch.id,
      remoteRunStatus: "started"
    });
    journal.appendInCallerTransaction(fixture.scope, {
      kind: "activity",
      dispatchId: fixture.dispatch.id,
      activityId: record.activityId
    });
    const end = journal.appendInCallerTransaction(fixture.scope, { kind: "membership" });
    const replay = await fixture.connect(start.cursor, 2);
    await expect(replay.ready).resolves.toMatchObject([
      { kind: "membership", cursor: end.cursor },
      { type: "human.observer.welcome" }
    ]);
    const live = messages(replay.socket, 1);
    journal.appendInCallerTransaction(fixture.scope, {
      kind: "remote_run",
      dispatchId: "unresolved",
      remoteRunStatus: "failed"
    });
    journal.appendInCallerTransaction(fixture.scope, {
      kind: "activity",
      dispatchId: "unresolved"
    });
    const barrier = journal.appendInCallerTransaction(fixture.scope, { kind: "project" });
    await expect(live).resolves.toMatchObject([{ kind: "project", cursor: barrier.cursor }]);
  });
});
