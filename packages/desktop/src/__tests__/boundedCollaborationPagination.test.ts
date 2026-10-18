import {
  collaborationOperationScopeFixture,
  scopedProjectFixture
} from "./helpers/collaborationOperationScopeFixture";
/* @vitest-environment jsdom */

import { waitFor } from "@testing-library/react";
import {
  assignmentDisplayProjectionSchema,
  eligibleHostBatchResponseSchema,
  type AssignmentDisplayProjection,
  type EligibleHostBatchRequest
} from "@planweave-ai/collaboration-protocol/work/assignment";
import type { HumanMembershipView } from "@planweave-ai/collaboration-protocol/identity/workspace";
import {
  exampleActivityListPage,
  exampleAssignmentProjection,
  exampleCommentListPage,
  exampleCommentProjection,
  exampleMemberPage,
  exampleObserverEvent
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { describe, expect, it, vi } from "vitest";
import { CollaborationReadModelController } from "../renderer/collaboration/CollaborationReadModelController";
import { buildCollaborationProjectViewModel } from "../renderer/collaboration/collaborationViewModels";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import type { CollaborationObserverSignal, CollaborationStatus } from "../shared/collaboration";
import { workItemKey } from "../shared/collaborationReadModels";

function blockAssignment(index: number): AssignmentDisplayProjection {
  return assignmentDisplayProjectionSchema.parse({
    projectId: "project-demo-001",
    workItem: { kind: "block", canvasId: "canvas-1", blockRef: `task-1#B-${index}` },
    target: { kind: "exact_host", hostId: `host-${index}` },
    revision: 1,
    updatedAt: "2030-01-01T00:01:00.000Z",
    host: {
      hostId: `host-${index}`,
      displayName: `Host ${index}`,
      online: true,
      authorizedForProject: true,
      revoked: false,
      capabilitiesSatisfied: true
    },
    availability: { status: "ready", reason: "ready" }
  });
}

function member(membershipId: string): HumanMembershipView {
  return { ...exampleMemberPage.items[0]!, membershipId };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function assignmentSignal(
  cursor: number,
  workItem?: AssignmentDisplayProjection["workItem"]
): CollaborationObserverSignal {
  const event = {
    ...exampleObserverEvent,
    kind: "assignment" as const,
    cursor,
    previousCursor: cursor - 1,
    ...(workItem ? { workItem } : {})
  };
  if (!workItem) delete event.workItem;
  return {
    type: "human.observer.event",
    profileId: "profile-demo-001",
    projectId: "project-demo-001",
    event
  };
}

function connectedStatus(): CollaborationStatus {
  return {
    profiles: [],
    activeProfileId: "profile-demo-001",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      operationScope: collaborationOperationScopeFixture("profile-demo-001", "project-demo-001"),
      phase: "connected",
      activeProfileId: "profile-demo-001",
      detail: "observer:connected",
      lastErrorCode: null,
      lastErrorMessage: null
    },
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
}

function createApi() {
  const signalListeners: Array<(signal: CollaborationObserverSignal) => void> = [];
  const listMembers = vi.fn().mockResolvedValue(exampleMemberPage);
  const listAssignments = vi
    .fn()
    .mockResolvedValue({ items: [exampleAssignmentProjection], nextCursor: null });
  const listEligibleBatch = vi.fn(async (input: EligibleHostBatchRequest) =>
    eligibleHostBatchResponseSchema.parse({
      items: input.workItems.map((workItem, index) => ({ index, workItem, hostIds: [] })),
      hosts: []
    })
  );
  const api: CollaborationReadBridgePort = {
    getCollaborationStatus: vi.fn().mockResolvedValue(connectedStatus()),
    listCollaborationMembers: listMembers,
    listCollaborationAssignments: listAssignments,
    listCollaborationEligibleAssignees: vi.fn(),
    listCollaborationEligibleHostsBatch: listEligibleBatch,
    getCollaborationWorkAuthority: vi.fn(),
    updateCollaborationResponsibility: vi.fn(),
    updateCollaborationReviewer: vi.fn(),
    listCollaborationComments: vi.fn().mockResolvedValue(exampleCommentListPage),
    listCollaborationActivity: vi.fn().mockResolvedValue(exampleActivityListPage),
    updateCollaborationAssignment: vi.fn().mockResolvedValue(exampleAssignmentProjection),
    createCollaborationComment: vi.fn().mockResolvedValue(exampleCommentProjection),
    editCollaborationComment: vi.fn().mockResolvedValue(exampleCommentProjection),
    tombstoneCollaborationComment: vi.fn().mockResolvedValue(exampleCommentProjection),
    onCollaborationStatusChanged: () => () => undefined,
    onCollaborationObserverSignal: (listener) => {
      signalListeners.push(listener);
      return () => {
        const index = signalListeners.indexOf(listener);
        if (index >= 0) signalListeners.splice(index, 1);
      };
    }
  };
  return { api, listMembers, listAssignments, listEligibleBatch, signalListeners };
}

describe("CollaborationReadModelController bounded refresh", () => {
  it("merges all member and assignment pages and shards eligibility into batches of 50", async () => {
    const mock = createApi();
    const assignments = Array.from({ length: 55 }, (_, index) => blockAssignment(index + 1));
    mock.listMembers.mockImplementation(async ({ cursor }: { cursor?: number }) =>
      cursor === 0
        ? { items: [member("member-1"), member("member-duplicate")], nextCursor: 73 }
        : {
            items: [
              { ...member("member-duplicate"), displayName: "Latest duplicate" },
              member("member-2")
            ],
            nextCursor: null
          }
    );
    mock.listAssignments.mockImplementation(async ({ cursor }: { cursor?: number }) =>
      cursor === 0
        ? { items: assignments.slice(0, 50), nextCursor: 91 }
        : { items: assignments.slice(50), nextCursor: null }
    );

    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );

    const snapshot = controller.getSnapshot();
    expect(snapshot.members.map((item) => item.membershipId)).toEqual([
      "member-1",
      "member-duplicate",
      "member-2"
    ]);
    expect(snapshot.members[1]?.displayName).toBe("Latest duplicate");
    expect(Object.keys(snapshot.assignmentsByWorkItem)).toHaveLength(55);
    expect(mock.listAssignments.mock.calls.map(([query]) => query.cursor)).toEqual([0, 91]);
    expect(mock.listEligibleBatch).toHaveBeenCalledTimes(2);
    expect(mock.listEligibleBatch.mock.calls.map(([input]) => input.workItems.length)).toEqual([
      50, 5
    ]);
    expect(
      buildCollaborationProjectViewModel({ snapshot, localWorkItems: [] }).isAuthoritative
    ).toBe(true);
    controller.dispose();
  });

  it("keeps the prior snapshots and loses authority when either second page fails", async () => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const prior = controller.getSnapshot();

    mock.listMembers
      .mockResolvedValueOnce({ items: [member("partial-member")], nextCursor: 4 })
      .mockRejectedValueOnce(new Error("members page 2 failed"));
    mock.listAssignments
      .mockResolvedValueOnce({ items: [blockAssignment(2)], nextCursor: 8 })
      .mockRejectedValueOnce(new Error("assignments page 2 failed"));
    await controller.refreshAuthoritative({ reason: "second_page_failure" });

    const failed = controller.getSnapshot();
    expect(failed.members).toEqual(prior.members);
    expect(failed.assignmentsByWorkItem).toEqual(prior.assignmentsByWorkItem);
    expect(failed.syncPhase).toBe("error");
    expect(
      buildCollaborationProjectViewModel({ snapshot: failed, localWorkItems: [] }).isAuthoritative
    ).toBe(false);
    controller.dispose();
  });

  it.each([
    ["members", "offline"],
    ["assignments", "timeout"]
  ] as const)("marks a %s second-page %s failure non-authoritative", async (resource, kind) => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const failure = { kind, code: `${resource}_${kind}`, message: "page failed", retryable: true };
    if (resource === "members") {
      mock.listMembers
        .mockResolvedValueOnce({ items: [], nextCursor: 4 })
        .mockRejectedValueOnce(failure);
    } else {
      mock.listAssignments
        .mockResolvedValueOnce({ items: [], nextCursor: 4 })
        .mockRejectedValueOnce(failure);
    }

    await controller.refreshAuthoritative({ reason: "boundary_page_failure" });
    const snapshot = controller.getSnapshot();
    expect(snapshot.syncPhase).toBe("error");
    expect(
      buildCollaborationProjectViewModel({ snapshot, localWorkItems: [] }).isAuthoritative
    ).toBe(false);
    controller.dispose();
  });

  it.each([
    ["auth", "auth_expired"],
    ["forbidden", "forbidden"],
    ["conflict", "stale_conflict"]
  ] as const)("preserves the specific %s phase on incomplete pagination", async (kind, phase) => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    mock.listMembers
      .mockResolvedValueOnce({ items: [], nextCursor: 4 })
      .mockRejectedValueOnce({ kind, code: `${kind}_failure`, message: "page failed" });

    await controller.refreshAuthoritative({ reason: "specific_boundary_failure" });
    expect(controller.getSnapshot().syncPhase).toBe(phase);
    controller.dispose();
  });

  it("keeps the previous assignment snapshot when the second eligibility batch fails", async () => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const previous = controller.getSnapshot().assignmentsByWorkItem;
    const previousHosts = controller.getSnapshot().hosts;
    mock.listAssignments.mockResolvedValueOnce({
      items: Array.from({ length: 55 }, (_, index) => blockAssignment(index + 700)),
      nextCursor: null
    });
    mock.listEligibleBatch
      .mockImplementationOnce(async (input: EligibleHostBatchRequest) =>
        eligibleHostBatchResponseSchema.parse({
          items: input.workItems.map((workItem, index) => ({ index, workItem, hostIds: [] })),
          hosts: []
        })
      )
      .mockRejectedValueOnce(new Error("second eligibility batch failed"));

    await controller.refreshAuthoritative({ reason: "eligibility_batch_failure" });
    expect(controller.getSnapshot().assignmentsByWorkItem).toEqual(previous);
    expect(controller.getSnapshot().hosts).toEqual(previousHosts);
    expect(controller.getSnapshot().syncPhase).toBe("error");
    controller.dispose();
  });

  it("applies concurrent single-assignment refreshes for different keys", async () => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const first = blockAssignment(301);
    const second = blockAssignment(302);
    const firstRead = deferred<{ items: AssignmentDisplayProjection[]; nextCursor: null }>();
    const secondRead = deferred<{ items: AssignmentDisplayProjection[]; nextCursor: null }>();
    mock.listAssignments
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => secondRead.promise);

    mock.signalListeners[0]!(assignmentSignal(301, first.workItem));
    mock.signalListeners[0]!(assignmentSignal(302, second.workItem));
    secondRead.resolve({ items: [second], nextCursor: null });
    firstRead.resolve({ items: [first], nextCursor: null });
    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(302));

    expect(controller.getSnapshot().assignmentsByWorkItem[workItemKey(first.workItem)]).toEqual(
      first
    );
    expect(controller.getSnapshot().assignmentsByWorkItem[workItemKey(second.workItem)]).toEqual(
      second
    );
    expect(controller.getSnapshot().loadingKinds).not.toContain("assignments");
    controller.dispose();
  });

  it("does not advance a superseded same-key cursor and allows retry", async () => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const older = blockAssignment(401);
    const newer = { ...older, revision: 2 };
    const olderRead = deferred<{ items: AssignmentDisplayProjection[]; nextCursor: null }>();
    mock.listAssignments
      .mockImplementationOnce(() => olderRead.promise)
      .mockResolvedValueOnce({ items: [newer], nextCursor: null });

    mock.signalListeners[0]!(assignmentSignal(401, older.workItem));
    mock.signalListeners[0]!(assignmentSignal(402, older.workItem));
    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(402));
    olderRead.resolve({ items: [older], nextCursor: null });
    await waitFor(() => expect(controller.getSnapshot().loadingKinds).not.toContain("assignments"));
    expect(controller.getSnapshot().assignmentsByWorkItem[workItemKey(older.workItem)]).toEqual(
      newer
    );

    mock.listAssignments.mockResolvedValueOnce({ items: [newer], nextCursor: null });
    mock.signalListeners[0]!(assignmentSignal(401, older.workItem));
    await waitFor(() => expect(mock.listAssignments).toHaveBeenCalledTimes(4));
    controller.dispose();
  });

  it("preserves a single-key update when an older full refresh finishes last", async () => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const stale = blockAssignment(501);
    const latest = { ...stale, revision: 2 };
    const fullRead = deferred<{ items: AssignmentDisplayProjection[]; nextCursor: null }>();
    mock.listAssignments
      .mockImplementationOnce(() => fullRead.promise)
      .mockResolvedValueOnce({ items: [latest], nextCursor: null });

    mock.signalListeners[0]!(assignmentSignal(501));
    mock.signalListeners[0]!(assignmentSignal(502, latest.workItem));
    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(502));
    fullRead.resolve({ items: [stale], nextCursor: null });
    await waitFor(() => expect(controller.getSnapshot().loadingKinds).not.toContain("assignments"));
    expect(controller.getSnapshot().assignmentsByWorkItem[workItemKey(latest.workItem)]).toEqual(
      latest
    );
    controller.dispose();
  });

  it("supersedes an older single-key read when a newer full refresh finishes first", async () => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const stale = blockAssignment(601);
    const latest = { ...stale, revision: 2 };
    const singleRead = deferred<{ items: AssignmentDisplayProjection[]; nextCursor: null }>();
    mock.listAssignments
      .mockImplementationOnce(() => singleRead.promise)
      .mockResolvedValueOnce({ items: [latest], nextCursor: null });

    mock.signalListeners[0]!(assignmentSignal(601, stale.workItem));
    mock.signalListeners[0]!(assignmentSignal(602));
    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(602));
    singleRead.resolve({ items: [stale], nextCursor: null });
    await waitFor(() => expect(controller.getSnapshot().loadingKinds).not.toContain("assignments"));
    expect(controller.getSnapshot().assignmentsByWorkItem[workItemKey(latest.workItem)]).toEqual(
      latest
    );

    mock.listAssignments.mockResolvedValueOnce({ items: [latest], nextCursor: null });
    mock.signalListeners[0]!(assignmentSignal(601, stale.workItem));
    await waitFor(() => expect(mock.listAssignments).toHaveBeenCalledTimes(4));
    controller.dispose();
  });
});
