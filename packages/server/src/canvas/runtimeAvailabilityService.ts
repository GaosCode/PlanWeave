import {
  canvasRuntimeAvailabilitySchema,
  type CanvasRuntimeAvailability
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { decodeCanvasReplicaDocument, projectCanvasReplicaDocument } from "@planweave-ai/runtime";
import type { CollaborationAuthContext } from "../identity/auth.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";
import { authorizeCanvasContent } from "./policy.js";
import type { CanvasRuntimeAvailabilityPort } from "./runtimePort.js";

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

    const head = this.options.contentVersions.head(scope);
    if (!head) return unavailableContentOutOfSync();
    const authoritative = this.options.contentVersions.readVersion(scope, head.content);
    if (
      authoritative.completed.versionId !== head.content.versionId ||
      authoritative.content.canonicalDigest !== head.content.canonicalDigest
    ) {
      throw new Error("canvas_runtime_availability_content_head_mismatch");
    }
    const contentFingerprint = projectCanvasReplicaDocument(
      decodeCanvasReplicaDocument(authoritative.content)
    ).packageFingerprint;
    const currentHead = this.options.contentVersions.head(scope);
    if (
      !currentHead ||
      currentHead.revision !== head.revision ||
      currentHead.content.versionId !== head.content.versionId ||
      currentHead.content.canonicalDigest !== head.content.canonicalDigest ||
      availability.graphFingerprint !== contentFingerprint
    ) {
      return unavailableContentOutOfSync();
    }
    return canvasRuntimeAvailabilitySchema.parse(availability);
  }
}
