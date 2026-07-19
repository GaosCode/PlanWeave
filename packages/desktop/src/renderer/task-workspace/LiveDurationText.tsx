import type { ReactNode } from "react";
import {
  collectWorkspaceRunDurationInputs,
  needsLiveDurationClock,
  selectAgentTimeTotalMs,
  selectRunWallClockMs,
  selectTaskWallClockTotalMs,
  type LiveRunDurationInput
} from "./liveDuration";
import { useTaskWorkspaceClock } from "./useTaskWorkspaceClock";

function workspaceNeedsLiveClock(workspace: {
  activeRecordIds: readonly string[];
  blocks: readonly {
    runs: readonly {
      active: boolean;
      run: {
        duration: {
          finishedAt: string | null;
          startedAt: string | null;
        };
      };
    }[];
  }[];
}): boolean {
  if (workspace.activeRecordIds.length > 0) {
    return true;
  }
  return workspace.blocks.some((block) =>
    block.runs.some((item) =>
      needsLiveDurationClock({
        active: item.active,
        finishedAt: item.run.duration.finishedAt,
        startedAt: item.run.duration.startedAt
      })
    )
  );
}

/** Leaf: only re-renders when this run needs a live duration tick. */
export function LiveRunElapsedText({
  active,
  finishedAt,
  formatDuration,
  startedAt,
  unavailable,
  wallClockMs
}: {
  active: boolean;
  finishedAt: string | null;
  formatDuration: (milliseconds: number) => string;
  startedAt: string | null;
  unavailable: string;
  wallClockMs: number | null;
}): ReactNode {
  const input: LiveRunDurationInput = { active, finishedAt, startedAt, wallClockMs };
  const live = needsLiveDurationClock(input);
  const nowMs = useTaskWorkspaceClock(live);
  const elapsedMs = selectRunWallClockMs(input, nowMs);
  if (elapsedMs === null) {
    return unavailable;
  }
  return formatDuration(elapsedMs);
}

export function LiveTaskWallClockText({
  formatDuration,
  unavailable,
  workspace
}: {
  formatDuration: (milliseconds: number) => string;
  unavailable: string;
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
    duration: {
      wallClock: {
        available: boolean;
        totalMs: number | null;
      };
    };
  } | null;
}): ReactNode {
  const live = workspace !== null && workspaceNeedsLiveClock(workspace);
  const nowMs = useTaskWorkspaceClock(live);
  if (!workspace) {
    return unavailable;
  }
  if (!live) {
    if (!workspace.duration.wallClock.available || workspace.duration.wallClock.totalMs === null) {
      return unavailable;
    }
    return formatDuration(workspace.duration.wallClock.totalMs);
  }
  const totalMs = selectTaskWallClockTotalMs(collectWorkspaceRunDurationInputs(workspace), nowMs);
  if (totalMs === null) {
    return unavailable;
  }
  return formatDuration(totalMs);
}

export function LiveAgentTimeText({
  formatDuration,
  partialLabel,
  unavailable,
  workspace
}: {
  formatDuration: (milliseconds: number) => string;
  partialLabel: (includedRunCount: number, missingRunCount: number) => string;
  unavailable: string;
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
    duration: {
      agentTime: {
        availability: "unavailable" | "partial" | "complete";
        includedRunCount: number;
        missingRunCount: number;
        totalMs: number | null;
      };
    };
  } | null;
}): ReactNode {
  const live = workspace !== null && workspaceNeedsLiveClock(workspace);
  const nowMs = useTaskWorkspaceClock(live);
  if (!workspace) {
    return unavailable;
  }
  if (!live) {
    const agentTime = workspace.duration.agentTime;
    if (agentTime.availability === "unavailable" || agentTime.totalMs === null) {
      return unavailable;
    }
    return (
      <span>
        {formatDuration(agentTime.totalMs)}
        {agentTime.availability === "partial" ? (
          <span className="mt-0.5 block text-[10px] font-normal text-text-muted">
            {partialLabel(agentTime.includedRunCount, agentTime.missingRunCount)}
          </span>
        ) : null}
      </span>
    );
  }
  const agent = selectAgentTimeTotalMs(collectWorkspaceRunDurationInputs(workspace).runs, nowMs);
  if (agent.totalMs === null) {
    return unavailable;
  }
  return (
    <span>
      {formatDuration(agent.totalMs)}
      {agent.missingRunCount > 0 ? (
        <span className="mt-0.5 block text-[10px] font-normal text-text-muted">
          {partialLabel(agent.includedRunCount, agent.missingRunCount)}
        </span>
      ) : null}
    </span>
  );
}
