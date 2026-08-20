import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  loadProjectGraph,
  manifestSchema,
  projectCanvasWorkspace
} from "@planweave-ai/runtime";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { RemoteRuntimePortRegistry } from "./remoteRuntimeLocator.js";
import {
  createManifestWorkItemPort,
  createRoutedWorkItemPackagePort,
  workItemPackageFactsSchema,
  type WorkItemPackagePort
} from "./work/index.js";

export const trustedRuntimeProjectSchema = z
  .object({
    workspaceId: opaqueIdentifierSchema,
    projectId: opaqueIdentifierSchema,
    /** Legacy configuration: trust exactly this declared canvas. */
    canvasId: opaqueIdentifierSchema.optional(),
    /** Explicit opt-in to trust every canvas declared by the Runtime graph. */
    trustAllDeclaredCanvases: z.boolean().default(false),
    projectRoot: z.string().min(1).max(4096).refine(isAbsolute, "projectRoot must be absolute")
  })
  .strict()
  .superRefine((project, context) => {
    if (project.trustAllDeclaredCanvases && project.canvasId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "trusted_project_canvas_scope_conflict"
      });
      return;
    }
    if (!project.trustAllDeclaredCanvases && project.canvasId === undefined) {
      context.addIssue({ code: "custom", message: "trusted_project_canvas_required" });
    }
  });

export type TrustedRuntimeProject = z.infer<typeof trustedRuntimeProjectSchema>;

export type RuntimeCanvasExpansion = Readonly<{
  workspaceId: string;
  projectId: string;
  projectRoot: string;
  canvasId: string;
  packageDir: string;
}>;

export type TrustedRuntimeRegistry = {
  registry: RemoteRuntimePortRegistry;
  locators: Array<{ workspaceId: string; projectId: string; canvasId: string }>;
  readonly expansions: readonly RuntimeCanvasExpansion[];
  resolveExactCanvasLocation(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
  }): RuntimeCanvasExpansion | undefined;
  hasScope(input: { workspaceId: string; projectId: string; canvasId?: string }): boolean;
  /** Legacy adapter: succeeds only when a project ID has one trusted Workspace scope. */
  hasProject(projectId: string): boolean;
  /** Legacy adapter: succeeds only when this project/canvas pair has one trusted Workspace scope. */
  hasCanvas(projectId: string, canvasId: string): boolean;
  /** Legacy adapter: succeeds only when a project ID has one trusted Workspace scope. */
  workItemPackagePort(projectId: string): WorkItemPackagePort | undefined;
  /** Resolve a package port for one request-scoped workspace/project/canvas tuple. */
  scopedWorkItemPackagePort(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
  }): WorkItemPackagePort | undefined;
  /** Resolve one exact Workspace/project port that routes each declared canvas by WorkItemRef. */
  scopedProjectWorkItemPackagePort(input: {
    workspaceId: string;
    projectId: string;
  }): WorkItemPackagePort | undefined;
  acquireScopedWorkItemPackagePort(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
  }): { port: WorkItemPackagePort; release(): void } | undefined;
  setScopedPackageResolver(
    resolver: (input: {
      workspaceId: string;
      projectId: string;
      canvasId: string;
    }) => WorkItemPackagePort | undefined
  ): void;
  close(): void;
};

export type TrustedRuntimeRegistryOptions = {
  loadManifest?: (manifestFile: string) => unknown;
};

