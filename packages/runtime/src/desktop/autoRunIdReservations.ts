import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";

const desktopRunIdPattern = /^DESKTOP-RUN-(\d{4,})$/;
const autoRunIdReservationIndexFileName = "index.json";

export type AutoRunIdReservationState = {
  version: 1;
  highestRunId: string | null;
  migratedAt: string | null;
};

export function globalAutoRunIdsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.planweaveHome, "desktop", "auto-run-ids");
}

export function isDesktopRunId(runId: string): boolean {
  return desktopRunIdPattern.test(runId);
}

export function runNumber(runId: string): number | null {
  const match = desktopRunIdPattern.exec(runId);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function maxRunNumber(runIds: string[]): number {
  return runIds
    .map(runNumber)
    .filter((value): value is number => value !== null)
    .reduce((max, value) => Math.max(max, value), 0);
}

export function compareRunDirectoriesNewestFirst(left: string, right: string): number {
  const leftNumber = runNumber(left) ?? 0;
  const rightNumber = runNumber(right) ?? 0;
  if (leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }
  return right.localeCompare(left, undefined, { numeric: true });
}

export function highestRunId(runIds: string[]): string | null {
  return [...runIds].sort(compareRunDirectoriesNewestFirst).at(0) ?? null;
}

function autoRunIdReservationIndexPath(workspace: ProjectWorkspace): string {
  return join(globalAutoRunIdsRoot(workspace), autoRunIdReservationIndexFileName);
}

function parseAutoRunIdReservationState(value: unknown): AutoRunIdReservationState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }
  const highestRunId =
    record.highestRunId === null ||
    (typeof record.highestRunId === "string" && isDesktopRunId(record.highestRunId))
      ? record.highestRunId
      : null;
  if (record.highestRunId !== null && highestRunId === null) {
    return null;
  }
  const migratedAt =
    record.migratedAt === null || typeof record.migratedAt === "string" ? record.migratedAt : null;
  if (record.migratedAt !== null && migratedAt === null) {
    return null;
  }
  return {
    version: 1,
    highestRunId,
    migratedAt
  };
}

async function readAutoRunIdReservationState(
  workspace: ProjectWorkspace
): Promise<AutoRunIdReservationState | null> {
  try {
    return parseAutoRunIdReservationState(
      await readJsonFile<unknown>(autoRunIdReservationIndexPath(workspace))
    );
  } catch (error) {
    if (isNodeFileNotFoundError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function writeAutoRunIdReservationState(
  workspace: ProjectWorkspace,
  state: AutoRunIdReservationState
): Promise<void> {
  await writeJsonFile(autoRunIdReservationIndexPath(workspace), state);
}

async function listAutoRunIdReservationDirectories(workspace: ProjectWorkspace): Promise<string[]> {
  try {
    const entries = await readdir(globalAutoRunIdsRoot(workspace), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isDesktopRunId(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function reserveExistingRunId(workspace: ProjectWorkspace, runId: string): Promise<void> {
  try {
    await mkdir(join(globalAutoRunIdsRoot(workspace), runId), { recursive: false });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

async function repairAutoRunIdReservationsFromLegacyRuns(
  workspace: ProjectWorkspace,
  scanLegacyRunIds: () => Promise<string[]>
): Promise<AutoRunIdReservationState> {
  await mkdir(globalAutoRunIdsRoot(workspace), { recursive: true });
  const legacyRunIds = (await scanLegacyRunIds()).filter(isDesktopRunId);
  const reservationRunIds = await listAutoRunIdReservationDirectories(workspace);
  const runIds = [...new Set([...legacyRunIds, ...reservationRunIds])];
  for (const runId of runIds.sort(compareRunDirectoriesNewestFirst).reverse()) {
    await reserveExistingRunId(workspace, runId);
  }
  const state: AutoRunIdReservationState = {
    version: 1,
    highestRunId: highestRunId(runIds),
    migratedAt: new Date().toISOString()
  };
  await writeAutoRunIdReservationState(workspace, state);
  return state;
}

export async function ensureAutoRunIdReservationsMigrated(
  workspace: ProjectWorkspace,
  scanLegacyRunIds: () => Promise<string[]>
): Promise<AutoRunIdReservationState> {
  await mkdir(globalAutoRunIdsRoot(workspace), { recursive: true });
  const state = await readAutoRunIdReservationState(workspace);
  if (!state) {
    return repairAutoRunIdReservationsFromLegacyRuns(workspace, scanLegacyRunIds);
  }

  const reservationRunIds = await listAutoRunIdReservationDirectories(workspace);
  const highestReservedRunId = highestRunId(reservationRunIds);
  const highestKnownRunId = highestRunId(
    [state.highestRunId, highestReservedRunId].filter((runId): runId is string => runId !== null)
  );
  if (highestKnownRunId !== state.highestRunId) {
    const repairedState: AutoRunIdReservationState = {
      ...state,
      highestRunId: highestKnownRunId
    };
    await writeAutoRunIdReservationState(workspace, repairedState);
    return repairedState;
  }
  return state;
}

export async function reserveAutoRunId(
  workspace: ProjectWorkspace,
  runId: string
): Promise<boolean> {
  try {
    await mkdir(join(globalAutoRunIdsRoot(workspace), runId), { recursive: false });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

export async function recordReservedAutoRunId(
  workspace: ProjectWorkspace,
  runId: string
): Promise<void> {
  const state = await readAutoRunIdReservationState(workspace);
  const reservationRunIds = await listAutoRunIdReservationDirectories(workspace);
  const nextHighestRunId = highestRunId(
    [state?.highestRunId ?? null, highestRunId(reservationRunIds), runId].filter(
      (candidate): candidate is string => candidate !== null
    )
  );
  await writeAutoRunIdReservationState(workspace, {
    version: 1,
    highestRunId: nextHighestRunId,
    migratedAt: state?.migratedAt ?? new Date().toISOString()
  });
}
