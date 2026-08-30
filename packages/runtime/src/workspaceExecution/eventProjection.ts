import type {
  RemoteEventReplay,
  RemoteInteractionPage,
  RemoteInteractionView
} from "@planweave-ai/collaboration-protocol/remote-run";
import {
  workspaceExecutionEventSchema,
  type LocalWorkspaceExecutionHandle,
  type RemoteWorkspaceExecutionHandle,
  type WorkspaceExecutionEvent,
  type WorkspaceExecutionScope,
  type WorkspaceExecutionTarget
} from "./contracts.js";
import type { RemoteWorkspaceAdapterSnapshot, WorkspaceExecutionTerminal } from "./ports.js";
import { remoteInteractionIdentityKey } from "./remoteExecutionAdapter.js";

type Clock = () => Date;

function remoteBase(handle: RemoteWorkspaceExecutionHandle, cursor: number, clock: Clock) {
  return {
    version: "planweave.execution-event/v1" as const,
    observedAt: clock().toISOString(),
    runSessionId: handle.runSessionId,
    scope: handle.scope,
    source: {
      target: "remote" as const,
      operationId: handle.operationId,
      executionAttemptId: handle.executionAttemptId,
      cursor
    }
  };
}

export function projectExecutionSelectedEvent(input: {
  handle: LocalWorkspaceExecutionHandle | RemoteWorkspaceExecutionHandle;
  target: WorkspaceExecutionTarget;
  connectionProfileId?: string;
  clock?: Clock;
}): WorkspaceExecutionEvent {
  const clock = input.clock ?? (() => new Date());
  const source =
    input.handle.target === "local"
      ? {
          target: "local" as const,
          localRunId: input.handle.localRunId,
          sequence: input.handle.cursor.sequence
        }
      : {
          target: "remote" as const,
          operationId: input.handle.operationId,
          executionAttemptId: input.handle.executionAttemptId,
          cursor: input.handle.cursor.eventCursor
        };
  return workspaceExecutionEventSchema.parse({
    version: "planweave.execution-event/v1",
    eventId: `${input.handle.runSessionId}:execution-selected`,
    observedAt: clock().toISOString(),
    runSessionId: input.handle.runSessionId,
    scope: input.handle.scope,
    source,
    type: "execution_selected",
    data:
      input.target.target === "remote"
        ? { ...input.target, connectionProfileId: input.connectionProfileId }
        : input.target
  });
}

export function projectLocalTerminalEvent(input: {
  handle: LocalWorkspaceExecutionHandle;
  outcome: "completed" | "failed" | "cancelled";
  clock?: Clock;
}): WorkspaceExecutionEvent {
  const clock = input.clock ?? (() => new Date());
  return workspaceExecutionEventSchema.parse({
    version: "planweave.execution-event/v1",
    eventId: `${input.handle.localRunId}:terminal`,
    observedAt: clock().toISOString(),
    runSessionId: input.handle.runSessionId,
    scope: input.handle.scope,
    source: {
      target: "local",
      localRunId: input.handle.localRunId,
      sequence: input.handle.cursor.sequence
    },
    type: "run_terminal",
    data: { outcome: input.outcome }
  });
}

export function projectActionRequiredEvent(input: {
  handle: LocalWorkspaceExecutionHandle | RemoteWorkspaceExecutionHandle;
  reason: "manual" | "blocked" | "remote_interaction";
  clock?: Clock;
}): WorkspaceExecutionEvent {
  const clock = input.clock ?? (() => new Date());
  const source =
    input.handle.target === "local"
      ? {
          target: "local" as const,
          localRunId: input.handle.localRunId,
          sequence: input.handle.cursor.sequence
        }
      : {
          target: "remote" as const,
          operationId: input.handle.operationId,
          executionAttemptId: input.handle.executionAttemptId,
          cursor: input.handle.cursor.eventCursor
        };
  return workspaceExecutionEventSchema.parse({
    version: "planweave.execution-event/v1",
    eventId: `${input.handle.runSessionId}:action-required:${input.reason}`,
    observedAt: clock().toISOString(),
    runSessionId: input.handle.runSessionId,
    scope: input.handle.scope,
    source,
    type: "action_required",
    data: { reason: input.reason }
  });
}

function projectTerminalEvents(
  handle: RemoteWorkspaceExecutionHandle,
  terminal: WorkspaceExecutionTerminal,
  clock: Clock
): WorkspaceExecutionEvent[] {
  if (!terminal.terminal) return [];
  const base = remoteBase(handle, handle.cursor.eventCursor, clock);
  return [
    workspaceExecutionEventSchema.parse({
      ...base,
      eventId: `${handle.operationId}:writeback:${handle.operationRevision}`,
      type: "writeback_observed",
      data: { state: terminal.outcome }
    }),
    workspaceExecutionEventSchema.parse({
      ...base,
      eventId: `${handle.operationId}:run-terminal:${handle.operationRevision}`,
      type: "run_terminal",
      data: { outcome: terminal.outcome }
    })
  ];
}

