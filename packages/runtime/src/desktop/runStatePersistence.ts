import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import { readJsonFile } from "../json.js";
import { projectWorkspacePaths } from "../project.js";
import type { ProjectWorkspace } from "../types.js";
import type {
  DesktopAutoRunEventLog,
  DesktopAutoRunEventLogDiagnostic,
  DesktopAutoRunLogEvent,
  DesktopAutoRunPhase,
  DesktopAutoRunState
} from "./types.js";
import { loadProjectGraphForWorkspace, projectCanvasWorkspace } from "../projectGraph/index.js";
import { autoRunRoot, writeAutoRunState } from "./runStateStore.js";
import { normalizePersistedAutoRunState, recoverPersistedAutoRunState } from "./runRecovery.js";
import {
  ensureAutoRunIdReservationsMigrated,
  isDesktopRunId,
  maxRunNumber,
  recordReservedAutoRunId,
  reserveAutoRunId
} from "./autoRunIdReservations.js";
import {
  autoRunsRoot,
  compareAutoRunStatesNewestFirst,
  type PersistedAutoRunStateReadDiagnostic,
  updateLatestAutoRunStatePointerAfterWrite
} from "./runStatePointer.js";

export type { PersistedAutoRunStateReadDiagnostic };

export type PersistedAutoRunStateReadResult = {
  state: DesktopAutoRunState | null;
  diagnostics: PersistedAutoRunStateReadDiagnostic[];
};

export type LatestPersistedAutoRunStateResult = PersistedAutoRunStateReadResult;

export type PersistedAutoRunStateListResult = {
  states: DesktopAutoRunState[];
  diagnostics: PersistedAutoRunStateReadDiagnostic[];
};

const autoRunLogEventDataKeys = new Set([
  "timestamp",
  "runId",
  "type",
  "phase",
  "stepCount",
  "currentRef"
]);
const desktopAutoRunPhases = [
  "idle",
  "running",
  "pausing",
  "paused",
  "manual",
  "completed",
  "blocked",
  "failed",
  "stopped"
] satisfies readonly DesktopAutoRunPhase[];
const desktopAutoRunPhaseSet = new Set<string>(desktopAutoRunPhases);

function autoRunEventLogPath(workspace: ProjectWorkspace, runId: string): string {
  return join(autoRunRoot(workspace, runId), "events.ndjson");
}

function projectsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.planweaveHome, "projects");
}

export async function listRunDirectories(workspace: ProjectWorkspace): Promise<string[]> {
  return listRunDirectoriesAt(autoRunsRoot(workspace));
}

