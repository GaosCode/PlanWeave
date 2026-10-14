import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { remoteHumanExecutionActionCommandSchema } from "@planweave-ai/collaboration-protocol/remote-run";
import { dispatchIdSchema, executionAttemptIdSchema } from "@planweave-ai/agent-host-protocol";
import {
  WorkspaceExecutionCoordinator,
  RemoteOwnershipConflictError,
  createRemoteWorkspaceExecutionAdapter,
  createWorkspaceAuthorityBindingResolver,
  projectWorkspaceExecutionCoordinatorView,
  type RemoteWorkspaceAuthorityBinding,
  type ValidatedWorkspaceAuthorityBinding,
  type WorkspaceCanvasRemoteAuthorityBinding,
  type WorkspaceExecutionCoordinatorView,
  type WorkspaceExecutionSessionRecord,
  type WorkspaceExecutionRequest,
  type WorkspaceExecutionSessionStorage,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import type {
  DesktopWorkspaceExecutionCancellationRecovery,
  DesktopWorkspaceExecutionCancelInput,
  DesktopWorkspaceExecutionFollowInput,
  DesktopWorkspaceExecutionRespondInput,
  DesktopWorkspaceExecutionStartInput
} from "../shared/workspaceExecution.js";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator.js";
import { CollaborationService } from "./collaboration/collaborationService.js";
import type { CollaborationClient } from "./collaboration/CollaborationClient.js";
import { desktopHomePaths } from "./planweaveHomePaths.js";
import type { OperatorControlService } from "./operatorControl/operatorControlService.js";
import { DesktopWorkspaceExecutionSessionRepository } from "./workspaceExecutionDesktopSessionRepository.js";
import {
  ownerSessionStorage,
  withOwnerCanvasExistingExecutionCoordinator,
  withOwnerCanvasExecutionCoordinator,
  type OwnerCanvasRemoteOperations
} from "./workspaceExecutionOwnerCanvas.js";

type RemoteBinding = ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding;
type WorkspaceRemoteBinding = ValidatedWorkspaceAuthorityBinding &
  WorkspaceCanvasRemoteAuthorityBinding;
type OwnerCanvasExecutionInput = Extract<
  DesktopWorkspaceExecutionStartInput,
  { locator: { kind: "owner_canvas" } }
>;
type WorkspaceCanvasExecutionInput = Extract<
  DesktopWorkspaceExecutionStartInput,
  { locator: { kind: "workspace" } }
>;
type RemoteOperationsCancellationPort =
  | Pick<
      ReturnType<CollaborationClient["remoteOperations"]>,
      "executeRemoteOperationAction" | "observeRemoteOperation"
    >
  | OwnerCanvasRemoteOperations;
type WorkspaceExecutionCancelOutcome = "already_terminal" | "remote_terminal" | "cancelled";

type OwnerLocalWritebackContext = {
  request: WorkspaceExecutionRequest & { authority: { kind: "owner_canvas" } };
  view: WorkspaceExecutionCoordinatorView;
  runtime: RemoteBlockRuntimePort;
  remoteOperations: OwnerCanvasRemoteOperations;
};

function isOwnerCanvasExecutionInput(
  input: DesktopWorkspaceExecutionStartInput
): input is OwnerCanvasExecutionInput {
  return input.locator.kind === "owner_canvas";
}

function requireWorkspaceRemoteBinding(binding: RemoteBinding): WorkspaceRemoteBinding {
  if (!("workspaceId" in binding)) {
    throw new Error("workspace_execution_authority_kind_mismatch");
  }
  return binding;
}

async function writeBackOwnerCanvasExecution(input: OwnerLocalWritebackContext): Promise<void> {
  if (input.view.handle.target !== "remote" || input.request.scope.kind !== "block") {
    throw new Error("owner_canvas_remote_block_handle_required");
  }
  const handle = input.view.handle;
  if (!handle.executionAttemptId) return;
  const ref = input.request.scope.blockRef;
  const source = input.request.authority.expected;
  try {
    const existing = await input.runtime.query({ ref, operationId: handle.operationId });
    if (existing.terminalReceipt) return;
  } catch (error) {
    if (
      !(error instanceof RemoteOwnershipConflictError) ||
      error.code !== "remote_ownership_not_active"
    ) {
      throw error;
    }
    await input.runtime.claim({
      ref,
      operationId: handle.operationId,
      controlPlane: "owner",
      sourceRevision: source.contentRevision,
      graphFingerprint: source.graphFingerprint
    });
  }
  const identity = {
    ref,
    operationId: handle.operationId,
    controlPlane: "owner" as const,
    sourceRevision: source.contentRevision,
    graphFingerprint: source.graphFingerprint,
    dispatchId: dispatchIdSchema.parse(handle.dispatchId),
    executionAttemptId: executionAttemptIdSchema.parse(handle.executionAttemptId)
  };
  await input.runtime.activate(identity);
  if (input.view.session.phase === "completed") {
    const result = await input.remoteOperations.readOwnerRemoteOperationTerminalResult(
      handle.operationId
    );
    const metadata = result.metadata;
    if (
      metadata.operationId !== handle.operationId ||
      metadata.projectId !== input.request.authority.projectId ||
      metadata.canvasId !== input.request.authority.canvasId ||
      metadata.blockRef !== ref ||
      metadata.sourceRevision !== source.contentRevision ||
      metadata.graphFingerprint !== source.graphFingerprint ||
      metadata.dispatchId !== handle.dispatchId ||
      metadata.executionAttemptId !== handle.executionAttemptId
    ) {
      throw new Error("owner_canvas_terminal_result_identity_mismatch");
    }
    await input.runtime.complete({
      ...identity,
      reportArtifactRef: metadata.reportArtifactRef,
      reportBytes: new Uint8Array(result.reportBytes)
    });
    return;
  }
  if (input.view.session.phase === "failed" || input.view.session.phase === "stopped") {
    await input.runtime.fail({
      ...identity,
      failure: {
        code:
          input.view.session.phase === "stopped"
            ? "execution_cancelled"
            : "remote_execution_failed",
        message:
          input.view.session.error ??
          (input.view.session.phase === "stopped"
            ? "Remote operation was cancelled."
            : "Remote operation failed."),
        retryable: input.view.session.phase === "stopped"
      },
      ...(input.request.effectiveExecutor?.agentId
        ? { agentId: input.request.effectiveExecutor.agentId }
        : {})
    });
  }
}

function assertCancellationViewIdentity(
  view: {
    handle: WorkspaceExecutionCoordinatorView["handle"];
    session: Pick<WorkspaceExecutionSessionRecord, "sessionId" | "phase">;
  },
  expected: NonNullable<DesktopWorkspaceExecutionCancelInput["expectedRemoteHandle"]>
): void {
  if (
    view.handle.target !== "remote" ||
    view.session.sessionId !== expected.runSessionId ||
    view.handle.authorityBindingId !== expected.authorityBindingId ||
    view.handle.operationId !== expected.operationId ||
    view.handle.dispatchId !== expected.dispatchId ||
    view.handle.executionAttemptId !== expected.executionAttemptId ||
    (!["completed", "failed", "stopped"].includes(view.session.phase) &&
      view.handle.leaseId !== expected.leaseId)
  )
    throw new Error("workspace_execution_cancel_identity_mismatch");
}

export async function cancelActiveWorkspaceExecution(input: {
  current: WorkspaceExecutionCoordinatorView;
  actionId: string;
  reason: string;
  remoteOperations: RemoteOperationsCancellationPort;
  expectedRemoteHandle?: DesktopWorkspaceExecutionCancelInput["expectedRemoteHandle"];
}): Promise<WorkspaceExecutionCancelOutcome> {
  if (["completed", "failed", "stopped"].includes(input.current.session.phase)) {
    return "already_terminal";
  }
  if (input.current.handle.target !== "remote") {
    throw new Error("workspace_execution_remote_handle_required");
  }
  const handle = input.expectedRemoteHandle ?? input.current.handle;
  const observation = await input.remoteOperations.observeRemoteOperation(handle.operationId);
  const terminal = ["completed", "failed", "cancelled"].includes(observation.state);
  if (
    (input.expectedRemoteHandle || !terminal) &&
    (observation.operationId !== handle.operationId ||
      observation.dispatchId !== handle.dispatchId ||
      observation.executionAttemptId !== handle.executionAttemptId)
  )
    throw new Error("workspace_execution_cancel_identity_mismatch");
  if (terminal) {
    return "remote_terminal";
  }
  if (
    // Pinned retries replay the original command; Server owns action deduplication and CAS.
    (!input.expectedRemoteHandle &&
      observation.attempt.stateVersion !== handle.attemptStateVersion) ||
    observation.attempt.leaseId !== handle.leaseId ||
    handle.leaseId === null
  ) {
    throw new Error("workspace_execution_cancel_identity_mismatch");
  }
  await input.remoteOperations.executeRemoteOperationAction(
    handle.operationId,
    remoteHumanExecutionActionCommandSchema.parse({
      kind: "cancel",
      actionId: input.actionId,
      operationId: handle.operationId,
      dispatchId: handle.dispatchId,
      executionAttemptId: handle.executionAttemptId,
      expectedAttemptVersion: handle.attemptStateVersion,
      leaseId: handle.leaseId,
      reason: input.reason
    })
  );
  return "cancelled";
}

export async function cancelWorkspaceExecutionSession(input: {
  follow(): Promise<WorkspaceExecutionCoordinatorView>;
  actionId: string;
  reason: string;
  remoteOperations: RemoteOperationsCancellationPort;
  expectedRemoteHandle?: DesktopWorkspaceExecutionCancelInput["expectedRemoteHandle"];
}): Promise<WorkspaceExecutionCoordinatorView> {
  const current = await input.follow();
  const expected = input.expectedRemoteHandle;
  if (expected) assertCancellationViewIdentity(current, expected);
  const outcome = await cancelActiveWorkspaceExecution({
    current,
    expectedRemoteHandle: expected,
    actionId: input.actionId,
    reason: input.reason,
    remoteOperations: input.remoteOperations
  });
  const final = outcome === "already_terminal" ? current : await input.follow();
  if (expected) assertCancellationViewIdentity(final, expected);
  return final;
}

function namespaceFor(input: {
  profileId: string;
  serverOrigin: string;
  workspaceId: string;
  projectId: string;
  canvasId: string;
}): WorkspaceExecutionSessionStorage {
  const canonical = JSON.stringify([
    input.profileId,
    input.serverOrigin,
    input.workspaceId,
    input.projectId,
    input.canvasId
  ]);
  return {
    kind: "namespace",
    namespace: `wxs:sha256:${createHash("sha256").update(canonical).digest("hex")}`
  };
}

function requestFor(
  input: Extract<DesktopWorkspaceExecutionStartInput, { locator: { kind: "workspace" } }>,
  serverOrigin: string
) {
  return {
    authority: {
      kind: "workspace_canvas",
      contentAuthority: { kind: "server_canvas" },
      connectionProfileId: input.locator.connectionProfileId,
      serverOrigin,
      workspaceId: input.locator.workspaceId,
      projectId: input.locator.projectId,
      canvasId: input.locator.canvasId
    },
    scope: { kind: "block", blockRef: input.blockRef },
    trigger: "desktop",
    target: { policy: "remote", agentEndpointId: input.agentEndpointId },
    effectiveExecutor: input.effectiveExecutor,
    eventFormat: "execution-v1"
  } satisfies WorkspaceExecutionRequest;
}

export class WorkspaceExecutionDesktopService {
  private readonly sessions: DesktopWorkspaceExecutionSessionRepository;

  constructor(
    private readonly collaboration: CollaborationService,
    private readonly operatorControl: Pick<OperatorControlService, "withExecutionProfile">,
    sessionsRoot = join(desktopHomePaths().collaborationDir, "workspace-execution")
  ) {
    this.sessions = new DesktopWorkspaceExecutionSessionRepository(sessionsRoot);
  }

  start(input: DesktopWorkspaceExecutionStartInput) {
    return this.withRequestCoordinator(
      async ({ coordinator, request, remoteOperations, localRuntime }) => {
        const view = projectWorkspaceExecutionCoordinatorView(await coordinator.execute(request));
        if (localRuntime && request.authority.kind === "owner_canvas") {
          await writeBackOwnerCanvasExecution({
            request: request as OwnerLocalWritebackContext["request"],
            view,
            runtime: localRuntime,
            remoteOperations: remoteOperations as OwnerCanvasRemoteOperations
          });
        }
        return view;
      },
      input
    );
  }

  follow(input: DesktopWorkspaceExecutionFollowInput) {
    if ("operationId" in input) {
      if (input.locator.kind === "owner_canvas") {
        const locator = input.locator;
        return withOwnerCanvasExistingExecutionCoordinator({
          blockRef: input.blockRef,
          locator,
          operationId: input.operationId,
          operatorControl: this.operatorControl,
          sessions: this.sessions,
          operation: ({ coordinator, expected, serverOrigin }) =>
            coordinator
              .observeExisting({
                authority: {
                  kind: "owner_canvas",
                  packageWorkspace: locator.projectRoot,
                  expected,
                  connectionProfileId: locator.operatorProfileId,
                  serverOrigin,
                  humanPrincipalId: locator.humanPrincipalId,
                  projectId: locator.projectId,
                  canvasId: locator.canvasId
                },
                scope: { kind: "block", blockRef: input.blockRef },
                operationId: input.operationId,
                evidenceCursor: input.evidenceCursor
              })
              .then(projectWorkspaceExecutionCoordinatorView)
        });
      }
      const locator = input.locator;
      return this.withBoundCoordinator(locator, async ({ coordinator, serverOrigin }) =>
        projectWorkspaceExecutionCoordinatorView(
          await coordinator.observeExisting({
            authority: {
              kind: "workspace_canvas",
              contentAuthority: { kind: "server_canvas" },
              connectionProfileId: locator.connectionProfileId,
              serverOrigin,
              workspaceId: locator.workspaceId,
              projectId: locator.projectId,
              canvasId: locator.canvasId
            },
            scope: { kind: "block", blockRef: input.blockRef },
            operationId: input.operationId,
            evidenceCursor: input.evidenceCursor
          })
        )
      );
    }
    return this.withRequestCoordinator(
      async ({ coordinator, request, remoteOperations, localRuntime }) => {
        const view = projectWorkspaceExecutionCoordinatorView(
          await coordinator.follow(request, input.sessionId)
        );
        if (localRuntime && request.authority.kind === "owner_canvas") {
          await writeBackOwnerCanvasExecution({
            request: request as OwnerLocalWritebackContext["request"],
            view,
            runtime: localRuntime,
            remoteOperations: remoteOperations as OwnerCanvasRemoteOperations
          });
        }
        return view;
      },
      input
    );
  }

  respond(input: DesktopWorkspaceExecutionRespondInput) {
    return this.withRequestCoordinator(
      async ({ coordinator, request, remoteOperations, localRuntime }) => {
        await coordinator.respond({
          request,
          sessionId: input.sessionId,
          response: input.response
        });
        const view = projectWorkspaceExecutionCoordinatorView(
          await coordinator.follow(request, input.sessionId)
        );
        if (localRuntime && request.authority.kind === "owner_canvas") {
          await writeBackOwnerCanvasExecution({
            request: request as OwnerLocalWritebackContext["request"],
            view,
            runtime: localRuntime,
            remoteOperations: remoteOperations as OwnerCanvasRemoteOperations
          });
        }
        return view;
      },
      input
    );
  }

  private withCancellationStorage<T>(
    locator: DesktopWorkspaceExecutionStartInput["locator"],
    operation: (storage: WorkspaceExecutionSessionStorage) => Promise<T>
  ): Promise<T> {
    if (locator.kind === "owner_canvas") return operation(ownerSessionStorage(locator));
    return this.withBoundCoordinator(locator, ({ serverOrigin }) =>
      operation(
        namespaceFor({
          profileId: locator.connectionProfileId,
          serverOrigin,
          workspaceId: locator.workspaceId,
          projectId: locator.projectId,
          canvasId: locator.canvasId
        })
      )
    );
  }

  recoverCancellations(input: {
    locator: DesktopWorkspaceExecutionStartInput["locator"];
  }): Promise<DesktopWorkspaceExecutionCancellationRecovery> {
    return this.withCancellationStorage(input.locator, async (storage) => {
      const listed = await this.sessions.list(storage);
      return {
        version: "planweave.workspace-cancellation-recovery/v1",
        sessions: listed.sessions.flatMap((session) => {
          const intent = session.workspaceExecution?.cancellationIntent;
          return intent && session.scope.kind === "block"
            ? [{ sessionId: session.sessionId, blockRef: session.scope.blockRef, intent }]
            : [];
        })
      };
    });
  }

  private async persistCancellationIntent(
    input: DesktopWorkspaceExecutionCancelInput,
    confirmed: boolean
  ): Promise<void> {
    const expected = input.expectedRemoteHandle;
    if (!expected) return;
    await this.withCancellationStorage(input.locator, (storage) =>
      this.sessions.withMutation(storage, async () => {
        const session = (await this.sessions.get(storage, input.sessionId)).session;
        const state = session.workspaceExecution;
        if (!state || !state.handle || state.binding.bindingId !== expected.authorityBindingId)
          throw new Error("workspace_execution_cancel_identity_mismatch");
        assertCancellationViewIdentity({ session, handle: state.handle }, expected);
        const intent = {
          actionId: input.actionId,
          reason: input.reason,
          expectedRemoteHandle: expected,
          effectiveExecutor: input.effectiveExecutor
        };
        if (
          (confirmed && !state.cancellationIntent) ||
          (state.cancellationIntent &&
            (state.cancellationIntent.actionId !== intent.actionId ||
              state.cancellationIntent.reason !== intent.reason ||
              !isDeepStrictEqual(state.cancellationIntent.expectedRemoteHandle, expected) ||
              !isDeepStrictEqual(
                state.cancellationIntent.effectiveExecutor,
                intent.effectiveExecutor
              )))
        )
          throw new Error("workspace_execution_cancel_identity_mismatch");
        const next = { ...state };
        if (confirmed) delete next.cancellationIntent;
        else next.cancellationIntent = intent;
        await this.sessions.update(
          storage,
          input.sessionId,
          { workspaceExecution: next },
          { expectedStateVersion: session.stateVersion }
        );
      })
    );
  }

  async cancel(input: DesktopWorkspaceExecutionCancelInput) {
    await this.persistCancellationIntent(input, false);
    const result = await this.withRequestCoordinator(
      async ({ coordinator, request, remoteOperations, localRuntime }) => {
        const view = await cancelWorkspaceExecutionSession({
          follow: async () =>
            projectWorkspaceExecutionCoordinatorView(
              await coordinator.follow(request, input.sessionId)
            ),
          actionId: input.actionId,
          reason: input.reason,
          expectedRemoteHandle: input.expectedRemoteHandle,
          remoteOperations
        });
        if (localRuntime && request.authority.kind === "owner_canvas") {
          await writeBackOwnerCanvasExecution({
            request: request as OwnerLocalWritebackContext["request"],
            view,
            runtime: localRuntime,
            remoteOperations: remoteOperations as OwnerCanvasRemoteOperations
          });
        }
        return view;
      },
      input
    );
    if (["completed", "failed", "stopped"].includes(result.session.phase))
      await this.persistCancellationIntent(input, true);
    return result;
  }

  private withRequestCoordinator<T>(
    operation: (context: {
      coordinator: WorkspaceExecutionCoordinator;
      request: WorkspaceExecutionRequest;
      remoteOperations: RemoteOperationsCancellationPort;
      localRuntime?: RemoteBlockRuntimePort;
    }) => Promise<T>,
    input: DesktopWorkspaceExecutionStartInput & { sessionId?: string }
  ): Promise<T> {
    if (isOwnerCanvasExecutionInput(input)) {
      return withOwnerCanvasExecutionCoordinator({
        requestInput: input,
        operatorControl: this.operatorControl,
        sessions: this.sessions,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        operation
      });
    }
    const workspaceInput: WorkspaceCanvasExecutionInput = input;
    return this.withBoundCoordinator(
      workspaceInput.locator,
      ({ coordinator, client, serverOrigin }) =>
        operation({
          coordinator,
          request: requestFor(workspaceInput, serverOrigin),
          remoteOperations: client.remoteOperations()
        })
    );
  }

  private withBoundCoordinator<T>(
    locator: WorkspaceCanvasLocator,
    operation: (context: {
      coordinator: WorkspaceExecutionCoordinator;
      client: CollaborationClient;
      serverOrigin: string;
    }) => Promise<T>
  ): Promise<T> {
    return this.collaboration.withWorkspaceExecutionClient(locator, async (client) => {
      const serverOrigin = new URL(client.connectionProfile.serverBaseUrl).origin;
      const remote = client.remoteOperations();
      const workAuthority = {
        ensure: ({ binding }: { binding: RemoteBinding }, signal?: AbortSignal) =>
          client.getWorkAuthority(
            {
              kind: "block",
              workspaceId: locator.workspaceId,
              projectId: locator.projectId,
              canvasId: locator.canvasId,
              blockRef: binding.blockRef
            },
            signal
          )
      };
      const authority = createWorkspaceAuthorityBindingResolver({
        local: {
          async inspect() {
            throw new Error("local_authority_unavailable");
          }
        },
        remote: {
          async inspect(candidate, blockRef, signal) {
            if (
              candidate.connectionProfileId !== locator.connectionProfileId ||
              candidate.workspaceId !== locator.workspaceId ||
              candidate.projectId !== locator.projectId ||
              candidate.canvasId !== locator.canvasId
            ) {
              throw new Error("workspace_execution_locator_mismatch");
            }
            const [availability, current] = await Promise.all([
              client.readRuntimeAvailability(candidate.canvasId, signal),
              client.getWorkAuthority(
                {
                  kind: "block",
                  workspaceId: locator.workspaceId,
                  projectId: locator.projectId,
                  canvasId: locator.canvasId,
                  blockRef
                },
                signal
              )
            ]);
            if (availability.schemaVersion !== "canvas-runtime-view/v2") {
              throw new Error("workspace_execution_content_authority_unavailable");
            }
            return {
              connectionProfileId: candidate.connectionProfileId,
              serverOrigin,
              workspaceId: candidate.workspaceId,
              projectId: candidate.projectId,
              canvasId: candidate.canvasId,
              blockRef,
              contentRevision: availability.authority.sourceRevision,
              graphFingerprint: availability.authority.graphFingerprint,
              authorityRevisions: current.revisions
            };
          }
        }
      });
      const coordinator = new WorkspaceExecutionCoordinator({
        authority,
        catalog: {
          list: ({ binding }, signal) => {
            const workspaceBinding = requireWorkspaceRemoteBinding(binding);
            return remote.listAgentEndpoints(
              {
                workspaceId: workspaceBinding.workspaceId,
                projectId: workspaceBinding.projectId,
                canvasId: workspaceBinding.canvasId
              },
              signal
            );
          }
        },
        workAuthority,
        local: {
          async launch() {
            throw new Error("local_execution_unavailable");
          }
        },
        remote: createRemoteWorkspaceExecutionAdapter({
          workAuthority,
          command: {
            dispatch: ({ intent }, signal) => remote.dispatchRemoteOperation(intent, signal)
          },
          query: {
            recover: ({ binding, idempotencyKey }, signal) =>
              remote.lookupRemoteOperation(
                { canvasId: binding.canvasId, blockRef: binding.blockRef, idempotencyKey },
                signal
              ),
            observe: ({ operationId }, signal) =>
              remote.observeRemoteOperation(operationId, signal),
            replay: ({ operationId, afterCursor }, signal) =>
              remote.replayRemoteOperationEvents(operationId, { afterCursor }, signal),
            interactions: ({ operationId, cursor }, signal) =>
              remote.listRemoteOperationInteractions(operationId, { cursor }, signal)
          },
          interaction: {
            respond: ({ operationId, response }, signal) =>
              remote.settleRemoteOperationInteraction(operationId, response, signal)
          }
        }),
        sessions: this.sessions,
        sessionStorage: (binding) =>
          namespaceFor({
            profileId:
              binding.kind === "remote" ? binding.connectionProfileId : locator.connectionProfileId,
            serverOrigin,
            workspaceId: locator.workspaceId,
            projectId: locator.projectId,
            canvasId: locator.canvasId
          }),
        sessionStorageForRequest: () =>
          namespaceFor({
            profileId: locator.connectionProfileId,
            serverOrigin,
            workspaceId: locator.workspaceId,
            projectId: locator.projectId,
            canvasId: locator.canvasId
          }),
        idempotencyKey: randomUUID
      });
      return operation({ coordinator, client, serverOrigin });
    });
  }
}
