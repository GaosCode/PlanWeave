import type { SqliteDatabase } from "../sqlite.js";
import { decodeCanvasReplicaDocument } from "@planweave-ai/runtime";
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
import { observerEventsForActivity } from "../humanObserverActivity.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import type { HumanIdentityRepository } from "../identity/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { ServerConfig } from "../config.js";
import type { HumanProjectAuthority } from "../identity/index.js";
import { ContentVersionRepository } from "../canvas/index.js";
import { createRoutedWorkItemPackagePort } from "../work/ports.js";
import { createManifestWorkItemPort } from "../work/workItemFacts.js";

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
  projectAuthority: HumanProjectAuthority;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAccess: ProjectAccessRepository;
  humanIdentity: HumanIdentityRepository;
  activity: ActivityJournalComposition;
}) {
  const commentAttachmentRepository = new CommentAttachmentRepository(input.database, {
    onMutationInTransaction: (mutation) => {
      input.activity.humanObserverJournal.appendInCallerTransaction(
        { workspaceId: mutation.workspaceId, projectId: mutation.projectId },
        {
          kind: "attachment",
          ...(mutation.commentId ? { commentId: mutation.commentId } : {})
        },
        mutation.occurredAt
      );
    }
  });
  const commentAttachments = new CommentAttachmentService({
    repository: commentAttachmentRepository,
    blobs: new CommentAttachmentBlobStore(input.database, input.config.dataDirectory),
    clock: input.clock
  });
  const contentVersions = new ContentVersionRepository(input.database, input.clock);
  const commentServices = new Map<string, CommentService>();
  const resolveCommentService = (workspaceId: string, projectId: string) => {
    if (!input.projectAuthority.hasScope({ workspaceId, projectId })) return undefined;
    const serviceKey = collaborationScopeKey(workspaceId, projectId);
    let service = commentServices.get(serviceKey);
    if (!service) {
      const packagePort = createRoutedWorkItemPackagePort((canvasId) => {
        const scope = { workspaceId, projectId, canvasId };
        if (!input.projectAuthority.hasScope(scope)) return undefined;
        const head = contentVersions.head(scope);
        if (!head) return undefined;
        const content = contentVersions.readVersion(scope, head.content).content;
        const document = decodeCanvasReplicaDocument(content);
        return createManifestWorkItemPort(document.manifest, canvasId);
      });
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
          return input.workspaceIdentity
            .listMembershipViews(workspaceId)
            .some(
              (candidate) =>
                candidate.humanPrincipalId === humanPrincipalId && candidate.revokedAt === null
            );
        },
        assertMembership(actor) {
          const membership = input.workspaceIdentity
            .listMembershipViews(workspaceId)
            .find(
              (candidate) =>
                candidate.humanPrincipalId === actor.humanPrincipalId &&
                candidate.revokedAt === null
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
    resolveCommentService,
    retention
  };
}

function collaborationScopeKey(workspaceId: string, projectId: string): string {
  return `${workspaceId}\u0000${projectId}`;
}
