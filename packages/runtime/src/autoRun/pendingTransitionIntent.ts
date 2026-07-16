import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isNodeFileNotFoundError } from "../fs/optionalFile.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";

const desktopAutoRunPhaseSchema = z.enum([
  "idle",
  "running",
  "pausing",
  "paused",
  "manual",
  "completed",
  "blocked",
  "failed",
  "stopped"
]);

const transitionDataSchema = z.record(z.string(), z.unknown());

/**
 * Stable next-state identity used to decide whether authority write committed.
 * Phase alone is insufficient (e.g. running → running step_finish).
 */
export const autoRunExpectedAuthoritySchema = z.object({
  phase: desktopAutoRunPhaseSchema,
  stepCount: z.number().int().nonnegative(),
  currentRef: z.string().nullable(),
  updatedAt: z.string().datetime()
});

export type AutoRunExpectedAuthority = z.infer<typeof autoRunExpectedAuthoritySchema>;

export const autoRunTransitionIntentSchema = z.object({
  version: z.literal(2),
  transitionId: z.string().min(1),
  runId: z.string().min(1),
  previousPhase: desktopAutoRunPhaseSchema,
  nextPhase: desktopAutoRunPhaseSchema,
  eventType: z.string().min(1),
  /** Authority identity observed immediately before this transition. */
  previousAuthority: autoRunExpectedAuthoritySchema,
  /** Expected next authority identity after a successful state write. */
  expectedAuthority: autoRunExpectedAuthoritySchema,
  data: transitionDataSchema.default({}),
  createdAt: z.string().datetime()
});

export type AutoRunTransitionIntent = z.infer<typeof autoRunTransitionIntentSchema>;

export function matchesExpectedAuthority(
  state: {
    phase: string;
    stepCount: number;
    currentRef: string | null;
    updatedAt: string;
  },
  expected: AutoRunExpectedAuthority
): boolean {
  return (
    state.phase === expected.phase &&
    state.stepCount === expected.stepCount &&
    state.currentRef === expected.currentRef &&
    state.updatedAt === expected.updatedAt
  );
}

export function buildExpectedAuthority(state: {
  phase: AutoRunExpectedAuthority["phase"];
  stepCount: number;
  currentRef: string | null;
  updatedAt: string;
}): AutoRunExpectedAuthority {
  return {
    phase: state.phase,
    stepCount: state.stepCount,
    currentRef: state.currentRef,
    updatedAt: state.updatedAt
  };
}

export type TransitionDiagnostic = {
  code: string;
  message: string;
  path?: string;
  transitionId?: string;
  runId?: string;
};

export type PendingTransitionReadResult =
  | { status: "absent" }
  | { status: "ok"; intent: AutoRunTransitionIntent }
  | { status: "unreadable"; diagnostic: TransitionDiagnostic };

export function autoRunsRoot(workspace: ProjectWorkspace): string {
  return join(workspace.resultsDir, "auto-runs");
}

export function pendingTransitionPath(workspace: ProjectWorkspace, runId: string): string {
  return join(autoRunsRoot(workspace), runId, "pending-transition.json");
}

/**
 * Read pending intent. Only ENOENT is treated as absent.
 * Zod failure, JSON damage, I/O errors, and runId mismatch are unreadable (fail-closed).
 */
export async function readPendingTransitionIntentResult(
  workspace: ProjectWorkspace,
  runId: string
): Promise<PendingTransitionReadResult> {
  const path = pendingTransitionPath(workspace, runId);
  try {
    const raw = await readJsonFile<unknown>(path);
    const parsed = autoRunTransitionIntentSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: "unreadable",
        diagnostic: {
          code: "auto_run_pending_transition_unreadable",
          message: `Pending transition at '${path}' failed schema validation: ${parsed.error.message}`,
          path,
          runId
        }
      };
    }
    if (parsed.data.runId !== runId) {
      return {
        status: "unreadable",
        diagnostic: {
          code: "auto_run_pending_transition_unreadable",
          message: `Pending transition at '${path}' has runId '${parsed.data.runId}' which does not match directory runId '${runId}'.`,
          path,
          transitionId: parsed.data.transitionId,
          runId
        }
      };
    }
    return { status: "ok", intent: parsed.data };
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return { status: "absent" };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "unreadable",
      diagnostic: {
        code: "auto_run_pending_transition_unreadable",
        message: `Failed to read pending transition at '${path}': ${detail}`,
        path,
        runId
      }
    };
  }
}

export async function writePendingTransitionIntent(
  workspace: ProjectWorkspace,
  intent: AutoRunTransitionIntent
): Promise<void> {
  const parsed = autoRunTransitionIntentSchema.parse(intent);
  const path = pendingTransitionPath(workspace, parsed.runId);
  await writeJsonFile(path, parsed);
}

export async function clearPendingTransitionIntent(
  workspace: ProjectWorkspace,
  runId: string
): Promise<void> {
  const path = pendingTransitionPath(workspace, runId);
  await rm(path, { force: true });
}

export async function listAutoRunDirectoryIds(workspace: ProjectWorkspace): Promise<string[]> {
  try {
    const entries = await readdir(autoRunsRoot(workspace), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isNodeFileNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

/**
 * Inspect all auto-run directories for pending transition problems (doctor / start gate).
 */
export async function inspectPendingTransitionsForWorkspace(
  workspace: ProjectWorkspace,
  listRunIds: () => Promise<string[]> = () => listAutoRunDirectoryIds(workspace)
): Promise<TransitionDiagnostic[]> {
  const diagnostics: TransitionDiagnostic[] = [];
  for (const runId of await listRunIds()) {
    const result = await readPendingTransitionIntentResult(workspace, runId);
    if (result.status === "unreadable") {
      diagnostics.push(result.diagnostic);
      continue;
    }
    if (result.status === "ok") {
      diagnostics.push({
        code: "auto_run_pending_transition_incomplete",
        message: `Auto Run '${runId}' has unrecovered pending transition '${result.intent.transitionId}' (${result.intent.previousPhase} → ${result.intent.nextPhase}, event=${result.intent.eventType}).`,
        path: pendingTransitionPath(workspace, runId),
        transitionId: result.intent.transitionId,
        runId
      });
    }
  }
  return diagnostics;
}
