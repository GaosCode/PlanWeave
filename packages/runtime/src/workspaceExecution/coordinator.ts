import { randomUUID } from "node:crypto";
import type { RemoteInteractionResponse } from "@planweave-ai/collaboration-protocol/remote-run";
import {
  appendRunSessionEvent,
  createRunSession,
  getRunSession,
  listRunSessions,
  updateRunSession,
  withRunSessionScopeLock
} from "../runSessions/repository.js";
import type { RunSessionState, RunSessionTrigger } from "../runSessions/types.js";
import {
  remoteWorkspaceExecutionHandleSchema,
  workspaceExecutionRequestSchema,
  workspaceExecutionSessionStateSchema,
  type RemoteWorkspaceExecutionHandle,
  type WorkspaceExecutionDispatchIntent,
  type WorkspaceExecutionEvent,
  type WorkspaceExecutionHandle,
  type WorkspaceExecutionRequest
} from "./contracts.js";
import {
  assertRemoteWorkAuthorityMatchesBinding,
  type ValidatedWorkspaceAuthorityBinding,
  type WorkspaceAuthorityBindingPort
} from "./authorityBinding.js";
import { WorkspaceExecutionError, workspaceExecutionPortError } from "./errors.js";
import {
  executionScopeEquals,
  projectActionRequiredEvent,
  projectExecutionSelectedEvent,
  projectLocalTerminalEvent,
  projectRemoteEvidenceEvents,
  projectRemoteExecutionEvents,
  projectRemoteInteractionEvent
} from "./eventProjection.js";
import type {
  LocalWorkspaceExecutionAdapter,
  RemoteAgentCatalogPort,
  RemoteWorkspaceAdapterSnapshot,
  RemoteWorkspaceExecutionAdapter,
  WorkAuthorityPort
} from "./ports.js";
import { remoteInteractionIdentityKeyFrom } from "./remoteExecutionAdapter.js";
import {
  persistRemoteEvidence,
  persistRemoteEvidenceDiagnostic,
  persistRemoteInteraction,
  persistRemoteObservation,
  remoteSessionState
} from "./sessionCheckpoint.js";
import { resolveWorkspaceExecutionTarget } from "./targetResolution.js";

export type WorkspaceExecutionCoordinatorResult = {
  handle: WorkspaceExecutionHandle;
  session: RunSessionState;
  events: WorkspaceExecutionEvent[];
};

type RunSessionRepositoryPort = {
  create: typeof createRunSession;
  get: typeof getRunSession;
  list: typeof listRunSessions;
  update: typeof updateRunSession;
  appendEvent: typeof appendRunSessionEvent;
  withScopeLock: typeof withRunSessionScopeLock;
};

const terminalPhases = new Set(["completed", "failed", "stopped"]);

function runSessionTrigger(trigger: WorkspaceExecutionRequest["trigger"]): RunSessionTrigger {
  if (trigger === "desktop") return "desktop";
  if (trigger === "api") return "api";
  return "manual";
}

function bindingMatchesSession(
  session: RunSessionState,
  bindingId: string,
  request: WorkspaceExecutionRequest
): session is RunSessionState & {
  workspaceExecution: NonNullable<RunSessionState["workspaceExecution"]>;
} {
  return Boolean(
    session.workspaceExecution &&
      session.workspaceExecution.binding.bindingId === bindingId &&
      executionScopeEquals(session.scope, request.scope)
  );
}

function remoteIntent(input: {
  binding: Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>;
  endpointId: string;
  idempotencyKey: string;
}): WorkspaceExecutionDispatchIntent {
  return {
    schemaVersion: "remote-run/v3",
    projectId: input.binding.projectId,
    canvasId: input.binding.canvasId,
    blockRef: input.binding.blockRef,
    agentEndpointId: input.endpointId,
    idempotencyKey: input.idempotencyKey,
    expectedResponsibilityRevision: input.binding.authorityRevisions.responsibilityRevision,
    expectedReviewerRevision: input.binding.authorityRevisions.reviewerRevision,
    executionTargetRevision: input.binding.authorityRevisions.executionTargetRevision,
    contentRevision: input.binding.contentRevision,
    graphFingerprint: input.binding.graphFingerprint
  };
}

