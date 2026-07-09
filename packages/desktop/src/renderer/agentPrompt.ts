import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { joinWorkspacePath } from "./pathUtils";

export type AgentPromptScope = {
  project: Pick<DesktopProjectSummary, "projectId" | "rootPath" | "sourceRoot" | "workspaceRoot">;
  canvasId: string;
  packageDir: string;
  taskId?: string | null;
};

function absolutePackageDir(workspaceRoot: string, packageDir: string): string {
  if (!packageDir.trim()) {
    throw new Error("Cannot build agent prompt because packageDir is unavailable.");
  }
  return joinWorkspacePath(workspaceRoot, packageDir);
}

export function buildAgentScopePrompt({
  project,
  canvasId,
  packageDir,
  taskId
}: AgentPromptScope): string {
  const lines = [
    `projectId: ${project.projectId}`,
    `projectRoot: ${project.rootPath}`,
    `workspaceRoot: ${project.workspaceRoot}`,
    `canvasId: ${canvasId}`,
    `packageDir: ${absolutePackageDir(project.workspaceRoot, packageDir)}`,
    `sourceRoot: ${project.sourceRoot ?? ""}`
  ];
  if (taskId) {
    lines.push(`task_id: ${taskId}`);
  }
  return lines.join("\n");
}

export async function writeAgentScopePromptToClipboard(scope: AgentPromptScope): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is not available.");
  }
  await navigator.clipboard.writeText(buildAgentScopePrompt(scope));
}
