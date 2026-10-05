import { describe, expect, it } from "vitest";
import type {
  ActivityRecord,
  CommentDisplayProjection
} from "@planweave-ai/collaboration-protocol/activity/comments";
import {
  buildActivityRowViewModel,
  buildCommentRowViewModel,
  looksLikeFilesystemPath,
  resolveCommentActions,
  resolveCommentsPanelMode,
  sanitizeAttachmentFileName
} from "../renderer/collaboration/commentViewModels";

const baseComment: CommentDisplayProjection = {
  commentId: "comment-1",
  projectId: "project-1",
  workItem: { kind: "task", canvasId: "canvas-1", taskId: "T-1" },
  author: {
    humanPrincipalId: "human-1",
    displayName: "Ada",
    membershipActive: true
  },
  body: "Hello **world**",
  bodyFormat: "markdown",
  revision: 2,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:01:00.000Z",
  tombstoned: false,
  attachments: [
    {
      digestSha256: "a".repeat(64),
      sizeBytes: 12,
      mediaType: "text/plain",
      fileName: "../../etc/passwd"
    }
  ],
  workItemPresence: "present"
};

describe("commentViewModels", () => {
  it("resolves author and owner action visibility", () => {
    expect(
      resolveCommentActions({
        comment: baseComment,
        currentHumanPrincipalId: "human-1",
        currentUserIsOwner: false,
        canMutate: true
      })
    ).toMatchObject({
      hasEditPermission: true,
      canEdit: true,
      canTombstone: true,
      reason: "author"
    });

    expect(
      resolveCommentActions({
        comment: baseComment,
        currentHumanPrincipalId: "human-2",
        currentUserIsOwner: true,
        canMutate: true
      })
    ).toMatchObject({
      hasEditPermission: false,
      canEdit: false,
      canTombstone: true,
      reason: "owner"
    });

    expect(
      resolveCommentActions({
        comment: { ...baseComment, tombstoned: true },
        currentHumanPrincipalId: "human-1",
        currentUserIsOwner: true,
        canMutate: true
      })
    ).toMatchObject({
      hasEditPermission: false,
      canEdit: false,
      canTombstone: false,
      reason: "tombstoned"
    });

    for (const membershipActive of [true, false]) {
      expect(
        resolveCommentActions({
          comment: { ...baseComment, author: { ...baseComment.author, membershipActive } },
          currentHumanPrincipalId: "human-1",
          currentUserIsOwner: false,
          canMutate: false
        })
      ).toMatchObject({
        hasEditPermission: membershipActive,
        canEdit: false,
        canTombstone: false,
        reason: "offline"
      });
    }
  });

  it("sanitizes attachment names and never surfaces path segments", () => {
    expect(sanitizeAttachmentFileName("../../secret/token.bin")).toBe("token.bin");
    expect(sanitizeAttachmentFileName("C:\\\\Users\\\\a\\\\x.png")).toBe("x.png");
    const row = buildCommentRowViewModel({
      comment: baseComment,
      currentHumanPrincipalId: "human-1",
      currentUserIsOwner: false,
      canMutate: true,
      removedMemberLabel: "removed",
      tombstonedLabel: "removed comment"
    });
    expect(row.attachments[0]?.displayName).toBe("passwd");
    expect(looksLikeFilesystemPath(row.attachments[0]?.displayName ?? "")).toBe(false);
  });

  it("marks activity rows non-interactive and distinguishes sources", () => {
    const membership: ActivityRecord = {
      activityId: "act-1",
      projectId: "project-1",
      type: "member_joined",
      source: { kind: "membership", sourceId: "m-1" },
      summary: { headline: "Ada joined" },
      subjects: [{ kind: "human", humanPrincipalId: "human-1", displayName: "Ada" }],
      occurredAt: "2030-01-01T00:00:00.000Z"
    };
    const remote: ActivityRecord = {
      activityId: "act-2",
      projectId: "project-1",
      type: "remote_run_started",
      source: { kind: "remote_run", sourceId: "dispatch-1" },
      summary: {
        headline: "Remote run started",
        workItem: { kind: "block", canvasId: "canvas-1", blockRef: "T-1#B-001" },
        dispatchId: "dispatch-1"
      },
      subjects: [{ kind: "host", hostId: "host-1", displayName: "Builder" }],
      workItem: { kind: "block", canvasId: "canvas-1", blockRef: "T-1#B-001" },
      occurredAt: "2030-01-01T00:02:00.000Z"
    };
    expect(buildActivityRowViewModel(membership)).toMatchObject({
      interactive: false,
      sourceLabelKey: "activitySourceMembership"
    });
    expect(buildActivityRowViewModel(remote)).toMatchObject({
      interactive: false,
      sourceLabelKey: "activitySourceRemoteRun",
      workItemLabel: "Block T-1#B-001"
    });
  });

  it("maps disconnected and offline panel modes", () => {
    expect(
      resolveCommentsPanelMode({
        sessionConnected: false,
        sessionPhase: "idle",
        syncPhase: "idle",
        loading: false,
        hasComments: false,
        lastErrorKind: null
      })
    ).toBe("disconnected");
    expect(
      resolveCommentsPanelMode({
        sessionConnected: true,
        sessionPhase: "connected",
        syncPhase: "reconnecting",
        loading: false,
        hasComments: true,
        lastErrorKind: null
      })
    ).toBe("offline");
  });
});
