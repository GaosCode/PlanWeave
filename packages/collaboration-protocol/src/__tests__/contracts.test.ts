import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import {
  assertHumanDisplayDtoRedacted,
  humanBootstrapResponseSchema,
  humanConsumeInvitationResponseSchema,
  humanDeviceListQuerySchema,
  humanInvitationListQuerySchema,
  humanPageQuerySchema
} from "../identity.js";
import { activityRecordSchema, commentDisplayProjectionSchema } from "../comments.js";
import { collaborationBoundaryErrorKindSchema, mapHttpStatusToBoundaryKind } from "../errors.js";
import {
  exampleActivityRecord,
  exampleAssignmentProjection,
  exampleBootstrapResponse,
  exampleConnectionProfile,
  exampleCommentProjection,
  exampleHumanDeviceToken,
  exampleLoopbackConnectionProfile,
  exampleMemberPage,
  exampleObserverCatchupRequired,
  exampleObserverEvent,
  exampleObserverWelcome,
  exampleSecretsForRedaction
} from "../fixtures/collaboration.js";
import { COLLABORATION_JSON_BODY_MAX_BYTES } from "../limits.js";
import { WORK_ELIGIBLE_HOST_BATCH_MAX } from "../limits.js";
import { eligibleHostBatchRequestSchema, eligibleHostBatchResponseSchema } from "../assignment.js";
import { humanObserverEventSchema, parseHumanObserverServerMessage } from "../observer.js";
import {
  parseCollaborationClientLimits,
  parseCollaborationConnectionProfile
} from "../connection.js";

const productionExportPaths = [
  "./core/primitives",
  "./core/limits",
  "./errors",
  "./identity/workspace",
  "./identity/migration",
  "./access/project",
  "./access/control",
  "./content/snapshot",
  "./content/version",
  "./content/authority",
  "./content/transfer",
  "./work/assignment",
  "./work/responsibility",
  "./work/review",
  "./work/execution-target",
  "./work/host-authorization",
  "./work/authority",
  "./work/assignment-migration",
  "./work/package-facts",
  "./canvas/commands",
  "./canvas/live-sync",
  "./canvas/runtime-availability",
  "./canvas/status",
  "./canvas/presence",
  "./activity/comments",
  "./activity/attachments",
  "./activity/observer",
  "./connection",
  "./setup",
  "./handoff/setup",
  "./handoff/invitation",
  "./deployment",
  "./loopback",
  "./remote-run",
  "./agent-endpoint"
] as const;

const fixtureExportPaths = ["./fixtures/collaboration", "./fixtures/content-version"] as const;

