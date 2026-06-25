import { constants } from "node:fs";
import { access, appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePackageWorkspace } from "../package/loadPackage.js";
import { commandCanvasIdForWorkspace } from "../taskManager/canvasCommandScope.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type {
  CreateRunSessionOptions,
  ListRunSessionsResult,
  RunSessionDetail,
  RunSessionDiagnostic,
  RunSessionEvent,
  RunSessionPhase,
  RunSessionState,
  UpdateRunSessionPatch
} from "./types.js";
import type { PackageWorkspaceRef, ProjectWorkspace } from "../types.js";

const sessionIdPattern = /^SESSION-(\d{4,})$/;
const runSessionKinds = new Set(["run", "reset"]);
const runSessionTriggers = new Set(["manual", "cron", "desktop", "api"]);
const runSessionPhases = new Set(["created", "resetting", "running", "completed", "manual", "blocked", "failed", "stopped"]);
const autoRunStopReasons = new Set(["none", "once", "step_limit", "no_steps"]);

export function assertValidRunSessionId(sessionId: string): void {
  if (!sessionIdPattern.test(sessionId)) {
    throw new Error(`Invalid run session id '${sessionId}'. Expected format SESSION-0001.`);
  }
}

function runSessionsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.resultsDir, "run-sessions");
}

function sessionRoot(workspace: ProjectWorkspace, sessionId: string): string {
  return join(runSessionsRoot(workspace), sessionId);
}

function sessionSummaryPath(workspace: ProjectWorkspace, sessionId: string): string {
  return join(sessionRoot(workspace, sessionId), "session.json");
}

function sessionEventsPath(workspace: ProjectWorkspace, sessionId: string): string {
  return join(sessionRoot(workspace, sessionId), "events.ndjson");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveSessionWorkspace(projectRoot: PackageWorkspaceRef): Promise<ProjectWorkspace> {
  return resolvePackageWorkspace(projectRoot);
}

async function canvasIdForWorkspace(workspace: ProjectWorkspace): Promise<string> {
  return (await commandCanvasIdForWorkspace(workspace)) ?? "default";
}

async function listExistingSessionIds(workspace: ProjectWorkspace): Promise<string[]> {
  const root = runSessionsRoot(workspace);
  if (!(await exists(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && sessionIdPattern.test(entry.name)).map((entry) => entry.name);
}

function nextSessionId(existing: string[]): string {
  const highest = existing.reduce((max, sessionId) => {
    const match = sessionIdPattern.exec(sessionId);
    return match ? Math.max(max, Number.parseInt(match[1], 10)) : max;
  }, 0);
  return `SESSION-${String(highest + 1).padStart(4, "0")}`;
}

function nextSessionIdAfter(sessionId: string): string {
  const match = sessionIdPattern.exec(sessionId);
  const current = match ? Number.parseInt(match[1], 10) : 0;
  return `SESSION-${String(current + 1).padStart(4, "0")}`;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidSessionDiagnostic(sessionId: string, path: string, message: string): RunSessionDiagnostic {
  return { code: "run_session_invalid", sessionId, path, message };
}

function isRunSessionScope(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "project") {
    return true;
  }
  if (value.kind === "task") {
    return typeof value.taskId === "string" && value.taskId.length > 0;
  }
  if (value.kind === "block") {
    return typeof value.blockRef === "string" && value.blockRef.length > 0;
  }
  return false;
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isResetSummary(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  return (
    isRecord(value) &&
    value.performed === true &&
    typeof value.statePath === "string" &&
    Array.isArray(value.previousCurrentRefs) &&
    value.previousCurrentRefs.every((ref) => typeof ref === "string") &&
    isNullableString(value.previousCurrentFeedbackId) &&
    isNullableString(value.previousCurrentReviewBlockRef) &&
    Array.isArray(value.previousInProgressRefs) &&
    value.previousInProgressRefs.every((ref) => typeof ref === "string") &&
    typeof value.forced === "boolean"
  );
}

function isAutoRunSummary(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  return (
    isRecord(value) &&
    isNullableString(value.desktopRunId) &&
    typeof value.stepCount === "number" &&
    Number.isInteger(value.stepCount) &&
    value.stepCount >= 0 &&
    typeof value.parallel === "boolean" &&
    isNullableString(value.executorOverride) &&
    (value.stopReason === null || (typeof value.stopReason === "string" && autoRunStopReasons.has(value.stopReason)))
  );
}

function validateSessionState(value: unknown, sessionId: string, path: string): { session: RunSessionState | null; diagnostics: RunSessionDiagnostic[] } {
  if (!isRecord(value)) {
    return { session: null, diagnostics: [invalidSessionDiagnostic(sessionId, path, "Run session summary must be a JSON object.")] };
  }
  const diagnostics: RunSessionDiagnostic[] = [];
  if (value.sessionId !== sessionId) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary sessionId does not match its directory."));
  }
  if (!runSessionKinds.has(String(value.kind))) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary has an invalid kind."));
  }
  if (!runSessionTriggers.has(String(value.trigger))) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary has an invalid trigger."));
  }
  if (typeof value.projectRoot !== "string" || value.projectRoot.length === 0) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary is missing projectRoot."));
  }
  if (typeof value.canvasId !== "string" || value.canvasId.length === 0) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary is missing canvasId."));
  }
  if (!isRunSessionScope(value.scope)) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary has an invalid scope."));
  }
  if (!runSessionPhases.has(String(value.phase))) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary has an invalid phase."));
  }
  if (typeof value.startedAt !== "string" || value.startedAt.length === 0 || typeof value.updatedAt !== "string" || value.updatedAt.length === 0) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary is missing startedAt or updatedAt."));
  }
  if (!isNullableString(value.finishedAt)) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary has an invalid finishedAt."));
  }
  if (!isResetSummary(value.reset)) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary has an invalid reset summary."));
  }
  if (!isAutoRunSummary(value.autoRun)) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary has an invalid autoRun summary."));
  }
  if (!isNullableString(value.latestRecordId) || !isNullableString(value.latestRecordPath) || !isNullableString(value.error)) {
    diagnostics.push(invalidSessionDiagnostic(sessionId, path, "Run session summary has invalid nullable string fields."));
  }
  if (diagnostics.length > 0) {
    return { session: null, diagnostics };
  }
  return { session: value as RunSessionState, diagnostics: [] };
}