export class WorkspaceExecutionCoordinator {
  private readonly sessions: RunSessionRepositoryPort;

  constructor(
    private readonly input: {
      authority: WorkspaceAuthorityBindingPort;
      catalog: RemoteAgentCatalogPort;
      workAuthority: WorkAuthorityPort;
      local: LocalWorkspaceExecutionAdapter;
      remote: RemoteWorkspaceExecutionAdapter;
      sessions?: RunSessionRepositoryPort;
      clock?: () => Date;
      idempotencyKey?: () => string;
    }
  ) {
    this.sessions = input.sessions ?? {
      create: createRunSession,
      get: getRunSession,
      list: listRunSessions,
      update: updateRunSession,
      appendEvent: appendRunSessionEvent,
      withScopeLock: withRunSessionScopeLock
    };
  }

  async execute(
    rawRequest: unknown,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    const request = workspaceExecutionRequestSchema.parse(rawRequest);
    const binding = await this.input.authority.resolve(request.authority, request.scope, signal);

    if (request.target.policy === "local") {
      const target = resolveWorkspaceExecutionTarget(request);
      const snapshot = await this.input.local.launch({ request, binding, signal });
      const workspaceExecution = workspaceExecutionSessionStateSchema.parse({
        version: "planweave.workspace-execution-session/v1",
        binding,
        dispatchIntent: null,
        handle: snapshot.handle,
        interactions: [],
        evidence: { status: "complete", diagnostics: [] }
      });
      const persisted = await this.sessions.update(
        binding.packageWorkspace,
        snapshot.session.sessionId,
        {
          workspaceExecution,
          phase: snapshot.session.phase,
          finishedAt: snapshot.session.finishedAt,
          error: snapshot.session.error
        },
        { expectedStateVersion: snapshot.session.stateVersion }
      );
      return {
        handle: snapshot.handle,
        session: persisted,
        events: [
          projectExecutionSelectedEvent({
            handle: snapshot.handle,
            target,
            clock: this.input.clock
          }),
          ...(snapshot.terminal.terminal
            ? [
                projectLocalTerminalEvent({
                  handle: snapshot.handle,
                  outcome: snapshot.terminal.outcome,
                  clock: this.input.clock
                })
              ]
            : [
                projectActionRequiredEvent({
                  handle: snapshot.handle,
                  reason: snapshot.session.phase === "blocked" ? "blocked" : "manual",
                  clock: this.input.clock
                })
              ])
        ]
      };
    }

    return this.sessions.withScopeLock(binding.packageWorkspace, request.scope, async () => {
      if (binding.kind !== "remote" || !request.effectiveExecutor) {
        throw new WorkspaceExecutionError("workspace_execution_authority_mismatch");
      }
      const resumable = await this.findScopedSession(binding.bindingId, request);
      if (resumable) {
        return this.resumeOrRecover(binding, resumable, signal);
      }
      let currentAuthority: Awaited<ReturnType<WorkAuthorityPort["ensure"]>>;
      try {
        currentAuthority = await this.input.workAuthority.ensure({ binding }, signal);
      } catch (error) {
        throw workspaceExecutionPortError(error, "work_authority_unavailable");
      }
      assertRemoteWorkAuthorityMatchesBinding(binding, currentAuthority);
      let catalog: Awaited<ReturnType<RemoteAgentCatalogPort["list"]>>;
      try {
        catalog = await this.input.catalog.list(
          { binding, executor: request.effectiveExecutor },
          signal
        );
      } catch (error) {
        throw workspaceExecutionPortError(error, "remote_catalog_unavailable");
      }
      const rebound = await this.input.authority.resolve(request.authority, request.scope, signal);
      if (rebound.kind !== "remote" || rebound.bindingId !== binding.bindingId) {
        throw new WorkspaceExecutionError("workspace_execution_authority_mismatch");
      }
      const target = resolveWorkspaceExecutionTarget(request, catalog);
      if (target.target !== "remote") {
        throw new WorkspaceExecutionError("agent_endpoint_unavailable");
      }
      const intent = remoteIntent({
        binding,
        endpointId: target.agentEndpointId,
        idempotencyKey: `workspace-execution-${(this.input.idempotencyKey ?? randomUUID)()}`
      });
      const session = await this.sessions.create({
        projectRoot: binding.packageWorkspace,
        kind: "run",
        trigger: runSessionTrigger(request.trigger),
        scope: request.scope,
        phase: "running",
        workspaceExecution: remoteSessionState(binding, intent, null)
      });
      const snapshot = await this.input.remote.launch({
        request,
        binding,
        target,
        session,
        intent,
        signal
      });
      return this.acceptCheckpoint(binding, session, snapshot, target, signal);
    });
  }

