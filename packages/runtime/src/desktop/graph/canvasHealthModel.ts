import type { TaskStatus, ValidationIssue } from "../../types.js";
import type {
  DesktopCanvasHealth,
  DesktopCanvasHealthBlockedBlock,
  DesktopCanvasHealthBlocker,
  DesktopCanvasHealthCanvasSummary,
  DesktopCanvasHealthEdgeSummary,
  DesktopCanvasHealthSeverity
} from "../types.js";
import type { ProjectTodoContext } from "./todoModel.js";

type DiagnosticLevel = "error" | "warning";

function diagnosticKey(diagnostic: ValidationIssue): string {
  return [diagnostic.code, diagnostic.path ?? "", diagnostic.message].join("\u001f");
}

function uniqueDiagnostics(diagnostics: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function diagnosticMentionsCanvas(diagnostic: ValidationIssue, canvasId: string): boolean {
  if (diagnostic.path === canvasId) {
    return true;
  }
  return (
    diagnostic.message.includes(`'${canvasId}'`) ||
    diagnostic.message.includes(`${canvasId}::`) ||
    diagnostic.message.includes(`::${canvasId}`) ||
    diagnostic.message.includes(`canvas '${canvasId}'`)
  );
}

function diagnosticLevel(diagnostic: ValidationIssue, errorKeys: Set<string>): DiagnosticLevel {
  return errorKeys.has(diagnosticKey(diagnostic)) ? "error" : "warning";
}

function maxSeverity(
  current: DesktopCanvasHealthSeverity,
  next: DesktopCanvasHealthSeverity
): DesktopCanvasHealthSeverity {
  if (current === "error" || next === "error") {
    return "error";
  }
  if (current === "warning" || next === "warning") {
    return "warning";
  }
  return "ok";
}

function splitProjectBlockerRef(
  ref: string
):
  | { kind: "canvas"; canvasId: string }
  | { kind: "task"; canvasId: string; taskId: string }
  | null {
  if (ref.startsWith("canvas:")) {
    const canvasId = ref.slice("canvas:".length);
    return canvasId ? { kind: "canvas", canvasId } : null;
  }
  const separatorIndex = ref.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === ref.length - 1) {
    return null;
  }
  return {
    kind: "task",
    canvasId: ref.slice(0, separatorIndex),
    taskId: ref.slice(separatorIndex + 1)
  };
}

function taskTitle(context: ProjectTodoContext, canvasId: string, taskId: string): string {
  return (
    context.snapshotsByCanvas.get(canvasId)?.runtime?.graph.tasksById.get(taskId)?.title ?? taskId
  );
}

function taskStatus(context: ProjectTodoContext, canvasId: string, taskId: string): TaskStatus {
  return (
    context.aggregation.runtimeSnapshotsByCanvas.get(canvasId)?.taskStatusById.get(taskId) ??
    "planned"
  );
}

function canvasTitle(context: ProjectTodoContext, canvasId: string): string {
  return context.aggregation.canvasesById.get(canvasId)?.canvasName ?? canvasId;
}

function projectBlockerFromRef(
  context: ProjectTodoContext,
  rawRef: string
): DesktopCanvasHealthBlocker | null {
  const parsed = splitProjectBlockerRef(rawRef);
  if (!parsed) {
    return null;
  }
  if (parsed.kind === "canvas") {
    return {
      kind: "canvas",
      canvasId: parsed.canvasId,
      canvasTitle: canvasTitle(context, parsed.canvasId)
    };
  }
  return {
    kind: "task",
    canvasId: parsed.canvasId,
    canvasTitle: canvasTitle(context, parsed.canvasId),
    taskId: parsed.taskId,
    taskTitle: taskTitle(context, parsed.canvasId, parsed.taskId),
    status: taskStatus(context, parsed.canvasId, parsed.taskId)
  };
}

function blockedBlocks(context: ProjectTodoContext): DesktopCanvasHealthBlockedBlock[] {
  const result: DesktopCanvasHealthBlockedBlock[] = [];
  for (const canvasId of context.aggregation.orderedCanvasIds) {
    const snapshot = context.snapshotsByCanvas.get(canvasId);
    if (!snapshot?.status || !snapshot.runtime) {
      continue;
    }
    const blockStatusByRef = new Map(
      snapshot.status.blocks.map((block) => [block.ref, block.status])
    );
    for (const hint of snapshot.status.claimHints) {
      const status = blockStatusByRef.get(hint.ref);
      if (hint.blockedByProject.length === 0 || status !== "ready") {
        continue;
      }
      const block = snapshot.runtime.graph.blocksByRef.get(hint.ref);
      const blockers = hint.blockedByProject.flatMap((rawRef) => {
        const blocker = projectBlockerFromRef(context, rawRef);
        return blocker ? [blocker] : [];
      });
      if (blockers.length === 0) {
        continue;
      }
      result.push({
        blocked: {
          canvasId,
          canvasTitle: canvasTitle(context, canvasId),
          taskId: hint.taskId,
          taskTitle: taskTitle(context, canvasId, hint.taskId),
          blockRef: hint.ref,
          blockId: hint.blockId,
          blockTitle: block?.title ?? hint.ref,
          status
        },
        blockers,
        reason:
          hint.statusReason ??
          `Project graph blockers are not complete: ${hint.blockedByProject.join(", ")}.`
      });
    }
  }
  return result;
}

