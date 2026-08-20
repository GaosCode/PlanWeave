import type { CanvasRuntimeUnavailableReason } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";

export type CollaborationRuntimeAvailabilityView =
  | { kind: "not_applicable" }
  | { kind: "server_disconnected" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "unavailable"; reason: CanvasRuntimeUnavailableReason }
  | { kind: "error"; message: string };

export function collaborationRuntimeOperationsAllowed(
  availability: CollaborationRuntimeAvailabilityView
): boolean {
  return availability.kind === "not_applicable" || availability.kind === "available";
}

export function collaborationRuntimeStatusKnown(
  availability: CollaborationRuntimeAvailabilityView
): boolean {
  return collaborationRuntimeOperationsAllowed(availability);
}

export function collaborationRuntimeUnavailableCode(
  availability: CollaborationRuntimeAvailabilityView
): string | null {
  if (availability.kind === "not_applicable" || availability.kind === "available") return null;
  if (availability.kind === "unavailable") return `collaboration_runtime_${availability.reason}`;
  if (availability.kind === "error") {
    return `collaboration_runtime_availability_error:${availability.message}`;
  }
  return availability.kind === "server_disconnected"
    ? "collaboration_server_disconnected"
    : "collaboration_runtime_checking";
}
