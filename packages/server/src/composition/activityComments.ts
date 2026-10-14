import { CommentAttachmentMaintenance } from "../attachments/maintenance.js";
import type { CommentAttachmentServiceOptions } from "../attachments/service.js";
import type { SqliteDatabase } from "../sqlite.js";
import { ArtifactStore } from "../artifacts.js";
import {
  ActivityProjectionService,
  ActivityRepository,
  ActivityRetentionMaintenance,
  type ActivityRecord,
  CommentRepository,
  CommentService,
  CommentServiceError
} from "../comments/index.js";
import {
  CommentAttachmentBlobStore,
  CommentAttachmentRepository,
  CommentAttachmentService
} from "../attachments/index.js";
import { CommentAttachmentDigestLifecycle } from "../attachments/digestLifecycle.js";
import { observerEventsForActivity } from "../humanObserverActivity.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import type { HumanIdentityRepository } from "../identity/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { ServerConfig } from "../config.js";
import type { CollaborationScopeAuthority } from "../identity/index.js";
import { ContentVersionRepository } from "../canvas/index.js";
import { createRoutedWorkItemPackagePort } from "../work/ports.js";
import { createCommentWorkItemResolver } from "./commentWorkItemResolver.js";

function appendHumanObserverActivity(
  journal: HumanObserverJournal,
  workspaceId: string | undefined,
  record: ActivityRecord
): void {
  if (!workspaceId) throw new Error("human_observer_workspace_scope_unresolved");
  for (const event of observerEventsForActivity(record)) {
    journal.appendInCallerTransaction(
      { workspaceId, projectId: record.projectId },
      event,
      record.occurredAt
    );
  }
}

export function createActivityJournalComposition(input: {
  database: SqliteDatabase;
  config: ServerConfig;
  clock: () => Date;
}) {
  const artifactStore = new ArtifactStore(
    input.database,
    input.config.dataDirectory,
    input.config.limits.maxArtifactBytes
  );
  const humanObserverJournal = new HumanObserverJournal(
    input.database,
    input.config.limits.eventRetentionMaxEvents,
    input.clock
  );
  const activityRepository = new ActivityRepository(input.database, {
    onInsertedInTransaction: (record) =>
      appendHumanObserverActivity(
        humanObserverJournal,
        new WorkspaceIdentityRepository(input.database).workspaceForLegacyProject(record.projectId),
        record
      )
  });
  const activityProjection = new ActivityProjectionService({
    activity: activityRepository,
    clock: input.clock
  });
  const assignmentActivityProjections = new Map<string, ActivityProjectionService>();
  const assignmentActivityProjection = (workspaceId: string) => {
    let scoped = assignmentActivityProjections.get(workspaceId);
    if (!scoped) {
      scoped = new ActivityProjectionService({
        activity: new ActivityRepository(input.database, {
          workspaceId,
          onInsertedInTransaction: (record) =>
            appendHumanObserverActivity(humanObserverJournal, workspaceId, record)
        }),
        clock: input.clock
      });
      assignmentActivityProjections.set(workspaceId, scoped);
    }
    return scoped;
  };
  return {
    artifactStore,
    humanObserverJournal,
    activityRepository,
    activityProjection,
    assignmentActivityProjection
  };
}

export type ActivityJournalComposition = ReturnType<typeof createActivityJournalComposition>;

