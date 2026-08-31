import type { RemoteInteractionView } from "@planweave-ai/collaboration-protocol/remote-run";
import {
  remoteWorkspaceExecutionHandleSchema,
  workspaceExecutionSessionStateSchema,
  type RemoteWorkspaceExecutionHandle,
  type WorkspaceExecutionDispatchIntent,
  type WorkspaceExecutionSessionState
} from "./contracts.js";
import type { ValidatedWorkspaceAuthorityBinding } from "./authorityBinding.js";
import { WorkspaceExecutionError } from "./errors.js";
import type { RemoteWorkspaceAdapterSnapshot } from "./ports.js";
import { remoteInteractionIdentityKey } from "./remoteExecutionAdapter.js";
import {
  WorkspaceExecutionSessionVersionConflictError,
  type WorkspaceExecutionSessionRecord,
  type WorkspaceExecutionSessionRepositoryPort,
  type WorkspaceExecutionSessionStorage
} from "./sessionRepository.js";

type ValidatedRemoteBinding = Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>;

type Clock = () => Date;

function terminalPhase(outcome: "completed" | "failed" | "cancelled") {
  return outcome === "completed" ? "completed" : outcome === "cancelled" ? "stopped" : "failed";
}

function terminalInteractions(
  interactions: WorkspaceExecutionSessionState["interactions"]
): WorkspaceExecutionSessionState["interactions"] {
  return interactions.map((interaction) =>
    interaction.status === "pending" ? { ...interaction, status: "expired" as const } : interaction
  );
}

export function remoteSessionState(
  binding: ValidatedRemoteBinding,
  intent: WorkspaceExecutionDispatchIntent | null,
  handle: RemoteWorkspaceExecutionHandle | null,
  previous?: WorkspaceExecutionSessionState,
  observedOperationId?: string
): WorkspaceExecutionSessionState {
  return workspaceExecutionSessionStateSchema.parse({
    version: "planweave.workspace-execution-session/v1",
    binding,
    dispatchIntent: intent,
    ...(observedOperationId ? { observedOperationId } : {}),
    handle,
    interactions: previous?.interactions ?? [],
    evidence: previous?.evidence ?? { status: "pending", diagnostics: [] }
  });
}