  async follow(
    rawRequest: unknown,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    const request = workspaceExecutionRequestSchema.parse(rawRequest);
    const binding = await this.input.authority.resolve(request.authority, request.scope, signal);
    const detail = await this.sessions.get(binding.packageWorkspace, sessionId);
    if (
      !bindingMatchesSession(detail.session, binding.bindingId, request) ||
      binding.kind !== "remote"
    ) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    return this.resumeOrRecover(binding, detail.session, signal);
  }

  async respond(input: {
    request: unknown;
    sessionId: string;
    response: RemoteInteractionResponse;
    signal?: AbortSignal;
  }): Promise<WorkspaceExecutionEvent> {
    const request = workspaceExecutionRequestSchema.parse(input.request);
    const binding = await this.input.authority.resolve(
      request.authority,
      request.scope,
      input.signal
    );
    const detail = await this.sessions.get(binding.packageWorkspace, input.sessionId);
    if (!bindingMatchesSession(detail.session, binding.bindingId, request)) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    const handle = remoteWorkspaceExecutionHandleSchema.safeParse(
      detail.session.workspaceExecution.handle
    );
    if (!handle.success) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    const responseKey = remoteInteractionIdentityKeyFrom({
      operationId: handle.data.operationId,
      ...input.response
    });
    const pending = detail.session.workspaceExecution.interactions.some(
      (record) => record.key === responseKey && record.status === "pending"
    );
    if (!pending) throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    const interaction = await this.input.remote.respond({
      handle: handle.data,
      binding,
      response: input.response,
      signal: input.signal
    });
    await persistRemoteInteraction({
      sessions: this.sessions,
      original: detail.session,
      interaction
    });
    return projectRemoteInteractionEvent(handle.data, interaction, this.input.clock);
  }

  private async resumeOrRecover(
    binding: Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>,
    session: RunSessionState & {
      workspaceExecution: NonNullable<RunSessionState["workspaceExecution"]>;
    },
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    const handle = remoteWorkspaceExecutionHandleSchema.safeParse(
      session.workspaceExecution.handle
    );
    if (handle.success) {
      if (terminalPhases.has(session.phase)) {
        return this.collectEvidence(binding, session, handle.data, [], signal);
      }
      const snapshot = await this.input.remote.follow({ handle: handle.data, binding, signal });
      return this.acceptCheckpoint(binding, session, snapshot, undefined, signal);
    }
    const intent = session.workspaceExecution.dispatchIntent;
    if (intent === null) throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    const recovered = await this.input.remote.recover({ binding, session, intent, signal });
    if (recovered) return this.acceptCheckpoint(binding, session, recovered, undefined, signal);
    throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
  }

