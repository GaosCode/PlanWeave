import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommentAttachmentBlobStore,
  CommentAttachmentRepository,
  CommentAttachmentService
} from "../attachments/index.js";
import { ActivityRepository } from "../comments/activityRepository.js";
import { CommentRepository } from "../comments/repository.js";
import {
  ActivityProjectionService,
  CommentService,
  CommentServiceError
} from "../comments/service.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import type { HumanAuthContext } from "../identity/schemas.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import type { WorkItemPackageFacts, WorkItemRef } from "../work/schemas.js";
import type { WorkItemPackagePort } from "../work/workItemFacts.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const projectId = "project-a";
const workspaceId = "workspace-a";
const now = new Date("2026-07-24T15:00:00.000Z");
const taskItem: WorkItemRef = { kind: "task", canvasId: "default", taskId: "T-001" };
const missingItem: WorkItemRef = {
  kind: "task",
  canvasId: "default",
  taskId: "T-GONE"
};

function packageFactsFor(workItem: WorkItemRef): WorkItemPackageFacts {
  if (workItem.kind === "task" && workItem.taskId === "T-001") {
    return {
      canvasId: "default",
      kind: "task",
      exists: true,
      taskId: "T-001",
      requiredCapabilities: []
    };
  }
  return {
    canvasId: workItem.canvasId,
    kind: workItem.kind,
    exists: false,
    taskId: workItem.kind === "task" ? workItem.taskId : undefined,
    blockRef: workItem.kind === "block" ? workItem.blockRef : undefined,
    requiredCapabilities: []
  };
}

const packagePort: WorkItemPackagePort = {
  resolveWorkItem(workItem) {
    return packageFactsFor(workItem);
  },
  resolveWorkItems(workItems) {
    return workItems.map(packageFactsFor);
  }
};

async function openStack() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-comment-svc-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);

  const identity = new HumanIdentityRepository(database, () => now);
  const ownerBoot = identity.bootstrapOwner({
    kind: "local_administrative_proof",
    projectId,
    humanPrincipalId: "human-owner",
    displayName: "Ada Owner",
    issuedAt: now.toISOString()
  });
  const invite = identity.createInvitation({
    projectId,
    createdByHumanPrincipalId: ownerBoot.principal.humanPrincipalId
  });
  const member = identity.consumeInvitation({
    invitationToken: invite.invitationToken,
    projectId,
    displayName: "Bob Member"
  });

  const ownerContext: HumanAuthContext = {
    humanPrincipalId: ownerBoot.principal.humanPrincipalId,
    displayName: ownerBoot.principal.displayName,
    deviceCredentialId: ownerBoot.device.deviceCredentialId,
    projectId,
    role: "owner",
    membershipId: ownerBoot.membership.membershipId
  };
  const memberContext: HumanAuthContext = {
    humanPrincipalId: member.principal.humanPrincipalId,
    displayName: member.principal.displayName,
    deviceCredentialId: member.device.deviceCredentialId,
    projectId,
    role: "member",
    membershipId: member.membership.membershipId
  };

  const comments = new CommentRepository(database);
  const activity = new ActivityRepository(database);
  const attachmentRepository = new CommentAttachmentRepository(database);
  const blobs = new CommentAttachmentBlobStore(database, directory);
  const attachmentService = new CommentAttachmentService({
    repository: attachmentRepository,
    blobs,
    identity,
    clock: () => now
  });

  const service = new CommentService({
    workspaceId,
    comments,
    activity,
    packagePort,
    identity,
    attachments: attachmentService,
    attachmentRepository,
    authorizeMutation() {},
    authorMembershipActive(humanPrincipalId) {
      return identity.getActiveMembership(projectId, humanPrincipalId) !== undefined;
    },
    clock: () => now
  });
  const projection = new ActivityProjectionService({ activity, clock: () => now });

  return {
    directory,
    database,
    identity,
    comments,
    activity,
    attachmentRepository,
    attachmentService,
    service,
    projection,
    ownerContext,
    memberContext,
    ownerBoot,
    member
  };
}

