/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  assignmentDisplayProjectionSchema,
  assignmentHostFactsSchema,
  eligibleHostBatchResponseSchema,
  type AssignmentDisplayProjection,
  type AssignmentHostFacts,
  type EligibleHostBatchRequest,
  type EligibleHostBatchResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import type { BlockWorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  exampleActivityListPage,
  exampleAssignmentProjection,
  exampleCommentListPage,
  exampleCommentProjection,
  exampleMemberPage,
  exampleObserverCatchupRequired,
  exampleObserverEvent
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationReadModelController } from "../renderer/collaboration/CollaborationReadModelController";
import {
  buildCollaborationProjectViewModel,
  mutationAppearsSuccessful
} from "../renderer/collaboration/collaborationViewModels";
import { useCollaborationReadModels } from "../renderer/hooks/useCollaborationReadModels";
import { workItemKey } from "../shared/collaborationReadModels";
import type { CollaborationObserverSignal, CollaborationStatus } from "../shared/collaboration";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";

const workItem = exampleAssignmentProjection.workItem;
const workKey = workItemKey(workItem);

function eligibleHost(hostId: string, capabilities = ["acp"]): AssignmentHostFacts {
  return assignmentHostFactsSchema.parse({
    workspaceId: "workspace-1",
    projectId: "project-demo-001",
    hostId,
    exists: true,
    revoked: false,
    authorizedForProject: true,
    online: true,
    ready: true,
    capabilities,
    displayName: `Eligible ${hostId}`
  });
}

function eligibleHostBatch(
  workItems: readonly BlockWorkItemRef[],
  hosts: readonly AssignmentHostFacts[]
): EligibleHostBatchResponse {
  return eligibleHostBatchResponseSchema.parse({
    items: workItems.map((batchWorkItem, index) => ({
      index,
      workItem: batchWorkItem,
      hostIds: hosts.map((host) => host.hostId)
    })),
    hosts
  });
}

function blockAssignment(blockRef: string, hostId: string): AssignmentDisplayProjection {
  return assignmentDisplayProjectionSchema.parse({
    projectId: "project-demo-001",
    workItem: { kind: "block", canvasId: "canvas-1", blockRef },
    target: { kind: "exact_host", hostId },
    revision: 1,
    updatedAt: "2030-01-01T00:01:00.000Z",
    host: {
      hostId,
      displayName: `Assigned ${hostId}`,
      online: true,
      authorizedForProject: true,
      revoked: false,
      capabilitiesSatisfied: true
    },
    availability: { status: "ready", reason: "ready" }
  });
}

function assignmentObserverSignal(
  cursor: number,
  workItem?: AssignmentDisplayProjection["workItem"]
): CollaborationObserverSignal {
  const baseEvent = {
    ...exampleObserverEvent,
    cursor,
    previousCursor: cursor - 1
  };
  const event = workItem
    ? { ...baseEvent, workItem }
    : (() => {
        const withoutWorkItem = { ...baseEvent };
        delete withoutWorkItem.workItem;
        return withoutWorkItem;
      })();
  return {
    type: "human.observer.event",
    profileId: "profile-demo-001",
    projectId: "project-demo-001",
    event
  };
}

function idleStatus(overrides?: Partial<CollaborationStatus>): CollaborationStatus {
  return {
    profiles: [],
    activeProfileId: "profile-demo-001",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
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
    workspacePicker: {
      schemaVersion: "workspace-setup/v1",
      items: [],
      nextCursor: null
    },
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...overrides
  };
}

