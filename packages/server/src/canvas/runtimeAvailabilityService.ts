import {
  canvasRuntimeAvailabilityV2Schema,
  canvasRuntimeExecutionAvailabilitySchema,
  type CanvasRuntimeAvailabilityV2,
  type CanvasRuntimeExecutionAvailability
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationAuthContext } from "../identity/auth.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";
import { authorizeCanvasContent } from "./policy.js";
import type { CanvasRuntimeAuthorityAvailabilityPort } from "./runtimePort.js";
import { readStableCanvasRuntimeEvidence } from "./contentFingerprint.js";
import type { CanvasRuntimeStatusRepository } from "./runtimeStatusRepository.js";

export type CanvasRuntimeAvailabilityServiceOptions = {
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  contentVersions: ContentAuthorityStore;
  runtimeAvailability: CanvasRuntimeAuthorityAvailabilityPort;
  runtimeStatuses: CanvasRuntimeStatusRepository;
  clock?: () => Date;
};

function executionContentOutOfSync(): CanvasRuntimeExecutionAvailability {
  return canvasRuntimeExecutionAvailabilitySchema.parse({
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

/** Authorizes one logical Canvas read and combines Server state with device execution evidence. */
export class CanvasRuntimeAvailabilityService {
  private readonly clock: () => Date;

  constructor(private readonly options: CanvasRuntimeAvailabilityServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async read(
    actor: CollaborationAuthContext,
    input: { projectId: string; canvasId: string }
  ): Promise<CanvasRuntimeAvailabilityV2> {
    const scope = this.authorize(actor, input);
    const contentEvidence = this.contentEvidence(scope);
    if (!contentEvidence) throw new Error("canvas_runtime_availability_content_unavailable");
    const contentFingerprint = contentEvidence.target.graphFingerprint;
    const stored = this.options.runtimeStatuses.read(scope);
    const state =
      contentFingerprint && stored?.status.packageFingerprint === contentFingerprint
        ? {
            kind: "initialized" as const,
            runtimeRevision: stored.runtimeRevision,
            status: stored.status
          }
        : { kind: "uninitialized" as const };

    const capturedAt = this.clock().toISOString();
    const observed = canvasRuntimeExecutionAvailabilitySchema.parse(
      await this.options.runtimeAvailability.readAvailabilityForAuthority(
        scope,
        capturedAt,
        contentEvidence
      )
    );
    const execution =
      contentFingerprint &&
      observed.kind === "available" &&
      sameScope(observed.status.scope, scope) &&
      observed.status.packageFingerprint === observed.graphFingerprint &&
      observed.graphFingerprint === contentFingerprint &&
      observed.sourceRevision === contentEvidence.sourceRevision
        ? observed
        : observed.kind === "available"
          ? executionContentOutOfSync()
          : observed;

    return canvasRuntimeAvailabilityV2Schema.parse({
      schemaVersion: "canvas-runtime-view/v2",
      authority: {
        revision: contentEvidence.target.revision,
        sourceRevision: contentEvidence.sourceRevision,
        graphFingerprint: contentEvidence.target.graphFingerprint
      },
      state,
      execution
    });
  }

  private authorize(
    actor: CollaborationAuthContext,
    input: { projectId: string; canvasId: string }
  ) {
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
    return canvasScopeRefSchema.parse(authorization.scope);
  }

  private contentEvidence(scope: { workspaceId: string; projectId: string; canvasId: string }) {
    try {
      return readStableCanvasRuntimeEvidence(this.options.contentVersions, scope);
    } catch (error) {
      if (error instanceof Error && error.message === "canvas_content_head_mismatch") {
        throw new Error("canvas_runtime_availability_content_head_mismatch");
      }
      throw error;
    }
  }
}
