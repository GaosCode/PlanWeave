import {
  canvasRuntimeInitializeAcceptedSchema,
  canvasRuntimeInitializeRejectedSchema,
  canvasRuntimeInitializeRequestSchema,
  type CanvasRuntimeInitializeFailureCode,
  type CanvasRuntimeInitializeOutcome
} from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import {
  canvasScopeRefSchema,
  type CanvasScopeRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import type { CollaborationAuthContext } from "../identity/auth.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import { readStableCanvasContentFingerprint } from "./contentFingerprint.js";
import type { ContentAuthorityStore } from "./contentAuthorityStore.js";
import {
  CanvasRuntimeResetConflictError,
  CanvasRuntimeUnavailableError,
  type CanvasExecutionRuntimeLeasePort,
  type RuntimeCanvasScope
} from "./executionRuntimePort.js";
import { authorizeCanvasCommand } from "./policy.js";
import { CanvasRuntimeRpcError } from "./runtimeRpcBroker.js";
import type { CanvasRuntimeStatusRepository } from "./runtimeStatusRepository.js";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";

export type CanvasRuntimeInitializationCoordinatorOptions = {
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  contentVersions: ContentAuthorityStore;
  runtimeStatuses: CanvasRuntimeStatusRepository;
  executionLeases: CanvasExecutionRuntimeLeasePort;
  hasConflictingLease(scope: RuntimeCanvasScope): boolean;
  commitTransaction<T>(action: () => T): T;
};

class CanvasRuntimeInitializationContentSupersededError extends Error {}

function rejected(
  operationId: string,
  code: CanvasRuntimeInitializeFailureCode
): CanvasRuntimeInitializeOutcome {
  return canvasRuntimeInitializeRejectedSchema.parse({
    type: "canvas.runtime.initialize.rejected",
    operationId,
    code
  });
}

function hostFailure(error: unknown): CanvasRuntimeInitializeFailureCode {
  if (error instanceof CanvasRuntimeUnavailableError) {
    return error.reason === "host_offline" ? "host_offline" : "unavailable";
  }
  if (error instanceof CanvasRuntimeResetConflictError) {
    return error.code === "active_lease" ? "active_lease" : "source_drift";
  }
  if (error instanceof CanvasRuntimeRpcError) {
    if (
      error.code === "canvas_runtime_host_offline" ||
      error.code === "canvas_runtime_host_disconnected"
    ) {
      return "host_offline";
    }
    if (error.code === "content_out_of_sync") return "source_drift";
    if (error.code === "active_lease") return "active_lease";
  }
  if (error instanceof Error) {
    if (error.message === "content_out_of_sync") return "source_drift";
    if (error.message === "active_lease") return "active_lease";
  }
  return "unavailable";
}

function matchesScope(
  left: { workspaceId: string; projectId: string; canvasId: string },
  right: CanvasScopeRef
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

/** Creates the first Server Runtime projection by reading the Host; never resets Host state. */
export class CanvasRuntimeInitializationCoordinator {
  constructor(private readonly options: CanvasRuntimeInitializationCoordinatorOptions) {}

  async initialize(
    actor: CollaborationAuthContext,
    input: { projectId: string; canvasId: string; body: unknown }
  ): Promise<CanvasRuntimeInitializeOutcome> {
    const request = canvasRuntimeInitializeRequestSchema.parse(input.body);
    const authorization = authorizeCanvasCommand({
      actor,
      projectId: input.projectId,
      canvasId: input.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!authorization.ok) return rejected(request.operationId, "forbidden");
    const scope = canvasScopeRefSchema.parse(authorization.scope);
    if (!this.contentMatchesRequest(scope, request)) {
      return rejected(request.operationId, "source_drift");
    }
    if (this.options.hasConflictingLease(scope)) {
      return rejected(request.operationId, "active_lease");
    }

    let lease: Awaited<ReturnType<CanvasExecutionRuntimeLeasePort["acquire"]>> | undefined;
    let status: CanvasRuntimeStatusProjection;
    try {
      lease = await this.options.executionLeases.acquire(scope);
      if (!lease.readInitializationEvidence) throw new CanvasRuntimeUnavailableError();
      const evidence = await lease.readInitializationEvidence();
      if (
        evidence.sourceRevision !== request.expectedSourceRevision ||
        evidence.graphFingerprint !== request.expectedGraphFingerprint
      ) {
        throw new CanvasRuntimeResetConflictError("source_drift");
      }
      status = evidence.status;
    } catch (error) {
      return rejected(request.operationId, hostFailure(error));
    } finally {
      if (lease) {
        try {
          await lease.release();
        } catch {
          // Host status was read without mutation; cleanup does not change the result.
        }
      }
    }

    if (
      !matchesScope(status.scope, scope) ||
      status.packageFingerprint !== request.expectedGraphFingerprint
    ) {
      return rejected(request.operationId, "source_drift");
    }

    try {
      return this.options.commitTransaction(() => {
        if (!this.contentMatchesRequest(scope, request)) {
          throw new CanvasRuntimeInitializationContentSupersededError();
        }
        const current = this.options.runtimeStatuses.read(scope);
        const snapshot =
          current && current.status.packageFingerprint === request.expectedGraphFingerprint
            ? current
            : this.options.runtimeStatuses.replaceFromExecution(status);
        return canvasRuntimeInitializeAcceptedSchema.parse({
          type: "canvas.runtime.initialize.accepted",
          operationId: request.operationId,
          runtimeRevision: snapshot.runtimeRevision,
          sourceRevision: request.expectedSourceRevision,
          graphFingerprint: request.expectedGraphFingerprint,
          status: snapshot.status
        });
      });
    } catch (error) {
      return rejected(
        request.operationId,
        error instanceof CanvasRuntimeInitializationContentSupersededError
          ? "source_drift"
          : "persist_failed"
      );
    }
  }

  private contentMatchesRequest(
    scope: CanvasScopeRef,
    request: ReturnType<typeof canvasRuntimeInitializeRequestSchema.parse>
  ): boolean {
    const head = this.options.contentVersions.head(scope);
    const fingerprint = readStableCanvasContentFingerprint(this.options.contentVersions, scope);
    return (
      head?.revision === request.expectedContentRevision &&
      fingerprint === request.expectedGraphFingerprint
    );
  }
}
