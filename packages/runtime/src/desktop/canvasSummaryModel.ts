import { ZodError } from "zod";
import { compilePackageGraph } from "../graph/compileTaskGraph.js";
import { readJsonFile } from "../json.js";
import { manifestSchema } from "../schema/manifest.js";
import type { PlanPackageManifest, ProjectWorkspace, ValidationIssue } from "../types.js";
import type { DesktopCanvasExecutionPolicy, DesktopTaskCanvasSummary } from "./types.js";
import {
  appendDesktopDiagnostics,
  desktopDiagnostic,
  errorMessage
} from "./graph/desktopDiagnostics.js";

type CanvasSummaryInput = {
  canvasId: string;
  name: string;
  packageDir: string;
  workspace: ProjectWorkspace;
  createdAt: string;
  updatedAt: string;
  extraDiagnostics?: ValidationIssue[];
};

function issue(code: string, message: string, path?: string): ValidationIssue {
  return { code, message, path };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function taskCountFromManifestInput(raw: unknown): number {
  const record = asRecord(raw);
  const nodes = Array.isArray(record?.nodes) ? record.nodes : [];
  return nodes.filter((node) => asRecord(node)?.type === "task").length;
}

function executionPolicyFromManifestInput(raw: unknown): DesktopCanvasExecutionPolicy | null {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return {
    parallelEnabled: parsed.data.execution.parallel.enabled,
    maxConcurrent: parsed.data.execution.parallel.maxConcurrent
  };
}

async function diagnosticsFromManifestInput(
  raw: unknown,
  workspace: ProjectWorkspace
): Promise<ValidationIssue[]> {
  try {
    const manifest = manifestSchema.parse(raw) as PlanPackageManifest;
    const graph = await compilePackageGraph(manifest, workspace.packageDir, {
      validatePromptContents: false
    });
    return [...graph.diagnostics.errors, ...graph.diagnostics.warnings];
  } catch (error) {
    if (error instanceof ZodError) {
      return error.issues.map((zodIssue) =>
        issue(
          "manifest_schema",
          zodIssue.message,
          zodIssue.path.length > 0 ? zodIssue.path.join(".") : "manifest.json"
        )
      );
    }
    return [
      issue(
        "manifest_read_failed",
        error instanceof Error ? error.message : String(error),
        workspace.manifestFile
      )
    ];
  }
}

function taskCountReadFailedDiagnostic(
  workspace: ProjectWorkspace,
  caught: unknown
): ValidationIssue {
  return desktopDiagnostic(
    "desktop_canvas_task_count_read_failed",
    `Canvas task count could not be read: ${errorMessage(caught)}`,
    workspace.manifestFile
  );
}

export async function canvasDiagnosticsFromPackage(
  workspace: ProjectWorkspace
): Promise<ValidationIssue[]> {
  try {
    return await diagnosticsFromManifestInput(
      await readJsonFile<unknown>(workspace.manifestFile),
      workspace
    );
  } catch (error) {
    return [
      issue(
        "manifest_read_failed",
        error instanceof Error ? error.message : String(error),
        workspace.manifestFile
      )
    ];
  }
}

export async function summarizeTaskCanvasFromPackage(
  input: CanvasSummaryInput
): Promise<DesktopTaskCanvasSummary> {
  let taskCount = 0;
  let executionPolicy: DesktopCanvasExecutionPolicy | null = null;
  let diagnostics: ValidationIssue[];
  let taskCountDiagnostics: ValidationIssue[] = [];
  try {
    const raw = await readJsonFile<unknown>(input.workspace.manifestFile);
    taskCount = taskCountFromManifestInput(raw);
    executionPolicy = executionPolicyFromManifestInput(raw);
    diagnostics = await diagnosticsFromManifestInput(raw, input.workspace);
  } catch (caught) {
    diagnostics = [
      issue(
        "manifest_read_failed",
        caught instanceof Error ? caught.message : String(caught),
        input.workspace.manifestFile
      )
    ];
    taskCountDiagnostics = [taskCountReadFailedDiagnostic(input.workspace, caught)];
  }
  appendDesktopDiagnostics(diagnostics, input.extraDiagnostics ?? []);
  appendDesktopDiagnostics(diagnostics, taskCountDiagnostics);
  return {
    canvasId: input.canvasId,
    name: input.name,
    packageDir: input.packageDir,
    executionPolicy,
    taskCount,
    missingPromptCount: diagnostics.filter((diagnostic) => diagnostic.code === "prompt_missing")
      .length,
    diagnostics,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  };
}
