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
import {
  exampleActivityListPage,
  exampleAssignmentProjection,
  exampleCommentListPage,
  exampleCommentProjection,
  exampleMemberPage,
  exampleObserverEvent
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { describe, expect, it, vi } from "vitest";
import {
  CollaborationReadModelController,
  type CollaborationReadBridgePort
} from "../renderer/collaboration/CollaborationReadModelController";
import {
  AuthoritativeRefreshArbitrator,
  type AuthoritativeRefreshResource
} from "../renderer/collaboration/refreshArbitration";
import type { CollaborationObserverSignal, CollaborationStatus } from "../shared/collaboration";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function assignment(hostId: string, revision = 1): AssignmentDisplayProjection {
  return assignmentDisplayProjectionSchema.parse({
    projectId: "project-demo-001",
    workItem: { kind: "block", canvasId: "canvas-1", blockRef: "task-1#B-host" },
    target: { kind: "exact_host", hostId },
    revision,
    updatedAt: "2030-01-01T00:01:00.000Z",
    host: {
      hostId,
      displayName: hostId,
      online: true,
      authorizedForProject: true,
      revoked: false,
      capabilitiesSatisfied: true
    },
    availability: { status: "ready", reason: "ready" }
  });
}

function unassigned(revision: number): AssignmentDisplayProjection {
  return assignmentDisplayProjectionSchema.parse({
    projectId: "project-demo-001",
    workItem: { kind: "block", canvasId: "canvas-1", blockRef: "task-1#B-host" },
    target: { kind: "unassigned" },
    revision,
    updatedAt: "2030-01-01T00:02:00.000Z",
    availability: { status: "unassigned", reason: "unassigned" }
  });
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

function createApi(initialAssignment = exampleAssignmentProjection) {
  const listeners: Array<(signal: CollaborationObserverSignal) => void> = [];
  const listMembers = vi.fn().mockResolvedValue(exampleMemberPage);
  const listAssignments = vi
    .fn()
    .mockResolvedValue({ items: [initialAssignment], nextCursor: null });
  const api: CollaborationReadBridgePort = {
    getCollaborationStatus: vi.fn().mockResolvedValue(connectedStatus()),
    listCollaborationMembers: listMembers,
    listCollaborationAssignments: listAssignments,
    listCollaborationEligibleAssignees: vi.fn(),
    listCollaborationEligibleHostsBatch: vi.fn(async (input: EligibleHostBatchRequest) =>
      eligibleHostBatchResponseSchema.parse({
        items: input.workItems.map((workItem, index) => ({ index, workItem, hostIds: [] })),
        hosts: []
      })
    ),
    getCollaborationWorkAuthority: vi.fn(),
    updateCollaborationResponsibility: vi.fn(),
    updateCollaborationReviewer: vi.fn(),
    listCollaborationComments: vi.fn().mockResolvedValue(exampleCommentListPage),
    listCollaborationActivity: vi.fn().mockResolvedValue(exampleActivityListPage),
    updateCollaborationAssignment: vi.fn().mockResolvedValue(initialAssignment),
    createCollaborationComment: vi.fn().mockResolvedValue(exampleCommentProjection),
    editCollaborationComment: vi.fn().mockResolvedValue(exampleCommentProjection),
    tombstoneCollaborationComment: vi.fn().mockResolvedValue(exampleCommentProjection),
    onCollaborationStatusChanged: () => () => undefined,
    onCollaborationObserverSignal: (listener) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    }
  };
  return { api, listeners, listMembers, listAssignments };
}

function signal(kind: "membership" | "assignment", cursor: number): CollaborationObserverSignal {
  const event = { ...exampleObserverEvent, kind, cursor, previousCursor: cursor - 1 };
  delete event.workItem;
  return {
    type: "human.observer.event",
    profileId: "profile-demo-001",
    projectId: "project-demo-001",
    event
  };
}

describe("CollaborationReadModelController refresh arbitration", () => {
  it("bounds observer invalidation concurrency and queued cursors during a large burst", async () => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    mock.listMembers.mockClear();

    const releaseReads = deferred<void>();
    let activeReads = 0;
    let peakReads = 0;
    mock.listMembers.mockImplementation(async () => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await releaseReads.promise;
      activeReads -= 1;
      return exampleMemberPage;
    });

    for (let cursor = 1; cursor <= 10_000; cursor += 1) {
      mock.listeners[0]!(signal("membership", cursor));
    }
    await waitFor(() => expect(mock.listMembers).toHaveBeenCalledTimes(4));
    // Four event invalidations plus one authoritative overflow refresh may read concurrently.
    expect(peakReads).toBe(5);

    releaseReads.resolve();
    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(132));
    await waitFor(() => expect(controller.getSnapshot().loadingKinds).toEqual([]));
    expect(peakReads).toBeLessThanOrEqual(5);
    expect(mock.listMembers.mock.calls.length).toBeLessThan(200);
    controller.dispose();
  });

  it("does not let overflow recovery from before clear retire the reactivated cursor window", async () => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    mock.listMembers.mockClear();

    const oldRecovery = deferred<typeof exampleMemberPage>();
    const reactivation = deferred<typeof exampleMemberPage>();
    mock.listMembers
      .mockImplementationOnce(() => oldRecovery.promise)
      .mockImplementationOnce(() => reactivation.promise)
      .mockResolvedValue(exampleMemberPage);

    for (let cursor = 100; cursor < 612; cursor += 1) {
      mock.listeners[0]!({
        ...signal("membership", cursor),
        event: { ...exampleObserverEvent, kind: "invitation", cursor, previousCursor: cursor - 1 }
      });
    }
    await waitFor(() => expect(mock.listMembers).toHaveBeenCalledTimes(1));

    controller.clear();
    const activating = controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    for (let cursor = 100; cursor < 612; cursor += 1) {
      mock.listeners[0]!({
        ...signal("membership", cursor),
        event: { ...exampleObserverEvent, kind: "invitation", cursor, previousCursor: cursor - 1 }
      });
    }

    oldRecovery.resolve(exampleMemberPage);
    await waitFor(() => expect(mock.listMembers).toHaveBeenCalledTimes(2));
    mock.listeners[0]!(signal("membership", 50));
    await waitFor(() => expect(mock.listMembers).toHaveBeenCalledTimes(3));

    reactivation.resolve(exampleMemberPage);
    await activating;
    await waitFor(() => expect(controller.getSnapshot().loadingKinds).toEqual([]));
    expect(controller.getSnapshot().projectId).toBe("project-demo-001");
    controller.dispose();
  });

  it.each([
    "members",
    "assignments"
  ] as const)("requires the settle-time latest applied %s token", (resource: AuthoritativeRefreshResource) => {
    const arbitration = new AuthoritativeRefreshArbitrator();
    const aggregate = arbitration.next(resource);
    const replacement = arbitration.next(resource);
    expect(arbitration.markApplied(resource, replacement, 1)).toBe(false);
    arbitration.next(resource);
    expect(
      arbitration.settleAggregate(1, [{ application: "superseded", resource, token: aggregate }])
    ).toBe(false);
    const recovery = arbitration.next(resource);
    expect(arbitration.markApplied(resource, recovery, 1)).toBe(true);
  });

  it("keeps an aggregate non-authoritative until the latest member replacement recovers", async () => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const aggregate = deferred<typeof exampleMemberPage>();
    const pending = deferred<typeof exampleMemberPage>();
    mock.listMembers
      .mockImplementationOnce(() => aggregate.promise)
      .mockResolvedValueOnce(exampleMemberPage)
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(exampleMemberPage);

    const manual = controller.refreshAuthoritative({ reason: "three_member_reads" });
    await waitFor(() => expect(mock.listMembers).toHaveBeenCalledTimes(2));
    mock.listeners[0]!(signal("membership", 41));
    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(41));
    mock.listeners[0]!(signal("membership", 42));
    await waitFor(() => expect(mock.listMembers).toHaveBeenCalledTimes(4));
    aggregate.resolve(exampleMemberPage);
    await manual;
    expect(controller.getSnapshot().syncPhase).toBe("loading");

    pending.reject(new Error("latest replacement failed"));
    await waitFor(() => expect(controller.getSnapshot().syncPhase).toBe("error"));
    mock.listeners[0]!(signal("membership", 43));
    await waitFor(() => expect(controller.getSnapshot().syncPhase).toBe("ready"));
    expect(controller.getSnapshot().observerCursor).toBe(43);
    controller.dispose();
  });

  it.each([
    ["members", "observer_first"],
    ["members", "manual_first"],
    ["assignments", "observer_first"],
    ["assignments", "manual_first"]
  ] as const)("settles %s ready when the replacement finishes %s", async (resource, order) => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const older = deferred<{ items: AssignmentDisplayProjection[]; nextCursor: null }>();
    const newer = deferred<{ items: AssignmentDisplayProjection[]; nextCursor: null }>();
    const list = resource === "members" ? mock.listMembers : mock.listAssignments;
    const replacement =
      resource === "members"
        ? { items: exampleMemberPage.items, nextCursor: null }
        : { items: [assignment("host-new", 2)], nextCursor: null };
    list.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);

    const manual = controller.refreshAuthoritative({ reason: "manual_overlap" });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    mock.listeners[0]!(signal(resource === "members" ? "membership" : "assignment", 10));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));

    if (order === "observer_first") {
      newer.resolve(replacement);
      await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(10));
      older.resolve(replacement);
    } else {
      older.resolve(replacement);
      await manual;
      expect(controller.getSnapshot().syncPhase).toBe("loading");
      newer.resolve(replacement);
    }
    await manual;
    await waitFor(() => expect(controller.getSnapshot().syncPhase).toBe("ready"));
    expect(controller.getSnapshot().loadingKinds).toEqual([]);
    controller.dispose();
  });

  it.each([
    "switch",
    "clear"
  ] as const)("does not let an old generation release the new %s loading lease", async (mode) => {
    const mock = createApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const oldRead = deferred<typeof exampleMemberPage>();
    const newRead = deferred<typeof exampleMemberPage>();
    mock.listMembers
      .mockImplementationOnce(() => oldRead.promise)
      .mockImplementationOnce(() => newRead.promise);
    mock.listeners[0]!(signal("membership", 20));
    await waitFor(() => expect(mock.listMembers).toHaveBeenCalledTimes(2));
    if (mode === "clear") controller.clear();
    const activating = controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-002"
      })
    );
    await waitFor(() => expect(mock.listMembers).toHaveBeenCalledTimes(3));
    oldRead.resolve(exampleMemberPage);
    await waitFor(() => expect(controller.getSnapshot().loadingKinds).toContain("members"));
    newRead.resolve(exampleMemberPage);
    await activating;
    expect(controller.getSnapshot().loadingKinds).toEqual([]);
    controller.dispose();
  });

  it.each([
    [assignment("host-new", 2), ["host-new"]],
    [unassigned(2), []]
  ] as const)("rebuilds assigned host provenance after a protected update", async (latest, hosts) => {
    const stale = assignment("host-old");
    const mock = createApi(stale);
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const fullRead = deferred<{ items: AssignmentDisplayProjection[]; nextCursor: null }>();
    mock.listAssignments
      .mockImplementationOnce(() => fullRead.promise)
      .mockResolvedValueOnce({ items: [latest], nextCursor: null });
    mock.listeners[0]!(signal("assignment", 30));
    mock.listeners[0]!({
      ...signal("assignment", 31),
      event: {
        ...exampleObserverEvent,
        kind: "assignment",
        cursor: 31,
        previousCursor: 30,
        workItem: latest.workItem
      }
    });
    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(31));
    fullRead.resolve({ items: [stale], nextCursor: null });
    await waitFor(() => expect(controller.getSnapshot().loadingKinds).toEqual([]));
    expect(controller.getSnapshot().hosts.map(({ hostId }) => hostId)).toEqual(hosts);
    controller.dispose();
  });
});
