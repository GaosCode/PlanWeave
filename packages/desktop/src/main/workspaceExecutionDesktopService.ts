import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { remoteHumanExecutionActionCommandSchema } from "@planweave-ai/collaboration-protocol/remote-run";
import {
  WorkspaceExecutionCoordinator,
  createRemoteWorkspaceExecutionAdapter,
  createWorkspaceAuthorityBindingResolver,
  projectWorkspaceExecutionCoordinatorView,
  type RemoteWorkspaceAuthorityBinding,
  type ValidatedWorkspaceAuthorityBinding,
  type WorkspaceExecutionCoordinatorView,
  type WorkspaceExecutionRequest,
  type WorkspaceExecutionSessionStorage
} from "@planweave-ai/runtime";
import type {
  DesktopWorkspaceExecutionCancelInput,
  DesktopWorkspaceExecutionFollowInput,
  DesktopWorkspaceExecutionRespondInput,
  DesktopWorkspaceExecutionStartInput
} from "../shared/workspaceExecution.js";
import type { WorkspaceCanvasLocator } from "../shared/canvasLocator.js";
import { CollaborationService } from "./collaboration/collaborationService.js";
import type { CollaborationClient } from "./collaboration/CollaborationClient.js";
import { desktopHomePaths } from "./planweaveHomePaths.js";
import { DesktopWorkspaceExecutionSessionRepository } from "./workspaceExecutionDesktopSessionRepository.js";

type RemoteBinding = ValidatedWorkspaceAuthorityBinding & RemoteWorkspaceAuthorityBinding;
type RemoteOperationsCancellationPort = Pick<
  ReturnType<CollaborationClient["remoteOperations"]>,
  "executeRemoteOperationAction" | "observeRemoteOperation"
>;
type WorkspaceExecutionCancelOutcome = "already_terminal" | "remote_terminal" | "cancelled";

export async function cancelActiveWorkspaceExecution(input: {
  current: WorkspaceExecutionCoordinatorView;
  actionId: string;
  reason: string;
  remoteOperations: RemoteOperationsCancellationPort;
}): Promise<WorkspaceExecutionCancelOutcome> {
  if (["completed", "failed", "stopped"].includes(input.current.session.phase)) {
    return "already_terminal";
  }
  if (input.current.handle.target !== "remote") {
    throw new Error("workspace_execution_remote_handle_required");
  }
  const observation = await input.remoteOperations.observeRemoteOperation(
    input.current.handle.operationId
  );
  if (["completed", "failed", "cancelled"].includes(observation.state)) {
    return "remote_terminal";
  }
  if (
    observation.operationId !== input.current.handle.operationId ||
    observation.dispatchId !== input.current.handle.dispatchId ||
    observation.executionAttemptId !== input.current.handle.executionAttemptId ||
    observation.attempt.stateVersion !== input.current.handle.attemptStateVersion ||
    observation.attempt.leaseId !== input.current.handle.leaseId ||
    input.current.handle.leaseId === null
  ) {
    throw new Error("workspace_execution_cancel_identity_mismatch");
  }
  await input.remoteOperations.executeRemoteOperationAction(
    input.current.handle.operationId,
    remoteHumanExecutionActionCommandSchema.parse({
      kind: "cancel",
      actionId: input.actionId,
      operationId: input.current.handle.operationId,
      dispatchId: input.current.handle.dispatchId,
      executionAttemptId: input.current.handle.executionAttemptId,
      expectedAttemptVersion: input.current.handle.attemptStateVersion,
      leaseId: input.current.handle.leaseId,
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
}): Promise<WorkspaceExecutionCoordinatorView> {
  const current = await input.follow();
  const outcome = await cancelActiveWorkspaceExecution({
    current,
    actionId: input.actionId,
    reason: input.reason,
    remoteOperations: input.remoteOperations
  });
  return outcome === "already_terminal" ? current : input.follow();
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

function requestFor(input: DesktopWorkspaceExecutionStartInput, serverOrigin: string) {
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
    sessionsRoot = join(desktopHomePaths().collaborationDir, "workspace-execution")
  ) {
    this.sessions = new DesktopWorkspaceExecutionSessionRepository(sessionsRoot);
  }

  start(input: DesktopWorkspaceExecutionStartInput) {
    return this.withRequestCoordinator(
      input.locator,
      async ({ coordinator, request }) =>
        projectWorkspaceExecutionCoordinatorView(await coordinator.execute(request)),
      input
    );
  }

  follow(input: DesktopWorkspaceExecutionFollowInput) {
    if ("operationId" in input) {
      return this.withBoundCoordinator(input.locator, async ({ coordinator, serverOrigin }) =>
        projectWorkspaceExecutionCoordinatorView(
          await coordinator.observeExisting({
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
            operationId: input.operationId
          })
        )
      );
    }
    return this.withRequestCoordinator(
      input.locator,
      async ({ coordinator, request }) =>
        projectWorkspaceExecutionCoordinatorView(
          await coordinator.follow(request, input.sessionId)
        ),
      input
    );
  }

  respond(input: DesktopWorkspaceExecutionRespondInput) {
    return this.withRequestCoordinator(
      input.locator,
      async ({ coordinator, request }) => {
        await coordinator.respond({
          request,
          sessionId: input.sessionId,
          response: input.response
        });
        return projectWorkspaceExecutionCoordinatorView(
          await coordinator.follow(request, input.sessionId)
        );
      },
      input
    );
  }

  cancel(input: DesktopWorkspaceExecutionCancelInput) {
    return this.withRequestCoordinator(
      input.locator,
      async ({ coordinator, request, client }) => {
        return cancelWorkspaceExecutionSession({
          follow: async () =>
            projectWorkspaceExecutionCoordinatorView(
              await coordinator.follow(request, input.sessionId)
            ),
          actionId: input.actionId,
          reason: input.reason,
          remoteOperations: client.remoteOperations()
        });
      },
      input
    );
  }

  private withRequestCoordinator<T>(
    locator: WorkspaceCanvasLocator,
    operation: (context: {
      coordinator: WorkspaceExecutionCoordinator;
      request: WorkspaceExecutionRequest;
      client: CollaborationClient;
    }) => Promise<T>,
    input: DesktopWorkspaceExecutionStartInput
  ): Promise<T> {
    return this.withBoundCoordinator(locator, ({ coordinator, client, serverOrigin }) =>
      operation({ coordinator, request: requestFor(input, serverOrigin), client })
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
          list: ({ binding }, signal) =>
            remote.listAgentEndpoints(
              {
                workspaceId: binding.workspaceId,
                projectId: binding.projectId,
                canvasId: binding.canvasId
              },
              signal
            )
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
        idempotencyKey: randomUUID
      });
      return operation({ coordinator, client, serverOrigin });
    });
  }
}
