/**
 * Pure clock-derived duration selectors for Task Workspace leaves.
 * Keep server-owned workspace snapshots free of 1 Hz re-projection; only leaves
 * that render relative time call these with an injected nowMs.
 */

export type LiveRunDurationInput = {
  active: boolean;
  finishedAt: string | null;
  startedAt: string | null;
  /** Persisted/static wall-clock when the run is not live. */
  wallClockMs: number | null;
};

export function needsLiveDurationClock(input: {
  active: boolean;
  finishedAt: string | null;
  startedAt: string | null;
}): boolean {
  return input.active && input.startedAt !== null && input.finishedAt === null;
}

export function selectRunWallClockMs(input: LiveRunDurationInput, nowMs: number): number | null {
  if (input.startedAt === null) {
    return null;
  }
  if (!needsLiveDurationClock(input)) {
    return input.wallClockMs;
  }
  const startedAtMs = Date.parse(input.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return null;
  }
  if (!Number.isFinite(nowMs) || nowMs < startedAtMs) {
    return null;
  }
  return nowMs - startedAtMs;
}

export type LiveTaskWallClockInput = {
  activeRecordIds: readonly string[];
  runs: readonly LiveRunDurationInput[];
};

/**
 * Task wall-clock span: earliest startedAt → now (if any active) or latest finishedAt.
 * Mirrors runtime projectTaskWorkspaceDuration wallClock semantics without schema parse.
 */
export function selectTaskWallClockTotalMs(
  input: LiveTaskWallClockInput,
  nowMs: number
): number | null {
  const starts = input.runs
    .map((run) => (run.startedAt === null ? null : Date.parse(run.startedAt)))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (starts.length === 0) {
    return null;
  }
  const started = Math.min(...starts);
  const hasActiveRun = input.runs.some(
    (run) => needsLiveDurationClock(run) || (run.active && run.startedAt !== null)
  );
  if (hasActiveRun || input.activeRecordIds.length > 0) {
    if (!Number.isFinite(nowMs) || nowMs < started) {
      return null;
    }
    return nowMs - started;
  }
  const finishes = input.runs
    .map((run) => (run.finishedAt === null ? null : Date.parse(run.finishedAt)))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const ended = finishes.length > 0 ? Math.max(...finishes, started) : started;
  return Math.max(0, ended - started);
}

export function selectAgentTimeTotalMs(
  runs: readonly LiveRunDurationInput[],
  nowMs: number
): { totalMs: number | null; includedRunCount: number; missingRunCount: number } {
  let totalMs = 0;
  let includedRunCount = 0;
  let missingRunCount = 0;
  for (const run of runs) {
    const wallClockMs = selectRunWallClockMs(run, nowMs);
    if (wallClockMs === null) {
      missingRunCount += 1;
    } else {
      includedRunCount += 1;
      totalMs += wallClockMs;
    }
  }
  if (includedRunCount === 0) {
    return { totalMs: null, includedRunCount: 0, missingRunCount };
  }
  return { totalMs, includedRunCount, missingRunCount };
}

export function collectWorkspaceRunDurationInputs(
  workspace: {
    activeRecordIds: readonly string[];
    blocks: readonly {
      runs: readonly {
        active: boolean;
        run: {
          duration: {
            finishedAt: string | null;
            startedAt: string | null;
            wallClockMs: number | null;
          };
        };
      }[];
    }[];
  }
): LiveTaskWallClockInput {
  const runs = workspace.blocks.flatMap((block) =>
    block.runs.map((item) => ({
      active: item.active,
      finishedAt: item.run.duration.finishedAt,
      startedAt: item.run.duration.startedAt,
      wallClockMs: item.run.duration.wallClockMs
    }))
  );
  return { activeRecordIds: workspace.activeRecordIds, runs };
}
