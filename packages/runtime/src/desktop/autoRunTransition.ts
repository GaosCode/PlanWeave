import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ProjectWorkspace } from "../types.js";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import {
  autoRunTransitionIntentSchema,
  autoRunExpectedAuthoritySchema,
  buildExpectedAuthority,
  clearPendingTransitionIntent,
  inspectPendingTransitionsForWorkspace,
  matchesExpectedAuthority,
  pendingTransitionPath,
  readPendingTransitionIntentResult,
  writePendingTransitionIntent,
  type AutoRunExpectedAuthority,
  type AutoRunTransitionIntent,
  type PendingTransitionReadResult,
  type TransitionDiagnostic
} from "../autoRun/pendingTransitionIntent.js";
import { appendAutoRunEvent, autoRunRoot } from "./runStateStore.js";
import { normalizePersistedAutoRunState } from "./runRecovery.js";
import {
  listRunDirectories,
  readPersistedAutoRunEventLog,
  readRawPersistedAutoRunStateResult,
  writePersistedAutoRunState
} from "./runStateRepository.js";
import { appendRunSessionEvent, getRunSession, updateRunSession } from "../runSessions/index.js";
import type { DesktopAutoRunPhase, DesktopAutoRunState } from "./types.js";
import type { RunSessionAutoRunSummary, RunSessionPhase } from "../runSessions/index.js";

export {
  autoRunTransitionIntentSchema,
  autoRunExpectedAuthoritySchema,
  buildExpectedAuthority,
  clearPendingTransitionIntent,
  inspectPendingTransitionsForWorkspace,
  matchesExpectedAuthority,
  pendingTransitionPath,
  readPendingTransitionIntentResult,
  writePendingTransitionIntent
};
export type {
  AutoRunExpectedAuthority,
  AutoRunTransitionIntent,
  PendingTransitionReadResult,
  TransitionDiagnostic
};

export type SessionSummaryBuilder = (
  workspace: ProjectWorkspace,
  state: DesktopAutoRunState,
  eventType: string
) => Promise<RunSessionAutoRunSummary>;

/**
 * Injectable seams for fault-injection tests. Production uses real persistence.
 * Normal commit and recovery share these projection implementations.
 */
export type TransitionPersistenceAdapters = {
  writeState?: (state: DesktopAutoRunState) => Promise<void>;
  appendAutoRunEvent?: (
    state: DesktopAutoRunState,
    eventType: string,
    data: Record<string, unknown>
  ) => Promise<void>;
  updateSession?: (
    workspace: ProjectWorkspace,
    sessionId: string,
    patch: Parameters<typeof updateRunSession>[2]
  ) => Promise<unknown>;
  appendSessionEvent?: (
    workspace: ProjectWorkspace,
    sessionId: string,
    eventType: string,
    data: Record<string, unknown>
  ) => Promise<void>;
  getSession?: typeof getRunSession;
  writeCommitMarker?: (
    workspace: ProjectWorkspace,
    intent: AutoRunTransitionIntent,
    authority: DesktopAutoRunState
  ) => Promise<void>;
  clearCommitMarker?: (
    workspace: ProjectWorkspace,
    intent: AutoRunTransitionIntent
  ) => Promise<void>;
};

export type CommitAutoRunTransitionInput = {
  workspace: ProjectWorkspace;
  previous: DesktopAutoRunState;
  next: DesktopAutoRunState;
  eventType: string;
  data?: Record<string, unknown>;
  buildSessionSummary: SessionSummaryBuilder;
  adapters?: TransitionPersistenceAdapters;
  /**
   * When true, refuse to start if a different pending intent remains after recovery.
   * Default true.
   */
  refuseOverwritePending?: boolean;
};

export type MutateAutoRunTransitionInput = {
  workspace: ProjectWorkspace;
  runId: string;
  memoryState: DesktopAutoRunState;
  eventType: string;
  data?: Record<string, unknown>;
  buildSessionSummary: SessionSummaryBuilder;
  mutate: (authority: DesktopAutoRunState) => DesktopAutoRunState | null;
  adapters?: TransitionPersistenceAdapters;
};

export type CommitAutoRunTransitionResult = {
  state: DesktopAutoRunState;
  transitionId: string;
  eventType: string;
};