function interactionRecords(
  existing: WorkspaceExecutionSessionState["interactions"],
  interactions: RemoteInteractionView[]
): WorkspaceExecutionSessionState["interactions"] {
  const records = new Map(existing.map((record) => [record.key, record]));
  for (const interaction of interactions) {
    const key = remoteInteractionIdentityKey(interaction);
    const previous = records.get(key);
    if (!previous || previous.status === "pending") {
      records.set(key, { key, status: interaction.status });
    }
  }
  return [...records.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export async function persistRemoteObservation(input: {
  sessions: WorkspaceExecutionSessionRepositoryPort;
  storage: WorkspaceExecutionSessionStorage;
  binding: ValidatedRemoteBinding;
  original: WorkspaceExecutionSessionRecord;
  snapshot: RemoteWorkspaceAdapterSnapshot;
  clock?: Clock;
}): Promise<WorkspaceExecutionSessionRecord> {
  let expected = input.original;
  for (;;) {
    const current = (await input.sessions.get(input.storage, expected.sessionId)).session;
    const currentHandle = remoteWorkspaceExecutionHandleSchema.safeParse(
      current.workspaceExecution?.handle
    );
    if (["completed", "failed", "stopped"].includes(current.phase)) return current;
    if (currentHandle.success) {
      const currentAttemptVersion = currentHandle.data.attemptStateVersion ?? -1;
      const snapshotAttemptVersion = input.snapshot.handle.attemptStateVersion ?? -1;
      const observationIsOlder =
        currentHandle.data.operationRevision > input.snapshot.handle.operationRevision ||
        (currentHandle.data.operationRevision === input.snapshot.handle.operationRevision &&
          currentAttemptVersion > snapshotAttemptVersion);
      const observationIsAlreadyApplied =
        currentHandle.data.operationRevision === input.snapshot.handle.operationRevision &&
        currentAttemptVersion === snapshotAttemptVersion &&
        (!input.snapshot.terminal.terminal ||
          ["completed", "failed", "stopped"].includes(current.phase));
      if (observationIsOlder || observationIsAlreadyApplied) return current;
    }
    const intent = current.workspaceExecution?.dispatchIntent;
    const observedOperationId = current.workspaceExecution?.observedOperationId;
    if (!intent && observedOperationId !== input.snapshot.handle.operationId) {
      throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    }
    const terminal = input.snapshot.terminal;
    const workspaceExecution = remoteSessionState(
      input.binding,
      intent ?? null,
      input.snapshot.handle,
      current.workspaceExecution ?? undefined,
      observedOperationId
    );
    if (terminal.terminal) {
      workspaceExecution.interactions = terminalInteractions(workspaceExecution.interactions);
    }
    try {
      return await input.sessions.update(
        input.storage,
        current.sessionId,
        {
          workspaceExecution,
          phase: terminal.terminal ? terminalPhase(terminal.outcome) : "running",
          finishedAt: terminal.terminal
            ? (input.clock ?? (() => new Date()))().toISOString()
            : current.finishedAt,
          error:
            terminal.terminal && terminal.outcome === "failed"
              ? (terminal.errorCode ?? "remote_operation_failed")
              : current.error
        },
        { expectedStateVersion: current.stateVersion }
      );
    } catch (error) {
      if (!(error instanceof WorkspaceExecutionSessionVersionConflictError)) throw error;
      expected = (await input.sessions.get(input.storage, current.sessionId)).session;
    }
  }
}

export async function persistRemoteEvidence(input: {
  sessions: WorkspaceExecutionSessionRepositoryPort;
  storage: WorkspaceExecutionSessionStorage;
  original: WorkspaceExecutionSessionRecord;
  handle: RemoteWorkspaceExecutionHandle;
  interactions: RemoteInteractionView[];
}): Promise<WorkspaceExecutionSessionRecord> {
  let current = input.original;
  for (;;) {
    const state = current.workspaceExecution;
    const handle = remoteWorkspaceExecutionHandleSchema.safeParse(state?.handle);
    if (!state || !handle.success) return current;
    if (
      input.handle.operationRevision < handle.data.operationRevision ||
      handle.data.executionAttemptId !== input.handle.executionAttemptId ||
      (handle.data.attemptStateVersion !== null &&
        input.handle.attemptStateVersion !== null &&
        input.handle.attemptStateVersion < handle.data.attemptStateVersion) ||
      input.handle.cursor.eventCursor < handle.data.cursor.eventCursor
    ) {
      return current;
    }
    const workspaceExecution = workspaceExecutionSessionStateSchema.parse({
      ...state,
      handle: input.handle,
      interactions: interactionRecords(state.interactions, input.interactions),
      evidence: { status: "complete", diagnostics: state.evidence.diagnostics }
    });
    try {
      return await input.sessions.update(
        input.storage,
        current.sessionId,
        { workspaceExecution },
        { expectedStateVersion: current.stateVersion }
      );
    } catch (error) {
      if (!(error instanceof WorkspaceExecutionSessionVersionConflictError)) throw error;
      current = (await input.sessions.get(input.storage, current.sessionId)).session;
    }
  }
}

export async function persistRemoteEvidenceDiagnostic(input: {
  sessions: WorkspaceExecutionSessionRepositoryPort;
  storage: WorkspaceExecutionSessionStorage;
  original: WorkspaceExecutionSessionRecord;
  error: unknown;
  clock?: Clock;
}): Promise<WorkspaceExecutionSessionRecord> {
  let current = input.original;
  for (;;) {
    const state = current.workspaceExecution;
    if (!state) return current;
    const diagnostic = {
      code:
        input.error instanceof WorkspaceExecutionError
          ? input.error.code
          : "remote_evidence_incomplete",
      message: input.error instanceof Error ? input.error.message : String(input.error),
      observedAt: (input.clock ?? (() => new Date()))().toISOString()
    };
    const workspaceExecution = workspaceExecutionSessionStateSchema.parse({
      ...state,
      evidence: {
        status: "incomplete",
        diagnostics: [...state.evidence.diagnostics, diagnostic].slice(-100)
      }
    });
    try {
      return await input.sessions.update(
        input.storage,
        current.sessionId,
        { workspaceExecution },
        { expectedStateVersion: current.stateVersion }
      );
    } catch (error) {
      if (!(error instanceof WorkspaceExecutionSessionVersionConflictError)) throw error;
      current = (await input.sessions.get(input.storage, current.sessionId)).session;
    }
  }
}

export async function persistRemoteInteraction(input: {
  sessions: WorkspaceExecutionSessionRepositoryPort;
  storage: WorkspaceExecutionSessionStorage;
  original: WorkspaceExecutionSessionRecord;
  interaction: RemoteInteractionView;
}): Promise<WorkspaceExecutionSessionRecord> {
  let current = input.original;
  for (;;) {
    const state = current.workspaceExecution;
    if (!state) throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    const workspaceExecution = workspaceExecutionSessionStateSchema.parse({
      ...state,
      interactions: interactionRecords(state.interactions, [input.interaction])
    });
    try {
      return await input.sessions.update(
        input.storage,
        current.sessionId,
        { workspaceExecution },
        { expectedStateVersion: current.stateVersion }
      );
    } catch (error) {
      if (!(error instanceof WorkspaceExecutionSessionVersionConflictError)) throw error;
      current = (await input.sessions.get(input.storage, current.sessionId)).session;
    }
  }
}
