import { randomUUID } from "node:crypto";
import type { RemoteInteractionResponse } from "@planweave-ai/collaboration-protocol/remote-run";
import type { RunSessionTrigger } from "../runSessions/types.js";
import {
  remoteWorkspaceExecutionHandleSchema,
  workspaceExecutionAuthorityLocatorSchema,
  workspaceExecutionRequestSchema,
  workspaceExecutionScopeSchema,
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
import {
  createPackageWorkspaceExecutionSessionRepository,
  packageSessionStorageForBinding,
  type WorkspaceExecutionSessionRecord,
  type WorkspaceExecutionSessionRepositoryPort,
  type WorkspaceExecutionSessionStorage
} from "./sessionRepository.js";

export type WorkspaceExecutionCoordinatorResult = {
  handle: WorkspaceExecutionHandle;
  session: WorkspaceExecutionSessionRecord;
  events: WorkspaceExecutionEvent[];
};

const terminalPhases = new Set(["completed", "failed", "stopped"]);

function runSessionTrigger(trigger: WorkspaceExecutionRequest["trigger"]): RunSessionTrigger {
  if (trigger === "desktop") return "desktop";
  if (trigger === "api") return "api";
  return "manual";
}

function bindingMatchesSession(
  session: WorkspaceExecutionSessionRecord,
  bindingId: string,
  request: WorkspaceExecutionRequest
): session is WorkspaceExecutionSessionRecord & {
  workspaceExecution: NonNullable<WorkspaceExecutionSessionRecord["workspaceExecution"]>;
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
  private readonly sessions: WorkspaceExecutionSessionRepositoryPort;

  constructor(
    private readonly input: {
      authority: WorkspaceAuthorityBindingPort;
      catalog: RemoteAgentCatalogPort;
      workAuthority: WorkAuthorityPort;
      local: LocalWorkspaceExecutionAdapter;
      remote: RemoteWorkspaceExecutionAdapter;
      sessions?: WorkspaceExecutionSessionRepositoryPort;
      sessionStorage?: (
        binding: ValidatedWorkspaceAuthorityBinding
      ) => WorkspaceExecutionSessionStorage;
      clock?: () => Date;
      idempotencyKey?: () => string;
    }
  ) {
    this.sessions = input.sessions ?? createPackageWorkspaceExecutionSessionRepository();
  }

  async execute(
    rawRequest: unknown,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    const request = workspaceExecutionRequestSchema.parse(rawRequest);
    const binding = await this.input.authority.resolve(request.authority, request.scope, signal);
    const storage = this.sessionStorage(binding);

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
        storage,
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

    return this.sessions.withScopeLock(storage, request.scope, async () => {
      if (binding.kind !== "remote" || !request.effectiveExecutor) {
        throw new WorkspaceExecutionError("workspace_execution_authority_mismatch");
      }
      const resumable = await this.findScopedSession(storage, binding.bindingId, request);
      if (resumable) {
        return this.resumeOrRecover(storage, binding, resumable, request, signal);
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
      const session = await this.sessions.create(storage, {
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
      return this.acceptCheckpoint(storage, binding, session, snapshot, target, signal);
    });
  }

  async follow(
    rawRequest: unknown,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    const request = workspaceExecutionRequestSchema.parse(rawRequest);
    const binding = await this.input.authority.resolve(request.authority, request.scope, signal);
    const storage = this.sessionStorage(binding);
    const detail = await this.sessions.get(storage, sessionId);
    if (
      !bindingMatchesSession(detail.session, binding.bindingId, request) ||
      binding.kind !== "remote"
    ) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    return this.resumeOrRecover(storage, binding, detail.session, request, signal);
  }

  async observeExisting(input: {
    authority: unknown;
    scope: unknown;
    operationId: string;
    signal?: AbortSignal;
  }): Promise<WorkspaceExecutionCoordinatorResult> {
    const scope = workspaceExecutionScopeSchema.parse(input.scope);
    const authority = workspaceExecutionAuthorityLocatorSchema.parse(input.authority);
    const binding = await this.input.authority.resolve(authority, scope, input.signal);
    if (binding.kind !== "remote" || scope.kind !== "block") {
      throw new WorkspaceExecutionError("workspace_execution_remote_binding_required");
    }
    const inspected = await this.input.remote.inspectExisting({
      binding,
      operationId: input.operationId,
      signal: input.signal
    });
    const storage = this.sessionStorage(binding);
    return this.sessions.withScopeLock(storage, scope, async () => {
      const listed = await this.sessions.list(storage);
      if (listed.diagnostics.length > 0) {
        throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
      }
      const operationSessions = listed.sessions.filter((session) => {
        const state = session.workspaceExecution;
        return (
          state?.observedOperationId === input.operationId ||
          (state?.handle?.target === "remote" && state.handle.operationId === input.operationId)
        );
      });
      if (operationSessions.length > 1) {
        throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
      }
      const existing = operationSessions[0];
      if (existing) {
        if (
          !existing.workspaceExecution ||
          existing.workspaceExecution.binding.bindingId !== binding.bindingId ||
          !executionScopeEquals(existing.scope, scope)
        ) {
          throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
        }
        return this.resumeOrRecover(
          storage,
          binding,
          { ...existing, workspaceExecution: existing.workspaceExecution },
          undefined,
          input.signal
        );
      }
      const session = await this.sessions.create(storage, {
        kind: "run",
        trigger: "desktop",
        scope,
        phase: "running",
        workspaceExecution: remoteSessionState(binding, null, null, undefined, input.operationId)
      });
      const snapshot = await this.input.remote.attachExisting({
        binding,
        session,
        observation: inspected.observation,
        agentEndpointId: inspected.agentEndpointId,
        signal: input.signal
      });
      return this.acceptCheckpoint(storage, binding, session, snapshot, undefined, input.signal);
    });
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
    const storage = this.sessionStorage(binding);
    const detail = await this.sessions.get(storage, input.sessionId);
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
      storage,
      original: detail.session,
      interaction
    });
    return projectRemoteInteractionEvent(handle.data, interaction, this.input.clock);
  }

  private async resumeOrRecover(
    storage: WorkspaceExecutionSessionStorage,
    binding: Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>,
    session: WorkspaceExecutionSessionRecord & {
      workspaceExecution: NonNullable<WorkspaceExecutionSessionRecord["workspaceExecution"]>;
    },
    request?: WorkspaceExecutionRequest,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    const handle = remoteWorkspaceExecutionHandleSchema.safeParse(
      session.workspaceExecution.handle
    );
    if (handle.success) {
      if (terminalPhases.has(session.phase)) {
        return this.collectEvidence(storage, binding, session, handle.data, [], signal);
      }
      const snapshot = await this.input.remote.follow({ handle: handle.data, binding, signal });
      return this.acceptCheckpoint(storage, binding, session, snapshot, undefined, signal);
    }
    const intent = session.workspaceExecution.dispatchIntent;
    if (intent === null) throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    const recovered = await this.input.remote.recover({ binding, session, intent, signal });
    if (recovered)
      return this.acceptCheckpoint(storage, binding, session, recovered, undefined, signal);
    if (!request || !request.effectiveExecutor) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
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
    const target = resolveWorkspaceExecutionTarget(
      {
        ...request,
        target: { policy: "remote", agentEndpointId: intent.agentEndpointId }
      },
      catalog
    );
    if (target.target !== "remote" || target.agentEndpointId !== intent.agentEndpointId) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    const relaunched = await this.input.remote.launch({
      request,
      binding,
      target,
      session,
      intent,
      signal
    });
    return this.acceptCheckpoint(storage, binding, session, relaunched, target, signal);
  }

  private async findScopedSession(
    storage: WorkspaceExecutionSessionStorage,
    bindingId: string,
    request: WorkspaceExecutionRequest
  ): Promise<
    | (WorkspaceExecutionSessionRecord & {
        workspaceExecution: NonNullable<WorkspaceExecutionSessionRecord["workspaceExecution"]>;
      })
    | null
  > {
    const listed = await this.sessions.list(storage);
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
    storage: WorkspaceExecutionSessionStorage,
    binding: Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>,
    session: WorkspaceExecutionSessionRecord,
    snapshot: RemoteWorkspaceAdapterSnapshot,
    selectedTarget:
      | Extract<ReturnType<typeof resolveWorkspaceExecutionTarget>, { target: "remote" }>
      | undefined,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    const persisted = await persistRemoteObservation({
      sessions: this.sessions,
      storage,
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
        storage,
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
    return this.collectEvidence(
      storage,
      binding,
      persisted,
      persistedHandle,
      checkpointEvents,
      signal
    );
  }

  private async collectEvidence(
    storage: WorkspaceExecutionSessionStorage,
    binding: Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>,
    session: WorkspaceExecutionSessionRecord,
    handle: RemoteWorkspaceExecutionHandle,
    checkpointEvents: WorkspaceExecutionEvent[],
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    try {
      const evidence = await this.input.remote.collectEvidence({ handle, binding, signal });
      const persisted = await persistRemoteEvidence({
        sessions: this.sessions,
        storage,
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
        storage,
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

  private sessionStorage(
    binding: ValidatedWorkspaceAuthorityBinding
  ): WorkspaceExecutionSessionStorage {
    return (this.input.sessionStorage ?? packageSessionStorageForBinding)(binding);
  }
}
