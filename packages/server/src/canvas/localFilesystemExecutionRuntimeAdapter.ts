import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  resolveProjectCanvasWorkspace
} from "@planweave-ai/runtime";
import { resolve } from "node:path";
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
import { CanvasRuntimeUnavailableError } from "./executionRuntimePort.js";

export class LocalFilesystemExecutionRuntimeAdapter
  implements
    CanvasExecutionRuntimeLeasePort,
    CanvasRuntimeScopeAvailabilityPort,
    OwnerCanvasRuntimeScopeResolverPort
{
  constructor(private readonly registry: TrustedRuntimeRegistry) {}

  async acquire(scope: RuntimeCanvasScope) {
    try {
      return await this.registry.registry.acquire(scope);
    } catch (error) {
      if (isUnavailableRuntimeBinding(error)) throw new CanvasRuntimeUnavailableError();
      throw error;
    }
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
