import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runtimeSchemaTopicOrder } from "@planweave-ai/runtime";
import type {
  DesktopProjectSummary,
  DesktopSearchResultKind,
  GraphEditResult,
  RuntimeSchemaTopicName,
  ValidationIssue,
  ValidationReport
} from "@planweave-ai/runtime";
import type { ExportedPlanPackageFile, SearchProjectArgs } from "./toolTypes.js";

export type ProjectArgs = {
  projectId: string;
};

export type ProjectCanvasArgs = ProjectArgs & {
  canvasId?: string;
};

export type ProjectCanvasNullableArgs = ProjectArgs & {
  canvasId?: string | null;
};

const localPathArgNames = new Set(["rootPath", "projectRoot", "workspaceRoot", "packageDir", "resultsDir", "stateFile"]);
const runtimeSchemaTopicNames = new Set<string>(runtimeSchemaTopicOrder);
const searchResultKinds = new Set<DesktopSearchResultKind>(["task", "block", "prompt", "run_record", "review_attempt", "feedback"]);

export function jsonToolResult(value: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: value,
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function sanitizeProject(project: DesktopProjectSummary) {
  return {
    projectId: project.projectId,
    name: project.name,
    activeCanvasId: project.activeCanvasId,
    taskCanvases: project.taskCanvases
  };
}

export function summarizeGraphEdit(result: GraphEditResult) {
  return {
    ok: result.ok,
    affectedTasks: result.affectedTasks,
    diagnostics: result.diagnostics
  };
}

export function sanitizeValidationIssue(issue: ValidationIssue): ValidationIssue {
  return {
    ...issue,
    message: sanitizeLocalPaths(issue.message),
    path: issue.path === undefined ? undefined : sanitizeLocalPaths(issue.path)
  };
}

export function sanitizeValidationIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.map(sanitizeValidationIssue);
}

export function explainValidationReport(report: ValidationReport) {
  const issues = [
    ...report.errors.map((issue) => ({ severity: "error", ...issue })),
    ...report.warnings.map((issue) => ({ severity: "warning", ...issue }))
  ];
  return {
    ok: report.ok,
    issues,
    explanations: issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      path: issue.path ?? null,
      explanation: issue.message,
      suggestedAction: suggestionForValidationIssue(issue.code, issue.message)
    }))
  };
}

export function readObjectArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments must be an object.");
  }
  return args as Record<string, unknown>;
}

export function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

export function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return nonEmptyString(value, field);
}

export function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  return nonEmptyString(value, field);
}

export function optionalNullableNonEmptyString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return nonEmptyString(value, field);
}

export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value.map((item, index) => nonEmptyString(item, `${field}[${index}]`));
}

export function parseProjectArgs(args: unknown): ProjectArgs {
  const record = readObjectArgs(args);
  return { projectId: nonEmptyString(record.projectId, "projectId") };
}

export function parseProjectCanvasArgs(args: unknown): ProjectCanvasArgs {
  const record = readObjectArgs(args);
  return {
    projectId: nonEmptyString(record.projectId, "projectId"),
    canvasId: optionalNonEmptyString(record.canvasId, "canvasId")
  };
}

export function parseReadonlyProjectCanvasArgs(args: unknown): ProjectCanvasNullableArgs {
  const record = readObjectArgs(args);
  rejectLocalPathArgs(record);
  return {
    projectId: nonEmptyString(record.projectId, "projectId"),
    canvasId: optionalNullableNonEmptyString(record.canvasId, "canvasId")
  };
}

export function parseGetPromptArgs(args: unknown): ProjectCanvasNullableArgs & { ref: string } {
  const record = readObjectArgs(args);
  const { projectId, canvasId } = parseReadonlyProjectCanvasArgs(record);
  return {
    projectId,
    canvasId,
    ref: nonEmptyString(record.ref, "ref")
  };
}

export function parseSearchProjectArgs(args: unknown): { projectId: string; search: SearchProjectArgs } {
  const record = readObjectArgs(args);
  const { projectId, canvasId } = parseReadonlyProjectCanvasArgs(record);
  return {
    projectId,
    search: {
      query: nonEmptyString(record.query, "query"),
      canvasId,
      kinds: parseSearchKinds(record.kinds),
      limit: parseSearchLimit(record.limit)
    }
  };
}

