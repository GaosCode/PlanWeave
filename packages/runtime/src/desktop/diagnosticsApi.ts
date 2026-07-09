import { validateExecutionReadiness } from "../graph/executionReadiness.js";
import { validateGraphQuality } from "../graph/validateGraphQuality.js";
import type {
  ExecutionReadinessDiagnostic,
  GraphQualityDiagnostic,
  PackageWorkspaceRef
} from "../types.js";
import type { DesktopGraphDiagnosticIssue, DesktopGraphDiagnostics } from "./types/graphTypes.js";

function pathFromIds(ids: string[] | undefined): string | undefined {
  return ids && ids.length > 0 ? ids.slice(0, 5).join(", ") : undefined;
}

function graphQualityDiagnostic(diagnostic: GraphQualityDiagnostic): DesktopGraphDiagnosticIssue {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    path: pathFromIds(diagnostic.affectedIds),
    source: "graph_quality",
    severity: diagnostic.severity,
    ruleType: diagnostic.ruleType,
    affectedIds: diagnostic.affectedIds,
    suggestedTool: diagnostic.suggestedTool,
    fixId: diagnostic.fixId
  };
}

function executionReadinessDiagnostic(
  diagnostic: ExecutionReadinessDiagnostic
): DesktopGraphDiagnosticIssue {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    path: pathFromIds(diagnostic.affectedRefs),
    source: "execution_readiness",
    severity: diagnostic.severity,
    affectedIds: diagnostic.affectedRefs,
    suggestedTool: diagnostic.suggestedTool
  };
}

export async function getDesktopGraphDiagnostics(
  projectRoot: PackageWorkspaceRef
): Promise<DesktopGraphDiagnostics> {
  const [graphQuality, executionReadiness] = await Promise.all([
    validateGraphQuality({ projectRoot }),
    validateExecutionReadiness({ projectRoot })
  ]);
  return {
    graphQuality,
    executionReadiness,
    diagnostics: [
      ...graphQuality.diagnostics.map(graphQualityDiagnostic),
      ...executionReadiness.diagnostics.map(executionReadinessDiagnostic)
    ]
  };
}