export function projectRemoteExecutionEvents(input: {
  snapshot: RemoteWorkspaceAdapterSnapshot;
  previousHandle?: RemoteWorkspaceExecutionHandle;
  clock?: Clock;
}): WorkspaceExecutionEvent[] {
  const clock = input.clock ?? (() => new Date());
  const { handle, observation } = input.snapshot;
  const events: WorkspaceExecutionEvent[] = [];
  if (
    input.previousHandle &&
    input.previousHandle.executionAttemptId !== handle.executionAttemptId &&
    handle.executionAttemptId !== null
  ) {
    events.push(
      workspaceExecutionEventSchema.parse({
        ...remoteBase(handle, 0, clock),
        eventId: `${handle.operationId}:attempt:${handle.executionAttemptId}`,
        type: "attempt_changed",
        data: {
          previousExecutionAttemptId: input.previousHandle.executionAttemptId,
          executionAttemptId: handle.executionAttemptId
        }
      })
    );
  }
  events.push(
    workspaceExecutionEventSchema.parse({
      ...remoteBase(handle, handle.cursor.eventCursor, clock),
      eventId: `${handle.operationId}:operation:${handle.operationRevision}`,
      type: "operation_observed",
      data: {
        state: observation.state,
        attemptStatus: observation.attempt.status,
        operationRevision: handle.operationRevision
      }
    })
  );
  if (observation.state === "action_required") {
    events.push(
      projectActionRequiredEvent({
        handle,
        reason: "remote_interaction",
        clock
      })
    );
  }
  if (observation.diagnostics?.error) {
    events.push(
      workspaceExecutionEventSchema.parse({
        ...remoteBase(handle, handle.cursor.eventCursor, clock),
        eventId: `${handle.operationId}:diagnostic:${handle.operationRevision}`,
        type: "runner_diagnostic",
        data: {
          code: observation.diagnostics.error.code,
          message: observation.failure?.message ?? observation.diagnostics.error.code,
          retryable: observation.diagnostics.error.retryable,
          stage: observation.diagnostics.stage
        }
      })
    );
  }
  events.push(
    ...projectRemoteEvidenceEvents({
      handle,
      replays: input.snapshot.replays,
      interactions: input.snapshot.interactions,
      clock
    })
  );
  events.push(...projectTerminalEvents(handle, input.snapshot.terminal, clock));
  return events;
}

export function projectRemoteEvidenceEvents(input: {
  handle: RemoteWorkspaceExecutionHandle;
  replays: RemoteEventReplay[];
  interactions: RemoteInteractionPage;
  clock?: Clock;
}): WorkspaceExecutionEvent[] {
  const clock = input.clock ?? (() => new Date());
  const handle = input.handle;
  const events: WorkspaceExecutionEvent[] = [];
  for (const replay of input.replays) {
    for (const diagnostic of replay.diagnostics ?? []) {
      if (diagnostic.code === "remote_acp_event_retention_gap") {
        events.push(
          workspaceExecutionEventSchema.parse({
            ...remoteBase(handle, diagnostic.droppedThroughCursor, clock),
            eventId: `${replay.executionAttemptId}:retention:${diagnostic.droppedThroughCursor}`,
            type: "retention_gap",
            data: { droppedThroughCursor: diagnostic.droppedThroughCursor }
          })
        );
      }
    }
    if (replay.eventProtocolVersion === 1) {
      for (const event of replay.events) {
        events.push(
          workspaceExecutionEventSchema.parse({
            ...remoteBase(handle, event.cursor, clock),
            eventId: `${replay.executionAttemptId}:runner:${event.cursor}`,
            type: "runner_event",
            data: { eventProtocolVersion: 1, event }
          })
        );
      }
    } else {
      for (const event of replay.events) {
        events.push(
          workspaceExecutionEventSchema.parse({
            ...remoteBase(handle, event.cursor, clock),
            eventId: `${replay.executionAttemptId}:runner:${event.cursor}`,
            type: "runner_event",
            data: { eventProtocolVersion: 2, event }
          })
        );
      }
    }
  }
  for (const interaction of input.interactions.items) {
    events.push(projectRemoteInteractionEvent(handle, interaction, clock));
  }
  return events;
}

export function projectRemoteInteractionEvent(
  handle: RemoteWorkspaceExecutionHandle,
  interaction: RemoteInteractionView,
  clock: Clock = () => new Date()
): WorkspaceExecutionEvent {
  const identityKey = remoteInteractionIdentityKey(interaction);
  if (interaction.status === "settled" && interaction.settlement) {
    return workspaceExecutionEventSchema.parse({
      ...remoteBase(handle, handle.cursor.eventCursor, clock),
      eventId: `${handle.operationId}:interaction:${identityKey}:settled`,
      type: "interaction_resolved",
      data: interaction.settlement
    });
  }
  if (interaction.status === "expired") {
    return workspaceExecutionEventSchema.parse({
      ...remoteBase(handle, handle.cursor.eventCursor, clock),
      eventId: `${handle.operationId}:interaction:${identityKey}:expired`,
      type: "runner_diagnostic",
      data: {
        code: "remote_interaction_expired",
        message: "remote_interaction_expired",
        retryable: false,
        stage: "interaction"
      }
    });
  }
  return workspaceExecutionEventSchema.parse({
    ...remoteBase(handle, handle.cursor.eventCursor, clock),
    eventId: `${handle.operationId}:interaction:${identityKey}:pending`,
    type: "interaction_required",
    data: interaction.request
  });
}

export function executionScopeEquals(
  left: WorkspaceExecutionScope,
  right: WorkspaceExecutionScope
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
