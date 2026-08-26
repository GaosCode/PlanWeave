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
  if (availability.kind === "not_applicable" || availability.kind === "available") return true;
  if (availability.kind === "state_uninitialized") return true;
  return availability.kind === "unavailable" && availability.reason === "runtime_not_attached";
}

export function collaborationRuntimeResetAllowed(
  availability: CollaborationRuntimeAvailabilityView
): boolean {
  return (
    collaborationRuntimeOperationsAllowed(availability) ||
    availability.kind === "state_uninitialized" ||
    (availability.kind === "unavailable" && availability.reason === "runtime_not_attached")
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
  if (availability.kind === "state_uninitialized") return null;
  if (availability.kind === "unavailable") {
    if (availability.reason === "runtime_not_attached") return null;
    return `collaboration_runtime_${availability.reason}`;
  }
  if (availability.kind === "error") {
    return `collaboration_runtime_availability_error:${availability.message}`;
  }
  if (availability.kind === "session_disconnected") return "collaboration_session_disconnected";
  return "collaboration_runtime_checking";
}
