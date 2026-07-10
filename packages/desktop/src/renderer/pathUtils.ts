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
