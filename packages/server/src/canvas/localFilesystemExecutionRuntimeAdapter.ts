import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  capturePackageSnapshot,
  readAuthorizedCanvasRuntimeStatus,
  readRuntimeResetReceipt,
  resetRuntimeState,
  resolveProjectCanvasWorkspace
} from "@planweave-ai/runtime";
import { resolve } from "node:path";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { TrustedRuntimeRegistry } from "../runtimeProjectRegistry.js";
import type {
  CanvasExecutionRuntimeLeasePort,
  CanvasRuntimeScopeAvailabilityPort,
  OwnerCanvasRuntimeScopeResolverPort,
  RuntimeCanvasScope
} from "./executionRuntimePort.js";
import {
  CanvasRuntimeResetConflictError,
  CanvasRuntimeUnavailableError
} from "./executionRuntimePort.js";

export class LocalFilesystemExecutionRuntimeAdapter
  implements
    CanvasExecutionRuntimeLeasePort,
    CanvasRuntimeScopeAvailabilityPort,
    OwnerCanvasRuntimeScopeResolverPort
{
  constructor(private readonly registry: TrustedRuntimeRegistry) {}

  async acquire(scope: RuntimeCanvasScope) {
    try {
      const lease = await this.registry.registry.acquire(scope);
      const location = this.registry.resolveExactCanvasLocation(scope);
      const readStatus = location
        ? () =>
            readAuthorizedCanvasRuntimeStatus({
              projectRoot: location.projectRoot,
              canvasId: scope.canvasId,
              expectedPackageDir: location.packageDir,
              scope: canvasScopeRefSchema.parse(scope)
            })
        : undefined;
      return {
        ...lease,
        reset: async (command: {
          operationId: string;
          expectedSourceRevision: string;
          expectedGraphFingerprint: string;
          reason?: string;
        }) => {
          if (!location) throw new CanvasRuntimeUnavailableError();
          const before = await capturePackageSnapshot({
            projectRoot: location.projectRoot,
            canvasId: scope.canvasId
          });
          if (
            before.snapshot.sourceRevision !== command.expectedSourceRevision ||
            before.resolvedPackageDir !== location.packageDir
          ) {
            throw new CanvasRuntimeResetConflictError("source_drift");
          }
          const statusBeforeReset = await readAuthorizedCanvasRuntimeStatus({
            projectRoot: location.projectRoot,
            canvasId: scope.canvasId,
            expectedPackageDir: location.packageDir,
            scope: canvasScopeRefSchema.parse(scope)
          });
          if (statusBeforeReset.packageFingerprint !== command.expectedGraphFingerprint) {
            throw new CanvasRuntimeResetConflictError("source_drift");
          }
          const workspace = await resolveProjectCanvasWorkspace(
            location.projectRoot,
            scope.canvasId
          );
          try {
            await resetRuntimeState({
              projectRoot: workspace,
              ...(command.reason ? { reason: command.reason } : {}),
              receipt: {
                operationId: command.operationId,
                sourceRevision: command.expectedSourceRevision,
                graphFingerprint: command.expectedGraphFingerprint,
                committedAt: new Date().toISOString()
              }
            });
          } catch (error) {
            if (error instanceof Error && /active work exists/i.test(error.message)) {
              throw new CanvasRuntimeResetConflictError("active_lease");
            }
            throw error;
          }
          const status = await readAuthorizedCanvasRuntimeStatus({
            projectRoot: location.projectRoot,
            canvasId: scope.canvasId,
            expectedPackageDir: location.packageDir,
            scope: canvasScopeRefSchema.parse(scope)
          });
          if (status.packageFingerprint !== command.expectedGraphFingerprint) {
            throw new CanvasRuntimeResetConflictError("source_drift");
          }
          return {
            operationId: command.operationId,
            sourceRevision: before.snapshot.sourceRevision,
            graphFingerprint: status.packageFingerprint,
            status
          };
        },
        ...(location
          ? {
              readStatus,
              readInitializationEvidence: async () => {
                const before = await capturePackageSnapshot({
                  projectRoot: location.projectRoot,
                  canvasId: scope.canvasId
                });
                if (before.resolvedPackageDir !== location.packageDir || !readStatus) {
                  throw new CanvasRuntimeResetConflictError("source_drift");
                }
                const status = await readStatus();
                const after = await capturePackageSnapshot({
                  projectRoot: location.projectRoot,
                  canvasId: scope.canvasId
                });
                if (
                  after.resolvedPackageDir !== location.packageDir ||
                  after.snapshot.sourceRevision !== before.snapshot.sourceRevision
                ) {
                  throw new CanvasRuntimeResetConflictError("source_drift");
                }
                return {
                  sourceRevision: after.snapshot.sourceRevision,
                  graphFingerprint: status.packageFingerprint,
                  status
                };
              }
            }
          : {})
      };
    } catch (error) {
      if (isUnavailableRuntimeBinding(error)) throw new CanvasRuntimeUnavailableError();
      throw error;
    }
  }

  async reconcileReset(
    scope: RuntimeCanvasScope,
    command: {
      operationId: string;
      expectedSourceRevision: string;
      expectedGraphFingerprint: string;
    }
  ) {
    const location = this.registry.resolveExactCanvasLocation(scope);
    if (!location) throw new CanvasRuntimeUnavailableError();
    const workspace = await resolveProjectCanvasWorkspace(location.projectRoot, scope.canvasId);
    const receipt = await readRuntimeResetReceipt({ projectRoot: workspace });
    if (!receipt || receipt.operationId !== command.operationId)
      return { kind: "not_found" as const };
    if (
      receipt.sourceRevision !== command.expectedSourceRevision ||
      receipt.graphFingerprint !== command.expectedGraphFingerprint
    ) {
      return {
        kind: "failed" as const,
        error: { code: "content_out_of_sync", retryable: false }
      };
    }
    const snapshot = await capturePackageSnapshot({
      projectRoot: location.projectRoot,
      canvasId: scope.canvasId
    });
    const status = await readAuthorizedCanvasRuntimeStatus({
      projectRoot: location.projectRoot,
      canvasId: scope.canvasId,
      expectedPackageDir: location.packageDir,
      scope: canvasScopeRefSchema.parse(scope)
    });
    if (
      snapshot.snapshot.sourceRevision !== command.expectedSourceRevision ||
      status.packageFingerprint !== command.expectedGraphFingerprint
    ) {
      return {
        kind: "failed" as const,
        error: { code: "content_out_of_sync", retryable: false }
      };
    }
    return {
      kind: "succeeded" as const,
      result: {
        operationId: command.operationId,
        sourceRevision: snapshot.snapshot.sourceRevision,
        graphFingerprint: status.packageFingerprint,
        status
      }
    };
  }

  hasRuntimeScope(scope: RuntimeCanvasScope): boolean {
    return this.registry.hasScope(scope);
  }

  hasRuntimeProject(scope: { workspaceId: string; projectId: string }): boolean {
    return this.registry.hasScope(scope);
  }

  resolveUniqueOwnerScope(scope: {
    projectId: string;
    canvasId: string;
  }): RuntimeCanvasScope | undefined {
    const matches = this.registry.expansions.filter(
      (candidate) =>
        candidate.projectId === scope.projectId && candidate.canvasId === scope.canvasId
    );
    if (matches.length !== 1) return undefined;
    const match = matches[0]!;
    return {
      workspaceId: match.workspaceId,
      projectId: match.projectId,
      canvasId: match.canvasId
    };
  }

  attachCollaborationScopeResolution(input: {
    workspaceIdentity: WorkspaceIdentityRepository;
    projectAccess: ProjectAccessRepository;
  }): void {
    this.registry.registry.setScopedResolver(async (scope) => {
      if (!input.workspaceIdentity.workspaceExists(scope.workspaceId)) {
        throw new Error("remote_runtime_workspace_unresolved");
      }
      const project = input.projectAccess.registry.projectInternal(
        scope.workspaceId,
        scope.projectId
      );
      const canvas = input.projectAccess.registry.canvasInternal(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId
      );
      if (!project || project.revokedAt !== null || !canvas || canvas.revokedAt !== null) {
        throw new Error("remote_runtime_scope_unavailable");
      }
      if (!project.projectRoot || !canvas.packageDir) {
        try {
          return {
            runtime: this.registry.registry.resolve(scope),
            artifacts: this.registry.registry.resolveArtifactSource(scope),
            release() {}
          };
        } catch (error) {
          if (isUnavailableRuntimeBinding(error)) {
            throw new Error("remote_runtime_scope_unavailable");
          }
          throw error;
        }
      }
      const workspace = await resolveProjectCanvasWorkspace(project.projectRoot, scope.canvasId);
      if (resolve(workspace.packageDir) !== resolve(canvas.packageDir)) {
        throw new Error("remote_runtime_registry_path_mismatch");
      }
      return {
        runtime: canonicalRemoteRuntimePort(
          createRemoteBlockRuntimePort({ projectRoot: workspace }),
          scope.workspaceId
        ),
        artifacts: createRemoteBlockArtifactSource({ projectRoot: workspace }),
        release() {}
      };
    });
  }
}

function isUnavailableRuntimeBinding(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "remote_runtime_workspace_unresolved" ||
    error.message === "remote_runtime_scope_unavailable" ||
    error.message.startsWith("remote_runtime_locator_unresolved:") ||
    error.message.startsWith("remote_runtime_artifact_source_unresolved:")
  );
}
