import type { RemoteInteractionView } from "@planweave-ai/collaboration-protocol/remote-run";
import {
  getRunSession,
  RunSessionStateVersionConflictError,
  updateRunSession
} from "../runSessions/repository.js";
import type { RunSessionState } from "../runSessions/types.js";
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

type ValidatedRemoteBinding = Extract<ValidatedWorkspaceAuthorityBinding, { kind: "remote" }>;

export type SessionCheckpointRepository = {
  get: typeof getRunSession;
  update: typeof updateRunSession;
};

type Clock = () => Date;

function terminalPhase(outcome: "completed" | "failed" | "cancelled") {
  return outcome === "completed" ? "completed" : outcome === "cancelled" ? "stopped" : "failed";
}

export function remoteSessionState(
  binding: ValidatedRemoteBinding,
  intent: WorkspaceExecutionDispatchIntent,
  handle: RemoteWorkspaceExecutionHandle | null,
  previous?: WorkspaceExecutionSessionState
): WorkspaceExecutionSessionState {
  return workspaceExecutionSessionStateSchema.parse({
    version: "planweave.workspace-execution-session/v1",
    binding,
    dispatchIntent: intent,
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
  sessions: SessionCheckpointRepository;
  binding: ValidatedRemoteBinding;
  original: RunSessionState;
  snapshot: RemoteWorkspaceAdapterSnapshot;
  clock?: Clock;
}): Promise<RunSessionState> {
  let expected = input.original;
  for (;;) {
    const current = (await input.sessions.get(input.binding.packageWorkspace, expected.sessionId))
      .session;
    const currentHandle = remoteWorkspaceExecutionHandleSchema.safeParse(
      current.workspaceExecution?.handle
    );
    if (["completed", "failed", "stopped"].includes(current.phase)) return current;
    if (
      currentHandle.success &&
      currentHandle.data.operationRevision >= input.snapshot.handle.operationRevision
    ) {
      return current;
    }
    const intent = current.workspaceExecution?.dispatchIntent;
    if (!intent) throw new WorkspaceExecutionError("workspace_execution_resume_mismatch");
    const terminal = input.snapshot.terminal;
    const workspaceExecution = remoteSessionState(
      input.binding,
      intent,
      input.snapshot.handle,
      current.workspaceExecution ?? undefined
    );
    try {
      return await input.sessions.update(
        input.binding.packageWorkspace,
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
      if (!(error instanceof RunSessionStateVersionConflictError)) throw error;
      expected = (await input.sessions.get(input.binding.packageWorkspace, current.sessionId))
        .session;
    }
  }
}

export async function persistRemoteEvidence(input: {
  sessions: SessionCheckpointRepository;
  original: RunSessionState;
  handle: RemoteWorkspaceExecutionHandle;
  interactions: RemoteInteractionView[];
}): Promise<RunSessionState> {
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
        current.projectRoot,
        current.sessionId,
        { workspaceExecution },
        { expectedStateVersion: current.stateVersion }
      );
    } catch (error) {
      if (!(error instanceof RunSessionStateVersionConflictError)) throw error;
      current = (await input.sessions.get(current.projectRoot, current.sessionId)).session;
    }
  }
}

export async function persistRemoteEvidenceDiagnostic(input: {
  sessions: SessionCheckpointRepository;
  original: RunSessionState;
  error: unknown;
  clock?: Clock;
}): Promise<RunSessionState> {
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
        current.projectRoot,
        current.sessionId,
        { workspaceExecution },
        { expectedStateVersion: current.stateVersion }
      );
    } catch (error) {
      if (!(error instanceof RunSessionStateVersionConflictError)) throw error;
      current = (await input.sessions.get(current.projectRoot, current.sessionId)).session;
    }
  }
}

export async function persistRemoteInteraction(input: {
  sessions: SessionCheckpointRepository;
  original: RunSessionState;
  interaction: RemoteInteractionView;
}): Promise<RunSessionState> {
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
        current.projectRoot,
        current.sessionId,
        { workspaceExecution },
        { expectedStateVersion: current.stateVersion }
      );
    } catch (error) {
      if (!(error instanceof RunSessionStateVersionConflictError)) throw error;
      current = (await input.sessions.get(current.projectRoot, current.sessionId)).session;
    }
  }
}
