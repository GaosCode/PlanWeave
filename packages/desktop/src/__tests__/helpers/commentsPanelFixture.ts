import { collaborationOperationScopeFixture } from "./collaborationOperationScopeFixture";
import { vi } from "vitest";
import { deploymentEndpointSchema } from "@planweave-ai/collaboration-protocol/connection";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationReadBridgePort } from "../../renderer/collaboration/CollaborationReadModelController";
import type {
  CollaborationObserverSignal,
  CollaborationStatus,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration";

export const taskItem: WorkItemRef = { kind: "task", canvasId: "canvas-1", taskId: "T-1" };

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
        credentialRevision: null,
        connectionState: "ready",
        endpoint: deploymentEndpointSchema.parse({
          topology: "public_https",
          serverOrigin: "https://example.test",
          allowedClientOrigins: ["https://example.test"],
          tlsTrust: "system_ca"
        }),
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
      credentialRevision: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

export function commentProjection(id: string, body: string, revision = 1) {
  return {
    commentId: id,
    projectId: "project-1",
    workItem: taskItem,
    author: {
      humanPrincipalId: "human-1",
      displayName: "Ada",
      membershipActive: true
    },
    body,
    bodyFormat: "markdown" as const,
    revision,
    createdAt: `2030-01-01T00:00:0${id.slice(-1)}.000Z`,
    updatedAt: `2030-01-01T00:00:0${id.slice(-1)}.000Z`,
    tombstoned: false,
    attachments: [],
    workItemPresence: "present" as const
  };
}

export function createApi() {
  let status = connectedStatus();
  const statusListeners = new Set<(status: CollaborationStatus) => void>();
  const observerListeners = new Set<(signal: CollaborationObserverSignal) => void>();
  const listComments = vi.fn().mockImplementation(async (query: { cursor?: unknown }) => {
    if (query?.cursor) {
      return {
        items: [commentProjection("comment-0", "older")],
        nextCursor: null
      };
    }
    return {
      items: [
        { ...commentProjection("comment-1", "first"), projectId: status.profiles[0]!.projectId }
      ],
      nextCursor: { createdAt: "2030-01-01T00:00:01.000Z", commentId: "comment-1" }
    };
  });
  const listActivity = vi.fn().mockImplementation(async (query: { cursor?: unknown }) => {
    if (query?.cursor) {
      return { items: [], nextCursor: null };
    }
    return {
      items: [
        {
          activityId: "act-1",
          projectId: "project-1",
          type: "comment_created",
          source: { kind: "comment", sourceId: "comment-1" },
          summary: { headline: "Ada commented", commentId: "comment-1", workItem: taskItem },
          subjects: [{ kind: "human", humanPrincipalId: "human-1", displayName: "Ada" }],
          workItem: taskItem,
          occurredAt: "2030-01-01T00:00:01.000Z"
        }
      ],
      nextCursor: { occurredAt: "2030-01-01T00:00:01.000Z", activityId: "act-1" }
    };
  });

  const createComment = vi.fn().mockResolvedValue(commentProjection("comment-2", "new", 1));
  const editComment = vi.fn().mockResolvedValue(commentProjection("comment-1", "edited", 2));
  const tombstoneComment = vi.fn().mockResolvedValue({
    ...commentProjection("comment-1", "first", 3),
    body: null,
    tombstoned: true,
    tombstonedAt: "2030-01-01T00:05:00.000Z"
  });
  const readCommentAttachment = vi.fn().mockResolvedValue({
    digestSha256: "a".repeat(64),
    mediaType: "image/png",
    sizeBytes: 4,
    bodyBase64: "iVBORw=="
  });

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
    listCollaborationEligibleAssignees: vi.fn().mockResolvedValue({
      workItem: taskItem,
      humans: [],
      hosts: [],
      nextHumanCursor: null,
      nextHostCursor: null
    }),
    listCollaborationComments: listComments,
    listCollaborationActivity: listActivity,
    updateCollaborationAssignment: vi.fn(),
    createCollaborationComment: createComment,
    editCollaborationComment: editComment,
    tombstoneCollaborationComment: tombstoneComment,
    createCollaborationPendingAttachment: vi.fn(),
    uploadCollaborationPendingAttachment: vi.fn(),
    finalizeCollaborationPendingAttachment: vi.fn(),
    readCollaborationPendingAttachment: vi.fn(),
    readCollaborationCommentAttachment: readCommentAttachment,
    onCollaborationStatusChanged: vi.fn((listener: (next: CollaborationStatus) => void) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    }),
    onCollaborationObserverSignal: vi.fn(
      (listener: (signal: CollaborationObserverSignal) => void) => {
        observerListeners.add(listener);
        return () => {
          observerListeners.delete(listener);
        };
      }
    )
  } as unknown as PlanWeaveCollaborationApi & CollaborationReadBridgePort;

  return {
    api,
    emitObserver: (signal: CollaborationObserverSignal) => {
      for (const listener of observerListeners) listener(signal);
    },
    listComments,
    listActivity,
    createComment,
    editComment,
    tombstoneComment,
    readCommentAttachment,
    emitStatus: (next: CollaborationStatus) => {
      status = next;
      for (const listener of statusListeners) listener(status);
    },
    changeStatus: (
      projectId: string,
      profileId = "profile-1",
      credentialRevision: string | null = null
    ) => {
      status = connectedStatus();
      status.activeProfileId = profileId;
      status.session.activeProfileId = profileId;
      status.profiles[0] = { ...status.profiles[0]!, projectId, profileId, credentialRevision };
      for (const listener of statusListeners) listener(status);
    }
  };
}