function createMockApi(options?: {
  members?: typeof exampleMemberPage;
  assignments?: { items: (typeof exampleAssignmentProjection)[]; nextCursor: number | null };
  activity?: typeof exampleActivityListPage;
  comments?: typeof exampleCommentListPage;
  onUpdateAssignment?: ReturnType<typeof vi.fn>;
  onEditComment?: ReturnType<typeof vi.fn>;
}): {
  api: CollaborationReadBridgePort;
  statusListeners: Array<(status: CollaborationStatus) => void>;
  signalListeners: Array<(signal: CollaborationObserverSignal) => void>;
  listMembers: ReturnType<typeof vi.fn>;
  listAssignments: ReturnType<typeof vi.fn>;
  listActivity: ReturnType<typeof vi.fn>;
  listComments: ReturnType<typeof vi.fn>;
  listEligibleBatch: ReturnType<typeof vi.fn>;
} {
  const statusListeners: Array<(status: CollaborationStatus) => void> = [];
  const signalListeners: Array<(signal: CollaborationObserverSignal) => void> = [];
  const listMembers = vi.fn().mockResolvedValue(options?.members ?? exampleMemberPage);
  const listAssignments = vi
    .fn()
    .mockResolvedValue(
      options?.assignments ?? { items: [exampleAssignmentProjection], nextCursor: null }
    );
  const listActivity = vi.fn().mockResolvedValue(options?.activity ?? exampleActivityListPage);
  const listComments = vi.fn().mockResolvedValue(options?.comments ?? exampleCommentListPage);
  const listEligible = vi.fn();
  const listEligibleBatch = vi.fn((request: EligibleHostBatchRequest) =>
    Promise.resolve(eligibleHostBatch(request.workItems, []))
  );
  const updateAssignment =
    options?.onUpdateAssignment ??
    vi.fn().mockResolvedValue({
      ...exampleAssignmentProjection,
      revision: 2,
      target: { kind: "unassigned" }
    });
  const editComment =
    options?.onEditComment ??
    vi.fn().mockResolvedValue({
      ...exampleCommentProjection,
      revision: 2,
      body: "edited"
    });

  const api: CollaborationReadBridgePort = {
    getCollaborationStatus: vi.fn().mockResolvedValue(idleStatus()),
    listCollaborationMembers: listMembers,
    listCollaborationAssignments: listAssignments,
    listCollaborationEligibleAssignees: listEligible,
    listCollaborationEligibleHostsBatch: listEligibleBatch,
    getCollaborationWorkAuthority: vi.fn().mockImplementation(async ({ workItem: item }) => {
      const scope =
        item.kind === "task"
          ? {
              kind: "task" as const,
              workspaceId: "workspace-1",
              projectId: "project-demo-001",
              canvasId: item.canvasId,
              taskId: item.taskId
            }
          : {
              kind: "block" as const,
              workspaceId: "workspace-1",
              projectId: "project-demo-001",
              canvasId: item.canvasId,
              blockRef: item.blockRef
            };
      return {
        schemaVersion: "work-authority/v1",
        scope,
        responsibility: {
          schemaVersion: "responsibility/v1",
          scope,
          principal: null,
          revision: 0,
          updatedAt: "2030-01-01T00:00:00.000Z",
          availability: "unassigned"
        },
        reviewer: {
          schemaVersion: "review-assignment/v1",
          scope,
          principal: null,
          revision: 0,
          updatedAt: "2030-01-01T00:00:00.000Z",
          availability: "unassigned"
        },
        executionTarget:
          item.kind === "block"
            ? {
                schemaVersion: "execution-target/v1",
                scope,
                target: { kind: "unassigned" },
                revision: 0,
                updatedAt: "2030-01-01T00:00:00.000Z",
                availability: { status: "unassigned", reason: "unassigned" }
              }
            : null,
        revisions: {
          responsibilityRevision: 0,
          reviewerRevision: 0,
          executionTargetRevision: 0
        },
        selectedHost: null,
        evaluatedAt: "2030-01-01T00:00:00.000Z"
      };
    }),
    updateCollaborationResponsibility: vi.fn(),
    updateCollaborationReviewer: vi.fn(),
    updateCollaborationExecutionTarget: vi.fn(),
    listCollaborationComments: listComments,
    listCollaborationActivity: listActivity,
    updateCollaborationAssignment: updateAssignment,
    createCollaborationComment: vi.fn().mockResolvedValue(exampleCommentProjection),
    editCollaborationComment: editComment,
    tombstoneCollaborationComment: vi.fn().mockResolvedValue({
      ...exampleCommentProjection,
      tombstoned: true,
      revision: 3
    }),
    onCollaborationStatusChanged: (callback) => {
      statusListeners.push(callback);
      return () => {
        const index = statusListeners.indexOf(callback);
        if (index >= 0) statusListeners.splice(index, 1);
      };
    },
    onCollaborationObserverSignal: (callback) => {
      signalListeners.push(callback);
      return () => {
        const index = signalListeners.indexOf(callback);
        if (index >= 0) signalListeners.splice(index, 1);
      };
    }
  };

  return {
    api,
    statusListeners,
    signalListeners,
    listMembers,
    listAssignments,
    listActivity,
    listComments,
    listEligibleBatch
  };
}

