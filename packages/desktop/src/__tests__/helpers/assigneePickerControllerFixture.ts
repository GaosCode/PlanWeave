import { vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationReadBridgePort } from "../../renderer/collaboration/CollaborationReadModelController";
import type {
  CollaborationObserverSignal,
  CollaborationStatus,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration";
import { collaborationOperationScopeFixture } from "./collaborationOperationScopeFixture";

export const taskItem: WorkItemRef = { kind: "task", canvasId: "canvas-1", taskId: "T-1" };
export const blockItem: WorkItemRef = {
  kind: "block",
  canvasId: "canvas-1",
  blockRef: "T-1#B-001"
};
export function connectedStatus(): CollaborationStatus {
  return {
    profiles: [
      {
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://example.test",
        projectId: "project-1",
        allowInsecureTransport: false,
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-1",
        humanPrincipalId: "human-1",
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    activeProfileId: "profile-1",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      operationScope: collaborationOperationScopeFixture(),
      phase: "connected",
      activeProfileId: "profile-1",
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    updatedAt: "2030-01-01T00:00:00.000Z",
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

export function createApi() {
  let status = connectedStatus();
  const statusListeners = new Set<(status: CollaborationStatus) => void>();
  const signalListeners = new Set<(signal: CollaborationObserverSignal) => void>();
  const updateResponsibility = vi.fn().mockResolvedValue({
    schemaVersion: "responsibility/v1",
    scope: {
      kind: "task",
      workspaceId: "w",
      projectId: "project-1",
      canvasId: "canvas-1",
      taskId: "T-1"
    },
    principal: { kind: "human", humanPrincipalId: "human-1" },
    revision: 1,
    updatedAt: "2030-01-01T00:00:00.000Z",
    availability: "active"
  });
  const getWorkAuthority = vi
    .fn()
    .mockImplementation(async ({ workItem }: { workItem: WorkItemRef }) => {
      const scope =
        workItem.kind === "task"
          ? {
              kind: "task" as const,
              workspaceId: "w",
              projectId: status.profiles[0]!.projectId,
              canvasId: workItem.canvasId,
              taskId: workItem.taskId
            }
          : {
              kind: "block" as const,
              workspaceId: "w",
              projectId: status.profiles[0]!.projectId,
              canvasId: workItem.canvasId,
              blockRef: workItem.blockRef
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
          workItem.kind === "block"
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
    });
  const listEligibleAssignees = vi.fn(async ({ workItem }: { workItem: WorkItemRef }) => ({
    workItem,
    humans: [],
    hosts:
      workItem.kind === "block"
        ? [
            {
              projectId: "project-1",
              hostId: "host-1",
              displayName: "Builder",
              exists: true,
              revoked: false,
              authorizedForProject: true,
              online: true,
              capabilities: ["acp.codex"],
              capacityRemaining: 1
            },
            ...(workItem.blockRef === "T-1#B-002"
              ? []
              : [
                  {
                    projectId: "project-1",
                    hostId: "host-only-first",
                    displayName: "First only",
                    exists: true,
                    revoked: false,
                    authorizedForProject: true,
                    online: true,
                    capabilities: ["acp.codex"],
                    capacityRemaining: 1
                  }
                ])
          ]
        : [],
    nextHumanCursor: null,
    nextHostCursor: null
  }));
  const dispatchRemoteOperation = vi.fn().mockResolvedValue({ operationId: "operation-1" });
  const api = {
    getCollaborationStatus: vi.fn(async () => status),
    listCollaborationMembers: vi.fn().mockResolvedValue({
      items: [
        {
          membershipId: "m-1",
          projectId: "project-1",
          humanPrincipalId: "human-1",
          displayName: "Ada",
          role: "owner",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      nextCursor: null
    }),
    listCollaborationAssignments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationEligibleAssignees: listEligibleAssignees,
    getCollaborationWorkAuthority: getWorkAuthority,
    updateCollaborationResponsibility: updateResponsibility,
    updateCollaborationReviewer: vi.fn(),
    listCollaborationComments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationActivity: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    updateCollaborationAssignment: vi.fn(),
    createCollaborationComment: vi.fn(),
    editCollaborationComment: vi.fn(),
    tombstoneCollaborationComment: vi.fn(),
    dispatchCollaborationRemoteOperation: dispatchRemoteOperation,
    onCollaborationStatusChanged: vi.fn((listener: (next: CollaborationStatus) => void) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    }),
    onCollaborationObserverSignal: vi.fn(
      (listener: (signal: CollaborationObserverSignal) => void) => {
        signalListeners.add(listener);
        return () => {
          signalListeners.delete(listener);
        };
      }
    )
  } as unknown as PlanWeaveCollaborationApi & CollaborationReadBridgePort;
  return {
    api,
    updateResponsibility,
    listEligibleAssignees,
    dispatchRemoteOperation,
    getWorkAuthority,
    emitObserverSignal: (signal: CollaborationObserverSignal) => {
      for (const listener of signalListeners) listener(signal);
    },
    changeConnection: (kind: "workspace" | "server") => {
      status = {
        ...status,
        profiles: status.profiles.map((profile) => ({
          ...profile,
          ...(kind === "server" ? { serverBaseUrl: "https://other.test" } : {})
        })),
        workspaceConnection: {
          ...status.workspaceConnection,
          ...(kind === "workspace" ? { workspaceId: "workspace-B" } : {})
        }
      };
      for (const listener of statusListeners) listener(status);
    },
    changeStatus: (projectId: string | null, profileId = "profile-1") => {
      status = connectedStatus();
      if (projectId === null) {
        status.activeProfileId = null;
        status.session.activeProfileId = null;
        status.session.phase = "idle";
        status.session.operationScope = null;
      } else {
        status.activeProfileId = profileId;
        status.session.activeProfileId = profileId;
        status.profiles[0] = { ...status.profiles[0]!, projectId, profileId };
        status.session.operationScope = collaborationOperationScopeFixture(profileId, projectId);
      }
      for (const listener of statusListeners) listener(status);
    }
  };
}
