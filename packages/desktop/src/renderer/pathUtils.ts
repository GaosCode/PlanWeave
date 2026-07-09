import type { DesktopProjectSummary } from "@planweave-ai/runtime";

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

export function joinWorkspacePath(workspaceRoot: string, packageDir: string): string {
  if (isAbsolutePath(packageDir)) {
    return packageDir;
  }
  const separator = workspaceRoot.includes("\\") && !workspaceRoot.includes("/") ? "\\" : "/";
  return `${workspaceRoot.replace(/[\\/]+$/, "")}${separator}${packageDir.replace(/^[\\/]+/, "")}`;
}

export function taskNodeDirectory(
  project: Pick<DesktopProjectSummary, "workspaceRoot">,
  packageDir: string,
  taskId: string
): string {
  const separator =
    project.workspaceRoot.includes("\\") && !project.workspaceRoot.includes("/") ? "\\" : "/";
  return `${joinWorkspacePath(project.workspaceRoot, packageDir).replace(/[\\/]+$/, "")}${separator}nodes${separator}${taskId}`;
}
