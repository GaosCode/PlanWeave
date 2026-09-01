import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  remoteInteractionViewSchema,
  remoteOperationObservationSchema
} from "@planweave-ai/collaboration-protocol/remote-run";
import { exampleHumanIdentityToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import {
  capturePackageSnapshot,
  loadPlanGraphPackage,
  projectWorkspaceExecutionCoordinatorView
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import type { CollaborationRemoteOperationsPort } from "../main/collaboration/CollaborationRemoteOperationsClient.js";
import { CollaborationRemoteOperationsFacade } from "../main/collaboration/collaborationRemoteOperations.js";
import { OperatorControlClient } from "../main/operatorControl/OperatorControlClient.js";
import type { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { cancelWorkspaceExecutionSession } from "../main/workspaceExecutionDesktopService.js";
import { DesktopWorkspaceExecutionSessionRepository } from "../main/workspaceExecutionDesktopSessionRepository.js";
import {
  ownerCanvasMaterializationIntentId,
  withOwnerCanvasExistingExecutionCoordinator,
  withOwnerCanvasExecutionCoordinator
} from "../main/workspaceExecutionOwnerCanvas.js";
import {
  emptyInteractions,
  emptyReplay,
  endpoint,
  observation as runtimeObservation,
  pendingInteraction
} from "../../../runtime/src/__tests__/workspaceExecutionCoordinatorTestFixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const observation = remoteOperationObservationSchema.parse({
  operationId: "operation-characterization",
  projectId: "foreign-project",
  canvasId: "foreign-canvas",
  blockRef: "T-foreign#B-foreign",
  state: "running",
  dispatchId: "dispatch-characterization",
  executionAttemptId: "attempt-characterization",
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:01:00.000Z",
  attempt: {
    executionAttemptId: "attempt-characterization",
    dispatchId: "dispatch-characterization",
    status: "running",
    leaseId: "lease-characterization",
    stateVersion: 1
  },
  runtime: { ref: "T-foreign#B-foreign", status: "in_progress" }
});

function fixture() {
  const listAgentEndpoints = vi.fn(async () => ({
    schemaVersion: "agent-endpoint-list/v1" as const,
    items: []
  }));
  const dispatchRemoteOperation = vi.fn(async () => observation);
  const lookupRemoteOperation = vi.fn(async () => observation);
  const unused = async (): Promise<never> => {
    throw new Error("unused_remote_operation_port_method");
  };
  const client: CollaborationRemoteOperationsPort = {
    listAgentEndpoints,
    dispatchRemoteOperation,
    observeRemoteOperation: unused,
    lookupRemoteOperation,
    executeRemoteOperationAction: unused,
    replayRemoteOperationEvents: unused,
    listRemoteOperationInteractions: unused,
    settleRemoteOperationInteraction: unused
  };
  const activeClientCalls = vi.fn();
  const workspaceClientCalls = vi.fn();
  const facade = new CollaborationRemoteOperationsFacade(
    async (operation) => {
      activeClientCalls();
      return operation(client);
    },
    async (_locator, operation) => {
      workspaceClientCalls();
      return operation(client);
    }
  );
  return {
    facade,
    listAgentEndpoints,
    dispatchRemoteOperation,
    lookupRemoteOperation,
    activeClientCalls,
    workspaceClientCalls
  };
}

describe("workspace execution authority characterization", () => {
  it("uses a stable materialization id per content and expected-head publication intent", () => {
    const digest = "a".repeat(64);
    const absent = ownerCanvasMaterializationIntentId(digest, { kind: "absent" });
    const retry = ownerCanvasMaterializationIntentId(digest, { kind: "absent" });
    const afterB = ownerCanvasMaterializationIntentId(digest, {
      kind: "present",
      revision: 2,
      content: {
        versionId: "version-b",
        canonicalDigest: "b".repeat(64),
        verification: "complete"
      }
    });

    expect(retry).toBe(absent);
    expect(afterB).not.toBe(absent);
  });

  it("builds ordinary Canvas execution from the selected Operator profile without Workspace authority", async () => {
    const { root } = await createTestWorkspace();
    const loaded = await loadPlanGraphPackage(root);
    const captured = await capturePackageSnapshot({ projectRoot: root });
    const sessionsRoot = await mkdtemp(join(tmpdir(), "planweave-owner-canvas-execution-"));
    temporaryDirectories.push(root, sessionsRoot);
    const client = new OperatorControlClient({
      profile: {
        profileId: "profile-owner",
        displayName: "Owner Server",
        serverBaseUrl: "https://operator.example.test/",
        allowInsecureTransport: false
      },
      credential: {
        getOperatorToken: () => "operator_owner_token_abcdefghijklmnopqrstuvwxyz",
        getHumanIdentityToken: () => exampleHumanIdentityToken
      },
      request: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/owner-canvas-materializations/head") {
          return Response.json({
            schemaVersion: "owner-canvas-materialization/v1",
            scope: {
              ownerHumanPrincipalId: "human-owner",
              projectId: loaded.workspace.id,
              canvasId: "default"
            },
            head: { kind: "absent" }
          });
        }
        if (url.pathname === "/api/v1/owner-canvas-materializations" && init?.method === "POST") {
          const frames = String(init.body)
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          const header = frames[0] as { request: { materializationId: string; scope: unknown } };
          const complete = frames.at(-1) as { canonicalDigest: string };
          return Response.json(
            {
              schemaVersion: "owner-canvas-materialization/v1",
              materializationId: header.request.materializationId,
              scope: header.request.scope,
              head: {
                revision: 1,
                content: {
                  versionId: `version-${complete.canonicalDigest}`,
                  canonicalDigest: complete.canonicalDigest,
                  verification: "complete"
                }
              },
              contentRevision: captured.snapshot.sourceRevision,
              graphFingerprint: loaded.graph.packageFingerprint
            },
            { status: 201 }
          );
        }
        return Response.json({ error: "unexpected_operator_route" }, { status: 404 });
      })
    });
    const profileCalls: string[] = [];
    const operatorControl: Pick<OperatorControlService, "withExecutionProfile"> = {
      async withExecutionProfile<T>(
        profileId: string,
        action: (value: OperatorControlClient) => Promise<T>
      ) {
        profileCalls.push(profileId);
        return action(client);
      }
    };

    const request = await withOwnerCanvasExecutionCoordinator({
      requestInput: {
        locator: {
          kind: "owner_canvas",
          operatorProfileId: "profile-owner",
          humanPrincipalId: "human-owner",
          projectRoot: root,
          projectId: loaded.workspace.id,
          canvasId: "default"
        },
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-owner",
        effectiveExecutor: { name: "codex-acp", agentId: "codex" }
      },
      operatorControl,
      sessions: new DesktopWorkspaceExecutionSessionRepository(sessionsRoot),
      operation: async ({ request: value }) => value
    });

    expect(profileCalls).toEqual(["profile-owner"]);
    expect(request.authority).toMatchObject({
      kind: "owner_canvas",
      connectionProfileId: "profile-owner",
      serverOrigin: "https://operator.example.test",
      humanPrincipalId: "human-owner",
      projectId: loaded.workspace.id,
      canvasId: "default"
    });
    expect(request.authority).not.toHaveProperty("workspaceId");
  });

  it("keeps owner Canvas start, follow, respond, and cancel on one profile-scoped session", async () => {
    const { root } = await createTestWorkspace();
    const loaded = await loadPlanGraphPackage(root);
    const captured = await capturePackageSnapshot({ projectRoot: root });
    const sessionsRoot = await mkdtemp(join(tmpdir(), "planweave-owner-canvas-lifecycle-"));
    temporaryDirectories.push(root, sessionsRoot);
    const pending = pendingInteraction("attempt-1");
    const runningObservation = remoteOperationObservationSchema.parse({
      ...runtimeObservation({
        projectId: loaded.workspace.id,
        locatorWorkspaceId: "internal-runtime-workspace",
        authorityRevisions: {
          responsibilityRevision: 0,
          reviewerRevision: 0,
          executionTargetRevision: 0
        },
        contentRevision: captured.snapshot.sourceRevision,
        graphFingerprint: loaded.graph.packageFingerprint
      }),
      attempt: {
        ...runtimeObservation().attempt,
        leaseId: "lease-1"
      }
    });
    let interactionSettled = false;
    let materializedHead: {
      revision: number;
      content: { versionId: string; canonicalDigest: string; verification: "complete" };
    } | null = null;
    const calls: Array<{
      method: string;
      url: URL;
      authorization: string | null;
      body: unknown;
    }> = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const contentType = new Headers(init?.headers).get("content-type");
      const body =
        init?.body === undefined
          ? undefined
          : contentType === "application/x-planweave-owner-canvas-materialization-ndjson"
            ? String(init.body)
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as unknown)
            : JSON.parse(String(init.body));
      calls.push({
        method: init?.method ?? "GET",
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        body
      });
      if (url.pathname === "/api/v1/agent-endpoints") {
        return Response.json({ schemaVersion: "agent-endpoint-list/v1", items: [endpoint] });
      }
      if (url.pathname === "/api/v1/owner-canvas-materializations/head") {
        return Response.json({
          schemaVersion: "owner-canvas-materialization/v1",
          scope: {
            ownerHumanPrincipalId: "human-owner",
            projectId: loaded.workspace.id,
            canvasId: "default"
          },
          head: materializedHead ? { kind: "present", ...materializedHead } : { kind: "absent" }
        });
      }
      if (url.pathname === "/api/v1/owner-canvas-materializations" && init?.method === "POST") {
        const frames = body as Array<Record<string, unknown>>;
        const header = frames[0] as { request: { materializationId: string; scope: unknown } };
        const complete = frames.at(-1) as { canonicalDigest: string };
        materializedHead = {
          revision: 1,
          content: {
            versionId: `version-${complete.canonicalDigest}`,
            canonicalDigest: complete.canonicalDigest,
            verification: "complete"
          }
        };
        return Response.json(
          {
            schemaVersion: "owner-canvas-materialization/v1",
            materializationId: header.request.materializationId,
            scope: header.request.scope,
            head: materializedHead,
            contentRevision: captured.snapshot.sourceRevision,
            graphFingerprint: loaded.graph.packageFingerprint
          },
          { status: 201 }
        );
      }
      if (url.pathname === "/api/v1/remote-operations" && init?.method === "POST") {
        return Response.json(runningObservation, { status: 202 });
      }
      if (url.pathname.endsWith("/events")) {
        return Response.json(emptyReplay(Number(url.searchParams.get("afterCursor") ?? "0")));
      }
      if (url.pathname.endsWith("/interactions")) {
        return Response.json(interactionSettled ? emptyInteractions() : pending);
      }
      if (url.pathname.endsWith("/interactions/respond")) {
        interactionSettled = true;
        return Response.json(
          remoteInteractionViewSchema.parse({
            ...pending.items[0],
            status: "settled",
            settlement: body,
            settledBy: "human-owner",
            settledAt: "2030-01-01T00:01:00.000Z"
          })
        );
      }
      if (url.pathname.endsWith("/actions")) {
        return Response.json({
          request: body,
          state: "recorded",
          createdAt: "2030-01-01T00:02:00.000Z"
        });
      }
      if (url.pathname === "/api/v1/remote-operations/operation-1") {
        return Response.json(runningObservation);
      }
      return Response.json({ error: "unexpected_operator_route" }, { status: 404 });
    });
    const client = new OperatorControlClient({
      profile: {
        profileId: "profile-owner",
        displayName: "Owner Server",
        serverBaseUrl: "https://operator.example.test/",
        allowInsecureTransport: false
      },
      credential: {
        getOperatorToken: () => "operator_owner_token_abcdefghijklmnopqrstuvwxyz",
        getHumanIdentityToken: () => exampleHumanIdentityToken
      },
      request
    });
    const profileCalls: string[] = [];
    const operatorControl: Pick<OperatorControlService, "withExecutionProfile"> = {
      async withExecutionProfile<T>(
        profileId: string,
        action: (value: OperatorControlClient) => Promise<T>
      ) {
        profileCalls.push(profileId);
        return action(client);
      }
    };
    const sessions = new DesktopWorkspaceExecutionSessionRepository(sessionsRoot);
    const requestInput = {
      locator: {
        kind: "owner_canvas" as const,
        operatorProfileId: "profile-owner",
        humanPrincipalId: "human-owner",
        projectRoot: root,
        projectId: loaded.workspace.id,
        canvasId: "default"
      },
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-codex",
      effectiveExecutor: { name: "codex-acp", agentId: "codex" }
    };
    const runWithOwner = <T>(
      operation: Parameters<typeof withOwnerCanvasExecutionCoordinator<T>>[0]["operation"],
      sessionId?: string
    ) =>
      withOwnerCanvasExecutionCoordinator({
        requestInput,
        operatorControl,
        sessions,
        ...(sessionId ? { sessionId } : {}),
        operation
      });

    const started = await runWithOwner(({ coordinator, request: value }) =>
      coordinator.execute(value)
    );
    const sessionId = started.handle.runSessionId;
    const followed = await withOwnerCanvasExistingExecutionCoordinator({
      blockRef: requestInput.blockRef,
      locator: requestInput.locator,
      operationId: started.handle.target === "remote" ? started.handle.operationId : "",
      operatorControl,
      sessions,
      operation: ({ coordinator, expected, serverOrigin }) =>
        coordinator.observeExisting({
          authority: {
            kind: "owner_canvas",
            packageWorkspace: requestInput.locator.projectRoot,
            expected,
            connectionProfileId: requestInput.locator.operatorProfileId,
            serverOrigin,
            humanPrincipalId: requestInput.locator.humanPrincipalId,
            projectId: requestInput.locator.projectId,
            canvasId: requestInput.locator.canvasId
          },
          scope: { kind: "block", blockRef: requestInput.blockRef },
          operationId: started.handle.target === "remote" ? started.handle.operationId : ""
        })
    });
    const response = {
      type: "interaction.permission_response" as const,
      dispatchId: "dispatch-attempt-1",
      leaseId: "lease-1",
      executionAttemptId: "attempt-1",
      actionId: "action-1",
      acpSessionId: "acp-session-1",
      decision: "allow_once" as const
    };
    const responded = await runWithOwner(async ({ coordinator, request: value }) => {
      await coordinator.respond({ request: value, sessionId, response });
      return coordinator.follow(value, sessionId);
    }, sessionId);
    const cancelled = await runWithOwner(
      ({ coordinator, request: value, remoteOperations }) =>
        cancelWorkspaceExecutionSession({
          follow: async () =>
            projectWorkspaceExecutionCoordinatorView(await coordinator.follow(value, sessionId)),
          actionId: "cancel-owner",
          reason: "owner lifecycle characterization",
          remoteOperations
        }),
      sessionId
    );

    expect(profileCalls).toEqual([
      "profile-owner",
      "profile-owner",
      "profile-owner",
      "profile-owner"
    ]);
    expect(followed.handle.runSessionId).toBe(sessionId);
    expect(responded.handle.runSessionId).toBe(sessionId);
    expect(cancelled.handle.runSessionId).toBe(sessionId);
    expect(calls.every((call) => call.authorization !== null)).toBe(true);
    expect(
      calls.filter((call) => call.url.pathname === "/api/v1/owner-canvas-materializations")
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.url.pathname === "/api/v1/owner-canvas-materializations/head")
    ).toHaveLength(1);
    expect(calls.map((call) => call.url.pathname)).toEqual(
      expect.arrayContaining([
        "/api/v1/agent-endpoints",
        "/api/v1/remote-operations",
        "/api/v1/remote-operations/operation-1/interactions/respond",
        "/api/v1/remote-operations/operation-1/actions"
      ])
    );
    expect(
      calls
        .filter((call) => call.url.pathname.includes("remote-operations"))
        .every(
          (call) =>
            call.url.pathname.includes("operation-1") ||
            call.url.pathname === "/api/v1/remote-operations"
        )
    ).toBe(true);
    expect(calls.some((call) => call.url.searchParams.has("workspaceId"))).toBe(false);
    expect(calls.some((call) => JSON.stringify(call.body ?? null).includes("workspaceId"))).toBe(
      false
    );
    expect(
      calls.some((call) => JSON.stringify(call.body ?? null).includes("operator_owner_token"))
    ).toBe(false);
  });

  it("routes Catalog and Dispatch through the active client without a validated Workspace binding", async () => {
    const current = fixture();

    await current.facade.listAgentEndpoints({
      projectId: "selected-project",
      workspaceId: "selected-workspace",
      canvasId: "selected-canvas"
    });
    await current.facade.dispatch({
      schemaVersion: "remote-run/v3",
      projectId: "selected-project",
      canvasId: "selected-canvas",
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-characterization",
      idempotencyKey: "dispatch-characterization",
      expectedResponsibilityRevision: 1,
      expectedReviewerRevision: 1,
      executionTargetRevision: 1,
      contentRevision: "7",
      graphFingerprint: `pkg-${"a".repeat(64)}`
    });

    expect(current.activeClientCalls).toHaveBeenCalledTimes(2);
    expect(current.listAgentEndpoints).toHaveBeenCalledTimes(1);
    expect(current.dispatchRemoteOperation).toHaveBeenCalledTimes(1);
    expect(current.workspaceClientCalls).not.toHaveBeenCalled();
  });

  it("detects a Workspace operation authority mismatch only after the lookup call returns", async () => {
    const current = fixture();

    await expect(
      current.facade.lookupWorkspace({
        locator: {
          kind: "workspace",
          connectionProfileId: "profile-selected",
          workspaceId: "workspace-selected",
          projectId: "project-selected",
          canvasId: "canvas-selected"
        },
        blockRef: "T-001#B-001"
      })
    ).rejects.toThrow("workspace_remote_operation_authority_mismatch");

    expect(current.workspaceClientCalls).toHaveBeenCalledTimes(1);
    expect(current.lookupRemoteOperation).toHaveBeenCalledTimes(1);
  });
});
