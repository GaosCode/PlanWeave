import type { CollaborationStatus } from "../../shared/collaboration.js";
import { mapSessionPhaseToSync, type InternalState } from "./collaborationReadModelState.js";

/** Maps the published session into its matching controller; another profile retires the cache. */
export function applyCollaborationSessionStatus(input: {
  state: InternalState;
  status: CollaborationStatus;
  now: () => string;
  clear: () => void;
  emit: () => void;
}): void {
  const { state, status } = input;
  if (
    state.profileId &&
    status.session.activeProfileId &&
    status.session.activeProfileId !== state.profileId
  ) {
    input.clear();
    return;
  }
  const nextPhase = mapSessionPhaseToSync(status, state.syncPhase);
  if (nextPhase === state.syncPhase) return;
  state.syncPhase = nextPhase;
  state.updatedAt = input.now();
  if (status.session.lastErrorCode) {
    state.lastError = {
      kind: nextPhase === "auth_expired" ? "auth" : "unknown",
      code: status.session.lastErrorCode,
      message: status.session.lastErrorMessage ?? status.session.lastErrorCode,
      retryable: nextPhase === "reconnecting"
    };
  }
  input.emit();
}
