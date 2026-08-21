import {
  canvasRuntimeAvailabilitySchema,
  canvasRuntimeExecutionAvailabilitySchema,
  importCanvasRuntimeStatusRequestSchema,
  type CanvasRuntimeAvailability,
  type CanvasRuntimeExecutionAvailability
} from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationAuthContext } from "../identity/auth.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";
import { authorizeCanvasCommand, authorizeCanvasContent } from "./policy.js";
import type { CanvasRuntimeAvailabilityPort } from "./runtimePort.js";
import { readStableCanvasContentFingerprint } from "./contentFingerprint.js";
import type { CanvasRuntimeStatusRepository } from "./runtimeStatusRepository.js";

export type CanvasRuntimeAvailabilityServiceOptions = {
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  contentVersions: ContentAuthorityStore;
  runtimeAvailability: CanvasRuntimeAvailabilityPort;
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
  ): Promise<CanvasRuntimeAvailability> {
    const scope = this.authorize(actor, input, false);
    const contentFingerprint = this.contentFingerprint(scope);
    const stored = this.options.runtimeStatuses.read(scope);
    const state =
      stored?.packageFingerprint === contentFingerprint
        ? { kind: "initialized" as const, status: stored }
        : { kind: "uninitialized" as const };

    const observed = canvasRuntimeExecutionAvailabilitySchema.parse(
      await this.options.runtimeAvailability.readAvailability(scope, this.clock().toISOString())
    );
    const execution =
      observed.kind === "available" &&
      sameScope(observed.status.scope, scope) &&
      observed.status.packageFingerprint === observed.graphFingerprint &&
      observed.graphFingerprint === contentFingerprint
        ? observed
        : observed.kind === "available"
          ? executionContentOutOfSync()
          : observed;

    return canvasRuntimeAvailabilitySchema.parse({
      schemaVersion: "canvas-runtime-view/v1",
      state,
      execution
    });
  }

  importInitial(
    actor: CollaborationAuthContext,
    input: { projectId: string; canvasId: string; body: unknown }
  ): CanvasRuntimeAvailability["state"] {
    const scope = this.authorize(actor, input, true);
    const { status } = importCanvasRuntimeStatusRequestSchema.parse(input.body);
    if (!sameScope(status.scope, scope)) throw new Error("canvas_runtime_status_scope_mismatch");
    if (status.packageFingerprint !== this.contentFingerprint(scope)) {
      throw new Error("canvas_runtime_status_content_out_of_sync");
    }
    return {
      kind: "initialized",
      status: this.options.runtimeStatuses.initialize(status)
    };
  }

  private authorize(
    actor: CollaborationAuthContext,
    input: { projectId: string; canvasId: string },
    write: boolean
  ) {
    const authorization = (write ? authorizeCanvasCommand : authorizeCanvasContent)({
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

  private contentFingerprint(scope: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
  }): string {
    try {
      const fingerprint = readStableCanvasContentFingerprint(this.options.contentVersions, scope);
      if (!fingerprint) throw new Error("canvas_runtime_status_content_missing");
      return fingerprint;
    } catch (error) {
      if (error instanceof Error && error.message === "canvas_content_head_mismatch") {
        throw new Error("canvas_runtime_availability_content_head_mismatch");
      }
      throw error;
    }
  }
}
