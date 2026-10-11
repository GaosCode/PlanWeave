import {
  parsePlanGraphCommand,
  parsePlanGraphCommandArrayOrSingle,
  PlanGraphOperationLogParseError,
  planGraphCommandIssueSummary
} from "../commandSchema.js";
import type { PlanGraphAffectedRefs, PlanGraphCommand } from "../commands.js";
import type { PlanGraphOperationLogEntry } from "../ports.js";
import type { PackageWorkspaceRef, ProjectWorkspace } from "../../types.js";
import { operationLogWorkspaceRef } from "./workspaceRef.js";
import {
  jsonString,
  nullableStringColumn,
  numberColumn,
  parseJsonRecord,
  stringColumn
} from "./columns.js";

export type OperationLogCoalescingEntry = {
  id: number;
  workspaceRef: PackageWorkspaceRef;
  command: PlanGraphCommand;
  affected: PlanGraphAffectedRefs;
};

function parseAffected(value: string): PlanGraphAffectedRefs {
  return parseJsonRecord(value, "affected_json") as PlanGraphAffectedRefs;
}

function operationLogJson(
  row: Record<string, unknown>,
  fieldName: "command_json" | "inverse_json"
): unknown {
  const operationId = numberColumn(row, "id");
  try {
    return JSON.parse(stringColumn(row, fieldName));
  } catch (error) {
    throw new PlanGraphOperationLogParseError({
      operationId,
      fieldName,
      issueSummary: planGraphCommandIssueSummary(error)
    });
  }
}

function operationLogCommand(row: Record<string, unknown>): PlanGraphCommand {
  const operationId = numberColumn(row, "id");
  try {
    return parsePlanGraphCommand(operationLogJson(row, "command_json"));
  } catch (error) {
    if (error instanceof PlanGraphOperationLogParseError) {
      throw error;
    }
    throw new PlanGraphOperationLogParseError({
      operationId,
      fieldName: "command_json",
      issueSummary: planGraphCommandIssueSummary(error)
    });
  }
}

function operationLogInverse(row: Record<string, unknown>): PlanGraphCommand | PlanGraphCommand[] {
  const operationId = numberColumn(row, "id");
  try {
    return parsePlanGraphCommandArrayOrSingle(operationLogJson(row, "inverse_json"));
  } catch (error) {
    if (error instanceof PlanGraphOperationLogParseError) {
      throw error;
    }
    throw new PlanGraphOperationLogParseError({
      operationId,
      fieldName: "inverse_json",
      issueSummary: planGraphCommandIssueSummary(error)
    });
  }
}

export async function operationLogEntry(
  row: Record<string, unknown>,
  workspace: ProjectWorkspace
): Promise<PlanGraphOperationLogEntry> {
  return {
    id: numberColumn(row, "id"),
    workspaceRef: await operationLogWorkspaceRef(row, workspace),
    graphVersionBefore: stringColumn(row, "graph_version_before"),
    graphVersionAfter: stringColumn(row, "graph_version_after"),
    command: operationLogCommand(row),
    inverse: operationLogInverse(row),
    affected: parseAffected(stringColumn(row, "affected_json")),
    createdAt: stringColumn(row, "created_at"),
    undoneAt: nullableStringColumn(row, "undone_at")
  };
}

async function operationLogCoalescingEntry(
  row: Record<string, unknown>,
  workspace: ProjectWorkspace
): Promise<OperationLogCoalescingEntry> {
  return {
    id: numberColumn(row, "id"),
    workspaceRef: await operationLogWorkspaceRef(row, workspace),
    command: operationLogCommand(row),
    affected: parseAffected(stringColumn(row, "affected_json"))
  };
}

export async function tryOperationLogCoalescingEntry(
  row: Record<string, unknown>,
  workspace: ProjectWorkspace
): Promise<OperationLogCoalescingEntry | null> {
  try {
    return await operationLogCoalescingEntry(row, workspace);
  } catch {
    return null;
  }
}

export function promptHistoryTarget(command: PlanGraphCommand): string | null {
  if (command.type === "updateTaskPrompt") {
    return `task:${command.taskId}`;
  }
  if (command.type === "updateBlockPrompt") {
    return `block:${command.blockRef}`;
  }
  if (
    command.type === "updateTaskFields" &&
    command.fields.promptMarkdown !== undefined &&
    command.fields.title === undefined &&
    command.fields.executor === undefined &&
    command.fields.acceptance === undefined
  ) {
    return `task:${command.taskId}`;
  }
  if (
    command.type === "updateBlockFields" &&
    command.fields.promptMarkdown !== undefined &&
    command.fields.title === undefined &&
    command.fields.executor === undefined &&
    command.fields.dependsOn === undefined &&
    command.fields.sharedResources === undefined &&
    command.fields.requiredCapabilities === undefined &&
    command.fields.reviewRequired === undefined &&
    command.fields.maxFeedbackCycles === undefined &&
    command.fields.reviewHook === undefined
  ) {
    return `block:${command.blockRef}`;
  }
  return null;
}

export function mergeAffectedRefs(
  left: PlanGraphAffectedRefs,
  right: PlanGraphAffectedRefs
): PlanGraphAffectedRefs {
  return {
    canvases: [...new Set([...left.canvases, ...right.canvases])],
    tasks: [...new Set([...left.tasks, ...right.tasks])],
    blocks: [...new Set([...left.blocks, ...right.blocks])],
    prompts: [...new Set([...left.prompts, ...right.prompts])],
    packageFiles: [...new Set([...left.packageFiles, ...right.packageFiles])]
  };
}

export function sameWorkspaceRef(left: PackageWorkspaceRef, right: PackageWorkspaceRef): boolean {
  return jsonString(left) === jsonString(right);
}
