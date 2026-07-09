import type { DesktopCanvasReference } from "@planweave-ai/runtime";
import type { DesktopDiagnostic } from "./diagnostics";
import type { TranslationKey } from "./i18n";

type CopyFixId =
  | "add_review_blocks"
  | "connect_review_blocks_to_implementation"
  | "add_implementation_blocks"
  | "enable_review_feedback_cycles"
  | "add_canvas_gate_task"
  | "connect_canvas_gate_dependencies";

export type DiagnosticFixAction =
  | {
      kind: "apply";
      id: "apply_canvas_lane_layout";
      labelKey: TranslationKey;
      run(): Promise<void>;
    }
  | {
      kind: "copy";
      id: CopyFixId;
      labelKey: TranslationKey;
      command: string;
      run(): Promise<void>;
    };

export type DiagnosticFixContext = {
  projectId: string | null;
  projectRoot: string | null;
  canvasId: string | null;
  applyCanvasLaneLayout: (ref: DesktopCanvasReference) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  refreshProjectDerivedState: () => Promise<void>;
  setError: (message: string | null) => void;
};

const copyFixTools = {
  add_review_blocks: "create_block",
  connect_review_blocks_to_implementation: "set_block_dependencies",
  add_implementation_blocks: "create_block",
  enable_review_feedback_cycles: "update_review_pipeline",
  add_canvas_gate_task: "create_task",
  connect_canvas_gate_dependencies: "bulk_add_task_dependencies"
} satisfies Record<CopyFixId, string>;

function hasExplicitCanvasContext(
  context: DiagnosticFixContext
): context is DiagnosticFixContext & {
  projectRoot: string;
  canvasId: string;
} {
  return Boolean(context.projectRoot?.trim() && context.canvasId?.trim());
}

function hasCopyContext(context: DiagnosticFixContext): context is DiagnosticFixContext & {
  projectId: string;
  canvasId: string;
} {
  return Boolean(context.projectId?.trim() && context.canvasId?.trim());
}

function affectedIds(diagnostic: DesktopDiagnostic): string[] {
  return Array.isArray(diagnostic.affectedIds)
    ? diagnostic.affectedIds.filter((id) => typeof id === "string" && id.trim().length > 0)
    : [];
}

function isCopyFixId(fixId: string): fixId is CopyFixId {
  return fixId in copyFixTools;
}

function copyCommandFor(
  diagnostic: DesktopDiagnostic,
  context: DiagnosticFixContext & { projectId: string; canvasId: string },
  fixId: CopyFixId,
  ids: string[]
): string {
  const tool = diagnostic.suggestedTool?.trim() || copyFixTools[fixId];
  const lines = [
    `PlanWeave MCP tool: ${tool}`,
    `projectId: ${context.projectId}`,
    `canvasId: ${context.canvasId}`,
    `fixId: ${fixId}`,
    `diagnosticCode: ${diagnostic.code}`
  ];
  lines.push(`affectedIds: ${ids.join(", ")}`);
  return lines.join("\n");
}

export function diagnosticFixActionFor(
  diagnostic: DesktopDiagnostic,
  context: DiagnosticFixContext
): DiagnosticFixAction | null {
  if (!diagnostic.fixId) {
    return null;
  }

  if (diagnostic.fixId === "apply_canvas_lane_layout") {
    if (!hasExplicitCanvasContext(context)) {
      return null;
    }
    return {
      kind: "apply",
      id: diagnostic.fixId,
      labelKey: "diagnosticApplyFix",
      run: async () => {
        context.setError(null);
        await context.applyCanvasLaneLayout({
          projectRoot: context.projectRoot,
          canvasId: context.canvasId
        });
        await context.refreshProjectDerivedState();
      }
    };
  }

  if (isCopyFixId(diagnostic.fixId)) {
    if (!hasCopyContext(context)) {
      return null;
    }
    const fixId = diagnostic.fixId;
    const ids = affectedIds(diagnostic);
    if (ids.length === 0) {
      return null;
    }
    const command = copyCommandFor(diagnostic, context, fixId, ids);
    return {
      kind: "copy",
      id: fixId,
      labelKey: "diagnosticCopyCommand",
      command,
      run: async () => context.copyText(command)
    };
  }

  return null;
}