export async function createTrustedRuntimeRegistry(
  rawProjects: readonly TrustedRuntimeProject[],
  options: TrustedRuntimeRegistryOptions = {}
): Promise<TrustedRuntimeRegistry> {
  const projects = z.array(trustedRuntimeProjectSchema).max(256).parse(rawProjects);
  const registry = new RemoteRuntimePortRegistry();
  const unbind: Array<() => void> = [];
  const locators: Array<{ workspaceId: string; projectId: string; canvasId: string }> = [];
  const expansions: RuntimeCanvasExpansion[] = [];
  const canvasWorkItemPorts = new Map<string, Map<string, WorkItemPackagePort>>();
  const loadedGraphs = new Map<string, Awaited<ReturnType<typeof loadProjectGraph>>>();
  const loadManifest =
    options.loadManifest ??
    ((manifestFile: string) => JSON.parse(readFileSync(manifestFile, "utf8")));
  try {
    for (const project of projects) {
      let loaded = loadedGraphs.get(project.projectRoot);
      if (!loaded) {
        loaded = await loadProjectGraph(project.projectRoot);
        loadedGraphs.set(project.projectRoot, loaded);
      }
      if (loaded.workspace.id !== project.projectId)
        throw new Error("trusted_project_identity_mismatch");
      const selectedCanvases = project.trustAllDeclaredCanvases
        ? loaded.manifest.canvases
        : loaded.manifest.canvases.filter((canvas) => canvas.id === project.canvasId);
      if (!project.trustAllDeclaredCanvases && selectedCanvases.length !== 1) {
        throw new Error("trusted_project_canvas_not_declared");
      }
      const projectScopeKey = scopeKey(project.workspaceId, project.projectId);
      let projectPorts = canvasWorkItemPorts.get(projectScopeKey);
      if (!projectPorts) {
        projectPorts = new Map();
        canvasWorkItemPorts.set(projectScopeKey, projectPorts);
      }
      for (const canvas of selectedCanvases) {
        const workspace = projectCanvasWorkspace(loaded.workspace, canvas);
        const locator = {
          workspaceId: project.workspaceId,
          projectId: project.projectId,
          canvasId: canvas.id
        };
        projectPorts.set(canvas.id, {
          resolveWorkItem(workItem) {
            const manifest = manifestSchema.parse(loadManifest(workspace.manifestFile));
            return createManifestWorkItemPort(manifest, canvas.id).resolveWorkItem(workItem);
          },
          resolveWorkItems(workItems) {
            const manifest = manifestSchema.parse(loadManifest(workspace.manifestFile));
            return createManifestWorkItemPort(manifest, canvas.id).resolveWorkItems(workItems);
          }
        });
        unbind.push(
          registry.bind(
            locator,
            createRemoteBlockRuntimePort({ projectRoot: workspace }),
            createRemoteBlockArtifactSource({ projectRoot: workspace })
          )
        );
        locators.push(locator);
        expansions.push(
          Object.freeze({
            workspaceId: project.workspaceId,
            projectId: project.projectId,
            projectRoot: project.projectRoot,
            canvasId: canvas.id,
            packageDir: workspace.packageDir
          })
        );
      }
    }
  } catch (error) {
    for (const release of unbind.reverse()) release();
    throw error;
  }
  const canvasIdsByProjectScope = new Map(
    [...canvasWorkItemPorts].map(([projectScopeKey, ports]) => [
      projectScopeKey,
      new Set(ports.keys())
    ])
  );
  const projectWorkItemPorts = new Map(
    [...canvasWorkItemPorts].map(([projectScopeKey, ports]) => [
      projectScopeKey,
      createRoutedWorkItemPackagePort((canvasId) => ports.get(canvasId))
    ])
  );
  const configuredLocators = Object.freeze([...locators]);
  const scopedPackagePort = (input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
  }): WorkItemPackagePort | undefined => {
    if (
      !canvasIdsByProjectScope
        .get(scopeKey(input.workspaceId, input.projectId))
        ?.has(input.canvasId)
    ) {
      return undefined;
    }
    const port = projectWorkItemPorts.get(scopeKey(input.workspaceId, input.projectId));
    if (!port) return undefined;
    return {
      resolveWorkItem(workItem) {
        if (workItem.canvasId !== input.canvasId) {
          return workItemPackageFactsSchema.parse({
            canvasId: input.canvasId,
            kind: workItem.kind,
            exists: false,
            ...(workItem.kind === "task"
              ? { taskId: workItem.taskId }
              : { blockRef: workItem.blockRef }),
            requiredCapabilities: []
          });
        }
        return port.resolveWorkItem(workItem);
      },
      resolveWorkItems(workItems) {
        const matchingWorkItems = workItems.filter(
          (workItem) => workItem.canvasId === input.canvasId
        );
        const matchingFacts =
          matchingWorkItems.length > 0 ? port.resolveWorkItems(matchingWorkItems) : [];
        if (matchingFacts.length !== matchingWorkItems.length) {
          throw new Error("runtime_package_batch_result_mismatch");
        }
        let matchingIndex = 0;
        return workItems.map((workItem) => {
          if (workItem.canvasId === input.canvasId) {
            const facts = matchingFacts[matchingIndex];
            matchingIndex += 1;
            if (!facts) throw new Error("runtime_package_batch_result_mismatch");
            return facts;
          }
          return workItemPackageFactsSchema.parse({
            canvasId: input.canvasId,
            kind: workItem.kind,
            exists: false,
            ...(workItem.kind === "task"
              ? { taskId: workItem.taskId }
              : { blockRef: workItem.blockRef }),
            requiredCapabilities: []
          });
        });
      }
    };
  };
  let externalScopedResolver:
    | ((input: {
        workspaceId: string;
        projectId: string;
        canvasId: string;
      }) => WorkItemPackagePort | undefined)
    | undefined;
  return {
    registry,
    locators,
    expansions: Object.freeze(expansions),
    resolveExactCanvasLocation(input) {
      const matches = expansions.filter(
        (expansion) =>
          expansion.workspaceId === input.workspaceId &&
          expansion.projectId === input.projectId &&
          expansion.canvasId === input.canvasId
      );
      return matches.length === 1 ? matches[0] : undefined;
    },
    hasScope(input) {
      const canvases = canvasIdsByProjectScope.get(scopeKey(input.workspaceId, input.projectId));
      return (
        canvases !== undefined && (input.canvasId === undefined || canvases.has(input.canvasId))
      );
    },
    hasProject(projectId) {
      return uniqueProjectScope(projectId, configuredLocators) !== undefined;
    },
    hasCanvas(projectId, canvasId) {
      return uniqueCanvasScope(projectId, canvasId, configuredLocators) !== undefined;
    },
    workItemPackagePort(projectId) {
      const scope = uniqueProjectScope(projectId, configuredLocators);
      return scope ? projectWorkItemPorts.get(scopeKey(scope.workspaceId, projectId)) : undefined;
    },
    scopedWorkItemPackagePort(input) {
      return externalScopedResolver ? externalScopedResolver(input) : scopedPackagePort(input);
    },
    scopedProjectWorkItemPackagePort(input) {
      return projectWorkItemPorts.get(scopeKey(input.workspaceId, input.projectId));
    },
    acquireScopedWorkItemPackagePort(input) {
      const port = externalScopedResolver
        ? externalScopedResolver(input)
        : scopedPackagePort(input);
      if (!port) return undefined;
      let released = false;
      return {
        port: {
          resolveWorkItem(workItem) {
            if (released) throw new Error("runtime_package_scope_released");
            return port.resolveWorkItem(workItem);
          },
          resolveWorkItems(workItems) {
            if (released) throw new Error("runtime_package_scope_released");
            return port.resolveWorkItems(workItems);
          }
        },
        release() {
          released = true;
        }
      };
    },
    setScopedPackageResolver(resolver) {
      externalScopedResolver = resolver;
    },
    close() {
      for (const release of unbind.splice(0).reverse()) release();
    }
  };
}

function scopeKey(workspaceId: string, projectId: string): string {
  return `${workspaceId}\0${projectId}`;
}

function uniqueProjectScope(
  projectId: string,
  locators: readonly { workspaceId: string; projectId: string; canvasId: string }[]
): { workspaceId: string; projectId: string } | undefined {
  const matches = new Map<string, { workspaceId: string; projectId: string }>();
  for (const locator of locators) {
    if (locator.projectId === projectId) {
      matches.set(locator.workspaceId, { workspaceId: locator.workspaceId, projectId });
    }
  }
  return matches.size === 1 ? [...matches.values()][0] : undefined;
}

function uniqueCanvasScope(
  projectId: string,
  canvasId: string,
  locators: readonly { workspaceId: string; projectId: string; canvasId: string }[]
): { workspaceId: string; projectId: string; canvasId: string } | undefined {
  const matches = locators.filter(
    (locator) => locator.projectId === projectId && locator.canvasId === canvasId
  );
  return matches.length === 1 ? matches[0] : undefined;
}
