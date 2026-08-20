import { readFileSync } from "node:fs";
import { join } from "node:path";
import { manifestSchema } from "@planweave-ai/runtime";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { TrustedRuntimeRegistry } from "../runtimeProjectRegistry.js";
import { createManifestWorkItemPort } from "./workItemFacts.js";
import type { WorkRuntimePackageLeasePort, WorkRuntimeProjectResolverPort } from "./runtimePort.js";

export class LocalFilesystemWorkRuntimeAdapter
  implements WorkRuntimeProjectResolverPort, WorkRuntimePackageLeasePort
{
  constructor(private readonly registry: TrustedRuntimeRegistry) {}

  listAttachedProjects() {
    const projects = new Map<string, { workspaceId: string; projectId: string }>();
    for (const locator of this.registry.locators) {
      const key = JSON.stringify([locator.workspaceId, locator.projectId]);
      projects.set(key, { workspaceId: locator.workspaceId, projectId: locator.projectId });
    }
    return [...projects.values()];
  }

  resolveProjectPackage(scope: { workspaceId: string; projectId: string }) {
    return this.registry.scopedProjectWorkItemPackagePort(scope);
  }

  acquirePackage(scope: { workspaceId: string; projectId: string; canvasId: string }) {
    const acquired = this.registry.acquireScopedWorkItemPackagePort(scope);
    if (!acquired) return undefined;
    return { package: acquired.port, release: acquired.release };
  }

  attachCollaborationScopeResolution(input: {
    workspaceIdentity: WorkspaceIdentityRepository;
    projectAccess: ProjectAccessRepository;
  }): void {
    this.registry.setScopedPackageResolver((scope) => {
      if (!input.workspaceIdentity.workspaceExists(scope.workspaceId)) return undefined;
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
        return undefined;
      }
      if (!canvas.packageDir) {
        return this.registry.configuredScopedWorkItemPackagePort(scope);
      }
      const manifest = manifestSchema.parse(
        JSON.parse(readFileSync(join(canvas.packageDir, "manifest.json"), "utf8"))
      );
      return createManifestWorkItemPort(manifest, scope.canvasId);
    });
  }
}