describe("collaboration-protocol", () => {
  it("exposes only explicit domain and fixture subpaths", () => {
    expect("main" in packageJson).toBe(false);
    expect("types" in packageJson).toBe(false);
    expect(packageJson.exports["." as keyof typeof packageJson.exports]).toBeUndefined();
    expect(Object.keys(packageJson.exports).sort()).toEqual(
      [...productionExportPaths, ...fixtureExportPaths].sort()
    );
    for (const exportPath of [...productionExportPaths, ...fixtureExportPaths]) {
      expect(packageJson.exports[exportPath]).toEqual({
        types: expect.stringMatching(/^\.\/dist\/.+\.d\.ts$/),
        import: expect.stringMatching(/^\.\/dist\/.+\.js$/)
      });
    }
    for (const exportPath of productionExportPaths) {
      expect(packageJson.exports[exportPath].types).not.toContain("/fixtures/");
      expect(packageJson.exports[exportPath].import).not.toContain("/fixtures/");
    }
  });

  it("parses explicitly enabled private-LAN HTTP and rejects public insecure HTTP", () => {
    expect(exampleConnectionProfile.projectId).toBe("project-demo-001");
    expect(exampleLoopbackConnectionProfile.allowInsecureTransport).toBe(true);
    expect(
      parseCollaborationConnectionProfile({
        profileId: "p-lan",
        displayName: "LAN",
        serverBaseUrl: "http://192.168.1.20:8787/",
        projectId: "project-1",
        allowInsecureTransport: true,
        endpoint: {
          topology: "lan_http",
          serverOrigin: "http://192.168.1.20:8787/",
          allowedClientOrigins: ["http://192.168.1.20:8787/"],
          tlsTrust: "not_applicable"
        }
      }).serverBaseUrl
    ).toBe("http://192.168.1.20:8787/");
    expect(() =>
      parseCollaborationConnectionProfile({
        profileId: "p1",
        displayName: "Bad",
        serverBaseUrl: "http://example.com/",
        projectId: "project-1",
        allowInsecureTransport: true
      })
    ).toThrow();
  });

  it("defaults the client JSON response budget to the bounded page envelope", () => {
    const limits = parseCollaborationClientLimits();
    expect(COLLABORATION_JSON_BODY_MAX_BYTES).toBe(4 * 1_024 * 1_024);
    expect(limits.jsonBodyMaxBytes).toBe(COLLABORATION_JSON_BODY_MAX_BYTES);
  });

  it("bounds eligible Host batches and rejects duplicate or misordered projections", () => {
    const workItems = Array.from({ length: WORK_ELIGIBLE_HOST_BATCH_MAX }, (_, index) => ({
      kind: "block" as const,
      canvasId: "default",
      blockRef: `T-001#B-${String(index + 1).padStart(3, "0")}`
    }));
    expect(eligibleHostBatchRequestSchema.parse({ workItems }).workItems).toHaveLength(50);
    expect(
      eligibleHostBatchRequestSchema.safeParse({ workItems: [...workItems, workItems[0]] }).success
    ).toBe(false);
    expect(
      eligibleHostBatchRequestSchema.safeParse({ workItems: [workItems[0], workItems[0]] }).success
    ).toBe(false);
    expect(
      eligibleHostBatchRequestSchema.safeParse({
        workItems: [
          { kind: "block", canvasId: "a:b", blockRef: "T#B" },
          { kind: "block", canvasId: "a", blockRef: "b:T#B" }
        ]
      }).success
    ).toBe(true);
    expect(
      eligibleHostBatchRequestSchema.safeParse({
        workItems: [{ kind: "task", canvasId: "default", taskId: "T-001" }]
      }).success
    ).toBe(false);

    const host = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      hostId: "host-1",
      exists: true,
      revoked: false,
      authorizedForProject: true,
      online: true,
      ready: true,
      capabilities: ["acp.codex"]
    };
    expect(
      eligibleHostBatchResponseSchema.parse({
        items: [{ index: 0, workItem: workItems[0], hostIds: [host.hostId] }],
        hosts: [host]
      }).items[0]?.workItem
    ).toEqual(workItems[0]);
    expect(
      eligibleHostBatchResponseSchema.safeParse({
        items: [{ index: 1, workItem: workItems[0], hostIds: [host.hostId] }],
        hosts: [host]
      }).success
    ).toBe(false);
    expect(
      eligibleHostBatchResponseSchema.safeParse({
        items: [{ index: 0, workItem: workItems[0], hostIds: ["host-missing"] }],
        hosts: [host]
      }).success
    ).toBe(false);
  });

  it("loads shared fixtures without digest fields", () => {
    assertHumanDisplayDtoRedacted(exampleBootstrapResponse);
    assertHumanDisplayDtoRedacted(exampleMemberPage);
    assertHumanDisplayDtoRedacted(exampleAssignmentProjection);
    expect(exampleActivityRecord.type).toBe("comment_created");
    expect(exampleHumanDeviceToken.startsWith("pw_hdev_")).toBe(true);
  });

  it("requires Workspace identity on owner bootstrap and invitation join responses", () => {
    expect(humanBootstrapResponseSchema.parse(exampleBootstrapResponse).workspaceId).toBe(
      "workspace-demo-001"
    );
    expect(
      humanBootstrapResponseSchema.safeParse({
        ...exampleBootstrapResponse,
        workspaceId: undefined
      }).success
    ).toBe(false);
    expect(
      humanConsumeInvitationResponseSchema.safeParse({
        ...exampleBootstrapResponse,
        invitation: {
          invitationId: "invitation-demo-001",
          projectId: "project-demo-001",
          role: "member",
          createdByHumanPrincipalId: "human-owner-001",
          createdAt: "2030-01-01T00:00:00.000Z",
          expiresAt: "2030-01-02T00:00:00.000Z",
          consumedAt: "2030-01-01T00:00:00.000Z"
        },
        principalCreated: true,
        workspaceId: undefined
      }).success
    ).toBe(false);
  });

  it("normalizes HTTP identity queries at the protocol boundary", () => {
    expect(humanPageQuerySchema.parse({ cursor: "2", limit: "25" })).toEqual({
      cursor: 2,
      limit: 25
    });
    expect(humanInvitationListQuerySchema.parse({})).toEqual({
      cursor: 0,
      limit: 50,
      openOnly: true
    });
    expect(humanInvitationListQuerySchema.parse({ openOnly: "false" }).openOnly).toBe(false);
    expect(humanDeviceListQuerySchema.parse({ cursor: "1", limit: "10" })).toEqual({
      cursor: 1,
      limit: 10,
      scope: "own"
    });
  });

  it("rejects inconsistent comment and activity wire projections", () => {
    expect(() =>
      commentDisplayProjectionSchema.parse({
        ...exampleCommentProjection,
        tombstoned: true,
        body: "must be redacted",
        tombstonedAt: "2030-01-01T00:00:00.000Z"
      })
    ).toThrow();
    expect(() =>
      commentDisplayProjectionSchema.parse({
        ...exampleCommentProjection,
        body: null
      })
    ).toThrow();
    expect(() =>
      activityRecordSchema.parse({
        ...exampleActivityRecord,
        source: { kind: "assignment", sourceId: "source-1" }
      })
    ).toThrow();
    expect(() =>
      activityRecordSchema.parse({
        ...exampleActivityRecord,
        summary: { headline: "Comment created" }
      })
    ).toThrow();
  });

  it("validates human observer messages and cursor advance", () => {
    expect(parseHumanObserverServerMessage(exampleObserverWelcome).type).toBe(
      "human.observer.welcome"
    );
    expect(parseHumanObserverServerMessage(exampleObserverEvent).type).toBe("human.observer.event");
    expect(exampleObserverCatchupRequired.reason).toBe("retention_gap");
    expect(() =>
      humanObserverEventSchema.parse({
        ...exampleObserverEvent,
        cursor: 10,
        previousCursor: 10
      })
    ).toThrow();
  });

  it("requires a complete authoritative canvas invalidation payload", () => {
    expect(
      humanObserverEventSchema.parse({
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 12,
        previousCursor: 11,
        occurredAt: "2030-01-01T00:00:00.000Z",
        kind: "canvas",
        canvasId: "default",
        canvasRevision: 4,
        canvasContentDigest: "a".repeat(64)
      })
    ).toMatchObject({
      kind: "canvas",
      canvasId: "default",
      canvasRevision: 4,
      canvasContentDigest: "a".repeat(64)
    });
    expect(() =>
      humanObserverEventSchema.parse({
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 12,
        previousCursor: 11,
        occurredAt: "2030-01-01T00:00:00.000Z",
        kind: "canvas",
        canvasId: "default"
      })
    ).toThrow();
  });

  it("maps HTTP statuses to boundary error kinds", () => {
    expect(mapHttpStatusToBoundaryKind(401)).toBe("auth");
    expect(mapHttpStatusToBoundaryKind(409, "work_revision_conflict")).toBe("conflict");
    expect(mapHttpStatusToBoundaryKind(429)).toBe("rate_limited");
    expect(collaborationBoundaryErrorKindSchema.parse("offline")).toBe("offline");
  });

  it("exposes secrets only as explicit redaction fixtures", () => {
    expect(exampleSecretsForRedaction.deviceToken).toContain("pw_hdev_");
    expect(exampleSecretsForRedaction.authorizationHeader).toContain("Bearer ");
  });

  it("validates remote operation observation and action wire shapes", async () => {
    const {
      remoteActionViewSchema,
      remoteDispatchWireCommandSchema,
      remoteExecutionActionWireRequestSchema,
      remoteHumanExecutionActionCommandSchema,
      remoteOperationObservationSchema
    } = await import("../remoteRun.js");
    expect(
      remoteDispatchWireCommandSchema.parse({
        canvasId: "default",
        blockRef: "T-1#B-1",
        idempotencyKey: "idem-1"
      }).blockRef
    ).toBe("T-1#B-1");
    expect(
      remoteOperationObservationSchema.parse({
        operationId: "op-1",
        projectId: "project-1",
        canvasId: "default",
        blockRef: "T-1#B-1",
        state: "running",
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
        attempt: {
          executionAttemptId: "attempt-1",
          dispatchId: "dispatch-1",
          status: "running",
          stateVersion: 0
        },
        runtime: { ref: "T-1#B-1", status: "in_progress" }
      }).state
    ).toBe("running");
    expect(
      remoteExecutionActionWireRequestSchema.parse({
        kind: "cancel",
        actionId: "a1",
        operationId: "op-1",
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        expectedAttemptVersion: 0,
        leaseId: "lease-1",
        reason: "stop"
      }).kind
    ).toBe("cancel");
    const resumeCommand = remoteHumanExecutionActionCommandSchema.parse({
      kind: "resume_same_session",
      actionId: "resume-1",
      operationId: "op-1",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      expectedAttemptVersion: 4,
      priorLeaseId: "lease-1",
      reason: "continue"
    });
    expect(resumeCommand).not.toHaveProperty("leaseId");
    expect(() =>
      remoteHumanExecutionActionCommandSchema.parse({
        ...resumeCommand,
        leaseId: "lease-server-generated"
      })
    ).toThrow();
    const rejectedAction = {
      request: {
        kind: "cancel",
        actionId: "a1",
        operationId: "op-1",
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        expectedAttemptVersion: 0,
        leaseId: "lease-1",
        reason: "stop"
      },
      state: "rejected",
      createdAt: "2030-01-01T00:00:00.000Z"
    } as const;
    expect(() => remoteActionViewSchema.parse(rejectedAction)).toThrow();
    expect(
      remoteActionViewSchema.parse({
        ...rejectedAction,
        rejectedAt: "2030-01-01T00:00:01.000Z",
        rejectionCode: "work_not_agent_assigned"
      }).state
    ).toBe("rejected");
  });
});
