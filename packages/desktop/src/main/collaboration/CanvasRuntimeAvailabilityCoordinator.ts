import type { CanvasRuntimeAvailability } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import {
  collaborationCanvasSessionInputSchema,
  collaborationContentAuthorityCanvasInputSchema
} from "../../shared/collaboration.js";
import type { ContentVersionFacade } from "./ContentVersionFacade.js";
import type { CollaborationCanvasCommandFacade } from "./collaborationCanvasCommands.js";
import type { CanvasReplicaStore } from "./CanvasReplicaStore.js";

export type CanvasRuntimeContentPort = Pick<
  ContentVersionFacade,
  "resolveCanvasScope" | "readRuntimeAvailability"
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
    return this.contentVersions.resolveCanvasScope(input);
  }

  async readRuntimeAvailability(input: unknown): Promise<CanvasRuntimeAvailability | null> {
    const requested = collaborationContentAuthorityCanvasInputSchema.parse(input);
    const online = this.isOnline();
    const scope = online ? await this.contentVersions.resolveCanvasScope(requested) : null;
    const availability = await this.contentVersions.readRuntimeAvailability(requested);
    const authorityId = this.resolveAuthorityId();
    if (!availability || !online || !authorityId || !scope) return availability;
    const replicaScope = {
      authorityId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId
    };
    if (this.canvasReplicas.has(replicaScope)) {
      this.canvasReplicas.setRuntimeStatus(
        replicaScope,
        availability.kind === "available" ? availability.status : null
      );
    }
    return availability;
  }

  async getReplicaProjection(input: unknown) {
    const requested = collaborationCanvasSessionInputSchema.parse(input);
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
}
