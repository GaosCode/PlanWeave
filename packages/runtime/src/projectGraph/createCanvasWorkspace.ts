import {
  createProjectCanvas,
  toCreateCanvasWorkspaceResult,
  type ProjectCanvasMutationPorts
} from "./projectCanvasMutation.js";

export type CreateCanvasWorkspaceOptions = {
  cwd?: string;
  id?: string;
  title: string;
  activate?: boolean;
  dryRun?: boolean;
  /** Test-only ports for fault injection; production callers omit this. */
  ports?: ProjectCanvasMutationPorts;
};

export type CreateCanvasWorkspaceResult = {
  canvasId: string;
  title: string;
  created: boolean;
  activated: boolean;
  projectGraphPath: string;
  canvasRoot: string;
  packageDir: string;
  manifestPath: string;
  taskPromptsDir: string;
  blockPromptsDir: string;
  statePath: string;
  resultsDir: string;
  canvasValidationArgs: string[];
  projectValidationArgs: string[];
  qualityArgs: string[];
};

/**
 * CLI-facing canvas create entry.
 * Delegates ID allocation, locking, staging, commit, and graph write to the shared
 * project-canvas mutation coordinator — do not reimplement those steps here.
 */
export async function createCanvasWorkspace(
  options: CreateCanvasWorkspaceOptions
): Promise<CreateCanvasWorkspaceResult> {
  const result = await createProjectCanvas({
    projectRoot: options.cwd ?? process.cwd(),
    title: options.title,
    requestedId: options.id,
    idMode: "slug-from-title",
    activate: options.activate,
    dryRun: options.dryRun,
    ports: options.ports
  });
  return toCreateCanvasWorkspaceResult(result);
}
