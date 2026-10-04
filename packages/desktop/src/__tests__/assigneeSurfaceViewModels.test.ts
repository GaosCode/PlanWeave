import { describe, expect, it } from "vitest";
import {
  exampleActivityListPage,
  exampleAssignmentProjection
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import {
  buildAssigneeSurfaceIndex,
  buildCollaborationNotificationDrafts,
  buildCompactAssigneeChip,
  lookupBlockAssigneeChip,
  lookupTaskCardAssigneeChip,
  taskWorkItemKey
} from "../renderer/collaboration/assigneeSurfaceViewModels";
import { assigneeDisplayLabelsFromTranslator } from "../renderer/collaboration/assignmentViewModels";
import { createTranslator } from "../renderer/i18n";
import type { CollaborationReadModelSnapshot } from "../shared/collaborationReadModels";
import { workItemKey } from "../shared/collaborationReadModels";

function baseSnapshot(
  overrides: Partial<CollaborationReadModelSnapshot> = {}
): CollaborationReadModelSnapshot {
  return {
    profileId: "profile-1",
    projectId: "project-1",
    canvasId: "canvas-1",
    syncPhase: "ready",
    observerCursor: 1,
    members: [],
    hosts: [],
    assignmentsByWorkItem: {},
    workAuthorityByWorkItem: {},
    commentsByWorkItem: {},
    activity: [],
    remoteRunsByDispatchId: {},
    mutationsById: {},
    lastError: null,
    loadingKinds: [],
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("assigneeSurfaceViewModels", () => {
  it("hides unassigned chips without issues on dense surfaces", () => {
    const unassigned = buildCompactAssigneeChip(
      {
        ...exampleAssignmentProjection,
        target: { kind: "unassigned" },
        availability: { status: "unassigned", reason: "unassigned" },
        human: undefined,
        host: undefined
      },
      exampleAssignmentProjection.workItem
    );
    expect(unassigned.visible).toBe(false);
    expect(unassigned.tone).toBe("unassigned");
  });

  it("indexes assignments and resolves task/block chips by stable keys", () => {
    const assignment = {
      ...exampleAssignmentProjection,
      workItem: {
        kind: "block" as const,
        canvasId: "canvas-1",
        blockRef: "T-1#B-001"
      },
      target: { kind: "human" as const, humanPrincipalId: "human-1" },
      human: {
        humanPrincipalId: "human-1",
        displayName: "Ada",
        membershipActive: true
      },
      availability: { status: "ready" as const, reason: "ready" as const }
    };
    const index = buildAssigneeSurfaceIndex(
      baseSnapshot({
        assignmentsByWorkItem: {
          [workItemKey(assignment.workItem)]: assignment
        }
      })
    );
    expect(index.surfaceActive).toBe(true);
    expect(lookupBlockAssigneeChip(index, "canvas-1", "T-1#B-001")?.label).toBe("Ada");
    expect(lookupTaskCardAssigneeChip(index, "canvas-1", "T-1", ["T-1#B-001"])?.workItemKey).toBe(
      workItemKey(assignment.workItem)
    );
    expect(taskWorkItemKey("canvas-1", "T-1")).toBe(
      workItemKey({ kind: "task", canvasId: "canvas-1", taskId: "T-1" })
    );
  });

  it("localizes automatic host compact chips via catalog labels", () => {
    const zhLabels = assigneeDisplayLabelsFromTranslator(createTranslator("zh-CN"));
    const assignment = {
      ...exampleAssignmentProjection,
      workItem: {
        kind: "block" as const,
        canvasId: "canvas-1",
        blockRef: "T-1#B-001"
      },
      target: { kind: "automatic_host" as const },
      human: undefined,
      host: undefined,
      availability: {
        status: "pending" as const,
        reason: "automatic_pending_selection" as const
      }
    };
    const chip = buildCompactAssigneeChip(assignment, assignment.workItem, zhLabels);
    expect(chip.label).toBe("自动 Host");
    expect(chip.visible).toBe(true);

    const index = buildAssigneeSurfaceIndex(
      baseSnapshot({
        assignmentsByWorkItem: {
          [workItemKey(assignment.workItem)]: assignment
        }
      }),
      zhLabels
    );
    expect(lookupBlockAssigneeChip(index, "canvas-1", "T-1#B-001")?.label).toBe("自动 Host");
  });

  it("builds collaboration notifications from activity and confirmed/rejected mutations only", () => {
    const drafts = buildCollaborationNotificationDrafts({
      scope: baseSnapshot(),
      activity: [
        {
          ...exampleActivityListPage.items[0]!,
          activityId: "activity-assign-1",
          type: "assignment_updated",
          source: { kind: "assignment", sourceId: "assignment-1" },
          summary: {
            headline: "Ada assigned to T-1#B-001",
            workItem: { kind: "block", canvasId: "canvas-1", blockRef: "T-1#B-001" },
            assignmentRevision: 2
          }
        },
        {
          ...exampleActivityListPage.items[0]!,
          activityId: "activity-member-1",
          type: "member_joined",
          source: { kind: "membership", sourceId: "membership-1" },
          summary: {
            headline: "Grace joined the project",
            humanPrincipalId: "human-2",
            membershipRole: "member"
          }
        }
      ],
      mutations: [
        {
          mutationId: "mut-ok",
          kind: "assignment",
          workItemKey: workItemKey({
            kind: "block",
            canvasId: "canvas-1",
            blockRef: "T-1#B-001"
          }),
          status: "confirmed",
          submittedAt: "2030-01-01T00:00:00.000Z",
          resolvedAt: "2030-01-01T00:00:01.000Z"
        },
        {
          mutationId: "mut-pending",
          kind: "assignment",
          status: "pending",
          submittedAt: "2030-01-01T00:00:00.000Z"
        },
        {
          mutationId: "mut-bad",
          kind: "assignment",
          status: "rejected",
          errorMessage: "stale revision",
          submittedAt: "2030-01-01T00:00:00.000Z",
          resolvedAt: "2030-01-01T00:00:02.000Z"
        }
      ],
      labels: {
        assignmentUpdated: "Assignment updated",
        assignmentFailed: "Assignment failed",
        membershipChanged: "Membership changed",
        mutationConfirmed: "Assignment confirmed",
        mutationRejected: "Assignment rejected"
      }
    });
    expect(drafts).toHaveLength(4);
    expect(drafts.filter((item) => item.title === "Assignment confirmed")).toHaveLength(1);
    expect(drafts.find((item) => item.detail === "stale revision")?.tone).toBe("destructive");
  });
});

describe("collaboration notification authority", () => {
  it("isolates recycled mutation IDs by original authority and event, preserving refresh identity", () => {
    const input = {
      scope: { profileId: "profile:一", projectId: "project:1", canvasId: "canvas:1" },
      activity: [],
      mutations: [
        {
          mutationId: "mut-1",
          kind: "assignment" as const,
          status: "confirmed" as const,
          submittedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      labels: {
        assignmentUpdated: "updated",
        assignmentFailed: "failed",
        membershipChanged: "member",
        mutationConfirmed: "confirmed",
        mutationRejected: "rejected"
      }
    };
    const first = buildCollaborationNotificationDrafts(input)[0];
    const alternatives = [
      { ...input, scope: { ...input.scope, profileId: "profile:二" } },
      { ...input, scope: { ...input.scope, projectId: "other" } },
      { ...input, scope: { ...input.scope, canvasId: "other" } },
      { ...input, mutations: [{ ...input.mutations[0], mutationId: "mut-2" }] }
    ];
    expect(
      new Set([
        first.id,
        ...alternatives.map((value) => buildCollaborationNotificationDrafts(value)[0].id)
      ]).size
    ).toBe(5);
    expect(buildCollaborationNotificationDrafts(input)[0].id).toBe(first.id);
  });

  it("keeps activity identity on its original canvas while the selected collaboration canvas changes", () => {
    const input = {
      scope: { profileId: "profile-1", projectId: "project-1", canvasId: "B" },
      activity: [
        {
          ...exampleActivityListPage.items[0]!,
          type: "assignment_updated" as const,
          workItem: { kind: "block" as const, canvasId: "A", blockRef: "T-1#B-001" }
        }
      ],
      mutations: [],
      labels: {
        assignmentUpdated: "updated",
        assignmentFailed: "failed",
        membershipChanged: "member",
        mutationConfirmed: "confirmed",
        mutationRejected: "rejected"
      }
    };
    const first = buildCollaborationNotificationDrafts(input)[0];
    expect(
      buildCollaborationNotificationDrafts({
        ...input,
        scope: { ...input.scope, canvasId: "C" }
      })[0].id
    ).toBe(first.id);
    expect(
      buildCollaborationNotificationDrafts({
        ...input,
        scope: { ...input.scope, profileId: "other-profile" }
      })[0].id
    ).not.toBe(first.id);
  });
});
