import { vi } from "vitest";
import type {
  DesktopBlockDetail,
  DesktopGraphViewModel,
  DesktopTaskDetail
} from "@planweave-ai/runtime";
import { collaborationConnectionProfileSchema } from "@planweave-ai/collaboration-protocol/connection";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  eligibleAssigneesResponseSchema,
  type EligibleAssigneesResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import {
  workAuthorityProjectionSchema,
  type WorkAuthorityProjection
} from "@planweave-ai/collaboration-protocol/work/authority";
import { CollaborationClient } from "../../main/collaboration/CollaborationClient";
import { CollaborationOperationSession } from "../../main/collaboration/CollaborationOperationSession";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { createApi, connectedStatus } from "./commentsPanelFixture";

export const inspectorGraph: DesktopGraphViewModel = {
  projectId: "project-1",
  projectTitle: "Inspector",
  graphVersion: "graph-1",
  packageFingerprint: "package-1",
  executorOptions: [],
  autoRunPreflightExecutorHint: null,
  tasks: [],
  edges: [],
  sharedResourceGroups: [],
  diagnostics: [],
  dirtyPromptRefs: []
};
export const inspectorTask: DesktopTaskDetail = {
  taskId: "T-1",
  graphVersion: "graph-1",
  title: "Task",
  status: "ready",
  executor: null,
  promptMarkdown: "Task prompt",
  promptHash: "hash",
  promptMissing: false,
  acceptance: [],
  blockOrder: []
};
export const inspectorBlock: DesktopBlockDetail = {
  ref: "T-1#B-1",
  taskId: "T-1",
  blockId: "B-1",
  type: "implementation",
  title: "Block",
  status: "ready",
  executor: null,
  effectiveExecutor: "manual",
  promptMarkdown: "Block prompt",
  promptMissing: false,
  promptSurfaceMarkdown: "Block prompt",
  promptSources: [],
  dependencies: [],
  latestRunId: null,
  latestReviewAttemptId: null,
  activeFeedbackId: null,
  exceptionReason: null,
  reviewGate: null,
  remoteExecution: null
};

export function inspectorAuthority(workItem: WorkItemRef, name: string): WorkAuthorityProjection {
  const scope =
    workItem.kind === "task"
      ? {
          kind: "task",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: workItem.canvasId,
          taskId: workItem.taskId
        }
      : {
          kind: "block",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: workItem.canvasId,
          blockRef: workItem.blockRef
        };
  const updatedAt = "2030-01-01T00:00:00.000Z";
  return workAuthorityProjectionSchema.parse({
    schemaVersion: "work-authority/v1",
    scope,
    responsibility: {
      schemaVersion: "responsibility/v1",
      scope,
      principal: { kind: "human", humanPrincipalId: `owner-${name}` },
      revision: 5,
      updatedAt,
      availability: "active"
    },
    reviewer: {
      schemaVersion: "review-assignment/v1",
      scope,
      principal: { kind: "human", humanPrincipalId: `reviewer-${name}` },
      revision: 7,
      updatedAt,
      availability: "active"
    },
    executionTarget:
      workItem.kind === "block"
        ? {
            schemaVersion: "execution-target/v1",
            scope,
            target: { kind: "unassigned" },
            revision: 0,
            updatedAt,
            availability: { status: "unassigned", reason: "unassigned" }
          }
        : null,
    revisions: { responsibilityRevision: 5, reviewerRevision: 7, executionTargetRevision: 0 },
    selectedHost: null,
    evaluatedAt: updatedAt
  });
}

export function inspectorEligible(workItem: WorkItemRef, name: string): EligibleAssigneesResponse {
  return eligibleAssigneesResponseSchema.parse({
    workItem,
    humans: ["owner", "reviewer"].map((role) => ({
      projectId: "project-1",
      humanPrincipalId: `next-${role}-${name}`,
      membershipActive: true,
      displayName: `Next ${role} ${name}`
    })),
    hosts: [],
    nextHumanCursor: null,
    nextHostCursor: null
  });
}