async function readSessionState(workspace: ProjectWorkspace, sessionId: string): Promise<{ session: RunSessionState | null; diagnostics: RunSessionDiagnostic[] }> {
  const path = sessionSummaryPath(workspace, sessionId);
  try {
    return validateSessionState(await readJsonFile<unknown>(path), sessionId, path);
  } catch (error) {
    return {
      session: null,
      diagnostics: [
        {
          code: "run_session_read_failed",
          sessionId,
          path,
          message: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

export async function createRunSession(options: CreateRunSessionOptions): Promise<RunSessionState> {
  const workspace = await resolveSessionWorkspace(options.projectRoot);
  const root = runSessionsRoot(workspace);
  await mkdir(root, { recursive: true });
  let sessionId = nextSessionId(await listExistingSessionIds(workspace));
  for (;;) {
    try {
      await mkdir(sessionRoot(workspace, sessionId));
      break;
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
        throw error;
      }
      sessionId = nextSessionIdAfter(sessionId);
    }
  }
  const now = (options.now ?? new Date()).toISOString();
  const session: RunSessionState = {
    sessionId,
    kind: options.kind,
    trigger: options.trigger ?? "manual",
    projectRoot: workspace.sourceRoot ?? workspace.rootPath,
    canvasId: await canvasIdForWorkspace(workspace),
    scope: options.scope ?? { kind: "project" },
    phase: options.phase ?? "created",
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    reset: null,
    autoRun: null,
    latestRecordId: null,
    latestRecordPath: null,
    error: null
  };
  await writeJsonFile(sessionSummaryPath(workspace, sessionId), session);
  await appendRunSessionEvent(options.projectRoot, sessionId, "session_started", { timestamp: now, phase: session.phase });
  return session;
}

export async function updateRunSession(
  projectRoot: PackageWorkspaceRef,
  sessionId: string,
  patch: UpdateRunSessionPatch
): Promise<RunSessionState> {
  assertValidRunSessionId(sessionId);
  const workspace = await resolveSessionWorkspace(projectRoot);
  const current = await readSessionState(workspace, sessionId);
  if (!current.session) {
    throw new Error(`Run session '${sessionId}' could not be read.`);
  }
  const now = new Date().toISOString();
  const next: RunSessionState = {
    ...current.session,
    ...patch,
    updatedAt: now
  };
  await writeJsonFile(sessionSummaryPath(workspace, sessionId), next);
  return next;
}

export async function appendRunSessionEvent(
  projectRoot: PackageWorkspaceRef,
  sessionId: string,
  type: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  assertValidRunSessionId(sessionId);
  const workspace = await resolveSessionWorkspace(projectRoot);
  const event: RunSessionEvent = {
    timestamp: typeof data.timestamp === "string" ? data.timestamp : new Date().toISOString(),
    sessionId,
    type,
    phase: typeof data.phase === "string" ? (data.phase as RunSessionPhase) : "created",
    ...data
  };
  await mkdir(sessionRoot(workspace, sessionId), { recursive: true });
  await appendFile(sessionEventsPath(workspace, sessionId), `${JSON.stringify(event)}\n`, "utf8");
}

export async function listRunSessions(projectRoot: PackageWorkspaceRef): Promise<ListRunSessionsResult> {
  const workspace = await resolveSessionWorkspace(projectRoot);
  const diagnostics: RunSessionDiagnostic[] = [];
  const sessions: RunSessionState[] = [];
  for (const sessionId of await listExistingSessionIds(workspace)) {
    const read = await readSessionState(workspace, sessionId);
    diagnostics.push(...read.diagnostics);
    if (read.session) {
      sessions.push(read.session);
    }
  }
  sessions.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.sessionId.localeCompare(left.sessionId));
  return { sessions, diagnostics };
}

export async function getRunSession(projectRoot: PackageWorkspaceRef, sessionId: string): Promise<RunSessionDetail> {
  assertValidRunSessionId(sessionId);
  const workspace = await resolveSessionWorkspace(projectRoot);
  const read = await readSessionState(workspace, sessionId);
  if (!read.session) {
    throw new Error(`Run session '${sessionId}' could not be read.`);
  }
  const diagnostics = [...read.diagnostics];
  const events: RunSessionEvent[] = [];
  const path = sessionEventsPath(workspace, sessionId);
  try {
    const raw = await readFile(path, "utf8");
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed) || parsed.sessionId !== sessionId || typeof parsed.type !== "string" || typeof parsed.timestamp !== "string") {
          diagnostics.push({
            code: "run_session_event_invalid",
            sessionId,
            path: `${path}:${index + 1}`,
            message: "Run session event must include sessionId, type, and timestamp."
          });
          continue;
        }
        events.push(parsed as RunSessionEvent);
      } catch (error) {
        diagnostics.push({
          code: "run_session_event_invalid",
          sessionId,
          path: `${path}:${index + 1}`,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      diagnostics.push({
        code: "run_session_event_read_failed",
        sessionId,
        path,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { session: read.session, events, diagnostics };
}