export type MutateAutoRunTransitionResult = {
  state: DesktopAutoRunState;
  applied: boolean;
  transitionId: string | null;
  eventType: string | null;
};

export type RecoverPendingTransitionResult = {
  recovered: boolean;
  /** Raw persisted authority verified against the pending intent identity. */
  authorityState: DesktopAutoRunState | null;
  applied: string[];
  diagnostics: TransitionDiagnostic[];
  /** True when intent exists but cannot be parsed or IO fails (fail-closed). */
  unreadable: boolean;
};

/** In-process per-run serial seam: check-then-append and recover stay exclusive. */
const transitionSeams = new Map<string, Promise<unknown>>();

function seamKey(workspace: ProjectWorkspace, runId: string): string {
  return `${workspace.rootPath}::${runId}`;
}

async function withTransitionSeam<T>(
  workspace: ProjectWorkspace,
  runId: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = seamKey(workspace, runId);
  const previous = transitionSeams.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  transitionSeams.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (transitionSeams.get(key) === tail) {
      transitionSeams.delete(key);
    }
  }
}

export function generateTransitionId(): string {
  return randomUUID();
}

const committedTransitionSchema = z
  .object({
    version: z.literal(1),
    transitionId: z.string().min(1),
    runId: z.string().min(1),
    expectedAuthority: autoRunExpectedAuthoritySchema,
    authority: z.record(z.string(), z.unknown())
  })
  .strict();

function committedTransitionPath(
  workspace: ProjectWorkspace,
  runId: string,
  transitionId: string
): string {
  return join(autoRunRoot(workspace, runId), "committed-transitions", `${transitionId}.json`);
}

async function writeCommittedTransitionAuthority(
  workspace: ProjectWorkspace,
  intent: AutoRunTransitionIntent,
  authority: DesktopAutoRunState
): Promise<void> {
  await writeJsonFile(committedTransitionPath(workspace, intent.runId, intent.transitionId), {
    version: 1,
    transitionId: intent.transitionId,
    runId: intent.runId,
    expectedAuthority: intent.expectedAuthority,
    authority
  });
}

async function clearCommittedTransitionAuthority(
  workspace: ProjectWorkspace,
  intent: AutoRunTransitionIntent
): Promise<void> {
  await rm(committedTransitionPath(workspace, intent.runId, intent.transitionId), { force: true });
}

type CommittedTransitionReadResult =
  | { status: "absent" }
  | { status: "ok"; authority: DesktopAutoRunState }
  | { status: "unreadable"; diagnostic: TransitionDiagnostic };

async function readCommittedTransitionAuthority(
  workspace: ProjectWorkspace,
  intent: AutoRunTransitionIntent
): Promise<CommittedTransitionReadResult> {
  const path = committedTransitionPath(workspace, intent.runId, intent.transitionId);
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(path);
  } catch (error) {
    if (isNodeFileNotFoundError(error)) return { status: "absent" };
    return {
      status: "unreadable",
      diagnostic: {
        code: "auto_run_transition_commit_marker_unreadable",
        message: `Failed to read committed transition marker '${path}': ${error instanceof Error ? error.message : String(error)}`,
        path,
        transitionId: intent.transitionId,
        runId: intent.runId
      }
    };
  }
  const parsed = committedTransitionSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.transitionId !== intent.transitionId ||
    parsed.data.runId !== intent.runId ||
    !matchesExpectedAuthority(parsed.data.expectedAuthority, intent.expectedAuthority)
  ) {
    return {
      status: "unreadable",
      diagnostic: {
        code: "auto_run_transition_commit_marker_unreadable",
        message: `Committed transition marker '${path}' does not match pending transition '${intent.transitionId}'.`,
        path,
        transitionId: intent.transitionId,
        runId: intent.runId
      }
    };
  }
  const authority = normalizePersistedAutoRunState(parsed.data.authority, {
    statePath: join(autoRunRoot(workspace, intent.runId), "state.json"),
    eventLogPath: join(autoRunRoot(workspace, intent.runId), "events.ndjson")
  });
  if (!authority || !matchesExpectedAuthority(authority, intent.expectedAuthority)) {
    return {
      status: "unreadable",
      diagnostic: {
        code: "auto_run_transition_commit_marker_unreadable",
        message: `Committed transition marker '${path}' has an invalid authority snapshot.`,
        path,
        transitionId: intent.transitionId,
        runId: intent.runId
      }
    };
  }
  return { status: "ok", authority };
}