describe("CollaborationReadModelController", () => {
  it("loads membership, hosts, assignments, activity on setActiveProject", async () => {
    const { api, listMembers, listAssignments, listActivity, listEligibleBatch } = createMockApi();
    const controller = new CollaborationReadModelController({
      api,
      clock: { now: () => new Date("2030-01-01T00:00:00.000Z") }
    });

    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      canvasId: "canvas-1"
    });

    const snapshot = controller.getSnapshot();
    expect(snapshot.syncPhase).toBe("ready");
    expect(snapshot.members).toEqual(exampleMemberPage.items);
    expect(snapshot.assignmentsByWorkItem[workKey]?.revision).toBe(1);
    expect(snapshot.hosts).toEqual([]);
    expect(snapshot.activity).toEqual(exampleActivityListPage.items);
    expect(listMembers).toHaveBeenCalledTimes(1);
    expect(listAssignments).toHaveBeenCalledTimes(1);
    expect(listActivity).toHaveBeenCalledTimes(1);
    expect(listEligibleBatch).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("queries 50 bounded Blocks in one eligible Host batch and maps the Host union", async () => {
    const firstBlockRef = "task-1#B-001";
    const secondBlockRef = "task-1#B-002";
    const firstBlock = blockAssignment(firstBlockRef, "host-assigned-1");
    const secondBlock = blockAssignment(secondBlockRef, "host-assigned-2");
    const remainingBlocks = Array.from({ length: 48 }, (_, index) =>
      blockAssignment(
        `task-1#B-${String(index + 3).padStart(3, "0")}`,
        `host-assigned-${index + 3}`
      )
    );
    const allBlocks = [firstBlock, secondBlock, ...remainingBlocks];
    const mock = createMockApi({
      assignments: {
        items: [exampleAssignmentProjection, ...allBlocks],
        nextCursor: null
      }
    });
    mock.listEligibleBatch.mockImplementation(async (input: EligibleHostBatchRequest) =>
      eligibleHostBatch(input.workItems, [
        eligibleHost("host-eligible-1"),
        eligibleHost("host-assigned-1", ["acp", "shell"]),
        eligibleHost("host-eligible-2")
      ])
    );

    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    expect(mock.listEligibleBatch).toHaveBeenCalledTimes(1);
    expect(mock.listEligibleBatch).toHaveBeenCalledWith({
      workItems: allBlocks.map((block) => block.workItem)
    });
    const hostIds = controller.getSnapshot().hosts.map((host) => host.hostId);
    expect(hostIds).toHaveLength(52);
    expect(hostIds).toEqual(
      expect.arrayContaining([
        "host-assigned-1",
        "host-assigned-50",
        "host-eligible-1",
        "host-eligible-2"
      ])
    );
    expect(
      controller.getSnapshot().hosts.find((host) => host.hostId === "host-assigned-1")
    ).toEqual(expect.objectContaining({ capabilities: ["acp", "shell"] }));
    controller.dispose();
  });

  it("dedupes repeated Block assignments before the eligible Host batch", async () => {
    const first = blockAssignment("task-1#B-001", "host-assigned-first");
    const repeated = blockAssignment("task-1#B-001", "host-assigned-last");
    const second = blockAssignment("task-1#B-002", "host-assigned-second");
    if (
      first.workItem.kind !== "block" ||
      repeated.workItem.kind !== "block" ||
      second.workItem.kind !== "block"
    ) {
      throw new Error("block_work_item_expected");
    }
    const mock = createMockApi({
      assignments: { items: [first, repeated, second], nextCursor: null }
    });
    mock.listEligibleBatch.mockImplementation(async (input: EligibleHostBatchRequest) =>
      eligibleHostBatch(input.workItems, [eligibleHost("host-eligible")])
    );

    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    expect(mock.listEligibleBatch).toHaveBeenCalledTimes(1);
    expect(mock.listEligibleBatch).toHaveBeenCalledWith({
      workItems: [first.workItem, second.workItem]
    });
    const snapshot = controller.getSnapshot();
    expect(Object.keys(snapshot.assignmentsByWorkItem)).toHaveLength(2);
    expect(snapshot.assignmentsByWorkItem[workItemKey(first.workItem)]).toEqual(repeated);
    expect(snapshot.assignmentsByWorkItem[workItemKey(second.workItem)]).toEqual(second);
    expect(snapshot.hosts.map((host) => host.hostId)).toEqual([
      "host-assigned-last",
      "host-assigned-second",
      "host-eligible"
    ]);
    controller.dispose();
  });

  it("replaces assignments and Hosts when an authoritative refresh shrinks the page", async () => {
    const block = blockAssignment("task-1#B-001", "host-assigned-1");
    const mock = createMockApi({
      assignments: {
        items: [block],
        nextCursor: null
      }
    });
    if (block.workItem.kind !== "block") throw new Error("block_work_item_expected");
    mock.listEligibleBatch.mockResolvedValue(
      eligibleHostBatch([block.workItem], [eligibleHost("host-eligible-1")])
    );

    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    expect(
      controller.getSnapshot().assignmentsByWorkItem[workItemKey(block.workItem)]
    ).toBeTruthy();
    expect(new Set(controller.getSnapshot().hosts.map((host) => host.hostId))).toEqual(
      new Set(["host-assigned-1", "host-eligible-1"])
    );

    mock.listAssignments.mockResolvedValueOnce({ items: [], nextCursor: null });
    await controller.refreshAuthoritative({ reason: "authoritative_shrink" });

    expect(controller.getSnapshot().assignmentsByWorkItem).toEqual({});
    expect(controller.getSnapshot().hosts).toEqual([]);
    expect(controller.getSnapshot().syncPhase).toBe("ready");
    controller.dispose();
  });

  it("surfaces eligible Host failures through authoritative refresh state", async () => {
    const block = blockAssignment("task-1#B-001", "host-assigned-1");
    const mock = createMockApi({
      assignments: { items: [block], nextCursor: null }
    });
    mock.listEligibleBatch.mockRejectedValueOnce({
      kind: "network",
      code: "eligible_hosts_unavailable",
      message: "Eligible Host query failed.",
      retryAfterMs: 2_000,
      retryable: true
    });
    const controller = new CollaborationReadModelController({ api: mock.api });

    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    expect(controller.getSnapshot().syncPhase).toBe("error");
    expect(controller.getSnapshot().lastError).toEqual(
      expect.objectContaining({
        code: "eligible_hosts_unavailable",
        message: "Eligible Host query failed.",
        retryAfterMs: 2_000
      })
    );
    expect(controller.getSnapshot().loadingKinds).not.toContain("assignments");
    expect(controller.getSnapshot().assignmentsByWorkItem).toEqual({});
    expect(controller.getSnapshot().hosts).toEqual([]);
    controller.dispose();
  });

  it("keeps reliable assignments and Hosts on eligible failure, then replaces them after recovery", async () => {
    const initialBlock = blockAssignment("task-1#B-001", "host-assigned-old");
    const nextBlock = blockAssignment("task-1#B-002", "host-assigned-new");
    const mock = createMockApi({
      assignments: {
        items: [initialBlock],
        nextCursor: null
      }
    });
    if (initialBlock.workItem.kind !== "block" || nextBlock.workItem.kind !== "block") {
      throw new Error("block_work_item_expected");
    }
    mock.listEligibleBatch.mockResolvedValue(
      eligibleHostBatch([initialBlock.workItem], [eligibleHost("host-eligible-old")])
    );

    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    const initialAssignmentKey = workItemKey(initialBlock.workItem);
    expect(controller.getSnapshot().assignmentsByWorkItem[initialAssignmentKey]).toBeTruthy();

    const failure = {
      kind: "network",
      code: "eligible_reload_failed",
      message: "Eligible Host reload failed.",
      retryable: true
    };
    mock.listAssignments.mockResolvedValueOnce({ items: [nextBlock], nextCursor: null });
    mock.listEligibleBatch.mockRejectedValueOnce(failure);
    await controller.refreshAuthoritative({ reason: "eligible_failure" });

    const failedSnapshot = controller.getSnapshot();
    expect(failedSnapshot.syncPhase).toBe("error");
    expect(failedSnapshot.lastError).toEqual(
      expect.objectContaining({
        code: "eligible_reload_failed",
        message: "Eligible Host reload failed."
      })
    );
    expect(failedSnapshot.assignmentsByWorkItem[initialAssignmentKey]).toBeTruthy();
    expect(failedSnapshot.assignmentsByWorkItem[workItemKey(nextBlock.workItem)]).toBeUndefined();
    expect(new Set(failedSnapshot.hosts.map((host) => host.hostId))).toEqual(
      new Set(["host-assigned-old", "host-eligible-old"])
    );

    mock.listAssignments.mockResolvedValueOnce({ items: [nextBlock], nextCursor: null });
    mock.listEligibleBatch.mockResolvedValueOnce(
      eligibleHostBatch([nextBlock.workItem], [eligibleHost("host-eligible-new")])
    );
    await controller.refreshAuthoritative({ reason: "eligible_recovery" });

    const recoveredSnapshot = controller.getSnapshot();
    expect(recoveredSnapshot.syncPhase).toBe("ready");
    expect(recoveredSnapshot.lastError).toBeNull();
    expect(recoveredSnapshot.assignmentsByWorkItem[initialAssignmentKey]).toBeUndefined();
    expect(recoveredSnapshot.assignmentsByWorkItem[workItemKey(nextBlock.workItem)]).toBeTruthy();
    expect(new Set(recoveredSnapshot.hosts.map((host) => host.hostId))).toEqual(
      new Set(["host-assigned-new", "host-eligible-new"])
    );
    controller.dispose();
  });

  it("handles initial load race by ignoring stale generation results", async () => {
    vi.useFakeTimers();
    try {
      const { api, listMembers } = createMockApi();
      let membersCall = 0;
      listMembers.mockImplementation(async () => {
        membersCall += 1;
        if (membersCall === 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            items: [
              {
                ...exampleMemberPage.items[0]!,
                projectId: "project-a",
                membershipId: "membership-stale"
              }
            ],
            nextCursor: null
          };
        }
        return exampleMemberPage;
      });

      const controller = new CollaborationReadModelController({ api });
      const first = controller.setActiveProject({
        profileId: "profile-a",
        projectId: "project-a"
      });
      await act(async () => {
        await Promise.resolve();
      });

      const second = controller.setActiveProject({
        profileId: "profile-b",
        projectId: "project-b"
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      await second;
      await first;

      expect(controller.getSnapshot().profileId).toBe("profile-b");
      expect(controller.getSnapshot().projectId).toBe("project-b");
      expect(
        controller
          .getSnapshot()
          .members.some((member) => member.membershipId === "membership-stale")
      ).toBe(false);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops subscriptions and clears cache on project switch", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    expect(mock.signalListeners).toHaveLength(1);
    const firstListener = mock.signalListeners[0];
    expect(controller.getSnapshot().projectId).toBe("project-demo-001");

    mock.listAssignments.mockResolvedValueOnce({ items: [], nextCursor: null });
    mock.listMembers.mockResolvedValueOnce({ items: [], nextCursor: null });
    mock.listActivity.mockResolvedValueOnce({ items: [], nextCursor: null });

    await controller.setActiveProject({
      profileId: "profile-other",
      projectId: "project-other"
    });
    expect(mock.signalListeners).toHaveLength(1);
    expect(mock.signalListeners[0]).not.toBe(firstListener);
    expect(controller.getSnapshot().profileId).toBe("profile-other");
    expect(controller.getSnapshot().projectId).toBe("project-other");
    expect(controller.getSnapshot().assignmentsByWorkItem).toEqual({});
    controller.dispose();
    expect(mock.signalListeners).toHaveLength(0);
  });

  it("dedupes out-of-order and duplicate observer events", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    mock.listAssignments.mockClear();

    const baseEvent = exampleObserverEvent;
    controller.handleObserverSignalForTests({
      type: "human.observer.event",
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      event: baseEvent
    });
    await waitFor(() => {
      expect(controller.getSnapshot().observerCursor).toBe(baseEvent.cursor);
    });

    const assignmentCallsAfterFirst = mock.listAssignments.mock.calls.length;

    // duplicate
    controller.handleObserverSignalForTests({
      type: "human.observer.event",
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      event: baseEvent
    });
    await Promise.resolve();
    expect(mock.listAssignments.mock.calls.length).toBe(assignmentCallsAfterFirst);

    // out-of-order older cursor
    controller.handleObserverSignalForTests({
      type: "human.observer.event",
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      event: {
        ...baseEvent,
        cursor: 5,
        previousCursor: 4
      }
    });
    await Promise.resolve();
    expect(mock.listAssignments.mock.calls.length).toBe(assignmentCallsAfterFirst);

    controller.dispose();
  });

  it("does not reload members for invitation-only observer bursts", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    mock.listMembers.mockClear();

    for (let index = 0; index < 64; index += 1) {
      const cursor = 100 + index;
      controller.handleObserverSignalForTests({
        type: "human.observer.event",
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        event: {
          ...exampleObserverEvent,
          kind: "invitation",
          cursor,
          previousCursor: cursor - 1
        }
      });
    }

    await waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(163));
    expect(mock.listMembers).not.toHaveBeenCalled();

    controller.handleObserverSignalForTests({
      type: "human.observer.event",
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      event: {
        ...exampleObserverEvent,
        kind: "membership",
        cursor: 164,
        previousCursor: 163
      }
    });
    await waitFor(() => expect(mock.listMembers).toHaveBeenCalledOnce());
    expect(controller.getSnapshot().observerCursor).toBe(164);
    controller.dispose();
  });

  it("surfaces observer assignment reload failures and retries the failed cursor", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    const observerListener = mock.signalListeners[0]!;
    const failure = {
      kind: "network",
      code: "assignment_reload_failed",
      message: "Assignment reload failed.",
      retryable: true
    };
    const unhandledRejections: unknown[] = [];
    const unhandledRejectionListener = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", unhandledRejectionListener);
    try {
      mock.listAssignments.mockRejectedValueOnce(failure);
      observerListener(assignmentObserverSignal(21, workItem));
      await waitFor(() => {
        expect(controller.getSnapshot().syncPhase).toBe("degraded");
      });
      expect(controller.getSnapshot().lastError).toEqual(
        expect.objectContaining({
          code: "assignment_reload_failed",
          message: "Assignment reload failed."
        })
      );
      expect(controller.getSnapshot().loadingKinds).not.toContain("assignments");
      expect(unhandledRejections).toEqual([]);

      mock.listAssignments.mockResolvedValueOnce({
        items: [exampleAssignmentProjection],
        nextCursor: null
      });
      observerListener(assignmentObserverSignal(21, workItem));
      await waitFor(() => {
        expect(controller.getSnapshot().observerCursor).toBe(21);
      });
      await controller.refreshAuthoritative({ reason: "observer_retry_recovery" });
      expect(controller.getSnapshot().syncPhase).toBe("ready");
      expect(controller.getSnapshot().lastError).toBeNull();
    } finally {
      process.off("unhandledRejection", unhandledRejectionListener);
      controller.dispose();
    }
  });

  it("surfaces full assignment refresh eligibility failures and recovers on retry", async () => {
    const block = blockAssignment("task-1#B-001", "host-assigned-1");
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    const observerListener = mock.signalListeners[0]!;
    const failure = {
      kind: "network",
      code: "eligible_reload_failed",
      message: "Eligible Host reload failed.",
      retryable: true
    };

    mock.listAssignments.mockResolvedValueOnce({ items: [block], nextCursor: null });
    mock.listEligibleBatch.mockRejectedValueOnce(failure);
    observerListener(assignmentObserverSignal(31));
    await waitFor(() => {
      expect(controller.getSnapshot().syncPhase).toBe("error");
    });
    expect(controller.getSnapshot().lastError).toEqual(
      expect.objectContaining({
        code: "eligible_reload_failed",
        message: "Eligible Host reload failed."
      })
    );
    expect(controller.getSnapshot().loadingKinds).not.toContain("assignments");

    mock.listAssignments.mockResolvedValueOnce({ items: [block], nextCursor: null });
    if (block.workItem.kind !== "block") throw new Error("block_work_item_expected");
    mock.listEligibleBatch.mockResolvedValueOnce(eligibleHostBatch([block.workItem], []));
    observerListener(assignmentObserverSignal(31));
    await waitFor(() => {
      expect(controller.getSnapshot().observerCursor).toBe(31);
    });
    await controller.refreshAuthoritative({ reason: "observer_retry_recovery" });
    expect(controller.getSnapshot().syncPhase).toBe("ready");
    expect(controller.getSnapshot().lastError).toBeNull();
    controller.dispose();
  });

  it("does not let a stale observer failure contaminate a new project generation", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    const staleObserverListener = mock.signalListeners[0]!;
    let rejectStaleReload!: (reason: unknown) => void;
    const staleReload = new Promise<never>((_, reject) => {
      rejectStaleReload = reject;
    });
    mock.listAssignments.mockImplementationOnce(() => staleReload);
    staleObserverListener(assignmentObserverSignal(41, workItem));
    await waitFor(() => {
      expect(mock.listAssignments).toHaveBeenCalledTimes(2);
    });

    const switchProject = controller.setActiveProject({
      profileId: "profile-next",
      projectId: "project-next"
    });
    rejectStaleReload({
      kind: "network",
      code: "stale_assignment_reload_failed",
      message: "Stale assignment reload failed.",
      retryable: true
    });
    await switchProject;
    expect(controller.getSnapshot().projectId).toBe("project-next");
    expect(controller.getSnapshot().syncPhase).toBe("ready");
    expect(controller.getSnapshot().lastError).toBeNull();
    expect(controller.getSnapshot().loadingKinds).not.toContain("assignments");
    controller.dispose();
  });

  it("performs bounded authoritative refresh on cursor retention gap", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    expect(controller.getSnapshot().assignmentsByWorkItem[workKey]).toBeTruthy();

    mock.listMembers.mockClear();
    mock.listAssignments.mockClear();
    mock.listActivity.mockClear();

    await act(async () => {
      controller.handleObserverSignalForTests({
        type: "human.observer.catchup_required",
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        reason: exampleObserverCatchupRequired.reason,
        resumeCursor: exampleObserverCatchupRequired.resumeCursor,
        droppedThroughCursor: exampleObserverCatchupRequired.droppedThroughCursor
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(controller.getSnapshot().observerCursor).toBe(100);
      expect(controller.getSnapshot().syncPhase).toBe("ready");
    });
    expect(mock.listMembers).toHaveBeenCalled();
    expect(mock.listAssignments).toHaveBeenCalled();
    expect(mock.listActivity).toHaveBeenCalled();
    controller.dispose();
  });

  it("models auth expiry from session status", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    controller.handleStatusForTests(
      idleStatus({
        session: {
          phase: "error",
          activeProfileId: "profile-demo-001",
          detail: "observer:auth_expired",
          lastErrorCode: "human_device_revoked",
          lastErrorMessage: "revoked"
        }
      })
    );

    expect(controller.getSnapshot().syncPhase).toBe("auth_expired");
    expect(controller.getSnapshot().lastError?.code).toBe("human_device_revoked");
    controller.dispose();
  });

  it("keeps authoritative reads while marking observer-only failures as degraded", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    const membersBeforeFailure = controller.getSnapshot().members;

    controller.handleStatusForTests(
      idleStatus({
        session: {
          phase: "connected",
          activeProfileId: "profile-demo-001",
          detail: "observer:failed",
          lastErrorCode: "collaboration_observer_http_403",
          lastErrorMessage: "Realtime observer handshake was rejected."
        }
      })
    );

    expect(controller.getSnapshot().syncPhase).toBe("degraded");
    expect(controller.getSnapshot().members).toEqual(membersBeforeFailure);
    expect(controller.getSnapshot().lastError?.code).toBe("collaboration_observer_http_403");
    controller.dispose();
  });

  it("treats a prepared session as disconnected until the client connects", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    controller.handleStatusForTests(
      idleStatus({
        session: {
          phase: "ready",
          activeProfileId: "profile-demo-001",
          detail: "workspace_selected",
          lastErrorCode: null,
          lastErrorMessage: null
        }
      })
    );

    expect(controller.getSnapshot().syncPhase).toBe("disconnected");
    controller.dispose();
  });

  it("does not treat offline mutation as success", async () => {
    const updateAssignment = vi.fn().mockRejectedValue({
      kind: "offline",
      code: "collaboration_offline",
      message: "Network request failed.",
      retryable: true
    });
    const mock = createMockApi({ onUpdateAssignment: updateAssignment });
    const controller = new CollaborationReadModelController({
      api: mock.api,
      createMutationId: () => "mut-offline"
    });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    const result = await controller.updateAssignment({
      workItem,
      target: { kind: "unassigned" },
      expectedRevision: 1
    });
    expect(result).toBeNull();
    const mutation = controller.getSnapshot().mutationsById["mut-offline"];
    expect(mutation?.status).toBe("offline");
    expect(mutationAppearsSuccessful(mutation)).toBe(false);
    expect(controller.getSnapshot().syncPhase).toBe("degraded");
    // Assignment cache must still show last server projection (rev 1), not optimistic unassigned.
    expect(controller.getSnapshot().assignmentsByWorkItem[workKey]?.revision).toBe(1);
    expect(controller.getSnapshot().assignmentsByWorkItem[workKey]?.target).toEqual({
      kind: "human",
      humanPrincipalId: "human-owner-001"
    });
    controller.dispose();
  });

  it("models stale revision conflict without confirming the mutation", async () => {
    const updateAssignment = vi.fn().mockRejectedValue({
      kind: "conflict",
      code: "revision_conflict",
      message: "Assignment revision conflict.",
      retryable: false
    });
    const mock = createMockApi({ onUpdateAssignment: updateAssignment });
    const controller = new CollaborationReadModelController({
      api: mock.api,
      createMutationId: () => "mut-conflict"
    });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    const result = await controller.updateAssignment({
      workItem,
      target: { kind: "unassigned" },
      expectedRevision: 1
    });
    expect(result).toBeNull();
    expect(controller.getSnapshot().mutationsById["mut-conflict"]?.status).toBe("rejected");
    expect(controller.getSnapshot().syncPhase).toBe("stale_conflict");
    expect(mutationAppearsSuccessful(controller.getSnapshot().mutationsById["mut-conflict"])).toBe(
      false
    );
    controller.dispose();
  });

  it("confirms mutation only after server accepts it", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({
      api: mock.api,
      createMutationId: () => "mut-ok"
    });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    const result = await controller.updateAssignment({
      workItem,
      target: { kind: "unassigned" },
      expectedRevision: 1
    });
    expect(result?.revision).toBe(2);
    expect(controller.getSnapshot().mutationsById["mut-ok"]?.status).toBe("confirmed");
    expect(controller.getSnapshot().assignmentsByWorkItem[workKey]?.target).toEqual({
      kind: "unassigned"
    });
    controller.dispose();
  });

  it("derives remote runs from activity and observer progress", async () => {
    const activity = {
      items: [
        {
          ...exampleActivityListPage.items[0]!,
          activityId: "activity-remote-1",
          type: "remote_run_started" as const,
          source: { kind: "remote_run" as const, sourceId: "dispatch-001" },
          summary: {
            headline: "Remote run started",
            workItem,
            dispatchId: "dispatch-001",
            hostId: "host-001"
          }
        }
      ],
      nextCursor: null
    };
    const mock = createMockApi({ activity });
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    expect(controller.getSnapshot().remoteRunsByDispatchId["dispatch-001"]?.status).toBe("started");

    controller.handleObserverSignalForTests({
      type: "human.observer.event",
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      event: {
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 20,
        previousCursor: 19,
        occurredAt: "2030-01-01T00:10:00.000Z",
        kind: "remote_run",
        dispatchId: "dispatch-001",
        remoteRunStatus: "progress",
        workItem
      }
    });
    await Promise.resolve();
    expect(controller.getSnapshot().remoteRunsByDispatchId["dispatch-001"]?.status).toBe(
      "progress"
    );

    await controller.refreshAuthoritative({ reason: "test" });
    expect(controller.getSnapshot().remoteRunsByDispatchId["dispatch-001"]).toMatchObject({
      status: "progress",
      observerCursor: 20
    });
    controller.dispose();
  });

  it("does not derive business state from DOM", () => {
    // Structural guard: controller module must not touch document/window DOM APIs.
    const source = CollaborationReadModelController.toString();
    expect(source).not.toMatch(/document\.|querySelector|getElementById|innerHTML/);
  });
});

