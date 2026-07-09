import type {
  DefaultCanvasWorkspaceMigrationApplyResult,
  MaterializeProjectGraphResult,
  ValidationIssue
} from "@planweave-ai/runtime";

export function formatProjectGraphConflictDiagnostics(diagnostics: ValidationIssue[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n");
}

export function formatProjectGraphMigrationHuman(
  result: DefaultCanvasWorkspaceMigrationApplyResult
): string {
  const lines = [
    `Default canvas migration: ${result.action}`,
    `Project graph: ${result.projectGraphPath}`
  ];
  if (result.legacyBackupPaths.workspaceRoot) {
    lines.push(`Legacy backup: ${result.legacyBackupPaths.workspaceRoot}`);
  }
  return lines.join("\n");
}

export function formatProjectGraphMaterializeHuman(result: MaterializeProjectGraphResult): string {
  return [
    result.created
      ? `Project graph: ${result.path}`
      : `Project graph already exists: ${result.path}`,
    `Source: ${result.source}`,
    `Canvases: ${result.canvasCount}`
  ].join("\n");
}