export function createInspectorAssigneeFixture(kind: "task" | "block") {
  const fixture = createApi();
  const { api } = fixture;
  api.upsertCollaborationProfile = vi.fn();
  fixture.listComments.mockResolvedValue({ items: [], nextCursor: null });
  fixture.listActivity.mockResolvedValue({ items: [], nextCursor: null });
  const workItem: WorkItemRef =
    kind === "task"
      ? { kind: "task", canvasId: "canvas-1", taskId: "T-1" }
      : { kind: "block", canvasId: "canvas-1", blockRef: "T-1#B-1" };
  const client = new CollaborationClient({
    profile: collaborationConnectionProfileSchema.parse({
      profileId: "profile-1",
      displayName: "Inspector",
      projectId: "project-1",
      serverBaseUrl: "https://example.test",
      allowInsecureTransport: false,
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://example.test",
        allowedClientOrigins: ["https://example.test"],
        tlsTrust: "system_ca"
      }
    }),
    credential: { getDeviceToken: () => undefined }
  });
  const session = new CollaborationOperationSession();
  session.verify(client, "profile-1");
  let status = connectedStatus();
  status.session.operationScope = session.scope("connected");
  const firstScope = status.session.operationScope!;
  const authorities = new Map([[firstScope.sessionId, inspectorAuthority(workItem, "s1")]]);
  const eligiblePages = new Map([[firstScope.sessionId, inspectorEligible(workItem, "s1")]]);
  const rejected: string[] = [];
  const admit = async <T>(scope: typeof firstScope, action: () => Promise<T>) => {
    try {
      return await session.run(scope, status.session.phase, action);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "collaboration_operation_scope_stale"
      )
        rejected.push(scope.sessionId);
      throw error;
    }
  };
  const authorityAt = (sessionId: string) => {
    const authority = authorities.get(sessionId);
    if (!authority) throw new Error("Missing test Server authority");
    return authority;
  };
  const readAuthority = vi.fn<PlanWeaveCollaborationApi["getCollaborationWorkAuthority"]>(
    async ({ operationScope }) => authorityAt(operationScope.sessionId)
  );
  const listEligible = vi.fn<PlanWeaveCollaborationApi["listCollaborationEligibleAssignees"]>(
    async ({ operationScope }) => {
      const page = eligiblePages.get(operationScope.sessionId);
      if (!page) throw new Error("Missing test Server eligible page");
      return page;
    }
  );
  const listAssignments = vi.fn<PlanWeaveCollaborationApi["listCollaborationAssignments"]>(
    async () => ({ items: [], nextCursor: null })
  );
  const updateResponsibility = vi.fn<
    PlanWeaveCollaborationApi["updateCollaborationResponsibility"]
  >(async ({ operationScope, principal, expectedRevision }) => {
    const current = authorityAt(operationScope.sessionId);
    const responsibility = { ...current.responsibility, principal, revision: expectedRevision + 1 };
    authorities.set(operationScope.sessionId, {
      ...current,
      responsibility,
      revisions: { ...current.revisions, responsibilityRevision: responsibility.revision }
    });
    return responsibility;
  });
  const updateReviewer = vi.fn<PlanWeaveCollaborationApi["updateCollaborationReviewer"]>(
    async ({ operationScope, principal, expectedRevision }) => {
      const current = authorityAt(operationScope.sessionId);
      const reviewer = { ...current.reviewer, principal, revision: expectedRevision + 1 };
      authorities.set(operationScope.sessionId, {
        ...current,
        reviewer,
        revisions: { ...current.revisions, reviewerRevision: reviewer.revision }
      });
      return reviewer;
    }
  );
  api.getCollaborationWorkAuthority = (input) =>
    admit(input.operationScope, () => readAuthority(input));
  api.listCollaborationEligibleAssignees = (input) =>
    admit(input.operationScope, () => listEligible(input));
  api.listCollaborationAssignments = (input) =>
    admit(input.operationScope, () => listAssignments(input));
  api.updateCollaborationResponsibility = (input) =>
    admit(input.operationScope, () => updateResponsibility(input));
  api.updateCollaborationReviewer = (input) =>
    admit(input.operationScope, () => updateReviewer(input));
  fixture.emitStatus(status);
  return {
    api,
    workItem,
    firstScope,
    authorities,
    eligiblePages,
    readAuthority,
    listEligible,
    listAssignments,
    updateResponsibility,
    updateReviewer,
    rejected,
    reconnect: () => {
      session.retire();
      session.verify(client, "profile-1");
      const nextScope = session.scope("connected")!;
      authorities.set(nextScope.sessionId, inspectorAuthority(workItem, "s2"));
      eligiblePages.set(nextScope.sessionId, inspectorEligible(workItem, "s2"));
      status = { ...status, session: { ...status.session, operationScope: nextScope } };
      fixture.emitStatus(status);
      return nextScope;
    },
    emitClone: () => fixture.emitStatus(structuredClone(status)),
    dispose: () => {
      session.retire();
      client.dispose();
    }
  };
}
