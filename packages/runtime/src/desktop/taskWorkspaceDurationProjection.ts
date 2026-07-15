import type { TaskWorkspaceBlock } from "./types/taskWorkspaceAggregateTypes.js";

const TASK_WALL_CLOCK_UNAVAILABLE_REASON =
  "Task wall-clock duration is unavailable because no persisted block run has a start time.";
const AGENT_TIME_UNAVAILABLE_REASON =
  "Agent time is unavailable because no persisted block run has a calculable duration.";
const AGENT_TIME_PARTIAL_REASON =
  "Agent time is partial because one or more persisted block runs have no start time.";

function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function projectTaskWorkspaceDuration(blocks: TaskWorkspaceBlock[], now: Date) {
  const runs = blocks.flatMap((block) => block.runs.map((item) => item.run));
  const starts = runs
    .map((run) => timestamp(run.duration.startedAt))
    .filter((value): value is number => value !== null);
  const calculatedAt = now.toISOString();
  const wallClock =
    starts.length === 0
      ? {
          available: false,
          startedAt: null,
          endedAt: null,
          calculatedAt,
          totalMs: null,
          unavailableReason: TASK_WALL_CLOCK_UNAVAILABLE_REASON
        }
      : (() => {
          const started = Math.min(...starts);
          const hasActiveRun = blocks.some((block) =>
            block.runs.some((item) => item.active && item.run.duration.startedAt !== null)
          );
          const finishes = runs
            .map((run) => timestamp(run.duration.finishedAt))
            .filter((value): value is number => value !== null);
          const ended = hasActiveRun ? now.getTime() : Math.max(...finishes, started);
          return {
            available: true,
            startedAt: new Date(started).toISOString(),
            endedAt: new Date(ended).toISOString(),
            calculatedAt,
            totalMs: Math.max(0, ended - started),
            unavailableReason: null
          };
        })();
  const availableDurations = runs
    .map((run) => run.duration.wallClockMs)
    .filter((value): value is number => value !== null);
  const missingRunCount = runs.length - availableDurations.length;
  const agentTime =
    availableDurations.length === 0
      ? {
          availability: "unavailable" as const,
          totalMs: null,
          includedRunCount: 0,
          missingRunCount,
          reason: AGENT_TIME_UNAVAILABLE_REASON
        }
      : {
          availability: missingRunCount === 0 ? ("complete" as const) : ("partial" as const),
          totalMs: availableDurations.reduce((total, duration) => total + duration, 0),
          includedRunCount: availableDurations.length,
          missingRunCount,
          reason: missingRunCount === 0 ? null : AGENT_TIME_PARTIAL_REASON
        };
  return { wallClock, agentTime };
}
