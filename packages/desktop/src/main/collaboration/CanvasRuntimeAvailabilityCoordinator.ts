import {
  canvasRuntimeAvailabilitySchema,
  type CanvasRuntimeAvailability
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import {
  canvasRuntimeResetAcceptedSchema,
  canvasRuntimeResetOutcomeSchema,
  type CanvasRuntimeResetOutcome
} from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import {
  collaborationCanvasBindingInputSchema,
  type RemoteCollaborationCanvasBindingInput
} from "../../shared/collaboration.js";
import {
  workspaceCanvasRuntimeResetInputSchema,
  type WorkspaceCanvasRuntimeResetInput
} from "../../shared/collaborationRuntimeAvailability.js";
import { workspaceCanvasLocatorToBinding } from "../../shared/canvasLocator.js";
import type { ContentVersionFacade } from "./ContentVersionFacade.js";
import type { CollaborationCanvasCommandFacade } from "./collaborationCanvasCommands.js";
import type { CanvasReplicaStore } from "./CanvasReplicaStore.js";
import { CollaborationClientError } from "./collaborationErrors.js";

export type CanvasRuntimeContentPort = Pick<
  ContentVersionFacade,
  "resolveCanvasScope" | "readResolvedRuntimeAvailability" | "resetRuntime"
>;
export type CanvasRuntimeCommandPort = Pick<
  CollaborationCanvasCommandFacade,
  "projectionForBinding"
>;
export type CanvasRuntimeReplicaPort = Pick<
  CanvasReplicaStore,
  "has" | "setRuntimeStatus" | "projection"
>;

/** Coordinates Server runtime reads with the in-memory canvas replica overlay. */
export class CanvasRuntimeAvailabilityCoordinator {
  constructor(
    private readonly isOnline: () => boolean,
    private readonly resolveAuthorityId: () => string | null,
    private readonly contentVersions: CanvasRuntimeContentPort,
    private readonly canvasCommands: CanvasRuntimeCommandPort,
    private readonly canvasReplicas: CanvasRuntimeReplicaPort
  ) {}

  resolveCanvasScope(input: unknown) {
    return this.contentVersions.resolveCanvasScope(this.requireRemoteBinding(input));
  }

  async readRuntimeAvailability(input: unknown): Promise<CanvasRuntimeAvailability | null> {
    const requested = this.requireRemoteBinding(input);
    const authorityId = this.resolveAuthorityId();
    if (!this.isOnline() || !authorityId) return null;
    const scope = await this.contentVersions.resolveCanvasScope(requested);
    if (!scope) return null;
    const replicaScope = {
      authorityId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId
    };
    if (!this.isOnline()) {
      this.clearReplicaRuntimeStatus(replicaScope);
      return null;
    }
    let availability: CanvasRuntimeAvailability | null;
    try {
      availability = await this.contentVersions.readResolvedRuntimeAvailability(scope);
    } catch (error) {
      if (!this.isOnline()) {
        this.clearReplicaRuntimeStatus(replicaScope);
        return null;
      }
      throw error;
    }
    if (!this.isOnline()) {
      this.clearReplicaRuntimeStatus(replicaScope);
      return null;
    }
    if (!availability) {
      this.clearReplicaRuntimeStatus(replicaScope);
      return null;
    }
    if (this.canvasReplicas.has(replicaScope)) {
      this.canvasReplicas.setRuntimeStatus(
        replicaScope,
        availability.state.kind === "initialized" ? availability.state.status : null
      );
    }
    return availability;
  }

  async resetRuntime(input: WorkspaceCanvasRuntimeResetInput): Promise<CanvasRuntimeResetOutcome> {
    const requested = workspaceCanvasRuntimeResetInputSchema.parse(input);
    const binding = workspaceCanvasLocatorToBinding(requested.locator);
    const outcome = canvasRuntimeResetOutcomeSchema.parse(
      await this.contentVersions.resetRuntime(binding, {
        operationId: requested.operationId,
        expectedSourceRevision: requested.expectedSourceRevision,
        expectedGraphFingerprint: requested.expectedGraphFingerprint,
        ...(requested.reason === undefined ? {} : { reason: requested.reason })
      })
    );
    if (outcome.operationId !== requested.operationId) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "runtime_reset_operation_id_mismatch",
        message: "runtime_reset_operation_id_mismatch",
        retryable: false
      });
    }
    if (outcome.type === "canvas.runtime.reset.rejected") return outcome;

    const availability = canvasRuntimeAvailabilitySchema.parse(
      await this.readRuntimeAvailability(binding)
    );
    if (
      availability.state.kind !== "initialized" ||
      availability.state.runtimeRevision < outcome.runtimeRevision ||
      JSON.stringify(availability.state.status) !== JSON.stringify(outcome.status)
    ) {
      throw new CollaborationClientError({
        kind: "unknown",
        code: "runtime_reset_projection_postcondition_failed",
        message: "runtime_reset_projection_postcondition_failed",
        retryable: true
      });
    }
    return canvasRuntimeResetAcceptedSchema.parse(outcome);
  }

  private clearReplicaRuntimeStatus(scope: Parameters<CanvasRuntimeReplicaPort["has"]>[0]): void {
    if (this.canvasReplicas.has(scope)) this.canvasReplicas.setRuntimeStatus(scope, null);
  }

  async getReplicaProjection(input: unknown) {
    const requested = this.requireRemoteBinding(input);
    const fromBinding = this.canvasCommands.projectionForBinding(requested);
    if (fromBinding) return fromBinding;
    const authorityId = this.resolveAuthorityId();
    const scope = await this.contentVersions.resolveCanvasScope(requested);
    if (!authorityId || !scope) return null;
    return this.canvasReplicas.projection({
      authorityId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId
    });
  }

  private requireRemoteBinding(input: unknown): RemoteCollaborationCanvasBindingInput {
    const requested = collaborationCanvasBindingInputSchema.parse(input);
    if (requested.kind !== "remote") {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "workspace_canvas_remote_binding_required",
        message: "workspace_canvas_remote_binding_required",
        retryable: false
      });
    }
    return requested;
  }
}
