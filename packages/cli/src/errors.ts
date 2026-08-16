import { PlanWeaveWorkspaceNotInitializedError } from "@planweave-ai/runtime";
import { AcpProfilesJsonError } from "./commands/acpProfiles.js";

export function workspaceNotInitializedJson(
  error: PlanWeaveWorkspaceNotInitializedError
): Record<string, unknown> {
  return {
    initialized: false,
    projectRoot: error.projectRoot,
    workspaceDir: error.workspaceDir,
    projectId: error.projectId,
    projectDir: error.projectDir,
    projectGraphPath: error.projectGraphPath,
    packageDir: error.packageDir,
    statePath: error.statePath,
    resultsDir: error.resultsDir,
    message: error.message,
    nextCommands: [
      "planweave init --json",
      "planweave --project-root /path/to/project paths --json"
    ]
  };
}

export function formatWorkspaceNotInitialized(
  error: PlanWeaveWorkspaceNotInitializedError
): string {
  return [
    `PlanWeave workspace is not initialized for project: ${error.projectRoot}`,
    "",
    "Run:",
    "  planweave init --json",
    "",
    "Or target an existing project:",
    "  planweave --project-root /path/to/project paths --json"
  ].join("\n");
}

export function formatCliError(error: unknown): string {
  if (error instanceof AcpProfilesJsonError) return JSON.stringify(error.envelope);
  if (error instanceof PlanWeaveWorkspaceNotInitializedError) {
    return formatWorkspaceNotInitialized(error);
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}
