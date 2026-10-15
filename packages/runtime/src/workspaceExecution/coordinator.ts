import { parseInteractionSettlementForRequest } from "@planweave-ai/agent-host-protocol/browser";
import { stableJson } from "../plangraph/hash.js";
import { randomUUID } from "node:crypto";
import type {
  RemoteInteractionResponse,
  RemoteInteractionView
} from "@planweave-ai/collaboration-protocol/remote-run";
import type { RunSessionTrigger } from "../runSessions/types.js";
import {
  remoteWorkspaceExecutionHandleSchema,
  workspaceExecutionAuthorityLocatorSchema,
  workspaceExecutionCursorSchema,
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
  adoptStoredWorkspaceAuthorityBinding,
  assertRemoteWorkAuthorityMatchesBinding,
  isOwnerCanvasRemoteAuthorityBinding,
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
import {
  remoteInteractionIdentityKey,
  remoteInteractionIdentityKeyFrom
} from "./remoteExecutionAdapter.js";
import {
  persistRemoteEvidence,
  persistRemoteEvidenceDiagnostic,
  persistRemoteInteraction,
  persistRemoteInteractions,
  persistRemoteResponseIntent,
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

function packageStorageFromRequest(
  request: WorkspaceExecutionRequest
): WorkspaceExecutionSessionStorage | null {
  const locator = request.authority;
  if (locator.kind === "local_package" || locator.kind === "owner_canvas") {
    return { kind: "package", packageWorkspace: locator.packageWorkspace };
  }
  if (locator.kind === "workspace_canvas" && locator.contentAuthority.kind === "package_snapshot") {
    return { kind: "package", packageWorkspace: locator.contentAuthority.packageWorkspace };
  }
  return null;
}

function requestMatchesStoredBinding(
  request: Pick<WorkspaceExecutionRequest, "authority">,
  binding: ValidatedWorkspaceAuthorityBinding
): boolean {
  const locator = request.authority;
  if (locator.kind === "local_package") {
    return binding.kind === "local" && binding.packageWorkspace === locator.packageWorkspace;
  }
  if (locator.kind === "owner_canvas") {
    return (
      binding.kind === "remote" &&
      isOwnerCanvasRemoteAuthorityBinding(binding) &&
      binding.connectionProfileId === locator.connectionProfileId &&
      binding.serverOrigin === locator.serverOrigin &&
      binding.humanPrincipalId === locator.humanPrincipalId &&
      binding.projectId === locator.projectId &&
      binding.canvasId === locator.canvasId
    );
  }
  return (
    binding.kind === "remote" &&
    !isOwnerCanvasRemoteAuthorityBinding(binding) &&
    binding.connectionProfileId === locator.connectionProfileId &&
    binding.serverOrigin === locator.serverOrigin &&
    binding.workspaceId === locator.workspaceId &&
    binding.projectId === locator.projectId &&
    binding.canvasId === locator.canvasId
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
      sessionStorageForRequest?: (
        request: WorkspaceExecutionRequest
      ) => WorkspaceExecutionSessionStorage;
      clock?: () => Date;
      idempotencyKey?: () => string;
    }
  ) {
    this.sessions = input.sessions ?? createPackageWorkspaceExecutionSessionRepository();
  }

  async execute(
    rawRequest: unknown,
    signal?: AbortSignal,
    dispatchKey?: string
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
      if (dispatchKey) {
        const listed = await this.sessions.list(storage);
        if (listed.diagnostics.length)
          throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
        const matches = listed.sessions.filter(
          (session) => session.workspaceExecution?.dispatchIntent?.idempotencyKey === dispatchKey
        );
        if (matches.length > 1)
          throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
        const existing = matches[0];
        if (existing) {
          const recovered = await this.recoverForCancellation(request, existing.sessionId, signal);
          if (!recovered) throw new WorkspaceExecutionError("remote_dispatch_unavailable");
          return recovered;
        }
      }
      const resumable = await this.findScopedSession(storage, binding.bindingId, request);
      if (resumable) {
        if (dispatchKey) throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
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
      const target = resolveWorkspaceExecutionTarget(request, catalog);
      if (target.target !== "remote") {
        throw new WorkspaceExecutionError("agent_endpoint_unavailable");
      }
      const intent = remoteIntent({
        binding,
        endpointId: target.agentEndpointId,
        idempotencyKey:
          dispatchKey ?? `workspace-execution-${(this.input.idempotencyKey ?? randomUUID)()}`
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
        signal,
        skipWorkAuthorityEnsure: true,
        ensuredWorkAuthority: currentAuthority
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
    const storage = this.storageForExistingSession(request);
    const detail = await this.sessions.get(storage, sessionId);
    const stored = detail.session.workspaceExecution?.binding;
    if (!stored) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    const binding = adoptStoredWorkspaceAuthorityBinding(stored);
    if (
      binding.kind !== "remote" ||
      !requestMatchesStoredBinding(request, binding) ||
      !bindingMatchesSession(detail.session, binding.bindingId, request)
    ) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    await this.assertStoredRemoteWorkAuthority(binding, signal);
    return this.resumeOrRecover(storage, binding, detail.session, request, signal);
  }

  async recoverForCancellation(
    rawRequest: unknown,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionCoordinatorResult | null> {
    const request = workspaceExecutionRequestSchema.parse(rawRequest);
    const storage = this.storageForExistingSession(request);
    const session = (await this.sessions.get(storage, sessionId)).session;
    const state = session.workspaceExecution;
    if (!state) throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    const binding = adoptStoredWorkspaceAuthorityBinding(state.binding);
    if (
      binding.kind !== "remote" ||
      !requestMatchesStoredBinding(request, binding) ||
      !bindingMatchesSession(session, binding.bindingId, request)
    )
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    await this.assertStoredRemoteWorkAuthority(binding, signal);
    const handle = remoteWorkspaceExecutionHandleSchema.safeParse(state.handle);
    const snapshot = handle.success
      ? await this.input.remote.follow({ binding, handle: handle.data, signal })
      : state.dispatchIntent
        ? await this.input.remote.recover({
            binding,
            session,
            intent: state.dispatchIntent,
            signal
          })
        : null;
    if (!snapshot) return null;
    if (
      handle.success &&
      (snapshot.handle.operationId !== handle.data.operationId ||
        snapshot.handle.dispatchId !== handle.data.dispatchId ||
        snapshot.handle.executionAttemptId !== handle.data.executionAttemptId ||
        snapshot.handle.leaseId !== handle.data.leaseId)
    )
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    const persisted = await persistRemoteObservation({
      sessions: this.sessions,
      storage,
      binding,
      original: session,
      snapshot,
      clock: this.input.clock
    });
    return {
      handle: remoteWorkspaceExecutionHandleSchema.parse(persisted.workspaceExecution?.handle),
      session: persisted,
      events: []
    };
  }

  async observeExisting(input: {
    authority: unknown;
    scope: unknown;
    operationId: string;
    evidenceCursor?: RemoteWorkspaceExecutionHandle["cursor"];
    signal?: AbortSignal;
  }): Promise<WorkspaceExecutionCoordinatorResult> {
    const evidenceCursor = workspaceExecutionCursorSchema.options[1].parse(
      input.evidenceCursor ?? { target: "remote", executionAttemptId: null, eventCursor: 0 }
    );
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
        const storedBinding = existing.workspaceExecution
          ? adoptStoredWorkspaceAuthorityBinding(existing.workspaceExecution.binding)
          : null;
        const completedHistory =
          terminalPhases.has(existing.phase) &&
          ["completed", "failed", "cancelled"].includes(inspected.observation.state);
        if (
          !existing.workspaceExecution ||
          !storedBinding ||
          storedBinding.kind !== "remote" ||
          !requestMatchesStoredBinding({ authority }, storedBinding) ||
          storedBinding.blockRef !== scope.blockRef ||
          (!completedHistory && storedBinding.bindingId !== binding.bindingId) ||
          !executionScopeEquals(existing.scope, scope)
        ) {
          throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
        }
        return this.resumeOrRecover(
          storage,
          completedHistory ? storedBinding : binding,
          { ...existing, workspaceExecution: existing.workspaceExecution },
          undefined,
          input.signal,
          evidenceCursor
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
      return this.acceptCheckpoint(
        storage,
        binding,
        session,
        snapshot,
        undefined,
        input.signal,
        evidenceCursor
      );
    });
  }

  async synchronizeInteractions(input: {
    request: unknown;
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<{
    session: WorkspaceExecutionSessionRecord;
    handle: RemoteWorkspaceExecutionHandle;
    binding: Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>;
    items: RemoteInteractionView[];
  }> {
    const request = workspaceExecutionRequestSchema.parse(input.request);
    const storage = this.storageForExistingSession(request);
    const detail = await this.sessions.get(storage, input.sessionId);
    const stored = detail.session.workspaceExecution?.binding;
    if (!stored) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    const binding = adoptStoredWorkspaceAuthorityBinding(stored);
    if (
      binding.kind !== "remote" ||
      !requestMatchesStoredBinding(request, binding) ||
      !bindingMatchesSession(detail.session, binding.bindingId, request)
    ) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    const handle = remoteWorkspaceExecutionHandleSchema.safeParse(
      detail.session.workspaceExecution.handle
    );
    if (!handle.success) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    input.signal?.throwIfAborted();
    const page = await this.input.remote.readInteractions({
      handle: handle.data,
      binding,
      signal: input.signal
    });
    input.signal?.throwIfAborted();
    const items = page.items.map((item) =>
      item.status === "pending" &&
      Date.parse(item.request.expiresAt) <= (this.input.clock ?? (() => new Date()))().getTime()
        ? { ...item, status: "expired" as const }
        : item
    );
    const session = await persistRemoteInteractions({
      sessions: this.sessions,
      storage,
      original: detail.session,
      handle: handle.data,
      interactions: items
    });
    const records = new Map(
      session.workspaceExecution?.interactions.map((record) => [record.key, record.status])
    );
    return {
      session,
      handle: handle.data,
      binding,
      items: items.map((item) => {
        const status = records.get(remoteInteractionIdentityKey(item));
        if (status === undefined) {
          throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
        }
        return { ...item, status };
      })
    };
  }

  async respond(input: {
    request: unknown;
    sessionId: string;
    response: RemoteInteractionResponse;
    signal?: AbortSignal;
  }): Promise<WorkspaceExecutionEvent> {
    const synchronized = await this.synchronizeInteractions(input);
    const storage = this.storageForExistingSession(
      workspaceExecutionRequestSchema.parse(input.request)
    );
    const { session, handle, binding } = synchronized;
    const responseKey = remoteInteractionIdentityKeyFrom({
      operationId: handle.operationId,
      ...input.response
    });
    input.signal?.throwIfAborted();
    const record = session.workspaceExecution?.interactions.find(
      (item) => item.key === responseKey
    );
    const pending = synchronized.items.find(
      (item) => remoteInteractionIdentityKey(item) === responseKey && item.status === "pending"
    );
    const recovery = record?.responseIntent;
    if (!record || record.status !== "pending" || (!pending && !recovery)) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    if (recovery && stableJson(recovery.response) !== stableJson(input.response)) {
      throw new WorkspaceExecutionError("remote_interaction_response_conflict");
    }
    const interactionRequest = pending?.request ?? recovery?.request;
    if (!interactionRequest)
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    const response = parseInteractionSettlementForRequest(interactionRequest, input.response);
    if (
      response.dispatchId !== handle.dispatchId ||
      response.executionAttemptId !== handle.executionAttemptId ||
      (handle.leaseId !== null && response.leaseId !== handle.leaseId)
    ) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    const prepared = await persistRemoteResponseIntent({
      sessions: this.sessions,
      storage,
      original: session,
      handle,
      key: responseKey,
      request: interactionRequest,
      response,
      clock: this.input.clock,
      signal: input.signal
    });
    input.signal?.throwIfAborted();
    const interaction = await this.input.remote.respond({
      handle,
      binding,
      response,
      signal: input.signal
    });
    try {
      await persistRemoteInteraction({
        sessions: this.sessions,
        storage,
        original: prepared,
        interaction
      });
    } catch (error) {
      throw new WorkspaceExecutionError(
        "remote_interaction_checkpoint_failed",
        "Remote response accepted; synchronize this same interaction before retrying.",
        true,
        { cause: error }
      );
    }
    return projectRemoteInteractionEvent(handle, interaction, this.input.clock);
  }

  private async resumeOrRecover(
    storage: WorkspaceExecutionSessionStorage,
    binding: Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>,
    session: WorkspaceExecutionSessionRecord & {
      workspaceExecution: NonNullable<WorkspaceExecutionSessionRecord["workspaceExecution"]>;
    },
    request?: WorkspaceExecutionRequest,
    signal?: AbortSignal,
    evidenceCursor?: RemoteWorkspaceExecutionHandle["cursor"]
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    const handle = remoteWorkspaceExecutionHandleSchema.safeParse(
      session.workspaceExecution.handle
    );
    if (handle.success) {
      if (terminalPhases.has(session.phase)) {
        return this.collectEvidence(
          storage,
          binding,
          session,
          handle.data,
          [],
          signal,
          evidenceCursor
        );
      }
      const snapshot = await this.input.remote.follow({ handle: handle.data, binding, signal });
      return this.acceptCheckpoint(
        storage,
        binding,
        session,
        snapshot,
        undefined,
        signal,
        evidenceCursor
      );
    }
    const intent = session.workspaceExecution.dispatchIntent;
    if (intent === null) throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    const recovered = await this.input.remote.recover({ binding, session, intent, signal });
    if (recovered)
      return this.acceptCheckpoint(
        storage,
        binding,
        session,
        recovered,
        undefined,
        signal,
        evidenceCursor
      );
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
    let currentAuthority: Awaited<ReturnType<WorkAuthorityPort["ensure"]>>;
    try {
      currentAuthority = await this.input.workAuthority.ensure({ binding }, signal);
    } catch (error) {
      throw workspaceExecutionPortError(error, "work_authority_unavailable");
    }
    assertRemoteWorkAuthorityMatchesBinding(binding, currentAuthority);
    const relaunched = await this.input.remote.launch({
      request,
      binding,
      target,
      session,
      intent,
      signal,
      skipWorkAuthorityEnsure: true,
      ensuredWorkAuthority: currentAuthority
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
    signal?: AbortSignal,
    evidenceCursor?: RemoteWorkspaceExecutionHandle["cursor"]
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    const { persisted, persistedHandle, checkpointAccepted } = await this.sessions.withMutation(
      storage,
      async () => {
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
        return { persisted, persistedHandle, checkpointAccepted };
      }
    );
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
      signal,
      evidenceCursor
    );
  }

  private async collectEvidence(
    storage: WorkspaceExecutionSessionStorage,
    binding: Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>,
    session: WorkspaceExecutionSessionRecord,
    handle: RemoteWorkspaceExecutionHandle,
    checkpointEvents: WorkspaceExecutionEvent[],
    signal?: AbortSignal,
    evidenceCursor?: RemoteWorkspaceExecutionHandle["cursor"]
  ): Promise<WorkspaceExecutionCoordinatorResult> {
    try {
      const replayHandle =
        evidenceCursor === undefined
          ? handle
          : {
              ...handle,
              cursor: {
                ...handle.cursor,
                eventCursor:
                  evidenceCursor.executionAttemptId === handle.executionAttemptId
                    ? evidenceCursor.eventCursor
                    : 0
              }
            };
      const evidence = await this.input.remote.collectEvidence({
        handle: replayHandle,
        binding,
        signal
      });
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

  private async assertStoredRemoteWorkAuthority(
    binding: Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>,
    signal?: AbortSignal
  ): Promise<void> {
    let currentAuthority: Awaited<ReturnType<WorkAuthorityPort["ensure"]>>;
    try {
      currentAuthority = await this.input.workAuthority.ensure({ binding }, signal);
    } catch (error) {
      throw workspaceExecutionPortError(error, "work_authority_unavailable");
    }
    assertRemoteWorkAuthorityMatchesBinding(
      binding,
      currentAuthority,
      "workspace_execution_resume_mismatch"
    );
  }

  private sessionStorage(
    binding: ValidatedWorkspaceAuthorityBinding
  ): WorkspaceExecutionSessionStorage {
    return (this.input.sessionStorage ?? packageSessionStorageForBinding)(binding);
  }

  private storageForExistingSession(
    request: WorkspaceExecutionRequest
  ): WorkspaceExecutionSessionStorage {
    if (this.input.sessionStorageForRequest) {
      return this.input.sessionStorageForRequest(request);
    }
    const packaged = packageStorageFromRequest(request);
    if (packaged) return packaged;
    throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
  }
}