describe("collaboration view models", () => {
  it("keeps server projections separate from local runtime facts", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      canvasId: "canvas-1"
    });

    const viewModel = buildCollaborationProjectViewModel({
      snapshot: controller.getSnapshot(),
      localWorkItems: [
        {
          workItem,
          localTitle: "Local task title",
          localRuntimeStatus: "running",
          presentInLocalGraph: true
        }
      ]
    });

    expect(viewModel.workItems).toHaveLength(1);
    expect(viewModel.workItems[0]!.assignment?.target).toEqual({
      kind: "human",
      humanPrincipalId: "human-owner-001"
    });
    expect(viewModel.workItems[0]!.local?.localRuntimeStatus).toBe("running");
    expect(viewModel.workItems[0]!.local?.localTitle).toBe("Local task title");
    // Local runtime must not invent a successful mutation.
    expect(viewModel.workItems[0]!.hasConfirmedMutation).toBe(false);
    expect(viewModel.isAuthoritative).toBe(true);
    controller.dispose();
  });
});

describe("useCollaborationReadModels", () => {
  it("binds one controller per active project and cleans up on unmount", async () => {
    const mock = createMockApi();
    const { result, unmount } = renderHook(() =>
      useCollaborationReadModels({
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        canvasId: "canvas-1",
        manageActiveProject: true,
        api: mock.api
      })
    );

    await waitFor(() => {
      expect(result.current.snapshot.syncPhase).toBe("ready");
    });
    expect(result.current.viewModel.members).toHaveLength(1);
    expect(mock.signalListeners).toHaveLength(1);

    unmount();
    expect(mock.signalListeners).toHaveLength(0);
  });

  it("clears projections when project becomes null", async () => {
    const mock = createMockApi();
    const { result, rerender } = renderHook(
      (props: { profileId: string | null; projectId: string | null }) =>
        useCollaborationReadModels({
          profileId: props.profileId,
          projectId: props.projectId,
          manageActiveProject: true,
          api: mock.api
        }),
      { initialProps: { profileId: "profile-demo-001", projectId: "project-demo-001" } }
    );

    await waitFor(() => {
      expect(result.current.snapshot.syncPhase).toBe("ready");
    });

    rerender({ profileId: null, projectId: null });
    await waitFor(() => {
      expect(result.current.snapshot.syncPhase).toBe("idle");
      expect(result.current.snapshot.members).toEqual([]);
    });
  });

  it("subscribe-only consumers do not rebind or clear the shell-owned hub", async () => {
    const mock = createMockApi();
    const { result: shell } = renderHook(() =>
      useCollaborationReadModels({
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        canvasId: "canvas-shell",
        manageActiveProject: true,
        api: mock.api
      })
    );

    await waitFor(() => {
      expect(shell.current.snapshot.syncPhase).toBe("ready");
      expect(shell.current.snapshot.canvasId).toBe("canvas-shell");
    });
    const listCallsAfterShell = mock.listAssignments.mock.calls.length;

    const { unmount: unmountSubscriber } = renderHook(() =>
      useCollaborationReadModels({
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        canvasId: "canvas-other",
        manageActiveProject: false,
        api: mock.api
      })
    );

    await waitFor(() => {
      expect(shell.current.controller).toBeTruthy();
    });
    expect(shell.current.snapshot.canvasId).toBe("canvas-shell");
    expect(mock.listAssignments.mock.calls.length).toBe(listCallsAfterShell);

    unmountSubscriber();
    expect(shell.current.snapshot.syncPhase).toBe("ready");
    expect(shell.current.snapshot.canvasId).toBe("canvas-shell");
    expect(shell.current.snapshot.members).toHaveLength(1);
  });
});
