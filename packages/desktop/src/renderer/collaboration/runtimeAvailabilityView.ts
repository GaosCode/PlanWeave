import type { CanvasRuntimeUnavailableReason } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";

export type CollaborationRuntimeAvailabilityView =
  | { kind: "not_applicable" }
  | { kind: "session_disconnected"; statusKnown: boolean }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "unavailable"; reason: CanvasRuntimeUnavailableReason; statusKnown: boolean }
  | { kind: "state_uninitialized" }
  | { kind: "error"; message: string };

export function collaborationRuntimeOperationsAllowed(
  availability: CollaborationRuntimeAvailabilityView
): boolean {
  return (
    availability.kind === "not_applicable" ||
    availability.kind === "available" ||
    (availability.kind === "unavailable" && availability.statusKnown)
  );
}

export function collaborationRuntimeStartAllowed(
  availability: CollaborationRuntimeAvailabilityView
): boolean {
  return (
    collaborationRuntimeOperationsAllowed(availability) ||
    availability.kind === "state_uninitialized"
  );
}

export function collaborationRuntimeStatusKnown(
  availability: CollaborationRuntimeAvailabilityView
): boolean {
  return "statusKnown" in availability
    ? availability.statusKnown
    : availability.kind === "not_applicable" || availability.kind === "available";
}

export function collaborationRuntimeUnavailableCode(
  availability: CollaborationRuntimeAvailabilityView
): string | null {
  if (availability.kind === "not_applicable" || availability.kind === "available") return null;
  if (availability.kind === "unavailable") return `collaboration_runtime_${availability.reason}`;
  if (availability.kind === "state_uninitialized") {
    return "collaboration_runtime_state_uninitialized";
  }
  if (availability.kind === "error") {
    return `collaboration_runtime_availability_error:${availability.message}`;
  }
  if (availability.kind === "session_disconnected") return "collaboration_session_disconnected";
  return "collaboration_runtime_checking";
}