function defaultAdapters(): Required<TransitionPersistenceAdapters> {
  return {
    writeState: writePersistedAutoRunState,
    appendAutoRunEvent,
    updateSession: updateRunSession,
    appendSessionEvent: appendRunSessionEvent,
    getSession: getRunSession,
    writeCommitMarker: writeCommittedTransitionAuthority,
    clearCommitMarker: clearCommittedTransitionAuthority
  };
}

function mergeAdapters(
  overrides?: TransitionPersistenceAdapters
): Required<TransitionPersistenceAdapters> {
  return { ...defaultAdapters(), ...overrides };
}

async function hasAutoRunTransitionEvent(
  workspace: ProjectWorkspace,
  runId: string,
  transitionId: string,
  eventType: string
): Promise<boolean> {
  const log = await readPersistedAutoRunEventLog(workspace, runId);
  const unreadable = log.diagnostics.find(
    (diagnostic) => diagnostic.code !== "auto_run_event_log_missing"
  );
  if (unreadable) throw new Error(unreadable.message);
  return log.events.some((event) => {
    if (event.type !== eventType) return false;
    const dataTransition = (event.data as Record<string, unknown> | undefined)?.transitionId;
    return typeof dataTransition === "string" && dataTransition === transitionId;
  });
}

async function hasSessionTransitionEvent(
  workspace: ProjectWorkspace,
  sessionId: string | null | undefined,
  transitionId: string,
  eventType: string,
  getSession: typeof getRunSession
): Promise<boolean> {
  if (!sessionId) return true;
  const detail = await getSession(workspace, sessionId);
  if (detail.diagnostics.length > 0) {
    throw new Error(
      `Run session '${sessionId}' transition evidence is unreadable: ${detail.diagnostics
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join("; ")}`
    );
  }
  return detail.events.some((event) => {
    if (event.type !== eventType) return false;
    const t = (event as unknown as Record<string, unknown>).transitionId;
    return typeof t === "string" && t === transitionId;
  });
}

function runSessionPhaseForPhase(phase: DesktopAutoRunPhase): RunSessionPhase {
  if (
    phase === "completed" ||
    phase === "manual" ||
    phase === "blocked" ||
    phase === "failed" ||
    phase === "stopped"
  ) {
    return phase;
  }
  return "running";
}

function isTerminalRunSessionPhase(phase: RunSessionPhase): boolean {
  return phase === "completed" || phase === "blocked" || phase === "failed" || phase === "stopped";
}

function finalRunSessionEventTypeForPhase(phase: RunSessionPhase): string | null {
  if (phase === "completed") return "session_completed";
  if (phase === "blocked") return "session_blocked";
  if (phase === "failed") return "session_failed";
  if (phase === "stopped") return "session_stopped";
  return null;
}

const finalRunSessionEventTypes = new Set([
  "session_completed",
  "session_manual",
  "session_blocked",
  "session_failed",
  "session_stopped"
]);

/**
 * Shared session projection used by both normal commit and recovery.
 * Summary fields come from buildSessionSummary so normal/recovery stay parity.
 */
