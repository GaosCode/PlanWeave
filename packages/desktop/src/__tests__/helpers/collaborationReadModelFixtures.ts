import { vi } from "vitest";
import {
  eligibleHostBatchResponseSchema,
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
  exampleMemberPage
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import type { CollaborationObserverSignal, CollaborationStatus } from "../../shared/collaboration";
import type { CollaborationReadBridgePort } from "../../renderer/collaboration/CollaborationReadModelController";

export function eligibleHostBatch(
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

export function idleStatus(overrides?: Partial<CollaborationStatus>): CollaborationStatus {
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

export function createMockApi(options?: {
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
