import {
  canvasRuntimeAvailabilitySchema,
  type CanvasRuntimeAvailability
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationAuthContext } from "../identity/auth.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";
import { authorizeCanvasContent } from "./policy.js";
import type { CanvasRuntimeAvailabilityPort } from "./runtimePort.js";
import { readStableCanvasContentFingerprint } from "./contentFingerprint.js";

export type CanvasRuntimeAvailabilityServiceOptions = {
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  contentVersions: ContentAuthorityStore;
  runtimeAvailability: CanvasRuntimeAvailabilityPort;
  clock?: () => Date;
};

function unavailableContentOutOfSync(): CanvasRuntimeAvailability {
  return canvasRuntimeAvailabilitySchema.parse({
    schemaVersion: "canvas-runtime-availability/v1",
    kind: "unavailable",
    reason: "content_out_of_sync"
  });
}

function sameScope(
  left: { workspaceId: string; projectId: string; canvasId: string },
  right: { workspaceId: string; projectId: string; canvasId: string }
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

/** Authorizes one logical Canvas read and reconciles Runtime evidence with the Server content head. */
export class CanvasRuntimeAvailabilityService {
  private readonly clock: () => Date;

  constructor(private readonly options: CanvasRuntimeAvailabilityServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async read(
    actor: CollaborationAuthContext,
    input: { projectId: string; canvasId: string }
  ): Promise<CanvasRuntimeAvailability> {
    const authorization = authorizeCanvasContent({
      actor,
      projectId: input.projectId,
      canvasId: input.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!authorization.ok) {
      throw new Error(`canvas_runtime_availability_${authorization.code}`);
    }
    const scope = canvasScopeRefSchema.parse(authorization.scope);
    const availability = canvasRuntimeAvailabilitySchema.parse(
      await this.options.runtimeAvailability.readAvailability(scope, this.clock().toISOString())
    );
    if (availability.kind === "unavailable") return availability;
    if (
      !sameScope(availability.status.scope, scope) ||
      availability.status.packageFingerprint !== availability.graphFingerprint
    ) {
      return unavailableContentOutOfSync();
    }

    let contentFingerprint: string | undefined;
    try {
      contentFingerprint = readStableCanvasContentFingerprint(this.options.contentVersions, scope);
    } catch (error) {
      if (error instanceof Error && error.message === "canvas_content_head_mismatch") {
        throw new Error("canvas_runtime_availability_content_head_mismatch");
      }
      throw error;
    }
    if (!contentFingerprint || availability.graphFingerprint !== contentFingerprint) {
      return unavailableContentOutOfSync();
    }
    return canvasRuntimeAvailabilitySchema.parse(availability);
  }
}