export async function projectSessionForTransition(
  workspace: ProjectWorkspace,
  state: DesktopAutoRunState,
  intent: AutoRunTransitionIntent,
  buildSessionSummary: SessionSummaryBuilder,
  adapters?: TransitionPersistenceAdapters
): Promise<void> {
  if (!state.runSessionId) {
    return;
  }
  const a = mergeAdapters(adapters);
  const phase = runSessionPhaseForPhase(state.phase);
  const finishedAt = isTerminalRunSessionPhase(phase) ? state.updatedAt : undefined;
  const summary = await buildSessionSummary(workspace, state, intent.eventType);
  await a.updateSession(workspace, state.runSessionId, {
    phase,
    ...(finishedAt ? { finishedAt } : {}),
    autoRun: summary,
    latestRecordId: state.latestRecordId,
    latestRecordPath: state.latestRecordPath,
    error: state.error
  });

  const eventData = {
    phase,
    desktopRunId: state.runId,
    autoRunPhase: state.phase,
    stepCount: state.stepCount,
    currentRef: state.currentRef,
    latestRecordId: state.latestRecordId,
    latestRecordPath: state.latestRecordPath,
    error: state.error,
    transitionId: intent.transitionId,
    previousPhase: intent.previousPhase,
    nextPhase: intent.nextPhase,
    ...intent.data
  };

  const hasEvent = await hasSessionTransitionEvent(
    workspace,
    state.runSessionId,
    intent.transitionId,
    intent.eventType,
    a.getSession
  );
  if (!hasEvent) {
    await a.appendSessionEvent(workspace, state.runSessionId, intent.eventType, eventData);
  }

  const finalType = finalRunSessionEventTypeForPhase(phase);
  if (finalType) {
    const detail = await a.getSession(workspace, state.runSessionId);
    const alreadyHasFinal = detail.events.some((e) => finalRunSessionEventTypes.has(e.type));
    if (!alreadyHasFinal) {
      await a.appendSessionEvent(workspace, state.runSessionId, finalType, {
        phase,
        finishedAt,
        desktopRunId: state.runId,
        stepCount: state.stepCount,
        transitionId: intent.transitionId
      });
    }
  }
}

/**
 * Append Auto Run event for transition if absent. Call only under withTransitionSeam.
 */
export async function ensureAutoRunEventProjectionWithWorkspace(
  workspace: ProjectWorkspace,
  state: DesktopAutoRunState,
  intent: AutoRunTransitionIntent,
  adapters?: TransitionPersistenceAdapters
): Promise<void> {
  const a = mergeAdapters(adapters);
  const has = await hasAutoRunTransitionEvent(
    workspace,
    state.runId,
    intent.transitionId,
    intent.eventType
  );
  if (!has) {
    await a.appendAutoRunEvent(state, intent.eventType, {
      transitionId: intent.transitionId,
      previousPhase: intent.previousPhase,
      nextPhase: intent.nextPhase,
      ...intent.data
    });
  }
}

