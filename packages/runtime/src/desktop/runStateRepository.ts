import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import { readJsonFile } from "../json.js";
import { projectWorkspacePaths } from "../project.js";
import type { ProjectWorkspace } from "../types.js";
import type { DesktopAutoRunEventLog, DesktopAutoRunEventLogDiagnostic, DesktopAutoRunLogEvent, DesktopAutoRunPhase, DesktopAutoRunState } from "./types.js";
import { loadProjectGraphForWorkspace, projectCanvasWorkspace } from "../projectGraph/index.js";
import { autoRunRoot, writeAutoRunState } from "./runStateStore.js";
import { normalizePersistedAutoRunState, recoverPersistedAutoRunState } from "./runRecovery.js";

const desktopRunIdPattern = /^DESKTOP-RUN-(\d{4,})$/;
const autoRunLogEventDataKeys = new Set(["timestamp", "runId", "type", "phase", "stepCount", "currentRef"]);
const desktopAutoRunPhases = ["idle", "running", "pausing", "paused", "manual", "completed", "blocked", "failed", "stopped"] satisfies readonly DesktopAutoRunPhase[];
const desktopAutoRunPhaseSet = new Set<string>(desktopAutoRunPhases);

function autoRunsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.resultsDir, "auto-runs");
}

function autoRunEventLogPath(workspace: ProjectWorkspace, runId: string): string {
  return join(autoRunRoot(workspace, runId), "events.ndjson");
}

function projectsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.planweaveHome, "projects");
}

function globalAutoRunIdsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.planweaveHome, "desktop", "auto-run-ids");
}

function isDesktopRunId(runId: string): boolean {
  return desktopRunIdPattern.test(runId);
}

function runNumber(runId: string): number | null {
  const match = desktopRunIdPattern.exec(runId);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function listRunDirectories(workspace: ProjectWorkspace): Promise<string[]> {
  return listRunDirectoriesAt(autoRunsRoot(workspace));
}

async function listRunDirectoriesAt(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && isDesktopRunId(entry.name)).map((entry) => entry.name);
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
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(projectsRoot(workspace), entry.name));
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
    return loaded.manifest.canvases.map((canvas) => autoRunsRoot(projectCanvasWorkspace(loaded.workspace, canvas)));
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
    for (const canvasAutoRunRoot of await listCanvasAutoRunRoots(workspaceFromRoot(workspace, workspaceRoot))) {
      autoRunRoots.add(canvasAutoRunRoot);
    }
  }
  return [...autoRunRoots];
}

async function listPersistedRunDirectoriesAcrossProjects(workspace: ProjectWorkspace): Promise<string[]> {
  const runIds: string[] = [];
  for (const autoRunDirectory of await listAutoRunRootsAcrossProjects(workspace)) {
    runIds.push(...(await listRunDirectoriesAt(autoRunDirectory)));
  }
  return runIds;
}

function maxRunNumber(runIds: string[]): number {
  return runIds
    .map(runNumber)
    .filter((value): value is number => value !== null)
    .reduce((max, value) => Math.max(max, value), 0);
}

function compareAutoRunStatesNewestFirst(left: DesktopAutoRunState, right: DesktopAutoRunState): number {
  const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
  if (byUpdatedAt !== 0) {
    return byUpdatedAt;
  }
  return right.runId.localeCompare(left.runId, undefined, { numeric: true });
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

function parseAutoRunLogEventLine(line: string, lineNumber: number, path: string, expectedRunId: string): {
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
      issues.push(`currentRef must be a string or null, got ${formatUnknownValue(parsed.currentRef)}`);
    }
  }

  return {
    event,
    diagnostic: issues.length > 0
      ? {
          code: "auto_run_event_log_bad_line",
          message: `Line ${lineNumber} has invalid Auto Run event fields: ${issues.join("; ")}.`,
          line: lineNumber,
          path
        }
      : null
  };
}

export async function nextPersistedAutoRunId(workspace: ProjectWorkspace, options: { isReserved?: (runId: string) => boolean } = {}): Promise<string> {
  await mkdir(autoRunsRoot(workspace), { recursive: true });
  await mkdir(globalAutoRunIdsRoot(workspace), { recursive: true });
  let nextNumber = Math.max(
    maxRunNumber(await listPersistedRunDirectoriesAcrossProjects(workspace)),
    maxRunNumber(await listRunDirectoriesAt(globalAutoRunIdsRoot(workspace)))
  ) + 1;
  while (true) {
    const runId = `DESKTOP-RUN-${String(nextNumber).padStart(4, "0")}`;
    if (options.isReserved?.(runId)) {
      nextNumber += 1;
      continue;
    }
    try {
      await mkdir(join(globalAutoRunIdsRoot(workspace), runId), { recursive: false });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        nextNumber += 1;
        continue;
      }
      throw error;
    }
    try {
      await mkdir(autoRunRoot(workspace, runId), { recursive: false });
      return runId;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        nextNumber += 1;
        continue;
      }
      throw error;
    }
  }
}

export async function readPersistedAutoRunState(workspace: ProjectWorkspace, runId: string, options: { hasActiveLoop?: boolean } = {}): Promise<DesktopAutoRunState | null> {
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

export async function listPersistedAutoRunStates(workspace: ProjectWorkspace, options: { hasActiveLoop?: (runId: string) => boolean } = {}): Promise<DesktopAutoRunState[]> {
  const states: DesktopAutoRunState[] = [];
  for (const runId of await listRunDirectories(workspace)) {
    const state = await readPersistedAutoRunState(workspace, runId, { hasActiveLoop: options.hasActiveLoop?.(runId) ?? false });
    if (state) {
      states.push(state);
    }
  }
  return states.sort(compareAutoRunStatesNewestFirst);
}

export async function writePersistedAutoRunState(state: DesktopAutoRunState): Promise<void> {
  await writeAutoRunState(state);
}

export async function readPersistedAutoRunEventLog(workspace: ProjectWorkspace, runId: string): Promise<DesktopAutoRunEventLog> {
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