  private async findScopedSession(
    bindingId: string,
    request: WorkspaceExecutionRequest
  ): Promise<
    | (RunSessionState & {
        workspaceExecution: NonNullable<RunSessionState["workspaceExecution"]>;
      })
    | null
  > {
    const listed = await this.sessions.list(request.authority.packageWorkspace);
    if (listed.diagnostics.length > 0) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    for (const session of listed.sessions) {
      if (terminalPhases.has(session.phase)) continue;
      if (!executionScopeEquals(session.scope, request.scope)) continue;
      if (!bindingMatchesSession(session, bindingId, request)) {
        throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
      }
      return session;
    }
    return null;
  }

  private async acceptCheckpoint(
    binding: Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>,
    session: RunSessionState,
    snapshot: RemoteWorkspaceAdapterSnapshot,
    selectedTarget:
      | Extract<ReturnType<typeof resolveWorkspaceExecutionTarget>, { target: "remote" }>
      | undefined,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    const persisted = await persistRemoteObservation({
      sessions: this.sessions,
      binding,
      original: session,
      snapshot,
      clock: this.input.clock
    });
    const persistedHandle = remoteWorkspaceExecutionHandleSchema.parse(
      persisted.workspaceExecution?.handle
    );
    const checkpointAccepted =
      persistedHandle.operationRevision === snapshot.handle.operationRevision &&
      (!terminalPhases.has(persisted.phase) || snapshot.terminal.terminal);
    if (checkpointAccepted) {
      await this.sessions.appendEvent(
        binding.packageWorkspace,
        persisted.sessionId,
        "workspace_execution_checkpoint",
        {
          phase: persisted.phase,
          authorityBindingId: binding.bindingId,
          target: "remote",
          operationId: snapshot.handle.operationId,
          operationRevision: snapshot.handle.operationRevision,
          attemptStateVersion: snapshot.handle.attemptStateVersion,
          executionAttemptId: snapshot.handle.executionAttemptId,
          eventCursor: snapshot.handle.cursor.eventCursor,
          terminal: snapshot.terminal.terminal,
          outcome: snapshot.terminal.terminal ? snapshot.terminal.outcome : null
        }
      );
    }
    const checkpointSnapshot = { ...snapshot, handle: persistedHandle };
    const checkpointEvents = [
      ...(selectedTarget
        ? [
            projectExecutionSelectedEvent({
              handle: persistedHandle,
              target: selectedTarget,
              connectionProfileId: binding.connectionProfileId,
              clock: this.input.clock
            })
          ]
        : []),
      ...(checkpointAccepted
        ? projectRemoteExecutionEvents({
            snapshot: checkpointSnapshot,
            previousHandle:
              session.workspaceExecution?.handle?.target === "remote"
                ? session.workspaceExecution.handle
                : undefined,
            clock: this.input.clock
          })
        : [])
    ];
    return this.collectEvidence(binding, persisted, persistedHandle, checkpointEvents, signal);
  }

  private async collectEvidence(
    binding: Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>,
    session: RunSessionState,
    handle: RemoteWorkspaceExecutionHandle,
    checkpointEvents: WorkspaceExecutionEvent[],
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    try {
      const evidence = await this.input.remote.collectEvidence({ handle, binding, signal });
      const persisted = await persistRemoteEvidence({
        sessions: this.sessions,
        original: session,
        handle: evidence.handle,
        interactions: evidence.interactions.items
      });
      const evidenceEvents = projectRemoteEvidenceEvents({
        handle: evidence.handle,
        replays: evidence.replays,
        interactions: evidence.interactions,
        clock: this.input.clock
      });
      return {
        handle: evidence.handle,
        session: persisted,
        events: [...checkpointEvents, ...evidenceEvents]
      };
    } catch (error) {
      const persisted = await persistRemoteEvidenceDiagnostic({
        sessions: this.sessions,
        original: session,
        error,
        clock: this.input.clock
      });
      const currentHandle = remoteWorkspaceExecutionHandleSchema.parse(
        persisted.workspaceExecution?.handle
      );
      return { handle: currentHandle, session: persisted, events: checkpointEvents };
    }
  }
}