function canvasSummaries(
  context: ProjectTodoContext,
  diagnostics: ValidationIssue[],
  errorKeys: Set<string>,
  blocked: DesktopCanvasHealthBlockedBlock[]
): DesktopCanvasHealthCanvasSummary[] {
  return context.aggregation.graph.canvasIdsInOrder.map((canvasId) => {
    const diagnosticCount =
      (context.aggregation.canvasesById.get(canvasId)?.canvas.diagnostics.length ?? 0) +
      diagnostics.filter((diagnostic) => diagnosticMentionsCanvas(diagnostic, canvasId)).length;
    const blockerCount = blocked.filter((item) => item.blocked.canvasId === canvasId).length;
    const hasError = diagnostics.some(
      (diagnostic) =>
        diagnosticMentionsCanvas(diagnostic, canvasId) &&
        diagnosticLevel(diagnostic, errorKeys) === "error"
    );
    return {
      canvasId,
      severity: hasError ? "error" : diagnosticCount > 0 || blockerCount > 0 ? "warning" : "ok",
      blockerCount,
      diagnosticCount
    };
  });
}

function edgeKey(from: string, to: string, type: "depends_on"): string {
  return `${from}\u001f${to}\u001f${type}`;
}

function edgeSummaries(
  context: ProjectTodoContext,
  diagnostics: ValidationIssue[],
  errorKeys: Set<string>,
  blocked: DesktopCanvasHealthBlockedBlock[]
): DesktopCanvasHealthEdgeSummary[] {
  return context.aggregation.graph.manifest.edges.map((edge) => {
    const edgeDiagnostics = diagnostics.filter(
      (diagnostic) =>
        diagnostic.path === "edges" &&
        diagnostic.message.includes(edge.from) &&
        diagnostic.message.includes(edge.to)
    );
    const blockerCount = blocked.filter(
      (item) =>
        item.blocked.canvasId === edge.from &&
        item.blockers.some((blocker) => blocker.canvasId === edge.to)
    ).length;
    const hasError = edgeDiagnostics.some(
      (diagnostic) => diagnosticLevel(diagnostic, errorKeys) === "error"
    );
    return {
      from: edge.from,
      to: edge.to,
      type: edge.type,
      severity: hasError
        ? "error"
        : edgeDiagnostics.length > 0 || blockerCount > 0
          ? "warning"
          : "ok",
      blockerCount,
      diagnosticCount: edgeDiagnostics.length
    };
  });
}

export function buildCanvasHealth(context: ProjectTodoContext): DesktopCanvasHealth {
  const errorDiagnostics = context.aggregation.graph.diagnostics.errors;
  const warningDiagnostics = context.aggregation.graph.diagnostics.warnings;
  const diagnostics = uniqueDiagnostics([
    ...errorDiagnostics,
    ...warningDiagnostics,
    ...context.diagnostics
  ]);
  const errorKeys = new Set([...errorDiagnostics, ...context.diagnostics].map(diagnosticKey));
  const blocked = blockedBlocks(context);
  const canvases = canvasSummaries(context, diagnostics, errorKeys, blocked);
  const edgeSummaryByKey = new Map(
    edgeSummaries(context, diagnostics, errorKeys, blocked).map((edge) => [
      edgeKey(edge.from, edge.to, edge.type),
      edge
    ])
  );
  const edges = context.aggregation.graph.manifest.edges.map((edge) => {
    const summary = edgeSummaryByKey.get(edgeKey(edge.from, edge.to, edge.type));
    if (!summary) {
      throw new Error(`Canvas health edge summary missing for '${edge.from}' -> '${edge.to}'.`);
    }
    return summary;
  });
  const diagnosticSeverity = diagnostics.reduce<DesktopCanvasHealthSeverity>(
    (severity, diagnostic) =>
      maxSeverity(
        severity,
        diagnosticLevel(diagnostic, errorKeys) === "error" ? "error" : "warning"
      ),
    "ok"
  );
  const blockerSeverity: DesktopCanvasHealthSeverity = blocked.length > 0 ? "warning" : "ok";
  return {
    severity: maxSeverity(diagnosticSeverity, blockerSeverity),
    canvases,
    edges,
    blockedBlocks: blocked,
    diagnostics
  };
}