async function recoverPendingTransitionUnlocked(
  workspace: ProjectWorkspace,
  runId: string,
  options: {
    buildSessionSummary?: SessionSummaryBuilder;
    adapters?: TransitionPersistenceAdapters;
  } = {}
): Promise<RecoverPendingTransitionResult> {
  const applied: string[] = [];
  const diagnostics: TransitionDiagnostic[] = [];
  const pendingPath = pendingTransitionPath(workspace, runId);
  const read = await readPendingTransitionIntentResult(workspace, runId);
  if (read.status === "absent") {
    return { recovered: false, authorityState: null, applied, diagnostics, unreadable: false };
  }
  if (read.status === "unreadable") {
    diagnostics.push(read.diagnostic);
    return { recovered: false, authorityState: null, applied, diagnostics, unreadable: true };
  }
  const intent = read.intent;
  const expected = intent.expectedAuthority;
  const committed = await readCommittedTransitionAuthority(workspace, intent);
  if (committed.status === "unreadable") {
    diagnostics.push(committed.diagnostic);
    return { recovered: false, authorityState: null, applied, diagnostics, unreadable: true };
  }

  // Authority: raw disk state without process-interrupt derivation.
  // Commit identity is expectedAuthority (phase + stepCount + currentRef + updatedAt),
  // not phase alone — same-phase step_finish must not false-positive on stale state.
  let authority: DesktopAutoRunState | null = null;
  const raw = await readRawPersistedAutoRunStateResult(workspace, runId);
  if (raw.status === "unreadable") {
    // Cannot determine whether state advanced: keep intent, fail closed.
    diagnostics.push({
      code: "auto_run_authority_state_unreadable",
      message: `Pending transition ${intent.transitionId} cannot be recovered because authority state is unreadable: ${raw.diagnostic.message}`,
      path: raw.diagnostic.path,
      transitionId: intent.transitionId,
      runId
    });
    return { recovered: false, authorityState: null, applied, diagnostics, unreadable: true };
  }
  if (committed.status === "ok") {
    authority = committed.authority;
    if (raw.status === "ok" && !matchesExpectedAuthority(raw.state, expected)) {
      await clearPendingTransitionIntent(workspace, runId);
      await mergeAdapters(options.adapters).clearCommitMarker(workspace, intent);
      diagnostics.push({
        code: "auto_run_transition_superseded_after_commit",
        message: `Pending transition ${intent.transitionId} was already superseded by newer authority; its older projections were not replayed.`,
        path: pendingPath,
        transitionId: intent.transitionId,
        runId
      });
      return {
        recovered: true,
        authorityState: raw.state,
        applied: ["cleared-intent", "cleared-commit-marker"],
        diagnostics,
        unreadable: false
      };
    }
    if (raw.status === "absent") {
      try {
        await mergeAdapters(options.adapters).writeState(authority);
        applied.push("authority-state");
      } catch (error) {
        diagnostics.push({
          code: "auto_run_transition_authority_rebuild_failed",
          message: `Failed to rebuild missing authority state for ${intent.transitionId}: ${error instanceof Error ? error.message : String(error)}`,
          path: authority.statePath,
          transitionId: intent.transitionId,
          runId
        });
        return { recovered: false, authorityState: null, applied, diagnostics, unreadable: true };
      }
    }
  } else if (raw.status === "ok" && matchesExpectedAuthority(raw.state, expected)) {
    authority = raw.state;
    try {
      await mergeAdapters(options.adapters).writeCommitMarker(workspace, intent, authority);
      applied.push("commit-marker");
    } catch (error) {
      diagnostics.push({
        code: "auto_run_transition_commit_marker_heal_failed",
        message: `Failed to persist committed transition marker for ${intent.transitionId}: ${error instanceof Error ? error.message : String(error)}`,
        transitionId: intent.transitionId,
        runId
      });
      return {
        recovered: false,
        authorityState: authority,
        applied,
        diagnostics,
        unreadable: false
      };
    }
  }

  if (!authority) {
    if (raw.status === "ok" && matchesExpectedAuthority(raw.state, intent.previousAuthority)) {
      // Exact previous authority plus no commit marker proves the state write never committed.
      await clearPendingTransitionIntent(workspace, runId);
      diagnostics.push({
        code: "auto_run_transition_aborted_before_state",
        message: `Pending transition ${intent.transitionId} cleaned because authority still matches its exact previous identity.`,
        path: pendingPath,
        transitionId: intent.transitionId,
        runId
      });
      return {
        recovered: false,
        authorityState: raw.state,
        applied,
        diagnostics,
        unreadable: false
      };
    }
    diagnostics.push({
      code: "auto_run_transition_superseded_without_commit_evidence",
      message: `Pending transition ${intent.transitionId} is retained because current authority matches neither its previous nor expected identity and no committed marker proves the transition was applied.`,
      path: pendingPath,
      transitionId: intent.transitionId,
      runId
    });
    return {
      recovered: false,
      authorityState: raw.status === "ok" ? raw.state : null,
      applied,
      diagnostics,
      unreadable: false
    };
  }
  const exposedAuthority = raw.status === "ok" ? raw.state : authority;

  const adapters = options.adapters;
  try {
    await ensureAutoRunEventProjectionWithWorkspace(workspace, authority, intent, adapters);
    applied.push("autoRunEvent");
  } catch (e) {
    diagnostics.push({
      code: "auto_run_transition_event_heal_failed",
      message: `Failed to heal Auto Run event for ${intent.transitionId}: ${e instanceof Error ? e.message : String(e)}`,
      path: authority.eventLogPath,
      transitionId: intent.transitionId,
      runId
    });
  }

  const sessionBuilder: SessionSummaryBuilder =
    options.buildSessionSummary ??
    (async (_ws, state, eventType) => {
      let parallel = false;
      let agentId: RunSessionAutoRunSummary["agentId"] = null;
      let runnerKind: RunSessionAutoRunSummary["runnerKind"] = null;
      if (state.runSessionId) {
        const existing = await getRunSession(workspace, state.runSessionId);
        if (existing.session?.autoRun) {
          parallel = existing.session.autoRun.parallel ?? false;
          agentId = existing.session.autoRun.agentId ?? null;
          runnerKind = existing.session.autoRun.runnerKind ?? null;
        }
      }
      return {
        desktopRunId: state.runId,
        stepCount: state.stepCount,
        parallel,
        executorOverride: null,
        effectiveExecutor: state.currentExecutor,
        agentId,
        runnerKind,
        stopReason: eventType === "step_limit_reached" ? "step_limit" : null
      };
    });

  if (authority.runSessionId) {
    try {
      await projectSessionForTransition(workspace, authority, intent, sessionBuilder, adapters);
      applied.push("session");
    } catch (e) {
      diagnostics.push({
        code: "auto_run_transition_session_heal_failed",
        message: `Failed to heal run-session projections for ${intent.transitionId}: ${e instanceof Error ? e.message : String(e)}`,
        transitionId: intent.transitionId,
        runId
      });
    }
  }

  const hadHealFailure = diagnostics.some((d) => d.code.includes("heal_failed"));
  if (!hadHealFailure) {
    await mergeAdapters(options.adapters).clearCommitMarker(workspace, intent);
    applied.push("cleared-commit-marker");
    await clearPendingTransitionIntent(workspace, runId);
    applied.push("cleared-intent");
    return {
      recovered: true,
      authorityState: exposedAuthority,
      applied,
      diagnostics,
      unreadable: false
    };
  }
  return {
    recovered: false,
    authorityState: exposedAuthority,
    applied,
    diagnostics,
    unreadable: false
  };
}

