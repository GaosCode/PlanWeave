import type { CanvasRuntimeUnavailableReason } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";

export type CollaborationRuntimeAvailabilityView =
  | { kind: "not_applicable" }
  | { kind: "server_disconnected" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "unavailable"; reason: CanvasRuntimeUnavailableReason; statusKnown: boolean }
  | { kind: "state_uninitialized" }
  | { kind: "error"; message: string };

export function collaborationRuntimeOperationsAllowed(
  availability: CollaborationRuntimeAvailabilityView
): boolean {
  return collaborationRuntimeStatusKnown(availability);
}

export function collaborationRuntimeStatusKnown(
  availability: CollaborationRuntimeAvailabilityView
): boolean {
  return (
    availability.kind === "not_applicable" ||
    availability.kind === "available" ||
    (availability.kind === "unavailable" && availability.statusKnown)
  );
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
  return availability.kind === "server_disconnected"
    ? "collaboration_server_disconnected"
    : "collaboration_runtime_checking";
}
