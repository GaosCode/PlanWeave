import type {
  ProjectedRemoteAcpEvent,
  RemoteAcpReplayDiagnostic,
  RemoteAcpReplayProjection
} from "@planweave-ai/runtime";
import { mergeRemoteAcpReplayDiagnostics } from "@planweave-ai/runtime/browser";

export type RemoteAcpAttemptReplayState = {
  executionAttemptId: string | null;
  eventProtocolVersion: 1 | 2 | null;
  cursor: number;
  events: ProjectedRemoteAcpEvent[];
  diagnostics: RemoteAcpReplayDiagnostic[];
  hasMore: boolean;
};

export function createRemoteAcpAttemptReplayState(
  executionAttemptId: string | null = null
): RemoteAcpAttemptReplayState {
  return {
    executionAttemptId,
    eventProtocolVersion: null,
    cursor: 0,
    events: [],
    diagnostics: [],
    hasMore: false
  };
}

export function scopeRemoteAcpReplayToAttempt(
  state: RemoteAcpAttemptReplayState,
  executionAttemptId: string
): RemoteAcpAttemptReplayState {
  return state.executionAttemptId === executionAttemptId
    ? state
    : createRemoteAcpAttemptReplayState(executionAttemptId);
}

export function remoteAcpReplayRequestMatchesState(
  request: RemoteAcpAttemptReplayState,
  current: RemoteAcpAttemptReplayState
): boolean {
  return (
    request.executionAttemptId === current.executionAttemptId &&
    request.eventProtocolVersion === current.eventProtocolVersion &&
    request.cursor === current.cursor
  );
}

export function applyRemoteAcpReplayPage(input: {
  state: RemoteAcpAttemptReplayState;
  requestedAfterCursor: number;
  cursor: number;
  hasMore: boolean;
  projection: RemoteAcpReplayProjection;
}): RemoteAcpAttemptReplayState {
  const { state, projection } = input;
  if (
    state.executionAttemptId !== null &&
    state.executionAttemptId !== projection.executionAttemptId
  ) {
    throw new Error("remote_acp_event_attempt_mismatch");
  }
  if (state.cursor !== input.requestedAfterCursor) {
    throw new Error("remote_acp_event_cursor_stale");
  }
  if (input.cursor < input.requestedAfterCursor) {
    throw new Error("remote_acp_event_cursor_regressed");
  }
  if (
    state.eventProtocolVersion !== null &&
    state.eventProtocolVersion !== projection.eventProtocolVersion
  ) {
    throw new Error("remote_acp_event_protocol_version_changed");
  }
  const byCursor = new Map(state.events.map((event) => [event.cursor, event]));
  for (const event of projection.events) byCursor.set(event.cursor, event);
  return {
    executionAttemptId: projection.executionAttemptId,
    eventProtocolVersion: projection.eventProtocolVersion,
    cursor: input.cursor,
    events: [...byCursor.values()].sort((left, right) => left.cursor - right.cursor),
    diagnostics: mergeRemoteAcpReplayDiagnostics(state.diagnostics, projection.diagnostics),
    hasMore: input.hasMore
  };
}
