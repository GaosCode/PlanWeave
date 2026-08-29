import {
  canvasRuntimeAvailabilitySchema,
  type CanvasRuntimeAvailability
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import {
  canvasRuntimeInitializeOutcomeSchema,
  canvasRuntimeInitializeRequestSchema,
  type CanvasRuntimeInitializeOutcome,
  type CanvasRuntimeInitializeRequest,
  canvasRuntimeResetOutcomeSchema,
  canvasRuntimeResetRequestSchema,
  type CanvasRuntimeResetOutcome,
  type CanvasRuntimeResetRequest
} from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { CollaborationHttpTransport } from "./collaborationHttpTransport.js";

/** Strict HTTP boundary for Server-authoritative Canvas Runtime operations. */
export class CanvasRuntimeClient {
  constructor(
    private readonly projectId: string,
    private readonly transport: CollaborationHttpTransport
  ) {}

  readAvailability(canvasId: string, signal?: AbortSignal): Promise<CanvasRuntimeAvailability> {
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(canvasId)}/runtime-availability?view=canvas-runtime-view%2Fv2`,
      canvasRuntimeAvailabilitySchema,
      { signal }
    );
  }

  async initialize(
    canvasId: string,
    input: CanvasRuntimeInitializeRequest
  ): Promise<CanvasRuntimeInitializeOutcome> {
    const request = canvasRuntimeInitializeRequestSchema.parse(input);
    const outcome = await this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(canvasId)}/runtime-initialize`,
      canvasRuntimeInitializeOutcomeSchema,
      {
        body: request,
        acceptedStatus: [400, 403, 409, 500, 503]
      }
    );
    if (outcome.operationId !== request.operationId) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "runtime_initialize_operation_id_mismatch",
        message: "runtime_initialize_operation_id_mismatch",
        retryable: false
      });
    }
    return outcome;
  }

  async reset(
    canvasId: string,
    input: CanvasRuntimeResetRequest
  ): Promise<CanvasRuntimeResetOutcome> {
    const request = canvasRuntimeResetRequestSchema.parse(input);
    const outcome = await this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(canvasId)}/runtime-reset`,
      canvasRuntimeResetOutcomeSchema,
      {
        body: request,
        acceptedStatus: [400, 403, 409, 500, 503]
      }
    );
    if (outcome.operationId !== request.operationId) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "runtime_reset_operation_id_mismatch",
        message: "runtime_reset_operation_id_mismatch",
        retryable: false
      });
    }
    return outcome;
  }
}