export async function listRunDirectoriesAt(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
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

async function listProjectWorkspaceRoots(workspace: ProjectWorkspace): Promise<string[]> {
  try {
    const entries = await readdir(projectsRoot(workspace), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projectsRoot(workspace), entry.name));
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function workspaceFromRoot(workspace: ProjectWorkspace, workspaceRoot: string): ProjectWorkspace {
  return projectWorkspacePaths({
    id: basename(workspaceRoot),
    kind: "managed",
    rootPath: workspaceRoot,
    sourceRoot: null,
    planweaveHome: workspace.planweaveHome,
    workspaceRoot
  });
}

async function listCanvasAutoRunRoots(workspace: ProjectWorkspace): Promise<string[]> {
  try {
    const loaded = await loadProjectGraphForWorkspace(workspace);
    return loaded.manifest.canvases.map((canvas) =>
      autoRunsRoot(projectCanvasWorkspace(loaded.workspace, canvas))
    );
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

async function listAutoRunRootsAcrossProjects(workspace: ProjectWorkspace): Promise<string[]> {
  const autoRunRoots = new Set([autoRunsRoot(workspace)]);
  for (const workspaceRoot of await listProjectWorkspaceRoots(workspace)) {
    autoRunRoots.add(join(workspaceRoot, "results", "auto-runs"));
    for (const canvasAutoRunRoot of await listCanvasAutoRunRoots(
      workspaceFromRoot(workspace, workspaceRoot)
    )) {
      autoRunRoots.add(canvasAutoRunRoot);
    }
  }
  return [...autoRunRoots];
}

async function listPersistedRunDirectoriesAcrossProjects(
  workspace: ProjectWorkspace
): Promise<string[]> {
  const runIds: string[] = [];
  for (const autoRunDirectory of await listAutoRunRootsAcrossProjects(workspace)) {
    runIds.push(...(await listRunDirectoriesAt(autoRunDirectory)));
  }
  return runIds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDesktopAutoRunPhase(value: unknown): value is DesktopAutoRunPhase {
  return typeof value === "string" && desktopAutoRunPhaseSet.has(value);
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function eventData(record: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!autoRunLogEventDataKeys.has(key)) {
      data[key] = value;
    }
  }
  return data;
}

function parseAutoRunLogEventLine(
  line: string,
  lineNumber: number,
  path: string,
  expectedRunId: string
): {
  event: DesktopAutoRunLogEvent | null;
  diagnostic: DesktopAutoRunEventLogDiagnostic | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      event: null,
      diagnostic: {
        code: "auto_run_event_log_bad_line",
        message: `Line ${lineNumber} is not valid JSON: ${detail}`,
        line: lineNumber,
        path
      }
    };
  }

  if (!isRecord(parsed)) {
    return {
      event: null,
      diagnostic: {
        code: "auto_run_event_log_bad_line",
        message: `Line ${lineNumber} is not a JSON object.`,
        line: lineNumber,
        path
      }
    };
  }

  const issues: string[] = [];
  const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
  if (typeof parsed.timestamp !== "string") {
    issues.push(`timestamp must be a string, got ${formatUnknownValue(parsed.timestamp)}`);
  }
  const parsedRunId = typeof parsed.runId === "string" ? parsed.runId : null;
  if (typeof parsed.runId !== "string") {
    issues.push(`runId must be a string, got ${formatUnknownValue(parsed.runId)}`);
  } else if (parsed.runId !== expectedRunId) {
    issues.push(`runId "${parsed.runId}" does not match requested runId "${expectedRunId}"`);
  }
  const type = typeof parsed.type === "string" ? parsed.type : null;
  if (typeof parsed.type !== "string") {
    issues.push(`type must be a string, got ${formatUnknownValue(parsed.type)}`);
  }

  const event: DesktopAutoRunLogEvent = {
    line: lineNumber,
    timestamp,
    runId: parsedRunId,
    type,
    data: eventData(parsed)
  };
  if (parsed.phase !== undefined) {
    if (isDesktopAutoRunPhase(parsed.phase)) {
      event.phase = parsed.phase;
    } else {
      issues.push(`phase must be a DesktopAutoRunPhase, got ${formatUnknownValue(parsed.phase)}`);
    }
  }
  if (parsed.stepCount !== undefined) {
    if (typeof parsed.stepCount === "number" && Number.isFinite(parsed.stepCount)) {
      event.stepCount = parsed.stepCount;
    } else {
      issues.push(`stepCount must be a finite number, got ${formatUnknownValue(parsed.stepCount)}`);
    }
  }
  if (parsed.currentRef !== undefined) {
    if (typeof parsed.currentRef === "string" || parsed.currentRef === null) {
      event.currentRef = parsed.currentRef;
    } else {
      issues.push(
        `currentRef must be a string or null, got ${formatUnknownValue(parsed.currentRef)}`
      );
    }
  }

  return {
    event,
    diagnostic:
      issues.length > 0
        ? {
            code: "auto_run_event_log_bad_line",
            message: `Line ${lineNumber} has invalid Auto Run event fields: ${issues.join("; ")}.`,
            line: lineNumber,
            path
          }
        : null
  };
}

export async function nextPersistedAutoRunId(
  workspace: ProjectWorkspace,
  options: { isReserved?: (runId: string) => boolean } = {}
): Promise<string> {
  await mkdir(autoRunsRoot(workspace), { recursive: true });
  const reservationState = await ensureAutoRunIdReservationsMigrated(workspace, () =>
    listPersistedRunDirectoriesAcrossProjects(workspace)
  );
  let nextNumber =
    maxRunNumber(reservationState.highestRunId ? [reservationState.highestRunId] : []) + 1;
  while (true) {
    const runId = `DESKTOP-RUN-${String(nextNumber).padStart(4, "0")}`;
    if (options.isReserved?.(runId)) {
      nextNumber += 1;
      continue;
    }
    if (!(await reserveAutoRunId(workspace, runId))) {
      nextNumber += 1;
      continue;
    }
    try {
      await mkdir(autoRunRoot(workspace, runId), { recursive: false });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        nextNumber += 1;
        continue;
      }
      throw error;
    }
    try {
      await recordReservedAutoRunId(workspace, runId);
      return runId;
    } catch (error) {
      try {
        await rm(autoRunRoot(workspace, runId), { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Auto Run '${runId}' reservation failed and cleanup did not complete.`
        );
      }
      throw error;
    }
  }
}

export async function readPersistedAutoRunState(
  workspace: ProjectWorkspace,
  runId: string,
  options: { hasActiveLoop?: boolean } = {}
): Promise<DesktopAutoRunState | null> {
  const runRoot = autoRunRoot(workspace, runId);
  const statePath = join(runRoot, "state.json");
  const eventLogPath = join(runRoot, "events.ndjson");
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(statePath);
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  const state = normalizePersistedAutoRunState(raw, { statePath, eventLogPath });
  return state ? recoverPersistedAutoRunState(state, options.hasActiveLoop ?? false) : null;
}

function autoRunStateDiagnostic(
  code: string,
  message: string,
  path: string
): PersistedAutoRunStateReadDiagnostic {
  return { code, message, path };
}

export async function readPersistedAutoRunStateWithDiagnostics(
  workspace: ProjectWorkspace,
  runId: string,
  options: { hasActiveLoop?: boolean } = {}
): Promise<PersistedAutoRunStateReadResult> {
  const runRoot = autoRunRoot(workspace, runId);
  const statePath = join(runRoot, "state.json");
  const eventLogPath = join(runRoot, "events.ndjson");
  let content: string;
  try {
    content = await readFile(statePath, "utf8");
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return {
        state: null,
        diagnostics: [
          autoRunStateDiagnostic(
            "auto_run_state_missing",
            `Auto Run state '${statePath}' does not exist.`,
            statePath
          )
        ]
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      state: null,
      diagnostics: [
        autoRunStateDiagnostic(
          "auto_run_state_read_failed",
          `Failed to read Auto Run state '${statePath}': ${detail}`,
          statePath
        )
      ]
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      state: null,
      diagnostics: [
        autoRunStateDiagnostic(
          "auto_run_state_invalid_json",
          `Auto Run state '${statePath}' is not valid JSON: ${detail}`,
          statePath
        )
      ]
    };
  }

  const state = normalizePersistedAutoRunState(raw, { statePath, eventLogPath });
  if (!state) {
    return {
      state: null,
      diagnostics: [
        autoRunStateDiagnostic(
          "auto_run_state_invalid",
          `Auto Run state '${statePath}' is not a valid persisted Auto Run state.`,
          statePath
        )
      ]
    };
  }
  return {
    state: recoverPersistedAutoRunState(state, options.hasActiveLoop ?? false),
    diagnostics: []
  };
}

export async function listPersistedAutoRunStates(
  workspace: ProjectWorkspace,
  options: { hasActiveLoop?: (runId: string) => boolean } = {}
): Promise<DesktopAutoRunState[]> {
  return (await listPersistedAutoRunStatesWithDiagnostics(workspace, options)).states;
}

export async function listPersistedAutoRunStatesWithDiagnostics(
  workspace: ProjectWorkspace,
  options: { hasActiveLoop?: (runId: string) => boolean } = {}
): Promise<PersistedAutoRunStateListResult> {
  const states: DesktopAutoRunState[] = [];
  const diagnostics: PersistedAutoRunStateReadDiagnostic[] = [];
  for (const runId of await listRunDirectories(workspace)) {
    const result = await readPersistedAutoRunStateWithDiagnostics(workspace, runId, {
      hasActiveLoop: options.hasActiveLoop?.(runId) ?? false
    });
    diagnostics.push(...result.diagnostics);
    if (result.state) {
      states.push(result.state);
    }
  }
  return {
    states: states.sort(compareAutoRunStatesNewestFirst),
    diagnostics
  };
}

export async function writePersistedAutoRunState(state: DesktopAutoRunState): Promise<void> {
  await writeAutoRunState(state);
  await updateLatestAutoRunStatePointerAfterWrite(state);
}

export async function readPersistedAutoRunEventLog(
  workspace: ProjectWorkspace,
  runId: string
): Promise<DesktopAutoRunEventLog> {
  if (!isDesktopRunId(runId)) {
    const path = autoRunsRoot(workspace);
    return {
      runId,
      events: [],
      diagnostics: [
        {
          code: "auto_run_event_log_read_failed",
          message: `Invalid Auto Run runId '${runId}'. Expected format DESKTOP-RUN-0001 or another DESKTOP-RUN id with at least four digits.`,
          path
        }
      ]
    };
  }
  const path = autoRunEventLogPath(workspace, runId);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return {
        runId,
        events: [],
        diagnostics: [
          {
            code: "auto_run_event_log_missing",
            message: `Auto Run event log '${path}' does not exist.`,
            path
          }
        ]
      };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      runId,
      events: [],
      diagnostics: [
        {
          code: "auto_run_event_log_read_failed",
          message: `Failed to read Auto Run event log '${path}': ${detail}`,
          path
        }
      ]
    };
  }

  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  if (lines.length > 0 && (content.endsWith("\n") || content.endsWith("\r\n"))) {
    lines.pop();
  }

  const events: DesktopAutoRunLogEvent[] = [];
  const diagnostics: DesktopAutoRunEventLogDiagnostic[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const parsed = parseAutoRunLogEventLine(line, lineNumber, path, runId);
    if (parsed.event) {
      events.push(parsed.event);
    }
    if (parsed.diagnostic) {
      diagnostics.push(parsed.diagnostic);
    }
  }

  return { runId, events, diagnostics };
}
