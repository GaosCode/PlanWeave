import type {
  CanvasRuntimeAvailability,
  CanvasRuntimeStateAvailability
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import type { CollaborationCanvasBindingInput } from "./collaborationCanvasBinding.js";

export type PlanWeaveCollaborationRuntimeAvailabilityApi = {
  readCollaborationCanvasBindingRuntimeAvailability: (
    input: CollaborationCanvasBindingInput
  ) => Promise<CanvasRuntimeAvailability | null>;
  importCollaborationLocalRuntimeStatus: (
    input: CollaborationCanvasBindingInput
  ) => Promise<CanvasRuntimeStateAvailability | null>;
};