export function blockRefFromArgs(record: Record<string, unknown>): string {
  const blockRef = optionalNonEmptyString(record.blockRef, "blockRef");
  const taskId = optionalNonEmptyString(record.taskId, "taskId");
  const blockId = optionalNonEmptyString(record.blockId, "blockId");
  if (!blockRef && (!taskId || !blockId)) {
    throw new Error("blockRef is required unless taskId and blockId are provided.");
  }
  return blockRef ?? `${taskId}#${blockId}`;
}

export function parseGetSchemaArgs(args: unknown): { topic?: RuntimeSchemaTopicName } {
  if (args === undefined || args === null) {
    return {};
  }
  const record = readObjectArgs(args);
  const topic = record.topic;
  if (topic === undefined || topic === null || topic === "") {
    return {};
  }
  if (typeof topic !== "string" || !isRuntimeSchemaTopic(topic)) {
    throw new Error(`topic must be one of: ${runtimeSchemaTopicOrder.join(", ")}.`);
  }
  return { topic };
}

function isRuntimeSchemaTopic(value: string): value is RuntimeSchemaTopicName {
  return runtimeSchemaTopicNames.has(value);
}

export function parsePackageFiles(value: unknown): ExportedPlanPackageFile[] {
  if (!Array.isArray(value)) {
    throw new Error("files must be an array.");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`files[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    const encoding = record.encoding ?? "utf8";
    if (encoding !== "utf8") {
      throw new Error(`files[${index}].encoding must be utf8.`);
    }
    return {
      path: nonEmptyString(record.path, `files[${index}].path`),
      content: typeof record.content === "string" ? record.content : nonEmptyString(record.content, `files[${index}].content`),
      encoding
    };
  });
}

function rejectLocalPathArgs(record: Record<string, unknown>): void {
  const rejected = Object.keys(record).find((key) => localPathArgNames.has(key));
  if (rejected) {
    throw new Error(`${rejected} is not accepted; use projectId for registered projects.`);
  }
}

export function sanitizeLocalPaths(value: string): string {
  return sanitizeUnixLocalPaths(sanitizeWindowsLocalPaths(value));
}

function sanitizeWindowsLocalPaths(value: string): string {
  return value.replace(/\b[A-Za-z]:\\[^"'`,;)]+/g, (path) => summarizeLocalPath(path.trimEnd()));
}

function sanitizeUnixLocalPaths(value: string): string {
  const unixLocalPathPattern = /(^|[\s"'`(])((?:\/Users|\/home|\/tmp|\/var\/folders|\/private\/tmp|\/sensitive)\/[^"'`,;)]+)/g;
  return value.replace(unixLocalPathPattern, (match, prefix: string, path: string) => {
    const trailingWhitespace = path.match(/\s+$/)?.[0] ?? "";
    return `${prefix}${summarizeLocalPath(path.trimEnd())}${trailingWhitespace}`;
  });
}

function summarizeLocalPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const meaningfulMarkers = ["/canvases/", "/package/", "/results/", "/desktop/"];
  for (const marker of meaningfulMarkers) {
    const index = normalized.indexOf(marker);
    if (index >= 0) {
      return normalized.slice(index + 1);
    }
  }
  const fileMarkers = ["manifest.json", "state.json", "project-graph.json", "canvases.json"];
  for (const marker of fileMarkers) {
    if (normalized.endsWith(`/${marker}`) || normalized.endsWith(marker)) {
      return marker;
    }
  }
  const basename = normalized.split("/").filter(Boolean).at(-1);
  return basename ? `<local-path>/${basename}` : "<local-path>";
}

function parseSearchKinds(value: unknown): DesktopSearchResultKind[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("kinds must be an array.");
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || !searchResultKinds.has(item as DesktopSearchResultKind)) {
      throw new Error(`kinds[${index}] must be one of: task, block, prompt, run_record, review_attempt, feedback.`);
    }
    return item as DesktopSearchResultKind;
  });
}

function parseSearchLimit(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("limit must be an integer from 1 to 100.");
  }
  return value;
}

function suggestionForValidationIssue(code: string, message: string): string {
  if (code.includes("prompt")) {
    return "Use read_prompt and the relevant update_task or update_block promptMarkdown field to repair the missing or invalid prompt content.";
  }
  if (code.includes("dependency") || message.toLowerCase().includes("cycle")) {
    return "Inspect get_project_graph, then use add_dependency or remove_dependency to make the DAG valid.";
  }
  if (code.includes("manifest")) {
    return "Use get_schema and graph edit tools instead of editing manifest structure directly.";
  }
  return "Open the referenced project, inspect the affected task or block, then apply the smallest matching write tool.";
}
