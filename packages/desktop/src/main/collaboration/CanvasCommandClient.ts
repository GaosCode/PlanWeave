import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasCommandIntentSchema,
  canvasCommandOperationIdSchema,
  canvasCommandOutcomeSchema,
  canvasCommandSubmitSchema,
  canvasReconnectRequestSchema,
  canvasReconnectResponseSchema,
  type CanvasCommandAccepted,
  type CanvasCommandIntent,
  type CanvasCommandOutcome,
  type CanvasJournalEntry,
  type CanvasReconnectResponse,
  type CanvasRevision
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { CollaborationHttpTransport } from "./collaborationHttpTransport.js";
import {
  CanvasCommandSessionState,
  type CanvasCommandSessionSnapshot
} from "./canvasCommandSession.js";

export type CanvasCommandSubmitInput = {
  canvasId: string;
  operationId: string;
  intent: CanvasCommandIntent;
  /** When omitted, uses the last tracked authoritative revision (CAS). */
  expectedRevision?: CanvasRevision;
};

export type CanvasCommandReconnectInput = {
  canvasId: string;
  afterRevision?: CanvasRevision;
  afterContentDigest?: string;
};

export type CanvasCommandMaterializationHooks = {
  beforeAccepted?: (outcome: CanvasCommandAccepted, intent: CanvasCommandIntent) => Promise<void>;
  beforeReconnect?: (input: {
    response: CanvasReconnectResponse;
    entriesToApply: CanvasJournalEntry[];
    snapshotRequired: boolean;
  }) => Promise<void>;
};

/**
 * Durable canvas command transport (HTTP).
 * Independent from ephemeral presence. Tracks revision/operationId session state.
 */
export class CanvasCommandClient {
  private readonly session = new CanvasCommandSessionState();

  constructor(
    private readonly transport: CollaborationHttpTransport,
    private readonly projectId: string
  ) {}

  sessionSnapshot(): CanvasCommandSessionSnapshot | null {
    return this.session.snapshot();
  }

  bindCanvas(canvasId: string): void {
    this.session.bind(canvasId);
  }

  clearSession(): void {
    this.session.clear();
  }

  async submit(
    input: CanvasCommandSubmitInput,
    signal?: AbortSignal,
    hooks?: CanvasCommandMaterializationHooks
  ): Promise<CanvasCommandOutcome> {
    this.transport.ensureOpen();
    const intent = canvasCommandIntentSchema.parse(input.intent);
    const operationId = canvasCommandOperationIdSchema.parse(input.operationId);
    const canvasId = input.canvasId.trim();
    if (!canvasId) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_canvas_id_required",
        message: "canvasId is required for canvas commands."
      });
    }
    this.session.bind(canvasId);
    const expectedRevision =
      input.expectedRevision !== undefined ? input.expectedRevision : this.session.getRevision();
    const body = canvasCommandSubmitSchema.parse({
      type: "canvas.command.submit",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: this.projectId,
      canvasId,
      operationId,
      expectedRevision,
      intent
    });
    this.session.beginSubmit(operationId);
    const outcome = await this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(canvasId)}/commands`,
      canvasCommandOutcomeSchema,
      {
        body,
        signal,
        // Accepted (200) and CAS/policy rejections (409) both carry outcome contracts.
        acceptedStatus: [409, 401, 403, 404, 429, 500]
      }
    );
    if (outcome.type === "canvas.command.accepted") {
      await hooks?.beforeAccepted?.(outcome, intent);
    }
    this.session.applyOutcome(outcome);
    return outcome;
  }

  async reconnect(
    input: CanvasCommandReconnectInput,
    signal?: AbortSignal,
    hooks?: CanvasCommandMaterializationHooks
  ): Promise<{
    response: CanvasReconnectResponse;
    entriesToApply: ReturnType<CanvasCommandSessionState["applyReconnect"]>["entriesToApply"];
    snapshotRequired: boolean;
    session: CanvasCommandSessionSnapshot | null;
  }> {
    this.transport.ensureOpen();
    const canvasId = input.canvasId.trim();
    if (!canvasId) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_canvas_id_required",
        message: "canvasId is required for canvas reconnect."
      });
    }
    this.session.bind(canvasId);
    const afterRevision =
      input.afterRevision !== undefined ? input.afterRevision : this.session.getRevision();
    const afterContentDigest =
      input.afterContentDigest !== undefined
        ? input.afterContentDigest
        : (this.session.getContentDigest() ?? undefined);
    const body = canvasReconnectRequestSchema.parse({
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: this.projectId,
      canvasId,
      afterRevision,
      ...(afterContentDigest !== undefined ? { afterContentDigest } : {})
    });
    const response = await this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(canvasId)}/reconnect`,
      canvasReconnectResponseSchema,
      {
        body,
        signal,
        acceptedStatus: [409, 401, 403, 404]
      }
    );
    const prepared = this.session.prepareReconnect(response);
    await hooks?.beforeReconnect?.({ response, ...prepared });
    const applied = this.session.applyReconnect(response);
    return {
      response,
      entriesToApply: applied.entriesToApply,
      snapshotRequired: applied.snapshotRequired,
      session: this.session.snapshot()
    };
  }
}