/**
 * Heal missing projections for a committed transition.
 * Serialized per run so concurrent recovery cannot duplicate terminal events.
 */
export async function recoverPendingTransition(
  workspace: ProjectWorkspace,
  runId: string,
  _getStateForRun: (runId: string) => DesktopAutoRunState | null,
  options: {
    buildSessionSummary?: SessionSummaryBuilder;
    adapters?: TransitionPersistenceAdapters;
  } = {}
): Promise<RecoverPendingTransitionResult> {
  return withTransitionSeam(workspace, runId, () =>
    recoverPendingTransitionUnlocked(workspace, runId, {
      buildSessionSummary: options.buildSessionSummary,
      adapters: options.adapters
    })
  );
}

/**
 * Full phase-transition persistence order under a per-run serial seam:
 * existing-intent recover/refuse → write intent → write state → Auto event → session → clear intent.
 * Caller updates in-memory map, emits, and releases resources only after this returns.
 */
async function recoverAndReadAuthorityUnlocked(options: {
  workspace: ProjectWorkspace;
  runId: string;
  buildSessionSummary: SessionSummaryBuilder;
  adapters?: TransitionPersistenceAdapters;
  memoryState?: DesktopAutoRunState;
}): Promise<DesktopAutoRunState> {
  const existing = await readPendingTransitionIntentResult(options.workspace, options.runId);
  if (existing.status === "unreadable") throw new Error(existing.diagnostic.message);
  if (existing.status === "ok") {
    const healed = await recoverPendingTransitionUnlocked(options.workspace, options.runId, {
      buildSessionSummary: options.buildSessionSummary,
      adapters: options.adapters
    });
    if (healed.unreadable) {
      throw new Error(
        healed.diagnostics[0]?.message ??
          `Pending transition for Auto Run '${options.runId}' is unreadable.`
      );
    }
    const after = await readPendingTransitionIntentResult(options.workspace, options.runId);
    if (after.status === "unreadable") throw new Error(after.diagnostic.message);
    if (after.status === "ok") {
      throw new Error(
        `Cannot mutate Auto Run '${options.runId}' while pending transition '${after.intent.transitionId}' remains without complete authority evidence.`
      );
    }
  }
  const raw = await readRawPersistedAutoRunStateResult(options.workspace, options.runId);
  if (raw.status === "ok") return raw.state;
  if (raw.status === "unreadable") throw new Error(raw.diagnostic.message);
  if (options.memoryState) return options.memoryState;
  throw new Error(`Auto Run '${options.runId}' has no persisted authority state.`);
}