async function stageAttachment(
  stack: Awaited<ReturnType<typeof openStack>>,
  actor: HumanAuthContext,
  body: string
) {
  const bytes = Buffer.from(body, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const pending = stack.attachmentService.createPendingUpload({
    actor,
    workspaceId,
    projectId,
    expectedSizeBytes: bytes.byteLength,
    mediaType: "text/plain",
    fileName: "note.txt",
    expectedDigestSha256: digest
  });
  await stack.attachmentService.uploadBody({
    actor,
    workspaceId,
    projectId,
    pendingUploadId: pending.pendingUploadId,
    declaredDigestSha256: digest,
    contentLength: bytes.byteLength,
    mediaType: "text/plain",
    chunks: (async function* () {
      yield bytes;
    })()
  });
  return {
    pendingUploadId: pending.pendingUploadId,
    digestSha256: digest,
    sizeBytes: bytes.byteLength,
    mediaType: "text/plain" as const,
    fileName: "note.txt" as const
  };
}

describe("CommentService", () => {
  it("creates, lists, edits, tombstones with redaction and activity projection", async () => {
    const stack = await openStack();
    const attachment = await stageAttachment(stack, stack.memberContext, "blob-body");

    const created = stack.service.createComment({
      projectId,
      workItem: taskItem,
      body: "first comment",
      actor: stack.memberContext,
      attachments: [attachment]
    });
    expect(created.record.revision).toBe(1);
    expect(created.record.attachments).toHaveLength(1);
    expect(created.display.body).toBe("first comment");
    expect(created.display.workItemPresence).toBe("present");

    const binding = stack.attachmentRepository.getBinding(
      workspaceId,
      projectId,
      created.record.commentId,
      attachment.digestSha256
    );
    expect(binding).toBeDefined();

    const listed = stack.service.listComments({
      projectId,
      workItem: taskItem,
      actor: stack.memberContext
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.nextCursor).toBeNull();

    const edited = stack.service.editComment({
      projectId,
      commentId: created.record.commentId,
      body: "edited body",
      expectedRevision: 1,
      actor: stack.memberContext
    });
    expect(edited.record.revision).toBe(2);
    expect(edited.display.body).toBe("edited body");

    const tombstoned = stack.service.tombstoneComment({
      projectId,
      commentId: created.record.commentId,
      expectedRevision: 2,
      actor: stack.ownerContext,
      reason: "moderation"
    });
    expect(tombstoned.display.tombstoned).toBe(true);
    expect(tombstoned.display.body).toBeNull();
    // Durable audit retention
    expect(tombstoned.record.body).toBe("edited body");

    const active = stack.service.listComments({
      projectId,
      workItem: taskItem,
      actor: stack.memberContext,
      includeTombstoned: false
    });
    expect(active.items).toHaveLength(0);

    const withTomb = stack.service.listComments({
      projectId,
      workItem: taskItem,
      actor: stack.memberContext,
      includeTombstoned: true
    });
    expect(withTomb.items[0]?.body).toBeNull();

    const feed = stack.service.listActivity({
      projectId,
      actor: stack.memberContext
    });
    const types = feed.items.map((i) => i.type);
    expect(types).toEqual(
      expect.arrayContaining(["comment_created", "comment_edited", "comment_tombstoned"])
    );
  });

  it("rejects missing work items, non-authors, revision conflicts, and removed members", async () => {
    const stack = await openStack();

    expect(() =>
      stack.service.createComment({
        projectId,
        workItem: missingItem,
        body: "nope",
        actor: stack.memberContext
      })
    ).toThrowError(/comment_work_item_not_found|Work item/);

    const created = stack.service.createComment({
      projectId,
      workItem: taskItem,
      body: "mine",
      actor: stack.memberContext
    });

    expect(() =>
      stack.service.editComment({
        projectId,
        commentId: created.record.commentId,
        body: "hijack",
        expectedRevision: 1,
        actor: stack.ownerContext
      })
    ).toThrow(CommentServiceError);

    expect(() =>
      stack.service.editComment({
        projectId,
        commentId: created.record.commentId,
        body: "stale",
        expectedRevision: 99,
        actor: stack.memberContext
      })
    ).toThrow(CommentServiceError);

    // Remove member — auth context is stale; mutations must fail closed.
    stack.identity.removeMember(projectId, stack.memberContext.humanPrincipalId);
    expect(() =>
      stack.service.createComment({
        projectId,
        workItem: taskItem,
        body: "after removal",
        actor: stack.memberContext
      })
    ).toThrow(CommentServiceError);

    // Orphaned comments remain listable for remaining members; author shows inactive.
    const listed = stack.service.listComments({
      projectId,
      workItem: taskItem,
      actor: stack.ownerContext
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.author.membershipActive).toBe(false);
  });

  it("keeps comments readable when work item is later missing from package", async () => {
    const stack = await openStack();
    stack.service.createComment({
      projectId,
      workItem: taskItem,
      body: "before rename",
      actor: stack.memberContext
    });

    const missingPort: WorkItemPackagePort = {
      resolveWorkItem() {
        return {
          canvasId: "default",
          kind: "task",
          exists: false,
          taskId: "T-001",
          requiredCapabilities: []
        };
      },
      resolveWorkItems(workItems) {
        return workItems.map(() => this.resolveWorkItem(taskItem));
      }
    };
    const orphanService = new CommentService({
      workspaceId,
      comments: stack.comments,
      activity: stack.activity,
      packagePort: missingPort,
      identity: stack.identity,
      authorizeMutation() {},
      authorMembershipActive(humanPrincipalId) {
        return stack.identity.getActiveMembership(projectId, humanPrincipalId) !== undefined;
      },
      clock: () => now
    });
    const page = orphanService.listComments({
      projectId,
      workItem: taskItem,
      actor: stack.memberContext
    });
    expect(page.items[0]?.workItemPresence).toBe("missing");
    expect(page.items[0]?.body).toBe("before rename");

    // Create on missing ref fails.
    expect(() =>
      orphanService.createComment({
        projectId,
        workItem: taskItem,
        body: "new",
        actor: stack.memberContext
      })
    ).toThrow(CommentServiceError);
  });

  it("isolates activity by project and supports membership/assignment/remote projection + reconcile", async () => {
    const stack = await openStack();
    stack.service.createComment({
      projectId,
      workItem: taskItem,
      body: "in a",
      actor: stack.memberContext
    });

    // Second project with owner.
    const otherBoot = stack.identity.bootstrapOwner({
      kind: "local_administrative_proof",
      projectId: "project-b",
      humanPrincipalId: "human-owner-b",
      displayName: "Other Owner",
      issuedAt: now.toISOString()
    });
    const otherCtx: HumanAuthContext = {
      humanPrincipalId: otherBoot.principal.humanPrincipalId,
      displayName: otherBoot.principal.displayName,
      deviceCredentialId: otherBoot.device.deviceCredentialId,
      projectId: "project-b",
      role: "owner",
      membershipId: otherBoot.membership.membershipId
    };
    const otherComments = new CommentService({
      workspaceId: "workspace-b",
      comments: stack.comments,
      activity: stack.activity,
      packagePort,
      identity: stack.identity,
      authorizeMutation() {},
      authorMembershipActive(humanPrincipalId) {
        return stack.identity.getActiveMembership("project-b", humanPrincipalId) !== undefined;
      },
      clock: () => now
    });
    // packagePort allows T-001 for any project id (facts are package-local).
    otherComments.createComment({
      projectId: "project-b",
      workItem: taskItem,
      body: "in b",
      actor: otherCtx
    });

    const feedA = stack.service.listActivity({
      projectId,
      actor: stack.memberContext
    });
    expect(feedA.items.every((i) => i.projectId === projectId)).toBe(true);
    expect(feedA.items.some((i) => i.summary.headline?.includes("in b"))).toBe(false);

    const membership = stack.projection.projectMembershipEvent({
      projectId,
      type: "member_joined",
      membershipId: stack.member.membership.membershipId,
      transitionRevision: stack.member.membership.revision,
      humanPrincipalId: stack.memberContext.humanPrincipalId,
      displayName: stack.memberContext.displayName,
      membershipRole: "member"
    });
    expect(membership.inserted).toBe(true);
    // Idempotent source
    const again = stack.projection.projectMembershipEvent({
      projectId,
      type: "member_joined",
      membershipId: stack.member.membership.membershipId,
      transitionRevision: stack.member.membership.revision,
      humanPrincipalId: stack.memberContext.humanPrincipalId,
      displayName: stack.memberContext.displayName,
      membershipRole: "member"
    });
    expect(again.inserted).toBe(false);

    stack.projection.projectAssignmentEvent({
      projectId,
      workItem: taskItem,
      assignmentRevision: 1,
      targetHeadline: "Assigned T-001 to Bob",
      actor: {
        kind: "human",
        humanPrincipalId: stack.ownerContext.humanPrincipalId,
        displayName: stack.ownerContext.displayName
      }
    });
    stack.projection.projectRemoteRunEvent({
      projectId,
      type: "remote_run_started",
      dispatchId: "dispatch-1",
      hostId: "host-1",
      workItem: { kind: "block", canvasId: "default", blockRef: "T-001#B-001" }
    });

    // Force outbox gap recovery path.
    const gapRecord = {
      activityId: "act-manual-gap",
      projectId,
      type: "remote_run_failed" as const,
      source: { kind: "remote_run" as const, sourceId: "dispatch-2:failed" },
      summary: {
        headline: "Remote run failed",
        dispatchId: "dispatch-2"
      },
      subjects: [{ kind: "system" as const }],
      occurredAt: "2026-07-24T16:00:00.000Z"
    };
    stack.activity.database
      .prepare(
        `INSERT INTO activity_projection_outbox(
          outbox_id,workspace_id,project_id,source_kind,source_id,activity_json,activity_occurred_at,
          created_at,projected_at
        ) VALUES (?,?,?,?,?,?,?,?, NULL)`
      )
      .run(
        "outbox-manual",
        "legacy",
        projectId,
        "remote_run",
        "dispatch-2:failed",
        JSON.stringify(gapRecord),
        gapRecord.occurredAt,
        gapRecord.occurredAt
      );
    const recon = stack.projection.reconcileOutbox(20);
    expect(recon.processed).toBeGreaterThanOrEqual(1);
    expect(stack.activity.getBySource(projectId, "remote_run", "dispatch-2:failed")).toBeDefined();

    const full = stack.service.listActivity({
      projectId,
      actor: stack.ownerContext,
      limit: 50
    });
    const types = new Set(full.items.map((i) => i.type));
    expect(types.has("member_joined")).toBe(true);
    expect(types.has("assignment_updated")).toBe(true);
    expect(types.has("remote_run_started")).toBe(true);
    expect(types.has("remote_run_failed")).toBe(true);
  });

  it("enforces concurrent CAS losers on edit", async () => {
    const stack = await openStack();
    const created = stack.service.createComment({
      projectId,
      workItem: taskItem,
      body: "race base",
      actor: stack.memberContext
    });

    const winner = stack.service.editComment({
      projectId,
      commentId: created.record.commentId,
      body: "winner",
      expectedRevision: 1,
      actor: stack.memberContext
    });
    expect(winner.record.revision).toBe(2);

    expect(() =>
      stack.service.editComment({
        projectId,
        commentId: created.record.commentId,
        body: "loser",
        expectedRevision: 1,
        actor: stack.memberContext
      })
    ).toThrow(CommentServiceError);
  });
});
