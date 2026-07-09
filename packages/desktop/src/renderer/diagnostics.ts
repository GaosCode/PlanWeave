import type { ValidationIssue } from "@planweave-ai/runtime";

export type DesktopDiagnostic = ValidationIssue & {
  source?: string;
  severity?: string;
  suggestedTool?: string;
  fixId?: string;
  affectedIds?: string[];
};

export type DesktopDiagnosticSource =
  | "performance"
  | "package"
  | "search"
  | "runtime"
  | "project"
  | "graphQuality"
  | "other";

export type DesktopDiagnosticGroup = {
  source: DesktopDiagnosticSource;
  diagnostics: DesktopDiagnostic[];
};

const desktopDiagnosticSourceOrder: DesktopDiagnosticSource[] = [
  "performance",
  "package",
  "search",
  "runtime",
  "project",
  "graphQuality",
  "other"
];

const desktopPerformanceDiagnosticCodes = new Set([
  "desktop_projection_slow_part",
  "desktop_search_index_slow_part",
  "desktop_statistics_slow_part"
]);

const packageDiagnosticPrefixes = ["package_", "manifest_", "prompt_", "project_canvas_manifest_"];

const searchDiagnosticPrefixes = [
  "desktop_search_",
  "desktop_result_",
  "desktop_results_",
  "desktop_search_body_index_"
];

const runtimeDiagnosticCodes = new Set(["desktop_canvas_runtime_input_failed"]);

const runtimeDiagnosticPrefixes = [
  "auto_run_state_",
  "auto_run_event_log_",
  "auto_run_retrospective_",
  "desktop_canvas_execution_"
];

const projectDiagnosticPrefixes = [
  "project_graph_",
  "project_canvas_",
  "project_cross_task_",
  "project_task_",
  "depends_on_",
  "canvas_dependency_",
  "canvas_graph_",
  "canvas_registry_",
  "canvas_doctor_"
];

function hasAnyPrefix(value: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

export function desktopDiagnosticSource(
  diagnostic: Pick<ValidationIssue, "code"> & { source?: string }
): DesktopDiagnosticSource {
  if (diagnostic.source === "graph_quality" || diagnostic.source === "execution_readiness") {
    return "graphQuality";
  }
  if (desktopPerformanceDiagnosticCodes.has(diagnostic.code)) {
    return "performance";
  }
  if (hasAnyPrefix(diagnostic.code, packageDiagnosticPrefixes)) {
    return "package";
  }
  if (hasAnyPrefix(diagnostic.code, searchDiagnosticPrefixes)) {
    return "search";
  }
  if (
    runtimeDiagnosticCodes.has(diagnostic.code) ||
    hasAnyPrefix(diagnostic.code, runtimeDiagnosticPrefixes)
  ) {
    return "runtime";
  }
  if (hasAnyPrefix(diagnostic.code, projectDiagnosticPrefixes)) {
    return "project";
  }
  return "other";
}

export function isDesktopPerformanceDiagnostic(diagnostic: Pick<ValidationIssue, "code">): boolean {
  return desktopDiagnosticSource(diagnostic) === "performance";
}

export function groupDesktopDiagnostics(
  diagnostics: DesktopDiagnostic[]
): DesktopDiagnosticGroup[] {
  const grouped: Record<DesktopDiagnosticSource, DesktopDiagnostic[]> = {
    performance: [],
    package: [],
    search: [],
    runtime: [],
    project: [],
    graphQuality: [],
    other: []
  };
  for (const diagnostic of diagnostics) {
    grouped[desktopDiagnosticSource(diagnostic)].push(diagnostic);
  }
  return desktopDiagnosticSourceOrder
    .map((source) => ({ source, diagnostics: grouped[source] }))
    .filter((group) => group.diagnostics.length > 0);
}

function desktopDiagnosticKey(diagnostic: DesktopDiagnostic): string {
  return `${diagnostic.code}\u001f${diagnostic.message}\u001f${diagnostic.path ?? ""}`;
}

export function uniqueDesktopDiagnostics<T extends DesktopDiagnostic>(diagnostics: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const diagnostic of diagnostics) {
    const key = desktopDiagnosticKey(diagnostic);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique;
}