async function commitTransitionUnlocked(options: {
  workspace: ProjectWorkspace;
  previous: DesktopAutoRunState;
  next: DesktopAutoRunState;
  eventType: string;
  data: Record<string, unknown>;
  buildSessionSummary: SessionSummaryBuilder;
  adapters?: TransitionPersistenceAdapters;
}): Promise<CommitAutoRunTransitionResult> {
  const transitionId = generateTransitionId();
  const intent: AutoRunTransitionIntent = {
    version: 2,
    transitionId,
    runId: options.next.runId,
    previousPhase: options.previous.phase,
    nextPhase: options.next.phase,
    eventType: options.eventType,
    previousAuthority: buildExpectedAuthority(options.previous),
    expectedAuthority: buildExpectedAuthority(options.next),
    data: {
      previousPhase: options.previous.phase,
      nextPhase: options.next.phase,
      ...options.data
    },
    createdAt: new Date().toISOString()
  };
  const adapters = mergeAdapters(options.adapters);
  await writePendingTransitionIntent(options.workspace, intent);
  await adapters.writeState(options.next);
  await adapters.writeCommitMarker(options.workspace, intent, options.next);
  await ensureAutoRunEventProjectionWithWorkspace(
    options.workspace,
    options.next,
    intent,
    options.adapters
  );
  await projectSessionForTransition(
    options.workspace,
    options.next,
    intent,
    options.buildSessionSummary,
    options.adapters
  );
  await adapters.clearCommitMarker(options.workspace, intent);
  await clearPendingTransitionIntent(options.workspace, options.next.runId);
  return { state: options.next, transitionId, eventType: options.eventType };
}

export async function mutateAutoRunTransition(
  input: MutateAutoRunTransitionInput
): Promise<MutateAutoRunTransitionResult> {
  return withTransitionSeam(input.workspace, input.runId, async () => {
    const authority = await recoverAndReadAuthorityUnlocked({
      ...input,
      memoryState: input.memoryState
    });
    const next = input.mutate(authority);
    if (next === null) {
      return { state: authority, applied: false, transitionId: null, eventType: null };
    }
    if (next.runId !== input.runId) {
      throw new Error(`Auto Run mutation cannot change runId '${input.runId}'.`);
    }
    const committed = await commitTransitionUnlocked({
      workspace: input.workspace,
      previous: authority,
      next,
      eventType: input.eventType,
      data: input.data ?? {},
      buildSessionSummary: input.buildSessionSummary,
      adapters: input.adapters
    });
    return { ...committed, applied: true };
  });
}

export async function commitAutoRunTransition(
  input: CommitAutoRunTransitionInput
): Promise<CommitAutoRunTransitionResult> {
  return withTransitionSeam(input.workspace, input.next.runId, async () => {
    const authority = await recoverAndReadAuthorityUnlocked({
      workspace: input.workspace,
      runId: input.next.runId,
      buildSessionSummary: input.buildSessionSummary,
      adapters: input.adapters
    });
    if (!matchesExpectedAuthority(authority, buildExpectedAuthority(input.previous))) {
      throw new Error(
        `Auto Run '${input.next.runId}' transition input is stale relative to persisted authority.`
      );
    }
    return commitTransitionUnlocked({
      workspace: input.workspace,
      previous: authority,
      next: input.next,
      eventType: input.eventType,
      data: input.data ?? {},
      buildSessionSummary: input.buildSessionSummary,
      adapters: input.adapters
    });
  });
}

/**
 * Heal all recoverable pending transitions; returns remaining diagnostics (unreadable or failed heal).
 */
export async function recoverAllPendingTransitions(
  workspace: ProjectWorkspace,
  listRunIds: () => Promise<string[]> = () => listRunDirectories(workspace),
  getStateForRun: (runId: string) => DesktopAutoRunState | null = () => null,
  options: {
    buildSessionSummary?: SessionSummaryBuilder;
    onRecoveredAuthority?: (state: DesktopAutoRunState) => void;
  } = {}
): Promise<TransitionDiagnostic[]> {
  const remaining: TransitionDiagnostic[] = [];
  for (const runId of await listRunIds()) {
    const rec = await recoverPendingTransition(workspace, runId, getStateForRun, options);
    if (rec.recovered && rec.authorityState) {
      options.onRecoveredAuthority?.(rec.authorityState);
    }
    remaining.push(...rec.diagnostics);
    if (!rec.recovered && !rec.unreadable) {
      const still = await readPendingTransitionIntentResult(workspace, runId);
      if (still.status === "ok") {
        remaining.push({
          code: "auto_run_pending_transition_incomplete",
          message: `Auto Run '${runId}' still has pending transition '${still.intent.transitionId}' after recovery attempt.`,
          path: pendingTransitionPath(workspace, runId),
          transitionId: still.intent.transitionId,
          runId
        });
      }
    }
  }
  return remaining;
}
