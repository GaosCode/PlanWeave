import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { ProjectWorkspace, ValidationIssue } from "../types.js";
import type { DesktopAutoRunState } from "./types.js";
import {
  compareRunDirectoriesNewestFirst,
  isDesktopRunId,
  runNumber
} from "./autoRunIdReservations.js";

export type PersistedAutoRunStateReadDiagnostic = ValidationIssue;

export type LatestAutoRunStateDiagnosticEntry = {
  runId: string;
  diagnostic: PersistedAutoRunStateReadDiagnostic;
};

export type LatestAutoRunStatePointer = {
  version: 1;
  selectedRunId: string | null;
  selectedUpdatedAt: string | null;
  highestRunId: string | null;
  diagnostics: LatestAutoRunStateDiagnosticEntry[];
};

const latestAutoRunStatePointerFileName = "latest-state.json";

export function autoRunsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.resultsDir, "auto-runs");
}

export function latestAutoRunStatePointerPath(workspace: ProjectWorkspace): string {
  return join(autoRunsRoot(workspace), latestAutoRunStatePointerFileName);
}

export function latestAutoRunStatePointerPathForState(state: DesktopAutoRunState): string {
  return join(dirname(dirname(state.statePath)), latestAutoRunStatePointerFileName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLatestAutoRunStateDiagnosticEntry(
  value: unknown
): LatestAutoRunStateDiagnosticEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const { runId, diagnostic } = value;
  if (typeof runId !== "string" || !isDesktopRunId(runId) || !isRecord(diagnostic)) {
    return null;
  }
  if (
    typeof diagnostic.code !== "string" ||
    typeof diagnostic.message !== "string" ||
    typeof diagnostic.path !== "string"
  ) {
    return null;
  }
  return {
    runId,
    diagnostic: {
      code: diagnostic.code,
      message: diagnostic.message,
      path: diagnostic.path
    }
  };
}

export function parseLatestAutoRunStatePointer(value: unknown): LatestAutoRunStatePointer | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  const selectedRunId =
    typeof value.selectedRunId === "string" && isDesktopRunId(value.selectedRunId)
      ? value.selectedRunId
      : null;
  const selectedUpdatedAt =
    typeof value.selectedUpdatedAt === "string" ? value.selectedUpdatedAt : null;
  const highestRunId =
    typeof value.highestRunId === "string" && isDesktopRunId(value.highestRunId)
      ? value.highestRunId
      : selectedRunId;
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics
        .map(parseLatestAutoRunStateDiagnosticEntry)
        .filter((entry): entry is LatestAutoRunStateDiagnosticEntry => entry !== null)
    : [];
  return {
    version: 1,
    selectedRunId,
    selectedUpdatedAt,
    highestRunId,
    diagnostics
  };
}

export async function readLatestAutoRunStatePointerAt(
  path: string
): Promise<LatestAutoRunStatePointer | null> {
  try {
    return parseLatestAutoRunStatePointer(await readJsonFile<unknown>(path));
  } catch (error) {
    if (isNodeFileNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export async function readLatestAutoRunStatePointer(
  workspace: ProjectWorkspace
): Promise<LatestAutoRunStatePointer | null> {
  return readLatestAutoRunStatePointerAt(latestAutoRunStatePointerPath(workspace));
}

export async function writeLatestAutoRunStatePointerAt(
  path: string,
  pointer: LatestAutoRunStatePointer
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFile(path, pointer);
}

export async function writeLatestAutoRunStatePointer(
  workspace: ProjectWorkspace,
  pointer: LatestAutoRunStatePointer
): Promise<void> {
  await writeLatestAutoRunStatePointerAt(latestAutoRunStatePointerPath(workspace), pointer);
}

export function compareAutoRunStatesNewestFirst(
  left: DesktopAutoRunState,
  right: DesktopAutoRunState
): number {
  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
  if (byUpdatedAt !== 0) {
    return byUpdatedAt;
  }
  return right.runId.localeCompare(left.runId, undefined, { numeric: true });
}

export function maxRunId(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return compareRunDirectoriesNewestFirst(left, right) <= 0 ? left : right;
}

export function isRunIdNewerThan(runId: string, baselineRunId: string | null): boolean {
  if (!baselineRunId) {
    return true;
  }
  const candidateNumber = runNumber(runId);
  const baselineNumber = runNumber(baselineRunId);
  return candidateNumber !== null && baselineNumber !== null
    ? candidateNumber > baselineNumber
    : runId.localeCompare(baselineRunId, undefined, { numeric: true }) > 0;
}

/**
 * Update the latest-state pointer after a state write (read-modify-write).
 * Isolated for CORRECTNESS-08 follow-up; behavior is intentionally unchanged.
 */
export async function updateLatestAutoRunStatePointerAfterWrite(
  state: DesktopAutoRunState
): Promise<void> {
  const pointerPath = latestAutoRunStatePointerPathForState(state);
  const current = await readLatestAutoRunStatePointerAt(pointerPath);
  const currentSelectedRunId = current?.selectedRunId ?? null;
  const currentSelectedUpdatedAt = current?.selectedUpdatedAt ?? null;
  const nextStateIsNewest =
    !currentSelectedRunId ||
    !currentSelectedUpdatedAt ||
    compareAutoRunStatesNewestFirst(state, {
      runId: currentSelectedRunId,
      updatedAt: currentSelectedUpdatedAt
    } as DesktopAutoRunState) < 0;
  const selectedRunId = nextStateIsNewest ? state.runId : currentSelectedRunId;
  await writeLatestAutoRunStatePointerAt(pointerPath, {
    version: 1,
    selectedRunId,
    selectedUpdatedAt: nextStateIsNewest ? state.updatedAt : currentSelectedUpdatedAt,
    highestRunId: maxRunId(current?.highestRunId ?? null, state.runId),
    diagnostics: selectedRunId
      ? (current?.diagnostics ?? []).filter((entry) => isRunIdNewerThan(entry.runId, selectedRunId))
      : (current?.diagnostics ?? [])
  });
}
