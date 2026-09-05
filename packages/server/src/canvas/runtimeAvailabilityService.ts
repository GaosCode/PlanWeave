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

const EXECUTION_AVAILABILITY_CACHE_LIMIT = 32;

function executionAvailabilityCacheKey(input: {
  workspaceId: string;
  projectId: string;
  canvasId: string;
  graphFingerprint: string;
  sourceRevision: string;
  runtimeRevision: number;
}): string {
  return [
    input.workspaceId,
    input.projectId,
    input.canvasId,
    input.graphFingerprint,
    input.sourceRevision,
    String(input.runtimeRevision)
  ].join("\u0000");
}

function cacheableExecution(execution: CanvasRuntimeExecutionAvailability): boolean {
  return execution.kind === "available" || execution.reason === "content_out_of_sync";
}

/** Authorizes one logical Canvas read and combines Server state with device execution evidence. */
export class CanvasRuntimeAvailabilityService {
  private readonly clock: () => Date;
  private readonly executionCache = new Map<string, CanvasRuntimeExecutionAvailability>();

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
    const cacheKey = executionAvailabilityCacheKey({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      graphFingerprint: contentEvidence.target.graphFingerprint,
      sourceRevision: contentEvidence.sourceRevision,
      runtimeRevision: stored?.runtimeRevision ?? 0
    });
    const cachedExecution = this.executionCache.get(cacheKey);
    const observed = canvasRuntimeExecutionAvailabilitySchema.parse(
      cachedExecution ??
        (await this.options.runtimeAvailability.readAvailabilityForAuthority(
          scope,
          capturedAt,
          contentEvidence
        ))
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
    if (!cachedExecution && cacheableExecution(execution)) {
      this.rememberExecution(cacheKey, execution);
    }

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

  private rememberExecution(cacheKey: string, execution: CanvasRuntimeExecutionAvailability): void {
    this.executionCache.delete(cacheKey);
    this.executionCache.set(cacheKey, execution);
    while (this.executionCache.size > EXECUTION_AVAILABILITY_CACHE_LIMIT) {
      const oldest = this.executionCache.keys().next().value;
      if (oldest === undefined) break;
      this.executionCache.delete(oldest);
    }
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
