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
  createRemoteBlockRuntimePort,
  loadPlanGraphPackage,
  projectWorkspaceExecutionCoordinatorView
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openServerDatabase, type SqliteDatabase } from "../../../server/src/sqlite.js";
import { applyMigrations } from "../../../server/src/migrations.js";
import {
  RemoteExecutionActionRepository,
  RemoteExecutionActionService
} from "../../../server/src/remoteExecutionActions.js";
import { createWorkspaceScopeCancellation } from "../renderer/collaboration/workspaceScopeCancellation.js";
import { restoreWorkspaceScopeCancellation } from "../renderer/collaboration/workspaceScopeCancellationRecovery.js";
import { createStartCancellationServerFixture } from "./workspaceExecutionStartCancellationTestFixture.js";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import type { CollaborationRemoteOperationsPort } from "../main/collaboration/CollaborationRemoteOperationsClient.js";
import { CollaborationRemoteOperationsFacade } from "../main/collaboration/collaborationRemoteOperations.js";
import { OperatorControlClient } from "../main/operatorControl/OperatorControlClient.js";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import type { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import {
  WorkspaceExecutionDesktopService,
  cancelWorkspaceExecutionSession
} from "../main/workspaceExecutionDesktopService.js";
import { DesktopWorkspaceExecutionSessionRepository } from "../main/workspaceExecutionDesktopSessionRepository.js";
import {
  ownerCanvasMaterializationIntentId,
  ownerSessionStorage,
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
const actionDatabases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of actionDatabases.splice(0)) database.close();
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

  it.each([
    "observe",
    "final follow",
    "CAS retry",
    "CAS restart",
    "CAS replaced attempt",
    "CAS replaced lease",
    "accepted response lost",
    "start accepted response lost",
    "start before accept failure",
    "start local writeback failure"
  ] as const)("preserves owner Canvas cancellation identity through %s", async (replacementAt) => {
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
    let currentObservation = runningObservation;
    let failObservation = false;
    let executeAction: ((body: unknown) => Promise<unknown>) | undefined;
    const scheduledObservations: (typeof runningObservation)[] = [];
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
        if (
          replacementAt === "start accepted response lost" ||
          replacementAt === "start before accept failure"
        )
          throw new Error("dispatch response lost");
        if (replacementAt === "start local writeback failure")
          await createRemoteBlockRuntimePort({ projectRoot: root }).claim({
            ref: "T-001#B-001",
            operationId: "different-owner",
            controlPlane: "owner",
            sourceRevision: captured.snapshot.sourceRevision,
            graphFingerprint: loaded.graph.packageFingerprint
          });
        return Response.json(runningObservation, { status: 202 });
      }
      if (url.pathname === "/api/v1/remote-operations" && init?.method === "GET") {
        expect(url.searchParams.get("idempotencyKey")).toBe("workspace-execution-start-lost");
        return Response.json(
          replacementAt === "start before accept failure" ? null : currentObservation
        );
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
        if (executeAction) {
          try {
            return Response.json(await executeAction(body), { status: 202 });
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === "remote_action_attempt_version_conflict"
            )
              return Response.json({ error: error.message }, { status: 409 });
            throw error;
          }
        }
        return Response.json({
          request: body,
          state: "recorded",
          createdAt: "2030-01-01T00:02:00.000Z"
        });
      }
      if (url.pathname === "/api/v1/remote-operations/operation-1") {
        if (failObservation) throw new Error("response_lost");
        return Response.json(scheduledObservations.shift() ?? currentObservation);
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

    if (replacementAt.startsWith("start ")) {
      const collaboration = new CollaborationService({
        profileStorePaths: { profilesPath: join(sessionsRoot, "profiles.json") },
        workspaceProfileStorePaths: { profilesPath: join(sessionsRoot, "workspace-profiles.json") },
        credentialsPath: join(sessionsRoot, "credentials.json"),
        invitationsPath: join(sessionsRoot, "invitations.json")
      });
      const db = await openServerDatabase(join(sessionsRoot, "start-actions.sqlite"), 5_000);
      actionDatabases.push(db);
      const actions = createStartCancellationServerFixture({
        database: db,
        read: () => currentObservation,
        write: (value) => {
          currentObservation = value;
        }
      });
      executeAction = actions.execute;
      const first = new WorkspaceExecutionDesktopService(
        collaboration,
        operatorControl,
        sessionsRoot
      );
      const startInput = { ...requestInput, startRequestId: "start-lost" };
      await expect(first.start(startInput)).rejects.toMatchObject({
        code:
          replacementAt === "start local writeback failure"
            ? "remote_ownership_operation_conflict"
            : "operator_request_failed"
      });
      const stop = {
        input: startInput,
        startRequestId: "start-lost",
        actionId: "stop-lost",
        reason: "Desktop Auto Run stop requested."
      };
      if (replacementAt === "start before accept failure") {
        expect(await first.cancelStart(stop)).toMatchObject({ confirmed: false });
      } else {
        failObservation = true;
        await expect(first.cancelStart(stop)).rejects.toThrow();
        failObservation = false;
      }
      const restarted = new WorkspaceExecutionDesktopService(
        collaboration,
        operatorControl,
        sessionsRoot
      );
      const recovered = await restarted.recoverCancellations({ locator: requestInput.locator });
      expect(recovered.starts).toEqual([stop]);
      const restored = restoreWorkspaceScopeCancellation({
        recovered,
        locator: requestInput.locator,
        scopeIdentity: "scope-start-lost"
      });
      if (!restored) throw new Error("restored Stop intent required");
      const cancellation = createWorkspaceScopeCancellation({
        api: {
          cancelWorkspaceExecutionStart: (input) => restarted.cancelStart(input),
          cancelWorkspaceExecution: (input) => restarted.cancel(input),
          recoverWorkspaceExecutionCancellations: (input) => restarted.recoverCancellations(input),
          startWorkspaceExecution: (input) => restarted.start(input),
          followWorkspaceExecution: (input) => restarted.follow(input),
          respondWorkspaceExecution: (input) => restarted.respond(input),
          remoteAcpConversation: vi.fn()
        },
        createId: () => "unused",
        publish: vi.fn()
      });
      const results = await cancellation.abortRun(restored, true);
      if (replacementAt === "start accepted response lost") {
        expect(results.every((result) => result.status === "fulfilled")).toBe(true);
        expect(restored.workspaceStarts.size).toBe(0);
        expect(actions.sideEffects()).toBe(1);
        expect(
          (await restarted.recoverCancellations({ locator: requestInput.locator })).starts
        ).toEqual([]);
      } else {
        expect(results.some((result) => result.status === "rejected")).toBe(true);
        expect(restored.workspaceStarts.size).toBe(1);
        if (replacementAt === "start before accept failure") {
          expect(await restarted.cancelStart(stop)).toMatchObject({ confirmed: false });
          expect(calls.filter((call) => call.url.pathname.endsWith("/actions"))).toHaveLength(0);
        } else {
          expect(
            (
              await createRemoteBlockRuntimePort({ projectRoot: root }).query({
                ref: requestInput.blockRef,
                operationId: "different-owner"
              })
            ).ownership.operationId
          ).toBe("different-owner");
        }
      }
      expect(
        calls.filter(
          (call) => call.url.pathname === "/api/v1/remote-operations" && call.method === "POST"
        )
      ).toHaveLength(1);
      return;
    }
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
      decision: "select_option" as const,
      optionId: "tool-approve-once"
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
    expect(calls.find((call) => call.url.pathname.endsWith("/interactions/respond"))?.body).toEqual(
      response
    );
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
    const collaboration = new CollaborationService({
      profileStorePaths: { profilesPath: join(sessionsRoot, "profiles.json") },
      workspaceProfileStorePaths: { profilesPath: join(sessionsRoot, "workspace-profiles.json") },
      credentialsPath: join(sessionsRoot, "credentials.json"),
      invitationsPath: join(sessionsRoot, "invitations.json")
    });
    const service = new WorkspaceExecutionDesktopService(
      collaboration,
      operatorControl,
      sessionsRoot
    );
    const storage = ownerSessionStorage(requestInput.locator);
    expect((await sessions.get(storage, sessionId)).session.workspaceExecution).not.toHaveProperty(
      "cancellationIntent"
    );
    if (started.handle.target !== "remote") throw new Error("remote handle required");
    const cancelInput = {
      ...requestInput,
      sessionId,
      actionId: "cancel-persisted",
      reason: "Desktop Auto Run stop requested.",
      expectedRemoteHandle: started.handle
    };
    if (replacementAt.startsWith("CAS ") || replacementAt === "accepted response lost") {
      const database = await openServerDatabase(join(sessionsRoot, "actions.sqlite"), 5_000);
      actionDatabases.push(database);
      applyMigrations(database);
      database.exec("PRAGMA foreign_keys=OFF");
      const ownerToken = "00000000-0000-4000-8000-000000000023";
      database
        .prepare(
          "INSERT INTO server_instance_ownership(singleton,owner_token,process_id,hostname,acquired_at) VALUES(1,?,1,'test-host',?)"
        )
        .run(ownerToken, "2030-01-01T00:00:00.000Z");
      const actions = new RemoteExecutionActionRepository(database);
      let sideEffects = 0;
      const engine = new RemoteExecutionActionService(
        actions,
        {
          snapshot: () => ({
            dispatchState: "persisted",
            operationId: currentObservation.operationId,
            dispatchId: currentObservation.dispatchId,
            executionAttemptId: currentObservation.executionAttemptId,
            attemptStatus: "running",
            attemptVersion: currentObservation.attempt.stateVersion,
            leaseId: currentObservation.attempt.leaseId,
            leaseFenced: false,
            hostCapabilities: []
          }),
          apply: async () => {
            sideEffects += 1;
            currentObservation = remoteOperationObservationSchema.parse({
              ...currentObservation,
              attempt: {
                ...currentObservation.attempt,
                stateVersion: currentObservation.attempt.stateVersion + 1
              }
            });
            return "delivered";
          }
        },
        ownerToken
      );
      const commands: unknown[] = [];
      let loseResponse = replacementAt === "accepted response lost";
      executeAction = async (command) => {
        commands.push(command);
        let result: Awaited<ReturnType<typeof engine.execute>>;
        try {
          result = await engine.execute(command);
        } catch (error) {
          if (replacementAt === "CAS replaced attempt" || replacementAt === "CAS replaced lease") {
            const replacement =
              replacementAt === "CAS replaced attempt"
                ? { executionAttemptId: "attempt-2", dispatchId: "dispatch-2" }
                : {};
            currentObservation = remoteOperationObservationSchema.parse({
              ...currentObservation,
              ...replacement,
              attempt: { ...currentObservation.attempt, ...replacement, leaseId: "lease-2" }
            });
          }
          throw error;
        }
        if (loseResponse) {
          loseResponse = false;
          throw new Error("response lost");
        }
        currentObservation = remoteOperationObservationSchema.parse({
          ...currentObservation,
          state: "cancelled",
          attempt: { ...currentObservation.attempt, status: "cancelled" }
        });
        return {
          request: result.request,
          state: result.state,
          createdAt: result.createdAt,
          deliveredAt: result.deliveredAt
        };
      };
      if (replacementAt !== "accepted response lost") {
        currentObservation = remoteOperationObservationSchema.parse({
          ...currentObservation,
          attempt: { ...currentObservation.attempt, stateVersion: 2 }
        });
      }
      await expect(service.cancel(cancelInput)).rejects.toThrow();
      const restarted = new WorkspaceExecutionDesktopService(
        collaboration,
        operatorControl,
        sessionsRoot
      );
      const recovery = await restarted.recoverCancellations({ locator: requestInput.locator });
      const intent = recovery.sessions[0]?.intent;
      expect(intent).toBeDefined();
      if (!intent) throw new Error("cancel intent required");
      if (replacementAt === "CAS replaced attempt" || replacementAt === "CAS replaced lease") {
        expect(intent.actionId).toBe(cancelInput.actionId);
        expect(intent.expectedRemoteHandle).toEqual(cancelInput.expectedRemoteHandle);
        await expect(restarted.cancel(cancelInput)).rejects.toThrow(
          /workspace_execution_(cancel_identity|resume)_mismatch/
        );
        expect(commands).toHaveLength(1);
        expect(sideEffects).toBe(0);
        return;
      }
      if (replacementAt === "accepted response lost") {
        expect(intent.actionId).toBe(cancelInput.actionId);
        expect(intent.expectedRemoteHandle).toEqual(cancelInput.expectedRemoteHandle);
      } else {
        expect(intent.actionId).not.toBe(cancelInput.actionId);
        expect(intent.expectedRemoteHandle).toMatchObject({
          attemptStateVersion: 2,
          leaseId: "lease-1",
          executionAttemptId: "attempt-1"
        });
        expect(actions.getRequired(cancelInput.actionId)).toMatchObject({
          state: "recorded",
          request: { expectedAttemptVersion: 1 }
        });
      }
      if (replacementAt === "CAS retry") {
        expect((await service.cancel(cancelInput)).session.phase).toBe("stopped");
      } else {
        const restored = restoreWorkspaceScopeCancellation({
          recovered: recovery,
          locator: requestInput.locator,
          scopeIdentity: "scope-1"
        });
        if (!restored) throw new Error("restored cancellation required");
        const cancellation = createWorkspaceScopeCancellation({
          api: {
            cancelWorkspaceExecutionStart: (input) => restarted.cancelStart(input),
            cancelWorkspaceExecution: (input) => restarted.cancel(input),
            recoverWorkspaceExecutionCancellations: (input) =>
              restarted.recoverCancellations(input),
            startWorkspaceExecution: (input) => restarted.start(input),
            followWorkspaceExecution: (input) => restarted.follow(input),
            respondWorkspaceExecution: (input) => restarted.respond(input),
            remoteAcpConversation: vi.fn()
          },
          createId: () => "unused-recovered-id",
          publish: vi.fn()
        });
        const results = await cancellation.abortRun(restored, true);
        expect(results).toEqual([{ status: "fulfilled", value: undefined }]);
        expect(restored.workspaceSessions.size).toBe(0);
      }
      expect(commands).toHaveLength(2);
      expect(sideEffects).toBe(1);
      if (replacementAt === "accepted response lost") expect(commands[1]).toEqual(commands[0]);
      expect(
        (await restarted.recoverCancellations({ locator: requestInput.locator })).sessions
      ).toEqual([]);
      return;
    }
    failObservation = true;
    await expect(service.cancel(cancelInput)).rejects.toThrow();
    failObservation = false;
    const restarted = new WorkspaceExecutionDesktopService(
      collaboration,
      operatorControl,
      sessionsRoot
    );
    expect(await restarted.recoverCancellations({ locator: requestInput.locator })).toMatchObject({
      sessions: [
        {
          sessionId,
          blockRef: requestInput.blockRef,
          intent: { actionId: "cancel-persisted", expectedRemoteHandle: started.handle }
        }
      ]
    });
    expect(
      (
        await restarted.recoverCancellations({
          locator: { ...requestInput.locator, canvasId: "other-canvas" }
        })
      ).sessions
    ).toEqual([]);
    const replacementTerminal = remoteOperationObservationSchema.parse({
      ...currentObservation,
      state: "cancelled",
      dispatchId: "dispatch-attempt-2",
      executionAttemptId: "attempt-2",
      attempt: {
        ...currentObservation.attempt,
        dispatchId: "dispatch-attempt-2",
        executionAttemptId: "attempt-2",
        status: "cancelled",
        leaseId: "lease-2",
        stateVersion: 3
      },
      diagnostics: { ...currentObservation.diagnostics, attemptId: "attempt-2", revision: 3 }
    });
    scheduledObservations.push(currentObservation);
    if (replacementAt === "final follow") scheduledObservations.push(currentObservation);
    scheduledObservations.push(replacementTerminal);
    currentObservation = replacementTerminal;
    await expect(restarted.cancel(cancelInput)).rejects.toThrow(
      "workspace_execution_cancel_identity_mismatch"
    );
    expect(
      (await sessions.get(storage, sessionId)).session.workspaceExecution?.cancellationIntent
    ).toMatchObject({ actionId: cancelInput.actionId, expectedRemoteHandle: started.handle });
    const afterReplacement = new WorkspaceExecutionDesktopService(
      collaboration,
      operatorControl,
      sessionsRoot
    );
    expect(
      (await afterReplacement.recoverCancellations({ locator: requestInput.locator })).sessions
    ).toMatchObject([
      {
        sessionId,
        intent: { actionId: cancelInput.actionId, expectedRemoteHandle: started.handle }
      }
    ]);
    if (replacementAt === "final follow") return;
    scheduledObservations.length = 0;
    currentObservation = runningObservation;
    await runWithOwner(
      ({ coordinator, request: value }) => coordinator.follow(value, sessionId),
      sessionId
    );
    currentObservation = remoteOperationObservationSchema.parse({
      ...runningObservation,
      attempt: { ...runningObservation.attempt, stateVersion: 2 },
      diagnostics: { ...runningObservation.diagnostics, revision: 2 }
    });
    await restarted.follow({ ...requestInput, sessionId });
    expect(
      (await sessions.get(storage, sessionId)).session.workspaceExecution?.cancellationIntent
        ?.actionId
    ).toBe("cancel-persisted");
    currentObservation = remoteOperationObservationSchema.parse({
      ...currentObservation,
      state: "cancelled",
      attempt: { ...currentObservation.attempt, status: "cancelled", stateVersion: 3 },
      diagnostics: { ...currentObservation.diagnostics, revision: 3 }
    });
    expect((await restarted.cancel(cancelInput)).session.phase).toBe("stopped");
    expect(
      (await restarted.recoverCancellations({ locator: requestInput.locator })).sessions
    ).toEqual([]);
    expect((await sessions.get(storage, sessionId)).session.workspaceExecution).not.toHaveProperty(
      "cancellationIntent"
    );

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