export function createActivityCommentsComposition(input: {
  database: SqliteDatabase;
  config: ServerConfig;
  clock: () => Date;
  collaborationScopeAuthority: CollaborationScopeAuthority;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAccess: ProjectAccessRepository;
  humanIdentity: HumanIdentityRepository;
  activity: ActivityJournalComposition;
}) {
  const canRead: CommentAttachmentServiceOptions["canRead"] = ({
    actor,
    workspaceId,
    projectId,
    canvasId
  }) => {
    try {
      input.projectAccess.policy.assertCapability({
        workspaceId,
        projectId,
        canvasId,
        actor: { kind: "human", id: actor.humanPrincipalId },
        capability: "read"
      });
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "access_scope_not_found" ||
          error.message.startsWith("access_capability_denied:"))
      )
        return false;
      throw error;
    }
  };
  const commentAttachmentRepository = new CommentAttachmentRepository(input.database, {
    onMutationInTransaction: (mutation) => {
      input.activity.humanObserverJournal.appendInCallerTransaction(
        { workspaceId: mutation.workspaceId, projectId: mutation.projectId },
        {
          kind: "attachment",
          ...(mutation.commentId
            ? {
                commentId: mutation.commentId,
                workItem: new CommentRepository(input.database, mutation.workspaceId).get(
                  mutation.projectId,
                  mutation.commentId
                )?.workItem
              }
            : {})
        },
        mutation.occurredAt
      );
    }
  });
  const commentAttachments = new CommentAttachmentService({
    repository: commentAttachmentRepository,
    lifecycle: new CommentAttachmentDigestLifecycle(input.database, input.config.dataDirectory),
    blobs: new CommentAttachmentBlobStore(input.database, input.config.dataDirectory),
    identity: input.humanIdentity,
    canRead,
    clock: input.clock
  });
  const contentVersions = new ContentVersionRepository(input.database, input.clock);
  const resolveWorkItems = createCommentWorkItemResolver({
    contentVersions,
    hasScope: (scope) => input.collaborationScopeAuthority.hasScope(scope)
  });
  const commentServices = new Map<string, CommentService>();
  const resolveCommentService = (workspaceId: string, projectId: string) => {
    if (!input.collaborationScopeAuthority.hasScope({ workspaceId, projectId })) return undefined;
    const serviceKey = collaborationScopeKey(workspaceId, projectId);
    let service = commentServices.get(serviceKey);
    if (!service) {
      const packagePort = createRoutedWorkItemPackagePort((canvasId) =>
        resolveWorkItems({ workspaceId, projectId, canvasId })
      );
      service = new CommentService({
        workspaceId,
        comments: new CommentRepository(input.database, workspaceId),
        activity: new ActivityRepository(input.database, {
          workspaceId,
          onInsertedInTransaction: (record) =>
            appendHumanObserverActivity(input.activity.humanObserverJournal, workspaceId, record)
        }),
        packagePort,
        identity: input.humanIdentity,
        attachments: commentAttachments,
        attachmentRepository: commentAttachmentRepository,
        canRead(actor, canvasId) {
          return canRead({ actor, workspaceId, projectId, canvasId });
        },
        canListActivity(actor) {
          const identity = { kind: "human" as const, id: actor.humanPrincipalId };
          return (
            canRead({ actor, workspaceId, projectId }) ||
            input.projectAccess.listAuthorizedCanvases({
              workspaceId,
              projectId,
              actor: identity,
              limit: 1
            }).length > 0
          );
        },
        authorizeMutation(actor, workItem) {
          try {
            input.projectAccess.policy.assertCapability({
              workspaceId,
              projectId: actor.projectId,
              canvasId: workItem.canvasId,
              actor: { kind: "human", id: actor.humanPrincipalId },
              capability: "comment"
            });
          } catch {
            throw new CommentServiceError("comment_auth_forbidden");
          }
        },
        authorMembershipActive(humanPrincipalId) {
          return input.workspaceIdentity.hasActiveMembership(workspaceId, humanPrincipalId);
        },
        assertMembership(actor) {
          const membership = input.workspaceIdentity.findActiveMembership(
            workspaceId,
            actor.humanPrincipalId
          );
          if (!membership || membership.role !== actor.role) {
            throw new CommentServiceError("comment_auth_forbidden");
          }
        },
        clock: input.clock
      });
      commentServices.set(serviceKey, service);
    }
    return service;
  };
  const retention = new ActivityRetentionMaintenance(
    input.activity.activityRepository,
    input.clock
  );
  return {
    commentAttachments,
    attachmentMaintenance: new CommentAttachmentMaintenance(commentAttachments),
    resolveCommentService,
    retention
  };
}

function collaborationScopeKey(workspaceId: string, projectId: string): string {
  return `${workspaceId}\u0000${projectId}`;
}
